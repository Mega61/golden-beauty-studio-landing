import { sql, type Kysely } from "kysely";
import type { Pool } from "mysql2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDb, createPool } from "./client";
import { runMigrations } from "./migrate";
import { EXPECTED_TABLES, MIGRATIONS } from "./migrations";
import { PaidCommissionRunError, repositories } from "./repositories";
import {
  canRunDbTests,
  skipReason,
  startEphemeralMysql,
  type EphemeralMysql,
} from "./testing/ephemeral-mysql";
import type { Database } from "./types";

/**
 * Los tests de capa 2: MySQL real, efímero, levantado por el propio test.
 *
 * Lo que se verifica acá es lo que **la base** hace, no lo que el código cree
 * que hace. Que un `CHECK` rechace, que un `RESTRICT` frene un borrado, que un
 * índice único con `NULL` admita varias filas, que `CREATE TABLE IF NOT EXISTS`
 * corrido dos veces no falle. Nada de eso se puede afirmar contra un doble del
 * driver: el doble contestaría lo que le enseñamos, que es justo el error que
 * estos tests existen para no cometer.
 *
 * Se saltan solos sin Docker — ver `testing/ephemeral-mysql.ts`. `npm test`
 * sigue verde en una máquina sin Docker Desktop levantado, y el reporte dice
 * que se saltaron.
 */

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;

/** Un id de Better Auth de mentira, con la forma correcta. */
const OWNER_ID = "usr_owner_0000000000000000000000";

