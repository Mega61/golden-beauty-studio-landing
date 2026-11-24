import { sql, type Kysely } from "kysely";
import type { Pool } from "mysql2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDb, createPool, MIGRATIONS, repositories, runMigrations, type Database } from "@/db";
import {
  canRunDbTests,
  skipReason,
  startEphemeralMysql,
  type EphemeralMysql,
} from "@/db/testing/ephemeral-mysql";
import { eaLocalToInstant, parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";
import type { IngestClient, PaymentLabels } from "@/lib/ingest-client";
import type { IngestPayment } from "@/lib/ingest-payload";

import { syncDay, type DayAppointment } from "./day-close";
import { syncDeposits } from "./deposits";

/**
 * Adelantos contra un **MySQL real** (migración `034`), de punta a punta:
 *
 * 1. El adelanto entra el 23 de noviembre y viaja esa noche como `abono:<id>`,
 *    con ese día: es lo que el bot de finanzas enlaza con la transferencia.
 * 2. La cita es el 12 de diciembre. La cuenta se paga con `abono` + efectivo,
 *    y el cierre de ese día manda **solo el efectivo**.
 * 3. Una devolución posterior sale una vez, como `abono:<id>:adj1` negativo.
 */

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;
const at = (local: string) => eaLocalToInstant(parseEaLocalDateTime(local));
const PAGO = at("2026-11-23 15:00:00");
const NOCHE_PAGO = at("2026-11-24 03:45:00");
const CITA = at("2026-12-12 10:00:00");
const NOCHE_CITA = at("2026-12-13 03:45:00");
const DESDE = at("2026-11-01 00:00:00");

type Lotes = { payments: IngestPayment[]; labels?: PaymentLabels }[];

function fakeIngest(lotes: Lotes): IngestClient {
  return {
    since: parseEaLocalDate("2026-10-24"),
    async push(payments, labels) {
      lotes.push({ payments: [...payments], labels });
      return { sent: payments.length, status: 200, at: new Date() };
    },
  };
}

describe.skipIf(!canRunDbTests())(
  `adelantos contra MySQL real${skipReason() ? ` (saltado: ${skipReason()})` : ""}`,
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
      await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
      for (const tabla of [
        "appointment_payment",
        "appointment_finance_item",
        "appointment_finance",
        "day_close",
        "appointment_deposit",
        "audit_log",
      ]) {
        await sql.raw(`TRUNCATE TABLE \`${tabla}\``).execute(db);
      }
      await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
    }, TEST_TIMEOUT);

    const nuevo = (over: Partial<Parameters<ReturnType<typeof repositories>["appointmentDeposits"]["insert"]>[0]> = {}) => ({
      ea_appointment_id: 9101,
      appointment_start_at: CITA,
      amount: 50_000,
      method: "transferencia" as const,
      paid_at: PAGO,
      paid_ref: null,
      customer_name: "Ana Ruiz",
      customer_phone: "+573001234567",
      created_by: null,
      ...over,
    });

    it(
      "la 034 es idempotente: cada sentencia aguanta volver a correr",
      async () => {
        const migracion = MIGRATIONS.find((m) => m.id === "034-appointment-deposits");
        expect(migracion).toBeDefined();
        for (const statement of migracion!.statements) {
          await sql.raw(statement).execute(db);
        }
        expect((await runMigrations(db)).applied).toEqual([]);
      },
      TEST_TIMEOUT,
    );

    it(
      "la base no acepta un adelanto de cero ni una devolución a medias o mayor que el adelanto",
      async () => {
        const repos = repositories(db);
        await expect(repos.appointmentDeposits.insert(nuevo({ amount: 0 }))).rejects.toThrow(/ck_ad_amount/);
        const id = await repos.appointmentDeposits.insert(nuevo());
        await expect(
          sql`UPDATE appointment_deposit SET refunded_amount = 10000 WHERE id = ${id}`.execute(db),
        ).rejects.toThrow(/ck_ad_refund/);
        await expect(
          repos.appointmentDeposits.markRefunded(id, {
            amount: 60_000,
            method: "efectivo",
            at: NOCHE_CITA,
            by: "usr_owner",
            reason: "x",
          }),
        ).rejects.toThrow(/ck_ad_refund/);
      },
      TEST_TIMEOUT,
    );

    it(
      "de punta a punta: el adelanto viaja el día que entró, la cuenta solo el resto, la devolución una vez",
      async () => {
        const repos = repositories(db);
        const id = await repos.appointmentDeposits.insert(nuevo());
        const lotes: Lotes = [];
        const ingest = fakeIngest(lotes);

        // 1. La noche del 23 viaja el adelanto, una sola vez.
        expect(await syncDeposits({ db, ingest }, { from: DESDE, to: NOCHE_PAGO, now: NOCHE_PAGO })).toEqual({
          state: "hecho",
          deposits: 1,
          refunds: 0,
        });
        expect(await syncDeposits({ db, ingest }, { from: DESDE, to: NOCHE_PAGO })).toEqual({ state: "nada" });
        expect(lotes[0].payments).toEqual([
          { source_tx_id: `abono:${id}`, amount: 50_000, tip: 0, method: "transferencia", paid_on: "2026-11-23" },
        ]);
        expect(lotes[0].labels?.get(`abono:${id}`)).toEqual({
          clientName: "Ana Ruiz",
          serviceName: "Adelanto cita 2026-12-12",
        });

        // 2. La cita: 150.000, pagada con el adelanto y 100.000 en efectivo.
        const { row } = await repos.appointmentFinance.ensure({
          ea_appointment_id: 9101,
          ea_provider_id: 4,
          secondary_ea_provider_id: null,
          appointment_start_at: CITA,
          booked_service_id: 5,
          performed_service_id: 5,
          service_price_snapshot: 150_000,
          snapshot_source: "webhook",
        });
        await repos.appointmentFinanceItems.insertMany([
          {
            appointment_finance_id: row.id,
            kind: "servicio",
            ea_service_id: 5,
            pricing_id: null,
            qty: 1,
            unit_price_snapshot: 150_000,
            line_total: 150_000,
            note: null,
          },
        ]);
        await repos.appointmentPayments.replaceForFinance(row.id, [
          { method: "abono", amount: 50_000 },
          { method: "efectivo", amount: 100_000 },
        ]);
        await repos.appointmentFinance.update(row.id, {
          amount_charged: 150_000,
          paid_at: CITA,
          closed_at: CITA,
        });
        expect(await repos.appointmentFinance.findClosedEaIds([9101, 9999])).toEqual(new Set([9101]));

        const result = await syncDay(
          { db, loadAppointments: async () => [] as DayAppointment[], ingest },
          { date: parseEaLocalDate("2026-12-12"), now: NOCHE_CITA },
        );
        expect(result.state).toBe("sincronizado");
        expect(lotes[1].payments).toEqual([
          { source_tx_id: "ea-appt:9101", amount: 100_000, tip: 0, method: "efectivo", paid_on: "2026-12-12" },
        ]);
        expect(await repos.dayCloses.findByDate(parseEaLocalDate("2026-12-12"))).toMatchObject({
          total_efectivo: 100_000,
          total_transferencia: 0,
        });

        // 3. Una devolución (de otro adelanto ya enviado): sale una vez, negativa.
        const otro = await repos.appointmentDeposits.insert(nuevo({ ea_appointment_id: 9102, amount: 40_000 }));
        await syncDeposits({ db, ingest }, { from: DESDE, to: NOCHE_PAGO, now: NOCHE_PAGO });
        expect(
          await repos.appointmentDeposits.markRefunded(otro, {
            amount: 40_000,
            method: "transferencia",
            at: at("2026-12-01 11:00:00"),
            by: "usr_owner",
            reason: "Canceló con tiempo",
          }),
        ).toBe(true);
        // Una sola devolución por adelanto.
        expect(
          await repos.appointmentDeposits.markRefunded(otro, {
            amount: 1,
            method: "efectivo",
            at: at("2026-12-01 11:00:00"),
            by: "usr_owner",
            reason: "otra",
          }),
        ).toBe(false);
        expect(await syncDeposits({ db, ingest }, { from: DESDE, to: NOCHE_CITA, now: NOCHE_CITA })).toEqual({
          state: "hecho",
          deposits: 0,
          refunds: 1,
        });
        expect(await syncDeposits({ db, ingest }, { from: DESDE, to: NOCHE_CITA })).toEqual({ state: "nada" });
        expect(lotes.at(-1)?.payments).toEqual([
          { source_tx_id: `abono:${otro}:adj1`, amount: -40_000, tip: 0, method: "transferencia", paid_on: "2026-12-01" },
        ]);
      },
      TEST_TIMEOUT,
    );

    it(
      "borrar solo lo que no viajó; pasar de cita; listar por celular y por día de caja",
      async () => {
        const repos = repositories(db);
        const viajado = await repos.appointmentDeposits.insert(nuevo());
        await repos.appointmentDeposits.markPushed([viajado], NOCHE_PAGO);
        const sinViajar = await repos.appointmentDeposits.insert(nuevo({ amount: 10_000 }));

        expect(await repos.appointmentDeposits.deleteUnpushed(viajado)).toBe(false);
        expect(await repos.appointmentDeposits.deleteUnpushed(sinViajar)).toBe(true);

        await repos.appointmentDeposits.moveToAppointment(viajado, 9200, NOCHE_CITA);
        expect(await repos.appointmentDeposits.findById(viajado)).toMatchObject({ ea_appointment_id: 9200 });
        expect((await repos.appointmentDeposits.listByAppointments([9200, 9101])).map((d) => d.id)).toEqual([viajado]);
        expect((await repos.appointmentDeposits.listByPhone("+573001234567")).map((d) => d.id)).toEqual([viajado]);
        expect(
          (await repos.appointmentDeposits.listMovedBetween(at("2026-11-23 00:00:00"), at("2026-11-24 00:00:00"))).map(
            (d) => d.id,
          ),
        ).toEqual([viajado]);
        expect((await repos.appointmentDeposits.listRecent(10)).map((d) => d.id)).toEqual([viajado]);
      },
      TEST_TIMEOUT,
    );
  },
);
