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
import { syncGiftCardSales } from "./gift-card-sales";

/**
 * Tarjetas regalo contra un **MySQL real** (migración `033`):
 *
 * - `appointment_payment` acepta `bono` con su código, y la cuenta guarda la
 *   tarjeta redimida.
 * - El cierre nocturno no manda el pago con tarjeta, y sí lo demás.
 * - Una venta viaja una vez con `bono:<código>`; su anulación posterior, una
 *   vez como `:adj1` negativo.
 */

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;
const DIA = parseEaLocalDate("2026-12-10");
const MEDIODIA = eaLocalToInstant(parseEaLocalDateTime("2026-12-10 12:00:00"));
const NOCHE = eaLocalToInstant(parseEaLocalDateTime("2026-12-11 03:45:00"));

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
  `tarjetas regalo contra MySQL real${skipReason() ? ` (saltado: ${skipReason()})` : ""}`,
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
      for (const tabla of ["appointment_payment", "appointment_finance_item", "appointment_finance", "day_close", "gift_card_sale", "audit_log", "job_run"]) {
        await sql.raw(`TRUNCATE TABLE \`${tabla}\``).execute(db);
      }
      await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
    }, TEST_TIMEOUT);

    it(
      "la 033 es idempotente: cada sentencia aguanta volver a correr",
      async () => {
        const migracion = MIGRATIONS.find((m) => m.id === "033-gift-cards");
        expect(migracion).toBeDefined();
        for (const statement of migracion!.statements) {
          await sql.raw(statement).execute(db);
        }
        expect((await runMigrations(db)).applied).toEqual([]);
      },
      TEST_TIMEOUT,
    );

    it(
      "una cuenta con tarjeta + efectivo: el cierre manda solo el efectivo",
      async () => {
        const repos = repositories(db);
        const { row } = await repos.appointmentFinance.ensure({
          ea_appointment_id: 9001,
          ea_provider_id: 4,
          secondary_ea_provider_id: null,
          appointment_start_at: MEDIODIA,
          booked_service_id: 5,
          performed_service_id: 5,
          service_price_snapshot: 120_000,
          snapshot_source: "webhook",
        });
        await repos.appointmentFinanceItems.insertMany([
          {
            appointment_finance_id: row.id,
            kind: "servicio",
            ea_service_id: 5,
            pricing_id: null,
            qty: 1,
            unit_price_snapshot: 120_000,
            line_total: 120_000,
            note: null,
          },
        ]);
        await repos.appointmentPayments.replaceForFinance(row.id, [
          { method: "bono", amount: 100_000, gift_card_code: "TR-AB12-CD34" },
          { method: "efectivo", amount: 20_000 },
        ]);
        await repos.appointmentFinance.update(row.id, {
          amount_charged: 120_000,
          paid_at: MEDIODIA,
          closed_at: MEDIODIA,
          gift_card_code: "TR-AB12-CD34",
        });

        const pagos = await repos.appointmentPayments.listByFinanceId(row.id);
        expect(pagos.map((p) => [p.method, p.amount, p.gift_card_code])).toEqual([
          ["bono", 100_000, "TR-AB12-CD34"],
          ["efectivo", 20_000, null],
        ]);
        expect((await repos.appointmentFinance.findById(row.id))?.gift_card_code).toBe("TR-AB12-CD34");

        const lotes: Lotes = [];
        const result = await syncDay(
          { db, loadAppointments: async () => [] as DayAppointment[], ingest: fakeIngest(lotes) },
          { date: DIA, now: NOCHE },
        );
        expect(result.state).toBe("sincronizado");
        expect(lotes.flatMap((l) => l.payments)).toEqual([
          { source_tx_id: "ea-appt:9001", amount: 20_000, tip: 0, method: "efectivo", paid_on: "2026-12-10" },
        ]);
        // El cajón del día cuenta el efectivo; la tarjeta, aparte.
        const cierre = await repos.dayCloses.findByDate(DIA);
        expect(cierre).toMatchObject({ total_efectivo: 20_000, total_transferencia: 0, total_otro: 0 });
      },
      TEST_TIMEOUT,
    );

    it(
      "pagada toda con tarjeta y con propina: viaja la propina, monto 0, con su método",
      async () => {
        const repos = repositories(db);
        const { row } = await repos.appointmentFinance.ensure({
          ea_appointment_id: 9002,
          ea_provider_id: 4,
          secondary_ea_provider_id: null,
          appointment_start_at: MEDIODIA,
          booked_service_id: 5,
          performed_service_id: 5,
          service_price_snapshot: 100_000,
          snapshot_source: "webhook",
        });
        await repos.appointmentFinanceItems.insertMany([
          {
            appointment_finance_id: row.id,
            kind: "servicio",
            ea_service_id: 5,
            pricing_id: null,
            qty: 1,
            unit_price_snapshot: 100_000,
            line_total: 100_000,
            note: null,
          },
        ]);
        await repos.appointmentPayments.replaceForFinance(row.id, [
          { method: "bono", amount: 100_000, gift_card_code: "TR-AB12-CD34" },
        ]);
        await repos.appointmentFinance.update(row.id, {
          amount_charged: 100_000,
          tip: 8_000,
          tip_method: "efectivo",
          paid_at: MEDIODIA,
          closed_at: MEDIODIA,
          gift_card_code: "TR-AB12-CD34",
        });

        const lotes: Lotes = [];
        const result = await syncDay(
          { db, loadAppointments: async () => [] as DayAppointment[], ingest: fakeIngest(lotes) },
          { date: DIA, now: NOCHE },
        );
        expect(result).toMatchObject({ state: "sincronizado", skipped: [] });
        expect(lotes.flatMap((l) => l.payments)).toEqual([
          { source_tx_id: "ea-appt:9002", amount: 0, tip: 8_000, method: "efectivo", paid_on: "2026-12-10" },
        ]);
        expect(await repos.dayCloses.findByDate(DIA)).toMatchObject({ total_efectivo: 0, total_tips: 8_000 });
      },
      TEST_TIMEOUT,
    );

    it(
      "una venta viaja una vez, y su anulación posterior una vez, en negativo",
      async () => {
        const repos = repositories(db);
        const id = await repos.giftCardSales.insert({
          stampee_gift_card_id: "gc-1",
          code: "TR-AB12-CD34",
          tier_name: "Consentida",
          amount: 100_000,
          method: "transferencia",
          paid_at: MEDIODIA,
          paid_ref: null,
          buyer_name: "Ana Ruiz",
          buyer_phone: "+573001234567",
          created_by: null,
        });
        // La misma tarjeta no se vende dos veces.
        await expect(
          repos.giftCardSales.insert({
            stampee_gift_card_id: "gc-1",
            code: "TR-AB12-CD34",
            tier_name: null,
            amount: 100_000,
            method: "efectivo",
            paid_at: MEDIODIA,
            paid_ref: null,
            buyer_name: null,
            buyer_phone: null,
            created_by: null,
          }),
        ).rejects.toThrow(/Duplicate/);

        const lotes: Lotes = [];
        const deps = { db, ingest: fakeIngest(lotes) };
        const rango = { from: eaLocalToInstant(parseEaLocalDateTime("2026-12-01 00:00:00")), to: NOCHE, now: NOCHE };

        expect(await syncGiftCardSales(deps, rango)).toEqual({ state: "hecho", sales: 1, voids: 0 });
        expect(await syncGiftCardSales(deps, rango)).toEqual({ state: "nada" });
        expect(lotes[0].payments).toEqual([
          { source_tx_id: "bono:TR-AB12-CD34", amount: 100_000, tip: 0, method: "transferencia", paid_on: "2026-12-10" },
        ]);
        expect(lotes[0].labels?.get("bono:TR-AB12-CD34")).toEqual({
          clientName: "Ana Ruiz",
          serviceName: "Tarjeta regalo Consentida",
        });

        await repos.giftCardSales.markVoided(id, { at: NOCHE, by: "usr_owner", reason: "se arrepintió" });
        expect(await syncGiftCardSales(deps, rango)).toEqual({ state: "hecho", sales: 0, voids: 1 });
        expect(await syncGiftCardSales(deps, rango)).toEqual({ state: "nada" });
        expect(lotes[1].payments).toEqual([
          { source_tx_id: "bono:TR-AB12-CD34:adj1", amount: -100_000, tip: 0, method: "transferencia", paid_on: "2026-12-10" },
        ]);
      },
      TEST_TIMEOUT,
    );

    it(
      "una venta anulada antes de viajar no viaja nunca, y la compensación de un pago a medias la borra",
      async () => {
        const repos = repositories(db);
        const base = {
          tier_name: null,
          amount: 50_000,
          method: "efectivo" as const,
          paid_at: MEDIODIA,
          paid_ref: null,
          buyer_name: null,
          buyer_phone: null,
          created_by: null,
        };
        const anulada = await repos.giftCardSales.insert({ ...base, stampee_gift_card_id: "gc-2", code: "TR-0000-0002" });
        await repos.giftCardSales.markVoided(anulada, { at: MEDIODIA, by: "usr_owner", reason: "error" });
        const compensada = await repos.giftCardSales.insert({ ...base, stampee_gift_card_id: "gc-3", code: "TR-0000-0003" });
        await repos.giftCardSales.deleteUnpushed(compensada);

        const lotes: Lotes = [];
        const result = await syncGiftCardSales(
          { db, ingest: fakeIngest(lotes) },
          { from: eaLocalToInstant(parseEaLocalDateTime("2026-12-01 00:00:00")), to: NOCHE, now: NOCHE },
        );
        expect(result).toEqual({ state: "nada" });
        expect(await repos.giftCardSales.findByCardId("gc-3")).toBeUndefined();
      },
      TEST_TIMEOUT,
    );
  },
);
