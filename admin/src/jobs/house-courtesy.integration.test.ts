import { sql, type Kysely } from "kysely";
import type { Pool } from "mysql2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDb,
  createPool,
  MIGRATIONS,
  repositories,
  runMigrations,
  type Database,
} from "@/db";
import type { AuthId, Cop } from "@/db/types";
import {
  canRunDbTests,
  skipReason,
  startEphemeralMysql,
  type EphemeralMysql,
} from "@/db/testing/ephemeral-mysql";
import {
  eaLocalToInstant,
  parseEaLocalDate,
  parseEaLocalDateTime,
  type EaLocalDateTime,
} from "@/lib/ea";
import { toStrapiPayment, type IngestClient } from "@/lib/ingest-client";
import type { IngestPayment } from "@/lib/ingest-payload";
import { houseCourtesyTicket, type TicketItemInput } from "@/lib/ticket";

import {
  fortnightDays,
  fortnightOf,
  markFortnightPaid,
  markFortnightReviewed,
  runFortnight,
} from "./commission-run";
import { closeDay, recordAdjustment, retryDayPush, type DayAppointment } from "./day-close";

/**
 * Cortesía de la casa contra un **MySQL real**: lo que decide la base y no el
 * código.
 *
 * - **La `026`.** Que la columna exista con `0` por defecto, que el CHECK
 *   `ck_af_house_courtesy` rechace una cortesía con cobro o con propina, y que
 *   `customer_setting` prenda y apague la marca sin duplicar filas.
 * - **La liquidación.** Que una cortesía escrita como la escribe el cierre
 *   pague el 40 % del precio de lista, y que una quincena **pagada** no se
 *   reescriba aunque la cortesía cambie después.
 * - **El cierre del día.** Que la cortesía quede congelada bajo el cierre, que
 *   `day_close` no la sume, y que el CRM no reciba ningún movimiento suyo —ni en
 *   el primer push ni en el reintento—.
 */

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;

const OWNER_ID: AuthId = "usr_owner_0000000000000000000000";
const LINA = 3;
const FORRADO = 5;
const DISENO = 31;

const QUINCENA = fortnightOf("2026-09-08");
const DESPUES = eaLocalToInstant(parseEaLocalDateTime("2026-09-16 10:00:00"));

const DIA = parseEaLocalDate("2026-09-08");
const OCHO_PM = eaLocalToInstant(parseEaLocalDateTime("2026-09-08 20:00:00"));

function dt(value: string): EaLocalDateTime {
  return parseEaLocalDateTime(value);
}

/** La cuenta de la hermana de la dueña: forrado congelado a 180.000 + 3 diseños. */
const RENGLONES: TicketItemInput[] = [
  { kind: "servicio", eaServiceId: FORRADO, qty: 1, unitPriceSnapshot: 180_000 },
  { kind: "adicional", eaServiceId: DISENO, qty: 3, unitPriceSnapshot: 10_000 },
];

type IngestEstado = { lotes: IngestPayment[][] };

function fakeIngest(estado: IngestEstado): IngestClient {
  return {
    async push(payments) {
      estado.lotes.push([...payments]);
      return { sent: payments.length, status: 200, at: new Date() };
    },
  };
}

function cita(eaAppointmentId: number, hora = "09:00:00"): DayAppointment {
  return {
    eaAppointmentId,
    status: "Completada",
    // Completada y ya terminada a las 8 p. m.: espera cuenta cerrada.
    start: dt(`2026-09-08 ${hora}`),
    end: dt(`2026-09-08 ${hora}`),
    customerName: "Hermana de la dueña",
    providerName: "Lina",
  };
}

