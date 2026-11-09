import { sql, type Kysely } from "kysely";
import type { Pool } from "mysql2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDb, createPool, repositories, runMigrations, type Database } from "@/db";
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
  type EaLocalDate,
  type EaLocalDateTime,
} from "@/lib/ea";
import { IngestError, toStrapiPayment, type IngestClient } from "@/lib/ingest-client";
import type { IngestPayment } from "@/lib/ingest-payload";

import {
  recordAdjustment,
  recordEditAdjustment,
  retryAdjustmentPush,
  retryDayPush,
  syncDay,
  type DayAppointment,
  type DayCloseDeps,
} from "./day-close";
import { runNightlySync, summarizeNightlySync } from "./nightly-sync";

/**
 * Capa 2 de C3: la sincronización de la caja contra un **MySQL real**.
 *
 * Lo que se verifica acá no se puede verificar con un doble del driver, porque
 * lo que decide es la base:
 *
 * - **Sin compuerta.** Que lo cobrado viaje aunque quede una cita sin cobrar o
 *   una cuenta sin método, y que lo incompleto se quede afuera sin frenar al
 *   resto.
 * - **La idempotencia.** `uq_day_close_date` es lo que hace que un día tenga
 *   una sola fila aunque se sincronice dos veces a la vez; sin un MySQL de
 *   verdad, "no duplica" sería una afirmación sobre un `if`. Y el push tampoco
 *   se repite, porque la marca `pushed_to_ingest_at` es una columna.
 * - **El camino de ajuste.** Que una corrección posterior al cierre entre como
 *   renglón nuevo con su propio `imported_id` —nunca reescribiendo el
 *   original— y que reintentar su push mande **el mismo** id y no el siguiente.
 *
 * Cada archivo de test corre en su propio proceso, así que este levanta su
 * propio contenedor. `startEphemeralMysql()` publica con `0:3306` y le pregunta
 * a Docker el puerto, justamente para que dos suites en paralelo no choquen.
 */

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;

const OWNER_ID = "usr_owner_0000000000000000000000";
const DIA: EaLocalDate = parseEaLocalDate("2026-09-03");

function dt(value: string): EaLocalDateTime {
  return parseEaLocalDateTime(value);
}

/** Las 8 p. m. del día del estudio. Después de la última cita. */
const OCHO_PM = eaLocalToInstant(dt("2026-09-03 20:00:00"));

// ── Doble del CRM ────────────────────────────────────────────────────────────

type IngestEstado = {
  /** Todos los lotes que se le mandaron, en orden. */
  lotes: IngestPayment[][];
  /** Qué hace el próximo push. */
  modo: "ok" | "caido" | "rechaza";
};

function fakeIngest(estado: IngestEstado): IngestClient {
  return {
    async push(payments) {
      if (estado.modo === "caido") {
        throw new IngestError("el CRM no responde", { retryable: true });
      }
      if (estado.modo === "rechaza") {
        throw new IngestError("cuerpo inválido", { retryable: false, status: 400 });
      }
      estado.lotes.push([...payments]);
      return { sent: payments.length, status: 200, at: new Date() };
    },
  };
}

/**
 * Los `tx_id` que el CRM recibió, en orden de llegada.
 *
 * Se pasan por `toStrapiPayment()` a propósito: `tx_id` es la llave UNIQUE de
 * `Payment` y de la que `actual-sync` deriva el `imported_id` de Actual Budget,
 * así que es **la identidad que de verdad llega afuera**. Afirmar sobre el
 * `imported_id` interno de B1 dejaría la traducción sin cubrir justo acá, que es
 * donde se ve el efecto de un ajuste con la llave equivocada.
 */