describe.skipIf(!canRunDbTests())(
  `esquema gbs_admin contra MySQL real${skipReason() ? ` (saltado: ${skipReason()})` : ""}`,
  () => {
    let container: EphemeralMysql;
    let pool: Pool;
    let db: Kysely<Database>;

    beforeAll(async () => {
      container = await startEphemeralMysql();
      pool = createPool(container.url);
      db = createDb(pool);
    }, HOOK_TIMEOUT);

    afterAll(async () => {
      await db?.destroy();
      await container?.stop();
    }, HOOK_TIMEOUT);

    // ── Las migraciones ────────────────────────────────────────────────────

    describe("migraciones", () => {
      it(
        "aplican en limpio y dejan todas las tablas",
        async () => {
          const first = await runMigrations(db);
          expect(first.applied.length).toBeGreaterThan(0);
          expect(first.skipped).toEqual([]);

          const { rows } = await sql<{ TABLE_NAME: string }>`
            SELECT TABLE_NAME FROM information_schema.TABLES
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
          `.execute(db);

          expect(rows.map((r) => r.TABLE_NAME).sort()).toEqual(
            [...EXPECTED_TABLES].sort(),
          );
        },
        TEST_TIMEOUT,
      );

      it(
        "corridas dos veces seguidas no fallan ni duplican",
        async () => {
          // Es el Definition of Done del paquete, literal. El contenedor de
          // migración del stack corre en cada despliegue: si la segunda corrida
          // fallara, el segundo despliegue no arrancaría.
          const second = await runMigrations(db);
          expect(second.applied).toEqual([]);
          expect(second.skipped).toEqual(MIGRATIONS.map((m) => m.id));

          const stations = await db
            .selectFrom("station")
            .selectAll()
            .orderBy("id")
            .execute();
          expect(stations).toHaveLength(2);
        },
        TEST_TIMEOUT,
      );

      it(
        "siembran dos estaciones, ambas sin restricción de categoría",
        async () => {
          const stations = await repositories(db).stations.listAll();
          expect(stations.map((s) => s.name)).toEqual(["Puesto 1", "Puesto 2"]);
          // `null` = cualquier categoría. Queda pendiente confirmar si una es
          // de manos y otra de pies; la respuesta permisiva es la que no
          // esconde citas que sí caben.
          expect(stations.every((s) => s.allows === null)).toBe(true);
        },
        TEST_TIMEOUT,
      );

      it(
        "rechazan una migración ya aplicada que cambió de contenido",
        async () => {
          // Es lo que hace real el "forward-only". Sin esto, alguien edita una
          // migración vieja, la corrida no hace nada porque el id ya está en el
          // libro, y la base y el archivo dicen cosas distintas para siempre.
          const original = await db
            .selectFrom("schema_migration")
            .select("checksum")
            .where("id", "=", "004-appointment-finance")
            .executeTakeFirstOrThrow();

          await db
            .updateTable("schema_migration")
            .set({ checksum: "0".repeat(64) })
            .where("id", "=", "004-appointment-finance")
            .execute();

          await expect(runMigrations(db)).rejects.toThrow(/forward-only/);

          await db
            .updateTable("schema_migration")
            .set({ checksum: original.checksum })
            .where("id", "=", "004-appointment-finance")
            .execute();
          await expect(runMigrations(db)).resolves.toBeTruthy();
        },
        TEST_TIMEOUT,
      );
    });

    // ── Las invariantes que viven en el esquema ────────────────────────────

    describe("invariantes del esquema", () => {
      beforeEach(async () => {
        await resetData(db);
        await seedOwner(db);
      }, TEST_TIMEOUT);

      it(
        "escribe CURRENT_TIMESTAMP en hora de Bogotá aunque el servidor esté en UTC",
        async () => {
          // `mysql-transversal` corre en UTC (verificado en la VM). Las ~20
          // columnas con DEFAULT CURRENT_TIMESTAMP se escribirían con hora de
          // pared UTC, y `timezone: "local"` de mysql2 las leería como si fueran
          // de Bogotá: cada `created_at` quedaría cinco horas en el futuro, sin
          // error. El pool fija `SET time_zone = '-05:00'` en cada conexión; esto
          // lo comprueba contra la base, no contra la configuración.
          //
          // El contenedor efímero de este test también arranca en UTC, así que
          // sin el arreglo la aserción falla — que es justo lo que se quiere.
          const { rows } = await sql<{
            session_tz: string;
            skew_seconds: number;
          }>`
            SELECT @@session.time_zone AS session_tz,
                   TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), CURRENT_TIMESTAMP()) AS skew_seconds
          `.execute(db);

          expect(rows[0]?.session_tz).toBe("-05:00");
          // Bogotá es UTC−5 todo el año: no hay horario de verano que mover esto.
          expect(Number(rows[0]?.skew_seconds)).toBeCloseTo(-5 * 3600, -1);
        },
        TEST_TIMEOUT,
      );

      it(
        "no guarda plata en DECIMAL, FLOAT ni DOUBLE en ninguna columna",
        async () => {
          // Colombia no tiene centavos. La aserción es sobre la base y no sobre
          // el SQL fuente a propósito: es la única forma de cazar un tipo que
          // MySQL haya reinterpretado.
          const { rows } = await sql<{
            TABLE_NAME: string;
            COLUMN_NAME: string;
            DATA_TYPE: string;
          }>`
            SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND DATA_TYPE IN ('decimal','float','double','newdecimal')
          `.execute(db);
          expect(rows).toEqual([]);
        },
        TEST_TIMEOUT,
      );

      it(
        "tiene los índices de las consultas que el plan describe",
        async () => {
          const indexesOf = async (table: string) => {
            const { rows } = await sql<{ INDEX_NAME: string }>`
              SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
              WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
            `.execute(db);
            return rows.map((r) => r.INDEX_NAME);
          };

          // Agenda por rango de fechas, liquidación por técnica, reportes por
          // servicio realizado. Las tres consultas del panel que corren seguido.
          expect(await indexesOf("appointment_finance")).toEqual(
            expect.arrayContaining([
              "uq_af_ea_appointment",
              "idx_af_start_closed",
              "idx_af_provider_start",
              "idx_af_performed_start",
            ]),
          );
          expect(await indexesOf("commission_entry")).toEqual(
            expect.arrayContaining([
              "uq_ce_item_provider",
              "idx_ce_provider_period",
            ]),
          );
          expect(await indexesOf("webhook_event")).toEqual(
            expect.arrayContaining(["uq_webhook_event_dedup"]),
          );
        },
        TEST_TIMEOUT,
      );

      it(
        "no deja dos filas de plata para la misma cita de EA",
        async () => {
          // La llave de idempotencia del webhook. Está en el esquema y no en el
          // handler porque hay dos caminos de escritura — webhook y reconcile —
          // y un solo esquema.
          const repo = repositories(db).appointmentFinance;
          const first = await repo.ensure({
            ea_appointment_id: 4242,
            snapshot_source: "webhook",
            service_price_snapshot: 180_000,
          });
          expect(first.created).toBe(true);

          const second = await repo.ensure({
            ea_appointment_id: 4242,
            snapshot_source: "reconcile",
            service_price_snapshot: 999_999,
          });
          expect(second.created).toBe(false);
          // Y no revaloró: el snapshot original es el que vale. Revalorar una
          // cita vieja al precio de hoy es la deriva de precios que el diseño
          // evita.
          expect(second.row.service_price_snapshot).toBe(180_000);
          expect(second.row.snapshot_source).toBe("webhook");
          expect(second.row.id).toBe(first.row.id);
        },
        TEST_TIMEOUT,
      );

      it(
        "deduplica el mismo webhook y deja pasar dos cambios distintos",
        async () => {
          const repo = repositories(db).webhookEvents;
          const at = new Date("2026-08-31T10:00:00");

          const a = await repo.record({
            action: "appointment_save",
            eaEntityId: 7,
            bodyHash: "a".repeat(64),
            receivedAt: at,
          });
          expect(a.duplicate).toBe(false);

          const replay = await repo.record({
            action: "appointment_save",
            eaEntityId: 7,
            bodyHash: "a".repeat(64),
            receivedAt: at,
          });
          expect(replay.duplicate).toBe(true);
          expect(replay.id).toBe(a.id);

          // Dos ediciones reales de la misma cita: distinto cuerpo, distinto
          // hash, las dos hay que procesarlas.
          const edit = await repo.record({
            action: "appointment_save",
            eaEntityId: 7,
            bodyHash: "b".repeat(64),
            receivedAt: at,
          });
          expect(edit.duplicate).toBe(false);
        },
        TEST_TIMEOUT,
      );

      it(
        "nunca deduplica cuerpos malformados entre sí",
        async () => {
          // `ea_entity_id` nulo, mismo hash: MySQL admite varios NULL en un
          // índice único, y eso es lo que queremos. Cada cuerpo roto merece su
          // propia fila, porque son las que se van a mirar a mano.
          const repo = repositories(db).webhookEvents;
          const at = new Date("2026-08-31T10:00:00");
          const input = {
            action: "appointment_save",
            eaEntityId: null,
            bodyHash: "c".repeat(64),
            receivedAt: at,
          };
          const a = await repo.record(input);
          const b = await repo.record(input);
          expect(a.duplicate).toBe(false);
          expect(b.duplicate).toBe(false);
          expect(b.id).not.toBe(a.id);
        },
        TEST_TIMEOUT,
      );

      it(
        "rechaza una regla de comisión con la unidad equivocada",
        async () => {
          // `percent` con monto fijo, o `fixed` con porcentaje. Es el CHECK que
          // reemplaza a una columna `value` con dos significados.
          await expect(
            db
              .insertInto("commission_rule")
              .values({
                applies_to: "ambos",
                kind: "percent",
                percent_bp: 1500,
                fixed_amount: 5000,
                valid_from: "2026-01-01",
              })
              .execute(),
          ).rejects.toThrow();

          await expect(
            db
              .insertInto("commission_rule")
              .values({
                applies_to: "ambos",
                kind: "fixed",
                percent_bp: 1500,
                valid_from: "2026-01-01",
              })
              .execute(),
          ).rejects.toThrow();

          // La buena pasa, y 1250 son 12,5 % — que un entero 0–100 no podría
          // expresar.
          await expect(
            db
              .insertInto("commission_rule")
              .values({
                applies_to: "principal",
                kind: "percent",
                percent_bp: 1250,
                valid_from: "2026-01-01",
              })
              .execute(),
          ).resolves.toBeTruthy();
        },
        TEST_TIMEOUT,
      );

      it(
        "rechaza una comisión con monto pero sin regla que la explique",
        async () => {
          // Cero sin regla es "cero marcado" y es válido. Un monto sin regla
          // sería plata que salió de la nada.
          const { itemId } = await seedClosedTicket(db);

          await expect(
            db
              .insertInto("commission_entry")
              .values({
                appointment_finance_item_id: itemId,
                ea_provider_id: 3,
                commission_rule_id: null,
                base_amount: 100_000,
                amount: 15_000,
                period_start: "2026-08-16",
                period_end: "2026-08-31",
              })
              .execute(),
          ).rejects.toThrow();

          await expect(
            db
              .insertInto("commission_entry")
              .values({
                appointment_finance_item_id: itemId,
                ea_provider_id: 3,
                commission_rule_id: null,
                base_amount: 100_000,
                amount: 0,
                period_start: "2026-08-16",
                period_end: "2026-08-31",
              })
              .execute(),
          ).resolves.toBeTruthy();
        },
        TEST_TIMEOUT,
      );

      it(
        "no deja borrar un renglón que ya tiene comisión calculada",
        async () => {
          // Después del cierre la cuenta se congela y las correcciones son
          // renglones nuevos. Un borrado ahí se llevaría plata liquidada por
          // delante, y el RESTRICT es lo que lo impide.
          const { itemId } = await seedClosedTicket(db);
          const ruleId = await repositories(db).commissionRules.insert({
            applies_to: "principal",
            kind: "percent",
            percent_bp: 1500,
            valid_from: "2026-01-01",
          });
          await repositories(db).commissionEntries.upsert({
            appointment_finance_item_id: itemId,
            ea_provider_id: 3,
            commission_rule_id: ruleId,
            base_amount: 100_000,
            rate_bp: 1500,
            amount: 15_000,
            period_start: "2026-08-16",
            period_end: "2026-08-31",
          });

          await expect(
            db
              .deleteFrom("appointment_finance_item")
              .where("id", "=", itemId)
              .execute(),
          ).rejects.toThrow();

          // Y tampoco la regla que la explica.
          await expect(
            db.deleteFrom("commission_rule").where("id", "=", ruleId).execute(),
          ).rejects.toThrow();
        },
        TEST_TIMEOUT,
      );

      it(
        "exige nota en un renglón manual",
        async () => {
          const { financeId } = await seedClosedTicket(db);
          await expect(
            db
              .insertInto("appointment_finance_item")
              .values({
                appointment_finance_id: financeId,
                kind: "manual",
                qty: 1,
                unit_price_snapshot: 0,
                line_total: 0,
                note: null,
              })
              .execute(),
          ).rejects.toThrow();

          // El retoque de garantía: cero pesos, con su nota. Queda contado en
          // ocupación y en la ficha de la clienta sin cobrar.
          await expect(
            db
              .insertInto("appointment_finance_item")
              .values({
                appointment_finance_id: financeId,
                kind: "manual",
                qty: 1,
                unit_price_snapshot: 0,
                line_total: 0,
                note: "Uña repuesta sin cobro",
              })
              .execute(),
          ).resolves.toBeTruthy();
        },
        TEST_TIMEOUT,
      );

      it(
        "devuelve las fechas de calendario como texto, no como instantes",
        async () => {
          // Un `DATE` convertido a `Date` queda a medianoche local, y en
          // America/Bogota eso es T05:00:00Z. Los cortes de quincena y la fecha
          // de cierre son calendario, no instantes: viajan como "YYYY-MM-DD" y
          // no se convierten nunca. El día que alguien quite `dateStrings` del
          // driver, este test lo dice.
          const id = await repositories(db).dayCloses.insert({
            close_date: "2026-08-31",
            total_efectivo: 450_000,
            total_transferencia: 320_000,
            total_otro: 0,
            total_tips: 25_000,
            appointment_count: 7,
            closed_by: OWNER_ID,
            closed_at: new Date("2026-08-31T20:15:00"),
          });
          const row = await repositories(db).dayCloses.findById(id);
          expect(row?.close_date).toBe("2026-08-31");
          expect(typeof row?.close_date).toBe("string");
          // El DATETIME sí vuelve como Date, en la zona del proceso.
          expect(row?.closed_at).toBeInstanceOf(Date);
        },
        TEST_TIMEOUT,
      );
    });

    // ── Los repositorios ───────────────────────────────────────────────────

    describe("repositorios", () => {
      beforeEach(async () => {
        await resetData(db);
        await seedOwner(db);
      }, TEST_TIMEOUT);

      it(
        "traen la agenda de un rango y solo las cuentas sin cerrar",
        async () => {
          const repo = repositories(db).appointmentFinance;
          await repo.ensure({
            ea_appointment_id: 1,
            ea_provider_id: 3,
            appointment_start_at: new Date("2026-08-30T09:00:00"),
            snapshot_source: "webhook",
          });
          const cerrada = await repo.ensure({
            ea_appointment_id: 2,
            ea_provider_id: 3,
            appointment_start_at: new Date("2026-08-31T11:00:00"),
            snapshot_source: "webhook",
          });
          await repo.ensure({
            ea_appointment_id: 3,
            ea_provider_id: 9,
            appointment_start_at: new Date("2026-08-31T14:00:00"),
            snapshot_source: "webhook",
          });
          await repo.update(cerrada.row.id, {
            closed_at: new Date("2026-08-31T12:30:00"),
            closed_by: OWNER_ID,
            amount_charged: 180_000,
          });

          const dia = await repo.listByStartRange(
            new Date("2026-08-31T00:00:00"),
            new Date("2026-09-01T00:00:00"),
          );
          expect(dia.map((r) => r.ea_appointment_id)).toEqual([2, 3]);

          const deUna = await repo.listByStartRange(
            new Date("2026-08-31T00:00:00"),
            new Date("2026-09-01T00:00:00"),
            { eaProviderId: 9 },
          );
          expect(deUna.map((r) => r.ea_appointment_id)).toEqual([3]);

          // La lista de pendientes de Caja: es la que el cierre diario tiene
          // que vaciar antes de dejar cerrar el día.
          const pendientes = await repo.listOpenInRange(
            new Date("2026-08-31T00:00:00"),
            new Date("2026-09-01T00:00:00"),
          );
          expect(pendientes.map((r) => r.ea_appointment_id)).toEqual([3]);
        },
        TEST_TIMEOUT,
      );

      it(
        "le dicen al reconcile qué citas ya conoce",
        async () => {
          const repo = repositories(db).appointmentFinance;
          await repo.ensure({ ea_appointment_id: 10, snapshot_source: "webhook" });
          await repo.ensure({ ea_appointment_id: 12, snapshot_source: "webhook" });

          const conocidas = await repo.findExistingEaIds([10, 11, 12, 13]);
          expect([...conocidas].sort((a, b) => a - b)).toEqual([10, 12]);
          expect(await repo.findExistingEaIds([])).toEqual(new Set());
        },
        TEST_TIMEOUT,
      );

      it(
        "reemplazan los renglones de una cuenta antes del cierre",
        async () => {
          const { financeId } = await seedClosedTicket(db);
          const items = repositories(db).appointmentFinanceItems;

          await items.replaceForFinance(financeId, [
            {
              kind: "servicio",
              ea_service_id: 5,
              pricing_id: "acrylic-sculpted",
              qty: 1,
              unit_price_snapshot: 180_000,
              line_total: 180_000,
            },
            {
              kind: "adicional",
              pricing_id: "design-per-nail",
              qty: 3,
              unit_price_snapshot: 8_000,
              line_total: 24_000,
            },
          ]);

          const rows = await items.listByFinanceId(financeId);
          expect(rows).toHaveLength(2);
          // El orden es estable: el prorrateo determinista del descuento
          // depende de que la lista llegue siempre igual.
          expect(rows.map((r) => r.kind)).toEqual(["servicio", "adicional"]);
          expect(rows[1].qty).toBe(3);
          expect(rows[1].line_total).toBe(24_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "congelan las cuentas del día bajo su cierre y marcan el push una sola vez",
        async () => {
          const { appointmentFinance, dayCloses } = repositories(db);
          const a = await appointmentFinance.ensure({
            ea_appointment_id: 20,
            appointment_start_at: new Date("2026-08-31T09:00:00"),
            snapshot_source: "webhook",
            amount_charged: 180_000,
          });
          const b = await appointmentFinance.ensure({
            ea_appointment_id: 21,
            appointment_start_at: new Date("2026-08-31T12:00:00"),
            snapshot_source: "webhook",
            amount_charged: 95_000,
          });

          const closeId = await dayCloses.insert({
            close_date: "2026-08-31",
            total_efectivo: 275_000,
            total_transferencia: 0,
            total_otro: 0,
            total_tips: 0,
            appointment_count: 2,
            closed_by: OWNER_ID,
            closed_at: new Date("2026-08-31T20:00:00"),
          });
          await appointmentFinance.attachToDayClose([a.row.id, b.row.id], closeId);

          expect(await appointmentFinance.listByDayClose(closeId)).toHaveLength(2);
          expect(await dayCloses.listPendingPush()).toHaveLength(1);

          const pushedAt = new Date("2026-08-31T20:05:00");
          await dayCloses.markPushed(closeId, pushedAt);
          await appointmentFinance.markPushed(closeId, pushedAt);

          expect(await dayCloses.listPendingPush()).toEqual([]);
          const rows = await appointmentFinance.listByDayClose(closeId);
          expect(rows.every((r) => r.pushed_to_ingest_at !== null)).toBe(true);
        },
        TEST_TIMEOUT,
      );

      it(
        "no dejan cerrar dos veces el mismo día",
        async () => {
          const { dayCloses } = repositories(db);
          const row = {
            close_date: "2026-08-31",
            total_efectivo: 0,
            total_transferencia: 0,
            total_otro: 0,
            total_tips: 0,
            appointment_count: 0,
            closed_by: OWNER_ID,
            closed_at: new Date("2026-08-31T20:00:00"),
          };
          await dayCloses.insert(row);
          await expect(dayCloses.insert(row)).rejects.toThrow();
        },
        TEST_TIMEOUT,
      );

      it(
        "traen las reglas vigentes con valid_to inclusivo",
        async () => {
          const { commissionRules } = repositories(db);
          await commissionRules.insert({
            applies_to: "principal",
            kind: "percent",
            percent_bp: 1000,
            valid_from: "2026-01-01",
            valid_to: "2026-08-15",
          });
          await commissionRules.insert({
            applies_to: "principal",
            kind: "percent",
            percent_bp: 1500,
            valid_from: "2026-08-16",
          });

          // Una regla que termina el 15 aplica al día 15 completo.
          const el15 = await commissionRules.listEffectiveOn("2026-08-15");
          expect(el15.map((r) => r.percent_bp)).toEqual([1000]);
          const el16 = await commissionRules.listEffectiveOn("2026-08-16");
          expect(el16.map((r) => r.percent_bp)).toEqual([1500]);

          // La quincena que cruza el cambio de tasa trae las dos: cada cita se
          // evalúa con la regla vigente ese día.
          const quincena = await commissionRules.listOverlappingPeriod(
            "2026-08-01",
            "2026-08-31",
          );
          expect(quincena).toHaveLength(2);
        },
        TEST_TIMEOUT,
      );

      it(
        "recalculan una quincena en borrador sin duplicar entradas",
        async () => {
          const { commissionEntries, commissionRules } = repositories(db);
          const { itemId } = await seedClosedTicket(db);
          const ruleId = await commissionRules.insert({
            applies_to: "principal",
            kind: "percent",
            percent_bp: 1000,
            valid_from: "2026-01-01",
          });

          const base = {
            appointment_finance_item_id: itemId,
            ea_provider_id: 3,
            commission_rule_id: ruleId,
            base_amount: 100_000,
            period_start: "2026-08-16",
            period_end: "2026-08-31",
          };
          expect(
            await commissionEntries.upsert({ ...base, rate_bp: 1000, amount: 10_000 }),
          ).toBe("inserted");
          expect(
            await commissionEntries.upsert({ ...base, rate_bp: 1500, amount: 15_000 }),
          ).toBe("updated");

          const entries = await commissionEntries.listByProviderAndPeriod(
            3,
            "2026-08-16",
            "2026-08-31",
          );
          expect(entries).toHaveLength(1);
          expect(entries[0].amount).toBe(15_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "reparten el mismo renglón entre dos técnicas sin chocar",
        async () => {
          // Un combo trabajado por dos: una las manos, otra los pies. Es por
          // esto que la UNIQUE incluye el provider y no es solo el renglón.
          const { commissionEntries, commissionRules } = repositories(db);
          const { itemId } = await seedClosedTicket(db);
          const ruleId = await commissionRules.insert({
            applies_to: "principal",
            kind: "percent",
            percent_bp: 1000,
            valid_from: "2026-01-01",
          });
          const base = {
            appointment_finance_item_id: itemId,
            commission_rule_id: ruleId,
            rate_bp: 1000,
            period_start: "2026-08-16",
            period_end: "2026-08-31",
          };
          await commissionEntries.upsert({
            ...base,
            ea_provider_id: 3,
            base_amount: 60_000,
            amount: 6_000,
          });
          await commissionEntries.upsert({
            ...base,
            ea_provider_id: 9,
            base_amount: 40_000,
            amount: 4_000,
          });

          expect(
            await commissionEntries.listByProviderAndPeriod(3, "2026-08-16", "2026-08-31"),
          ).toHaveLength(1);
          expect(
            await commissionEntries.listByProviderAndPeriod(9, "2026-08-16", "2026-08-31"),
          ).toHaveLength(1);
        },
        TEST_TIMEOUT,
      );

      it(
        "marcan el cero sin regla para que se vea en revisión",
        async () => {
          const { commissionEntries } = repositories(db);
          const { itemId } = await seedClosedTicket(db);
          await commissionEntries.upsert({
            appointment_finance_item_id: itemId,
            ea_provider_id: 3,
            commission_rule_id: null,
            base_amount: 100_000,
            rate_bp: null,
            amount: 0,
            period_start: "2026-08-16",
            period_end: "2026-08-31",
          });

          // Un cero silencioso es indistinguible de un cero correcto: esta
          // consulta es la que hace visible la diferencia.
          const sinRegla = await commissionEntries.listUnmatchedInPeriod(
            "2026-08-16",
            "2026-08-31",
          );
          expect(sinRegla).toHaveLength(1);
          expect(sinRegla[0].amount).toBe(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "no tocan una liquidación pagada ni sus entradas",
        async () => {
          const { commissionEntries, commissionRules, commissionRuns } =
            repositories(db);
          const { itemId } = await seedClosedTicket(db);
          const ruleId = await commissionRules.insert({
            applies_to: "principal",
            kind: "percent",
            percent_bp: 1000,
            valid_from: "2026-01-01",
          });
          await commissionEntries.upsert({
            appointment_finance_item_id: itemId,
            ea_provider_id: 3,
            commission_rule_id: ruleId,
            base_amount: 100_000,
            rate_bp: 1000,
            amount: 10_000,
            period_start: "2026-08-16",
            period_end: "2026-08-31",
          });

          const runId = await commissionRuns.insert({
            ea_provider_id: 3,
            period_start: "2026-08-16",
            period_end: "2026-08-31",
            total: 10_000,
          });
          const entradas = await commissionEntries.listByProviderAndPeriod(
            3,
            "2026-08-16",
            "2026-08-31",
          );
          await commissionEntries.attachToRun(
            entradas.map((e) => e.id),
            runId,
          );

          const actor = { userId: OWNER_ID, at: new Date("2026-09-01T09:00:00") };
          await commissionRuns.setStatus(runId, "revisada", actor);
          await commissionRuns.setStatus(runId, "pagada", actor);
          await commissionEntries.markPaidByRun(runId);

          // Nada se ajusta después de pagar. Así se trabaja hoy y el sistema lo
          // respalda en vez de pelearlo.
          await expect(
            commissionRuns.setStatus(runId, "borrador", actor),
          ).rejects.toBeInstanceOf(PaidCommissionRunError);
          await expect(
            commissionRuns.setDraftTotal(runId, 1),
          ).rejects.toThrow(/ya no se recalcula/);

          expect(
            await commissionEntries.upsert({
              appointment_finance_item_id: itemId,
              ea_provider_id: 3,
              commission_rule_id: ruleId,
              base_amount: 100_000,
              rate_bp: 9999,
              amount: 99_999,
              period_start: "2026-08-16",
              period_end: "2026-08-31",
            }),
          ).toBe("paid");

          const final = await commissionEntries.listByRun(runId);
          expect(final[0].amount).toBe(10_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "no dejan dos ids de vitrina apuntando al mismo servicio de EA",
        async () => {
          const { serviceMap } = repositories(db);
          await serviceMap.link("acrylic-sculpted", 5);
          await expect(serviceMap.link("acrylic-refill", 5)).rejects.toThrow();

          // Repuntar el mismo id de vitrina a otro servicio sí se puede: es lo
          // que pasa cuando se republica un servicio en EA.
          await serviceMap.link("acrylic-sculpted", 6);
          expect(
            (await serviceMap.findByPricingId("acrylic-sculpted"))?.ea_service_id,
          ).toBe(6);
          expect(await serviceMap.findByEaServiceId(5)).toBeUndefined();
        },
        TEST_TIMEOUT,
      );

      it(
        "importan el histórico de Agenda Pro dos veces sin duplicarlo",
        async () => {
          const { legacyAppointments } = repositories(db);
          const rows = [
            {
              source_id: "ap-1",
              started_at: new Date("2025-06-01T10:00:00"),
              client_phone_e164: "+573001112233",
              service_name: "Montaje acrílico",
              amount_charged: null,
            },
            {
              source_id: "ap-2",
              started_at: new Date("2025-07-15T15:00:00"),
              client_phone_e164: "+573001112233",
              service_name: "Retoque",
              amount_charged: null,
            },
          ];
          await legacyAppointments.insertIfAbsent(rows);
          await legacyAppointments.insertIfAbsent(rows);

          const all = await legacyAppointments.listByStartRange(
            new Date("2025-01-01T00:00:00"),
            new Date("2026-01-01T00:00:00"),
          );
          expect(all).toHaveLength(2);

          // "Clienta nueva" se responde sobre la unión EA + legacy, y esta es
          // la mitad de acá.
          expect(
            await legacyAppointments.firstVisitByPhone("+573001112233"),
          ).toEqual(new Date("2025-06-01T10:00:00"));
          expect(
            await legacyAppointments.firstVisitByPhone("+573009998877"),
          ).toBeUndefined();
        },
        TEST_TIMEOUT,
      );

      it(
        "guardan el antes y el después en la bitácora, y la dejan quieta",
        async () => {
          const { auditLog } = repositories(db);
          await auditLog.append({
            actorUserId: OWNER_ID,
            action: "ticket.close",
            entity: "appointment_finance",
            entityId: 42,
            after: { amount_charged: 180_000 },
            reason: null,
            at: new Date("2026-08-31T12:30:00"),
          });
          await auditLog.append({
            // `null` = el sistema. Es un valor legítimo, no un dato faltante.
            actorUserId: null,
            action: "ticket.snapshot",
            entity: "appointment_finance",
            entityId: 42,
            before: { service_price_snapshot: null },
            after: { service_price_snapshot: 180_000 },
            at: new Date("2026-08-31T08:00:00"),
          });

          const rastro = await auditLog.listForEntity("appointment_finance", 42);
          expect(rastro).toHaveLength(2);
          // Lo más nuevo arriba.
          expect(rastro[0].action).toBe("ticket.close");
          expect(rastro[0].before_json).toBeNull();
          expect(rastro[1].after_json).toEqual({ service_price_snapshot: 180_000 });
        },
        TEST_TIMEOUT,
      );

      it(
        "encuentran a una persona de la allowlist sin importar cómo escribió su correo",
        async () => {
          const { allowedUsers } = repositories(db);
          await allowedUsers.insert({
            email: "Duena@GoldenBeautyStudio.com.co",
            role: "owner",
          });
          const found = await allowedUsers.findByEmail(
            "  DUENA@goldenbeautystudio.com.co ",
          );
          expect(found?.role).toBe("owner");
          expect(found?.email).toBe("duena@goldenbeautystudio.com.co");
        },
        TEST_TIMEOUT,
      );

      it(
        "re-enrolar a una técnica borra el step consumido del secreto viejo",
        async () => {
          // El step pertenecía al secreto anterior; sobre el nuevo no significa
          // nada, y dejarlo bloquearía un código legítimo.
          const { staffTotp } = repositories(db);
          await db
            .insertInto("user")
            .values({
              id: "usr_tecnica_000000000000000000000",
              name: "Técnica",
              email: "tecnica@example.com",
              emailVerified: 1,
            })
            .execute();

          await staffTotp.enroll(
            "usr_tecnica_000000000000000000000",
            Buffer.from("secreto-viejo-cifrado"),
          );
          await staffTotp.confirm(
            "usr_tecnica_000000000000000000000",
            new Date("2026-08-01T10:00:00"),
            58_000_000,
          );
          await staffTotp.recordFailure("usr_tecnica_000000000000000000000", {
            failedAttempts: 4,
            firstFailedAt: new Date("2026-08-31T10:00:00"),
            lockedUntil: null,
          });

          await staffTotp.enroll(
            "usr_tecnica_000000000000000000000",
            Buffer.from("secreto-nuevo-cifrado"),
          );
          const row = await staffTotp.findByUserId(
            "usr_tecnica_000000000000000000000",
          );
          expect(row?.confirmed_at).toBeNull();
          expect(row?.last_used_step).toBeNull();
          expect(row?.failed_attempts).toBe(0);
          expect(row?.first_failed_at).toBeNull();
          expect(row?.secret_encrypted.toString()).toBe("secreto-nuevo-cifrado");
        },
        TEST_TIMEOUT,
      );
    });
  },
);

// ── Utilidades del fixture ───────────────────────────────────────────────────

/**
 * Vacía los datos entre tests, dejando el esquema y la siembra de `station`.
 *
 * Se apagan las FKs para no tener que mantener el orden de borrado sincronizado
 * con el grafo de dependencias: es un fixture de test, no una operación de
 * producción, y un orden mal mantenido acá se manifestaría como tests que
 * fallan por el motivo equivocado.
 */
async function resetData(db: Kysely<Database>): Promise<void> {
  const tables = [
    "commission_entry",
    "commission_run",
    "commission_rule",
    "appointment_finance_item",
    "appointment_finance",
    "day_close",
    "webhook_event",
    "audit_log",
    "combo",
    "service_map",
    "staff_totp",
    "legacy_appointment",
    "allowed_user",
    "session",
    "account",
    "verification",
    "user",
  ];
  await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
  for (const table of tables) {
    await sql.raw(`TRUNCATE TABLE \`${table}\``).execute(db);
  }
  await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
}

/** La dueña. Existe porque `closed_by` y `closed_at` tienen FK hacia `user`. */
async function seedOwner(db: Kysely<Database>): Promise<void> {
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
 * Una cuenta cerrada con un renglón de servicio, que es el fixture del que
 * cuelgan casi todas las pruebas de comisión.
 */
async function seedClosedTicket(
  db: Kysely<Database>,
): Promise<{ financeId: number; itemId: number }> {
  const { appointmentFinance, appointmentFinanceItems } = repositories(db);
  const { row } = await appointmentFinance.ensure({
    ea_appointment_id: 900,
    ea_provider_id: 3,
    appointment_start_at: new Date("2026-08-20T10:00:00"),
    booked_service_id: 5,
    performed_service_id: 5,
    service_price_snapshot: 100_000,
    snapshot_source: "webhook",
    amount_charged: 100_000,
    closed_by: OWNER_ID,
    closed_at: new Date("2026-08-20T12:00:00"),
    paid_at: new Date("2026-08-20T12:00:00"),
    payment_method: "efectivo",
  });
  await appointmentFinanceItems.insertMany([
    {
      appointment_finance_id: row.id,
      kind: "servicio",
      ea_service_id: 5,
      pricing_id: "acrylic-sculpted",
      qty: 1,
      unit_price_snapshot: 100_000,
      line_total: 100_000,
    },
  ]);
  const items = await appointmentFinanceItems.listByFinanceId(row.id);
  return { financeId: row.id, itemId: items[0].id };
}