describe.skipIf(!canRunDbTests())(
  `cortesía de la casa contra MySQL real${skipReason() ? ` (saltado: ${skipReason()})` : ""}`,
  () => {
    let container: EphemeralMysql;
    let pool: Pool;
    let db: Kysely<Database>;

    beforeAll(async () => {
      container = await startEphemeralMysql();
      pool = createPool(container.url);
      db = createDb(pool);
      await runMigrations(db);
    }, HOOK_TIMEOUT);

    afterAll(async () => {
      await db?.destroy();
      await container?.stop();
    }, HOOK_TIMEOUT);

    beforeEach(async () => {
      await limpiar(db);
      await sembrarDuena(db);
    }, TEST_TIMEOUT);

    // ── La migración ─────────────────────────────────────────────────────

    describe("la migración 026", () => {
      it(
        "es forward-only, idempotente y no rompe la segunda corrida",
        async () => {
          const migracion = MIGRATIONS.find((m) => m.id === "026-house-courtesy");
          expect(migracion).toBeDefined();
          const texto = migracion!.statements.join("\n");
          expect(texto).not.toMatch(/\bDROP\b/i);
          expect(texto).not.toMatch(/\bDELETE\s+FROM\b/i);

          // Cada sentencia sola tiene que aguantar volver a correr: el DDL hace
          // commit implícito y una migración a medias se retoma entera.
          for (const statement of migracion!.statements) {
            await sql.raw(statement).execute(db);
          }
          expect((await runMigrations(db)).applied).toEqual([]);

          const { rows } = await sql<{ COLUMN_DEFAULT: string; IS_NULLABLE: string }>`
            SELECT COLUMN_DEFAULT, IS_NULLABLE FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'appointment_finance'
              AND COLUMN_NAME = 'is_house_courtesy'
          `.execute(db);
          expect(rows).toEqual([{ COLUMN_DEFAULT: "0", IS_NULLABLE: "NO" }]);
        },
        TEST_TIMEOUT,
      );

      it(
        "una cuenta existente no es cortesía: el valor por defecto es cobrar",
        async () => {
          const id = await sembrarCuenta(db, { eaAppointmentId: 1, cortesia: false });
          const fila = await repositories(db).appointmentFinance.findById(id);
          expect(fila?.is_house_courtesy).toBe(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "el CHECK rechaza una cortesía con cobro o con propina",
        async () => {
          const id = await sembrarCuenta(db, { eaAppointmentId: 2, cortesia: true });
          const repo = repositories(db).appointmentFinance;

          await expect(repo.update(id, { amount_charged: 50_000 })).rejects.toThrow(
            /ck_af_house_courtesy/,
          );
          await expect(repo.update(id, { tip: 10_000 })).rejects.toThrow(/ck_af_house_courtesy/);
          // Y una cuenta cobrada no se puede marcar como cortesía sin bajar el cobro.
          const cobrada = await sembrarCuenta(db, { eaAppointmentId: 3, cortesia: false });
          await expect(repo.update(cobrada, { is_house_courtesy: 1 })).rejects.toThrow(
            /ck_af_house_courtesy/,
          );

          const fila = await repo.findById(id);
          expect(fila).toMatchObject({ is_house_courtesy: 1, amount_charged: 0, tip: 0 });
        },
        TEST_TIMEOUT,
      );

      it(
        "customer_setting prende y apaga la marca sin duplicar filas",
        async () => {
          const repo = repositories(db).customerSettings;
          expect(await repo.listHouseCourtesyIds([])).toEqual(new Set());

          await repo.setHouseCourtesy([482, 517], true, OWNER_ID);
          await repo.setHouseCourtesy([482], true, OWNER_ID);
          expect(await repo.listHouseCourtesyIds([482, 517, 999])).toEqual(new Set([482, 517]));

          await repo.setHouseCourtesy([517], false, OWNER_ID);
          expect(await repo.listHouseCourtesyIds([482, 517])).toEqual(new Set([482]));

          const filas = await db.selectFrom("customer_setting").selectAll().execute();
          expect(filas).toHaveLength(2);
        },
        TEST_TIMEOUT,
      );
    });

    // ── La liquidación ──────────────────────────────────────────────────

    describe("la liquidación", () => {
      it(
        "paga el 40 % del precio de lista de la cortesía",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 5001, cortesia: true });
          const result = await runFortnight(
            { db },
            { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES },
          );

          expect(result.skipped).toEqual([]);
          expect(result.runs).toEqual([
            expect.objectContaining({ eaProviderId: LINA, total: 84_000, status: "borrador" }),
          ]);

          const entradas = await repositories(db).commissionEntries.listDetailedByPeriod(
            QUINCENA.periodStart,
            QUINCENA.periodEnd,
          );
          expect(entradas.map((e) => [e.baseAmount, e.rateBp, e.amount, e.houseCourtesy])).toEqual([
            [180_000, 4000, 72_000, true],
            [30_000, 4000, 12_000, true],
          ]);

          // La consulta del reporte de cortesías trae la misma comisión.
          const montos = await repositories(db).commissionEntries.listAmountsByEaAppointmentIds([
            5001,
          ]);
          expect(montos.reduce((sum, m) => sum + m.amount, 0)).toBe(84_000);
          expect(
            await repositories(db).commissionEntries.listAmountsByEaAppointmentIds([]),
          ).toEqual([]);
        },
        TEST_TIMEOUT,
      );

      it(
        "una quincena pagada no se recalcula aunque la cortesía cambie después",
        async () => {
          const id = await sembrarCuenta(db, { eaAppointmentId: 5001, cortesia: true });
          await runFortnight({ db }, { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES });
          await cerrarTodosLosDias(db);

          expect(
            await markFortnightReviewed(
              { db },
              { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID, now: DESPUES },
            ),
          ).toMatchObject({ ok: true });
          expect(
            await markFortnightPaid(
              { db },
              { period: QUINCENA, eaProviderId: LINA, actorUserId: OWNER_ID, now: DESPUES },
            ),
          ).toMatchObject({ ok: true });

          // La dueña se arrepiente y la vuelve una cuenta cobrada a la mitad:
          // la base de comisión bajaría de 210.000 a 105.000. No importa: la
          // quincena ya se pagó y es de solo lectura entera.
          await repositories(db).appointmentFinance.update(id, {
            is_house_courtesy: 0,
            discount: 105_000,
            amount_charged: 105_000,
          });

          const recalculo = await runFortnight(
            { db },
            { period: QUINCENA, actorUserId: OWNER_ID, now: DESPUES },
          );
          expect(recalculo.written).toEqual({ inserted: 0, updated: 0, frozen: 2, dropped: 0 });
          expect(recalculo.runs).toEqual([
            expect.objectContaining({
              eaProviderId: LINA,
              total: 84_000,
              status: "pagada",
              recalculated: false,
            }),
          ]);

          const entradas = await db.selectFrom("commission_entry").selectAll().execute();
          expect(entradas.map((e) => [e.base_amount, e.amount, e.status])).toEqual([
            [180_000, 72_000, "paid"],
            [30_000, 12_000, "paid"],
          ]);
        },
        TEST_TIMEOUT,
      );
    });

    // ── El cierre del día ───────────────────────────────────────────────

    describe("el cierre del día", () => {
      it(
        "congela la cortesía, no la suma y no le manda nada al CRM",
        async () => {
          const ingest: IngestEstado = { lotes: [] };
          await sembrarCuenta(db, { eaAppointmentId: 101, cortesia: false, propina: 10_000 });
          const cortesiaId = await sembrarCuenta(db, {
            eaAppointmentId: 102,
            cortesia: true,
            hora: "11:00:00",
          });

          const deps = {
            db,
            loadAppointments: async () => [cita(101), cita(102, "11:00:00")],
            ingest: fakeIngest(ingest),
          };

          const result = await closeDay(deps, { date: DIA, closedBy: OWNER_ID, now: OCHO_PM });
          if (!result.ok) throw new Error(`no cerró: ${JSON.stringify(result)}`);
          expect(result.totals).toMatchObject({
            ingreso: 210_000,
            efectivo: 210_000,
            tips: 10_000,
            count: 1,
            cortesias: 1,
          });
          expect(result.push).toMatchObject({ state: "hecho", sent: 1 });

          const cierre = await repositories(db).dayCloses.findByDate(DIA);
          expect(cierre).toMatchObject({
            total_efectivo: 210_000,
            total_transferencia: 0,
            total_otro: 0,
            total_tips: 10_000,
            appointment_count: 1,
          });

          // El CRM recibió un solo movimiento, el de la cuenta cobrada.
          expect(ingest.lotes.flat().map((p) => toStrapiPayment(p).tx_id)).toEqual([
            "ea-appt:101",
          ]);

          // La cortesía quedó congelada bajo el cierre: la comisión que se
          // liquide sobre ella ya no se puede mover desde Hoy.
          const fila = await repositories(db).appointmentFinance.findById(cortesiaId);
          expect(fila?.day_close_id).toBe(cierre?.id);

          // Reintentar no crea nada nuevo: el día ya se empujó.
          expect(await retryDayPush(deps, { date: DIA, now: OCHO_PM })).toMatchObject({
            state: "ya",
          });
          expect(ingest.lotes).toHaveLength(1);
        },
        TEST_TIMEOUT,
      );

      it(
        "un día con solo cortesías cierra en cero y no empuja nada",
        async () => {
          const ingest: IngestEstado = { lotes: [] };
          await sembrarCuenta(db, { eaAppointmentId: 102, cortesia: true });
          const deps = {
            db,
            loadAppointments: async () => [cita(102)],
            ingest: fakeIngest(ingest),
          };

          const result = await closeDay(deps, { date: DIA, closedBy: OWNER_ID, now: OCHO_PM });
          if (!result.ok) throw new Error(`no cerró: ${JSON.stringify(result)}`);
          expect(result.totals).toMatchObject({ ingreso: 0, count: 0, cortesias: 1 });
          expect(result.push).toEqual({ state: "vacio" });
          expect(ingest.lotes).toEqual([]);
        },
        TEST_TIMEOUT,
      );

      it(
        "una cortesía ya cerrada no admite un ajuste de ingreso",
        async () => {
          const ingest: IngestEstado = { lotes: [] };
          const id = await sembrarCuenta(db, { eaAppointmentId: 102, cortesia: true });
          const deps = {
            db,
            loadAppointments: async () => [cita(102)],
            ingest: fakeIngest(ingest),
          };
          await closeDay(deps, { date: DIA, closedBy: OWNER_ID, now: OCHO_PM });

          const ajuste = await recordAdjustment(deps, {
            eaAppointmentId: 102,
            delta: 50_000,
            reason: "al final sí pagó",
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });
          expect(ajuste).toMatchObject({ ok: false, reason: "lote" });
          expect(ingest.lotes).toEqual([]);

          // Y no quedó un renglón suelto ni un cobro en la cortesía.
          const fila = await repositories(db).appointmentFinance.findById(id);
          expect(fila).toMatchObject({ amount_charged: 0, is_house_courtesy: 1 });
          const renglones = await repositories(db).appointmentFinanceItems.listByFinanceIds([id]);
          expect(renglones).toHaveLength(2);
        },
        TEST_TIMEOUT,
      );
    });
  },
);