function idsRecibidos(estado: IngestEstado): string[] {
  return estado.lotes.flat().map((p) => toStrapiPayment(p).tx_id);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function cita(over: Partial<DayAppointment> & { eaAppointmentId: number }): DayAppointment {
  return {
    status: "Completada",
    start: dt("2026-09-03 09:00:00"),
    end: dt("2026-09-03 10:30:00"),
    customerName: "Marcela",
    providerName: "Lina",
    ...over,
  };
}

// ── La suite ─────────────────────────────────────────────────────────────────

describe.skipIf(!canRunDbTests())(
  `cierre diario contra MySQL real${skipReason() ? ` (saltado: ${skipReason()})` : ""}`,
  () => {
    let container: EphemeralMysql;
    let pool: Pool;
    let db: Kysely<Database>;
    let ingest: IngestEstado;

    /** Las dependencias del cierre, con el día de citas que pida el test. */
    const deps = (
      appointments: readonly DayAppointment[],
      conIngest = true,
    ): DayCloseDeps => ({
      db,
      loadAppointments: async () => appointments,
      ingest: conIngest ? fakeIngest(ingest) : null,
    });

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
      ingest = { lotes: [], modo: "ok" };
      await limpiar(db);
      await sembrarDuena(db);
    }, TEST_TIMEOUT);

    // ── La compuerta ───────────────────────────────────────────────────────

    describe("sincronizar un día", () => {
      it(
        "manda lo cobrado aunque quede una cita sin cobrar, y crea el cierre solo",
        async () => {
          // Lo que la compuerta impedía: una cita sin cuenta ya no retiene la
          // plata de las demás.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
          await sembrarCuenta(db, {
            eaAppointmentId: 2,
            cerrada: true,
            monto: 240_000,
            metodo: "transferencia",
            propina: 20_000,
          });
          await sembrarCuenta(db, { eaAppointmentId: 3, cerrada: false });

          const result = await syncDay(deps([]), { date: DIA, now: OCHO_PM });

          expect(result.state).toBe("sincronizado");
          if (result.state !== "sincronizado") throw new Error("debería haber sincronizado");
          expect(result.attached).toBe(2);
          expect(result.push.state).toBe("hecho");

          const [cierre] = await cierres(db);
          expect(cierre).toMatchObject({
            close_date: DIA,
            total_efectivo: 180_000,
            total_transferencia: 240_000,
            total_otro: 0,
            total_tips: 20_000,
            appointment_count: 2,
            // Nadie lo firmó: lo armó la sincronización.
            closed_by: null,
          });
          expect(cierre.pushed_to_ingest_at).toBeInstanceOf(Date);

          const filas = await cuentas(db);
          expect(filas.find((f) => f.ea_appointment_id === 3)?.day_close_id).toBeNull();
          expect(
            filas.filter((f) => f.ea_appointment_id !== 3).every((f) => f.pushed_to_ingest_at !== null),
          ).toBe(true);
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1", "ea-appt:2"]);
        },
        TEST_TIMEOUT,
      );

      it(
        "una cuenta sin método de pago se salta sola y no frena a las demás",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
          await sembrarCuenta(db, { eaAppointmentId: 2, cerrada: true, monto: 90_000, metodo: null });

          const result = await syncDay(deps([]), { date: DIA, now: OCHO_PM });

          expect(result.state).toBe("sincronizado");
          expect(result.skipped).toEqual([
            { eaAppointmentId: 2, message: "Falta el método de pago" },
          ]);
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1"]);
          const filas = await cuentas(db);
          expect(filas.find((f) => f.ea_appointment_id === 2)?.day_close_id).toBeNull();
        },
        TEST_TIMEOUT,
      );

      it(
        "un día sin nada cobrado no crea cierre ni manda nada",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: false });

          const result = await syncDay(deps([]), { date: DIA, now: OCHO_PM });

          expect(result.state).toBe("nada");
          expect(await cierres(db)).toHaveLength(0);
          expect(ingest.lotes).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "no necesita la agenda: con EA caído sincroniza igual",
        async () => {
          // Antes, sin EA no se cerraba el día. La plata está en `gbs_admin`, y
          // mandar lo cobrado no depende de saber qué más hubo.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });

          const result = await syncDay(
            {
              db,
              loadAppointments: () => Promise.reject(new Error("EA no responde")),
              ingest: fakeIngest(ingest),
            },
            { date: DIA, now: OCHO_PM },
          );

          expect(result.state).toBe("sincronizado");
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1"]);
        },
        TEST_TIMEOUT,
      );
    });

    // ── Idempotencia ───────────────────────────────────────────────────────

    describe("sincronizar dos veces", () => {
      it(
        "no duplica el cierre, ni los totales, ni el push",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
          const input = { date: DIA, now: OCHO_PM };

          const primero = await syncDay(deps([]), input);
          const segundo = await syncDay(deps([]), input);

          expect(primero.state).toBe("sincronizado");
          expect(segundo.state).toBe("nada");
          const filas = await cierres(db);
          expect(filas).toHaveLength(1);
          expect(filas[0].total_efectivo).toBe(180_000);
          expect(filas[0].appointment_count).toBe(1);
          expect(ingest.lotes).toHaveLength(1);
        },
        TEST_TIMEOUT,
      );

      it(
        "dos sincronizaciones concurrentes dejan una sola fila",
        async () => {
          // La nocturna y un "Sincronizar ahora" a la vez. La idempotencia la
          // cuida `uq_day_close_date`: la que pierde el INSERT vuelve a
          // empezar y encuentra la fila de la otra.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });

          const results = await Promise.all([
            syncDay(deps([]), { date: DIA, now: OCHO_PM }),
            syncDay(deps([]), { date: DIA, now: OCHO_PM }),
          ]);

          expect(results.some((r) => r.state === "sincronizado")).toBe(true);
          const filas = await cierres(db);
          expect(filas).toHaveLength(1);
          expect(filas[0].total_efectivo).toBe(180_000);
          expect(filas[0].appointment_count).toBe(1);
          // Los `tx_id` son los mismos en cualquier caso: aunque las dos
          // llamadas llegaran a mandar, Strapi y Actual deduplican por ellos.
          expect(new Set(idsRecibidos(ingest))).toEqual(new Set(["ea-appt:1"]));
        },
        TEST_TIMEOUT,
      );

      it(
        "si el push falla, la cuenta queda en el cierre y la siguiente corrida la manda",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
          ingest.modo = "caido";

          const result = await syncDay(deps([]), { date: DIA, now: OCHO_PM });
          expect(result.state === "sincronizado" && result.push).toMatchObject({
            state: "fallo",
            retryable: true,
          });
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeNull();

          const pendientes = await repositories(db).dayCloses.listPendingPush();
          expect(pendientes.map((p) => p.close_date)).toEqual([DIA]);

          ingest.modo = "ok";
          const reintento = await syncDay(deps([]), { date: DIA, now: OCHO_PM });
          expect(reintento.state === "sincronizado" && reintento.push.state).toBe("hecho");
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1"]);
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeInstanceOf(Date);
        },
        TEST_TIMEOUT,
      );

      it(
        "con el push apagado las cuentas quedan listas y pendientes",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });

          const result = await syncDay(deps([], false), { date: DIA, now: OCHO_PM });

          expect(result.state === "sincronizado" && result.push.state).toBe("apagado");
          expect(await cierres(db)).toHaveLength(1);
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeNull();
        },
        TEST_TIMEOUT,
      );

      it(
        "una fila que ya no puede viajar frena el push sin marcarlo",
        async () => {
          // La fila se puede corromper **después** de entrar al cierre (una
          // edición por SQL, un bug de otra pantalla). El lote se arma desde la
          // base, así que el push tiene que fallar antes de mandar nada.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
          await syncDay(deps([], false), { date: DIA, now: OCHO_PM });

          const [congelada] = await db
            .selectFrom("appointment_finance")
            .select("id")
            .where("ea_appointment_id", "=", 1)
            .execute();
          await db
            .deleteFrom("appointment_payment")
            .where("appointment_finance_id", "=", congelada.id)
            .execute();

          const outcome = await retryDayPush(deps([]), { date: DIA, now: OCHO_PM });

          expect(outcome).toMatchObject({ state: "fallo", retryable: false });
          expect(ingest.lotes).toHaveLength(0);
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeNull();
        },
        TEST_TIMEOUT,
      );

      it(
        "un error que no es del CRM se propaga en vez de disfrazarse de push fallido",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });

          await expect(
            syncDay(
              {
                db,
                loadAppointments: async () => [],
                ingest: { push: () => Promise.reject(new TypeError("bug nuestro")) },
              },
              { date: DIA, now: OCHO_PM },
            ),
          ).rejects.toThrow(TypeError);

          // Las cuentas ya quedaron en el cierre y sin marca de push: la
          // siguiente corrida lo reintenta.
          expect(await cierres(db)).toHaveLength(1);
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeNull();
        },
        TEST_TIMEOUT,
      );

      it(
        "reintentar un día sin cierre no inventa uno",
        async () => {
          const outcome = await retryDayPush(deps([]), { date: DIA, now: OCHO_PM });
          expect(outcome.state).toBe("sin-cierre");
          expect(await cierres(db)).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );
    });

    // ── La sesión que se olvidó ────────────────────────────────────────────

    describe("la cuenta que se cobró después de sincronizar", () => {
      /** Día sincronizado con una cuenta de $180.000 en efectivo. */
      async function diaSincronizado(): Promise<void> {
        await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
        await syncDay(deps([]), { date: DIA, now: OCHO_PM });
        ingest.lotes = [];
      }

      it(
        "entra al cierre del día, suma a sus totales y viaja sola",
        async () => {
          await diaSincronizado();
          // La sesión que se olvidó y se cobró días después, desde Hoy.
          await sembrarCuenta(db, {
            eaAppointmentId: 2,
            cerrada: true,
            monto: 90_000,
            metodo: "transferencia",
            propina: 5_000,
            hora: "15:00:00",
          });

          const result = await syncDay(deps([]), { date: DIA, now: OCHO_PM });

          expect(result.state === "sincronizado" && result.attached).toBe(1);
          expect(result.state === "sincronizado" && result.push.state).toBe("hecho");
          // Solo la nueva: la original ya había salido, y re-mandarla pisaría
          // su monto en Strapi si tuvo un ajuste.
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:2"]);

          const [cierre] = await cierres(db);
          expect(cierre.total_efectivo).toBe(180_000);
          expect(cierre.total_transferencia).toBe(90_000);
          expect(cierre.total_tips).toBe(5_000);
          expect(cierre.appointment_count).toBe(2);
          expect(cierre.pushed_to_ingest_at).not.toBeNull();

          const filas = await cuentas(db);
          expect(filas.every((f) => f.day_close_id === cierre.id)).toBe(true);
          expect(filas.every((f) => f.pushed_to_ingest_at !== null)).toBe(true);
        },
        TEST_TIMEOUT,
      );

      it(
        "si el CRM no contesta, el cierre vuelve a la cola y el reintento manda solo la nueva",
        async () => {
          await diaSincronizado();
          await sembrarCuenta(db, { eaAppointmentId: 2, cerrada: true, monto: 90_000, hora: "15:00:00" });

          ingest.modo = "caido";
          const result = await syncDay(deps([]), { date: DIA, now: OCHO_PM });
          expect(result.state === "sincronizado" && result.push.state).toBe("fallo");

          const pendientes = await repositories(db).dayCloses.listPendingPush();
          expect(pendientes.map((c) => c.close_date)).toEqual([DIA]);

          ingest.modo = "ok";
          const retry = await retryDayPush(deps([]), { date: DIA, now: OCHO_PM });
          expect(retry.state).toBe("hecho");
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:2"]);
        },
        TEST_TIMEOUT,
      );
    });

    // ── La corrección desde Hoy de una cuenta que ya viajó ─────────────────

    describe("corregir una cuenta que ya llegó a Actual", () => {
      it(
        "deja la diferencia como ajuste y la sincronización la manda con llave propia",
        async () => {
          const financeId = await sembrarCuenta(db, {
            eaAppointmentId: 1,
            cerrada: true,
            monto: 180_000,
          });
          await syncDay(deps([]), { date: DIA, now: OCHO_PM });
          ingest.lotes = [];

          // Lo que hace Hoy al guardar: la cuenta con su nuevo monto y, en la
          // misma transacción, el ajuste por la diferencia.
          await db.transaction().execute(async (trx) => {
            await repositories(trx).appointmentFinance.update(financeId, { amount_charged: 200_000 });
            await trx
              .updateTable("appointment_payment")
              .set({ amount: 200_000 })
              .where("appointment_finance_id", "=", financeId)
              .execute();
            await recordEditAdjustment(trx, {
              financeId,
              before: 180_000,
              after: 200_000,
              actorUserId: OWNER_ID,
              now: OCHO_PM,
            });
          });

          const outcome = await retryAdjustmentPush(deps([]), { eaAppointmentId: 1, now: OCHO_PM });
          expect(outcome.state).toBe("hecho");
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1:adj1"]);
          expect(ingest.lotes[0][0].amount).toBe(20_000);

          // Reintentar no lo vuelve a mandar.
          const otra = await retryAdjustmentPush(deps([]), { eaAppointmentId: 1, now: OCHO_PM });
          expect(otra.state).toBe("vacio");
        },
        TEST_TIMEOUT,
      );

      it(
        "sin cambio de monto no deja ajuste",
        async () => {
          const financeId = await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
          const sequence = await recordEditAdjustment(db, {
            financeId,
            before: 180_000,
            after: 180_000,
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });
          expect(sequence).toBeNull();
        },
        TEST_TIMEOUT,
      );
    });

    // ── La noche ───────────────────────────────────────────────────────────

    describe("la sincronización de la noche", () => {
      const NOCHE = eaLocalToInstant(dt("2026-09-06 03:45:00"));
      const env = { INGEST_SINCE: "2026-09-01" };

      it(
        "sincroniza cada día anterior con plata nueva, deja hoy quieto y no repite",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 100_000, fecha: "2026-09-03" });
          await sembrarCuenta(db, { eaAppointmentId: 2, cerrada: true, monto: 50_000, fecha: "2026-09-05" });
          await sembrarCuenta(db, { eaAppointmentId: 3, cerrada: false, fecha: "2026-09-05" });
          // Hoy: todavía se puede corregir gratis, no se manda.
          await sembrarCuenta(db, { eaAppointmentId: 4, cerrada: true, monto: 70_000, fecha: "2026-09-06" });
          // Antes del corte: entró por Agenda Pro, no se manda nunca.
          await sembrarCuenta(db, { eaAppointmentId: 5, cerrada: true, monto: 90_000, fecha: "2026-08-30" });

          const report = await runNightlySync(deps([]), { env, now: NOCHE });

          expect(report.days.map((day) => day.date)).toEqual(["2026-09-03", "2026-09-05"]);
          expect(idsRecibidos(ingest).sort()).toEqual(["ea-appt:1", "ea-appt:2"]);
          expect(summarizeNightlySync(report)).toContain("2 cuenta(s) en 2 día(s)");

          // La segunda corrida de la misma noche no encuentra nada.
          const otra = await runNightlySync(deps([]), { env, now: NOCHE });
          expect(otra.days).toEqual([]);
          expect(ingest.lotes).toHaveLength(2);
        },
        TEST_TIMEOUT,
      );

      it(
        "la sesión olvidada que se cobra días después sale la noche siguiente",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 100_000, fecha: "2026-09-03" });
          await runNightlySync(deps([]), { env, now: NOCHE });
          ingest.lotes = [];

          await sembrarCuenta(db, { eaAppointmentId: 2, cerrada: true, monto: 60_000, fecha: "2026-09-03", hora: "15:00:00" });
          const report = await runNightlySync(deps([]), {
            env,
            now: eaLocalToInstant(dt("2026-09-08 03:45:00")),
          });

          expect(report.days.map((day) => day.date)).toEqual(["2026-09-03"]);
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:2"]);
          const [cierre] = await cierres(db);
          expect(cierre.total_efectivo).toBe(160_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "manda el ajuste de una cuenta corregida desde Hoy después de viajar",
        async () => {
          const financeId = await sembrarCuenta(db, {
            eaAppointmentId: 1,
            cerrada: true,
            monto: 100_000,
            fecha: "2026-09-03",
          });
          await runNightlySync(deps([]), { env, now: NOCHE });
          ingest.lotes = [];

          await db.transaction().execute(async (trx) => {
            await repositories(trx).appointmentFinance.update(financeId, { amount_charged: 90_000 });
            await trx
              .updateTable("appointment_payment")
              .set({ amount: 90_000 })
              .where("appointment_finance_id", "=", financeId)
              .execute();
            await recordEditAdjustment(trx, {
              financeId,
              before: 100_000,
              after: 90_000,
              actorUserId: OWNER_ID,
              now: NOCHE,
            });
          });

          const report = await runNightlySync(deps([]), {
            env,
            now: eaLocalToInstant(dt("2026-09-07 03:45:00")),
          });
          expect(report.adjustments).toMatchObject([{ eaAppointmentId: 1, outcome: { state: "hecho" } }]);
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1:adj1"]);
          expect(ingest.lotes[0][0].amount).toBe(-10_000);

          // Y no lo vuelve a mandar.
          ingest.lotes = [];
          const otra = await runNightlySync(deps([]), {
            env,
            now: eaLocalToInstant(dt("2026-09-08 03:45:00")),
          });
          expect(otra.adjustments).toEqual([]);
          expect(ingest.lotes).toEqual([]);
        },
        TEST_TIMEOUT,
      );
    });

    describe("el ajuste posterior al cierre", () => {
      /** Cierra el día con una cuenta de $180.000 ya empujada. */
      async function diaCerrado(): Promise<number> {
        const financeId = await sembrarCuenta(db, {
          eaAppointmentId: 1,
          cerrada: true,
          monto: 180_000,
        });
        await syncDay(deps([cita({ eaAppointmentId: 1 })]), { date: DIA, now: OCHO_PM });
        ingest.lotes = [];
        return financeId;
      }

      it(
        "entra como renglón nuevo con id propio, sin reescribir el original",
        async () => {
          const financeId = await diaCerrado();

          const result = await recordAdjustment(deps([]), {
            eaAppointmentId: 1,
            delta: 20_000,
            reason: "se cobró un diseño más",
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("el ajuste debería haber entrado");
          expect(result.sequence).toBe(1);
          expect(result.amountCharged).toBe(200_000);
          expect(result.push.state).toBe("hecho");

          // El `tx_id` es nuevo. Reusar `ea-appt:1` haría que el upsert de
          // Strapi pisara el pago original, y Actual se quedaría con un solo
          // movimiento por la cifra del ajuste.
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1:adj1"]);
          const [pago] = ingest.lotes[0];
          // Y viaja **el delta**, no el total nuevo: Actual lo suma al que ya
          // tiene. Mandar 200.000 duplicaría el ingreso de esa cita.
          expect(pago.amount).toBe(20_000);
          // La propina no se re-empuja con el ajuste.
          expect(pago.tip).toBe(0);

          const renglones = await repositories(db).appointmentFinanceItems.listByFinanceId(
            financeId,
          );
          const ajuste = renglones.at(-1);
          expect(ajuste).toMatchObject({
            kind: "manual",
            // El signo vive en el precio unitario, no en la cantidad.
            qty: 1,
            unit_price_snapshot: 20_000,
            line_total: 20_000,
            note: "se cobró un diseño más",
          });

          const filas = await cuentas(db);
          expect(filas[0].amount_charged).toBe(200_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "un ajuste negativo es un movimiento válido",
        async () => {
          await diaCerrado();

          const result = await recordAdjustment(deps([]), {
            eaAppointmentId: 1,
            delta: -30_000,
            reason: "cortesía que no se había registrado",
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok && result.amountCharged).toBe(150_000);
          expect(ingest.lotes[0][0].amount).toBe(-30_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "el segundo ajuste de la misma cuenta es adj2, no otro adj1",
        async () => {
          await diaCerrado();
          const base = {
            eaAppointmentId: 1,
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          };

          await recordAdjustment(deps([]), { ...base, delta: 20_000, reason: "un diseño" });
          const segundo = await recordAdjustment(deps([]), {
            ...base,
            delta: 5_000,
            reason: "otro diseño",
          });

          expect(segundo.ok && segundo.sequence).toBe(2);
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1:adj1", "ea-appt:1:adj2"]);
          expect(segundo.ok && segundo.amountCharged).toBe(205_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "reintentar un ajuste manda el MISMO id, no el siguiente",
        async () => {
          // Es la trampa que este camino existe para no caer: si el reintento
          // recalculara la secuencia sumando uno, mandaría `adj2` por una
          // corrección que ya era `adj1`. Y si el primer intento sí había
          // llegado —un timeout con la respuesta perdida— Actual cobraría la
          // misma corrección dos veces.
          await diaCerrado();
          ingest.modo = "caido";

          const result = await recordAdjustment(deps([]), {
            eaAppointmentId: 1,
            delta: 20_000,
            reason: "un diseño más",
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });

          // El renglón quedó escrito; lo que no salió es el movimiento.
          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("el ajuste debería haber entrado");
          expect(result.push).toMatchObject({ state: "fallo", retryable: true });
          expect(ingest.lotes).toHaveLength(0);

          ingest.modo = "ok";
          const reintento = await retryAdjustmentPush(deps([]), {
            eaAppointmentId: 1,
            now: OCHO_PM,
          });

          expect(reintento.state).toBe("hecho");
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1:adj1"]);

          // Y reintentar otra vez no manda nada: ya hay constancia de push.
          const otra = await retryAdjustmentPush(deps([]), {
            eaAppointmentId: 1,
            now: OCHO_PM,
          });
          expect(otra.state).toBe("vacio");
          expect(ingest.lotes).toHaveLength(1);
        },
        TEST_TIMEOUT,
      );

      it(
        "un ajuste sobre una cuenta que no entró a ningún cierre se rechaza",
        async () => {
          // Antes del cierre la corrección es una edición normal del ticket, y
          // ésa la hace "Cerrar servicio" desde Hoy. Dos formas de cambiar la
          // misma cifra, una sin el rastro de la otra, es cómo se desincroniza.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });

          const result = await recordAdjustment(deps([]), {
            eaAppointmentId: 1,
            delta: 10_000,
            reason: "un diseño",
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(false);
          if (result.ok) throw new Error("no debería haber entrado");
          expect(result.reason).toBe("sin-cierre");
          expect(ingest.lotes).toHaveLength(0);
          expect((await cuentas(db))[0].amount_charged).toBe(180_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "un ajuste de cero no se registra",
        async () => {
          await diaCerrado();

          const result = await recordAdjustment(deps([]), {
            eaAppointmentId: 1,
            delta: 0,
            reason: "nada",
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(false);
          if (result.ok) throw new Error("no debería haber entrado");
          expect(result.reason).toBe("cero");
          expect(ingest.lotes).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "un ajuste sin motivo no se registra: el CHECK de la base lo exige",
        async () => {
          await diaCerrado();

          const result = await recordAdjustment(deps([]), {
            eaAppointmentId: 1,
            delta: 10_000,
            reason: "   ",
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(false);
          expect(ingest.lotes).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "un ajuste que no puede viajar no deja un renglón escrito",
        async () => {
          // El movimiento se arma **antes** de escribir. Si no se puede armar
          // —acá, una fila congelada a la que alguien le borró el método— no
          // puede quedar un renglón en la base que nadie va a poder conciliar
          // contra Actual Budget.
          await diaCerrado();
          // Se le quita el método a la fila ya congelada. Hay que borrar el
          // pago, no vaciar la columna del encabezado: la columna es un shim de
          // rollback y nadie la lee.
          const [congelada] = await db
            .selectFrom("appointment_finance")
            .select("id")
            .where("ea_appointment_id", "=", 1)
            .execute();
          await db
            .deleteFrom("appointment_payment")
            .where("appointment_finance_id", "=", congelada.id)
            .execute();

          const antes = await renglones(db);

          const result = await recordAdjustment(deps([]), {
            eaAppointmentId: 1,
            delta: 10_000,
            reason: "un diseño",
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(false);
          if (result.ok) throw new Error("no debería haber entrado");
          expect(result.reason).toBe("lote");
          expect(await renglones(db)).toHaveLength(antes.length);
          expect((await cuentas(db))[0].amount_charged).toBe(180_000);
          expect(ingest.lotes).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "un error que no es del CRM se propaga al empujar un ajuste",
        async () => {
          await diaCerrado();

          await expect(
            recordAdjustment(
              {
                db,
                loadAppointments: async () => [],
                ingest: { push: () => Promise.reject(new TypeError("bug nuestro")) },
              },
              {
                eaAppointmentId: 1,
                delta: 10_000,
                reason: "un diseño",
                actorUserId: OWNER_ID,
                now: OCHO_PM,
              },
            ),
          ).rejects.toThrow(TypeError);

          // El renglón ya está escrito: el reintento es el camino, nunca un
          // ajuste nuevo.
          expect((await cuentas(db))[0].amount_charged).toBe(190_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "un ajuste sobre una cita sin cuenta se rechaza",
        async () => {
          const result = await recordAdjustment(deps([]), {
            eaAppointmentId: 999,
            delta: 10_000,
            reason: "un diseño",
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(false);
          if (result.ok) throw new Error("no debería haber entrado");
          expect(result.reason).toBe("sin-cuenta");
        },
        TEST_TIMEOUT,
      );

      it(
        "si el CRM rechaza el ajuste, el renglón sigue escrito y el fallo es definitivo",
        async () => {
          await diaCerrado();
          ingest.modo = "rechaza";

          const result = await recordAdjustment(deps([]), {
            eaAppointmentId: 1,
            delta: 10_000,
            reason: "un diseño",
            actorUserId: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("el ajuste debería haber entrado");
          // Definitivo: un 400 reintentado cada minuto es un contrato
          // equivocado que nadie va a ver.
          expect(result.push).toMatchObject({ state: "fallo", retryable: false });
          expect((await cuentas(db))[0].amount_charged).toBe(190_000);
        },
        TEST_TIMEOUT,
      );
    });
  },
);

// ── Helpers de base ──────────────────────────────────────────────────────────

async function limpiar(db: Kysely<Database>): Promise<void> {
  const tablas = [
    "appointment_finance_item",
    "appointment_finance",
    "day_close",
    "audit_log",
    "user",
  ];
  await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
  for (const tabla of tablas) {
    await sql.raw(`TRUNCATE TABLE \`${tabla}\``).execute(db);
  }
  await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
}

/** `day_close.closed_by` tiene FK hacia `user`. */
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
 * Una cuenta del día, cerrada o no.
 *
 * Se escribe con el repositorio y no con SQL a mano para que el fixture pase
 * por los mismos CHECK que la escritura real.
 */
async function sembrarCuenta(
  db: Kysely<Database>,
  opts: {
    eaAppointmentId: number;
    cerrada: boolean;
    monto?: number;
    propina?: number;
    metodo?: "efectivo" | "transferencia" | "otro" | null;
    hora?: string;
    /** El día de la cita. Por defecto, `DIA`. */
    fecha?: string;
  },
): Promise<number> {
  const { appointmentFinance, appointmentFinanceItems, appointmentPayments } =
    repositories(db);
  const start = eaLocalToInstant(dt(`${opts.fecha ?? DIA} ${opts.hora ?? "09:00:00"}`));
  const monto = opts.monto ?? 180_000;
  const metodo = opts.metodo === undefined ? "efectivo" : opts.metodo;

  const { row } = await appointmentFinance.ensure({
    ea_appointment_id: opts.eaAppointmentId,
    ea_provider_id: 3,
    secondary_ea_provider_id: null,
    appointment_start_at: start,
    booked_service_id: 5,
    performed_service_id: 5,
    service_price_snapshot: monto,
    snapshot_source: "webhook",
  });

  if (!opts.cerrada) return row.id;

  await appointmentFinanceItems.insertMany([
    {
      appointment_finance_id: row.id,
      kind: "servicio",
      ea_service_id: 5,
      pricing_id: null,
      qty: 1,
      unit_price_snapshot: monto,
      line_total: monto,
      note: null,
    },
  ]);

  // El método vive en `appointment_payment`, que es la fuente. La columna del
  // encabezado se escribe igual, como shim de rollback, que es lo que hace la
  // Server Action de verdad.
  // `replaceForFinance` y no un INSERT suelto: `appointmentFinance.ensure()` es
  // idempotente por `ea_appointment_id`, así que sembrar dos veces la misma cita
  // reusa la fila — y un insert acumularía un segundo pago, dejando la cuenta
  // cobrada al doble. Reemplazar es además lo que hace la Server Action.
  await appointmentPayments.replaceForFinance(
    row.id,
    metodo === null ? [] : [{ method: metodo, amount: monto }],
  );

  await appointmentFinance.update(row.id, {
    amount_charged: monto,
    tip: opts.propina ?? 0,
    payment_method: metodo,
    // Se cobra siempre el mismo día: `paid_at` cae en la fecha de la cita.
    paid_at: metodo === null ? null : start,
    closed_by: OWNER_ID,
    closed_at: eaLocalToInstant(dt("2026-09-03 10:40:00")),
  });

  return row.id;
}

function cierres(db: Kysely<Database>) {
  return db.selectFrom("day_close").selectAll().orderBy("close_date").execute();
}

function cuentas(db: Kysely<Database>) {
  return db
    .selectFrom("appointment_finance")
    .selectAll()
    .orderBy("ea_appointment_id")
    .execute();
}

function renglones(db: Kysely<Database>) {
  return db.selectFrom("appointment_finance_item").selectAll().orderBy("id").execute();
}