// ── Helpers ─────────────────────────────────────────────────────────────────

async function limpiar(db: Kysely<Database>): Promise<void> {
  const tablas = [
    "commission_entry",
    "commission_run",
    "commission_rule",
    "appointment_payment",
    "appointment_finance_item",
    "appointment_finance",
    "day_close",
    "customer_setting",
    "job_run",
    "audit_log",
    "user",
  ];
  await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
  for (const tabla of tablas) {
    await sql.raw(`TRUNCATE TABLE \`${tabla}\``).execute(db);
  }
  await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);

  // La regla del 40 % se resiembra con **su propio SQL**, el que se despliega.
  const siembra = MIGRATIONS.find((m) => m.id === "018-commission-rule");
  if (siembra === undefined) throw new Error("falta la migración 018");
  for (const statement of siembra.statements) {
    await sql.raw(statement).execute(db);
  }
}

async function sembrarDuena(db: Kysely<Database>): Promise<void> {
  await db
    .insertInto("user")
    .values({
      id: OWNER_ID,
      name: "Dueña",
      email: "duena@goldenbeautystudio.com.co",
      emailVerified: 1,
    })
    .execute();
}

/**
 * Una cuenta cerrada del 8 de septiembre, escrita como la escribe
 * `cerrarCuenta()`: con la cortesía, el descuento es la lista entera, no hay
 * pagos ni propina, y el motivo es `cortesia`. Pasa por los CHECK de verdad.
 */
async function sembrarCuenta(
  db: Kysely<Database>,
  opts: { eaAppointmentId: number; cortesia: boolean; propina?: Cop; hora?: string },
): Promise<number> {
  const repos = repositories(db);
  const start = eaLocalToInstant(dt(`2026-09-08 ${opts.hora ?? "09:00:00"}`));
  const totals = houseCourtesyTicket(RENGLONES);

  const { row } = await repos.appointmentFinance.ensure({
    ea_appointment_id: opts.eaAppointmentId,
    ea_provider_id: LINA,
    secondary_ea_provider_id: null,
    appointment_start_at: start,
    booked_service_id: FORRADO,
    performed_service_id: FORRADO,
    service_price_snapshot: 180_000,
    snapshot_source: "webhook",
  });

  await repos.appointmentFinanceItems.insertMany(
    totals.lines.map((line) => ({
      appointment_finance_id: row.id,
      kind: line.kind,
      ea_service_id: line.eaServiceId ?? null,
      pricing_id: null,
      qty: line.qty,
      unit_price_snapshot: line.unitPriceSnapshot,
      line_total: line.lineTotal,
      note: null,
    })),
  );

  if (opts.cortesia) {
    await repos.appointmentFinance.update(row.id, {
      discount: totals.discount,
      amount_charged: 0,
      tip: 0,
      is_house_courtesy: 1,
      payment_method: null,
      paid_at: null,
      variance_reason_code: "cortesia",
      closed_by: OWNER_ID,
      closed_at: start,
    });
    return row.id;
  }

  await repos.appointmentPayments.replaceForFinance(row.id, [
    { method: "efectivo", amount: totals.subtotal },
  ]);
  await repos.appointmentFinance.update(row.id, {
    discount: 0,
    amount_charged: totals.subtotal,
    tip: opts.propina ?? 0,
    payment_method: "efectivo",
    paid_at: start,
    closed_by: OWNER_ID,
    closed_at: start,
  });
  return row.id;
}

async function cerrarTodosLosDias(db: Kysely<Database>): Promise<void> {
  const { dayCloses } = repositories(db);
  for (const day of fortnightDays(QUINCENA)) {
    await dayCloses.insert({
      close_date: day,
      closed_by: OWNER_ID,
      closed_at: eaLocalToInstant(dt(`${day} 20:00:00`)),
    });
  }
}
