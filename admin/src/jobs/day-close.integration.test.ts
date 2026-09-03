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
  closeDay,
  recordAdjustment,
  retryAdjustmentPush,
  retryDayPush,
  type DayAppointment,
  type DayCloseDeps,
} from "./day-close";

/**
 * Capa 2 de C3: el cierre diario contra un **MySQL real**.
 *
 * Lo que se verifica acá no se puede verificar con un doble del driver, porque
 * lo que decide es la base:
 *
 * - **La compuerta.** Que el día no cierre con una cita atendida sin cuenta, y
 *   que cuando no cierra **no haya escrito nada**: ni fila `day_close`, ni
 *   `day_close_id` en las cuentas.
 * - **La idempotencia.** `uq_day_close_date` es lo que hace que un día se
 *   cierre una sola vez; sin un MySQL de verdad, "cerrar dos veces no duplica"
 *   sería una afirmación sobre un `if`. Y el push tampoco se repite, porque la
 *   marca `pushed_to_ingest_at` es una columna, no una variable.
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

/**
 * Una barrera de `n` participantes: nadie sigue hasta que llegaron todos.
 *
 * Es cómo se prueba una carrera sin depender del azar del planificador. Un test
 * de concurrencia que pasa "casi siempre" no prueba nada: el día que la carrera
 * se pierda de verdad, en producción, este test habrá estado verde.
 */
function enBarrera(n: number): () => Promise<void> {
  let llegaron = 0;
  let abrir: () => void = () => {};
  const puerta = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return async () => {
    llegaron += 1;
    if (llegaron >= n) abrir();
    await puerta;
  };
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

    describe("la compuerta", () => {
      it(
        "no cierra el día con una cita atendida sin cuenta, y no escribe nada",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true });
          await sembrarCuenta(db, { eaAppointmentId: 2, cerrada: false });

          const result = await closeDay(
            deps([cita({ eaAppointmentId: 1 }), cita({ eaAppointmentId: 2 })]),
            { date: DIA, closedBy: OWNER_ID, now: OCHO_PM },
          );

          expect(result.ok).toBe(false);
          if (result.ok) throw new Error("no debería haber cerrado");
          if (result.reason !== "compuerta") throw new Error("debería ser la compuerta");
          expect(result.review.issues.filter((issue) => issue.blocks)).toHaveLength(1);

          // Y lo que importa: **nada quedó escrito**. Un `day_close` a medio
          // hacer sería peor que no haber cerrado, porque congelaría cuentas
          // que después nadie puede corregir sin un ajuste.
          expect(await cierres(db)).toHaveLength(0);
          const filas = await cuentas(db);
          expect(filas.every((f) => f.day_close_id === null)).toBe(true);
          expect(ingest.lotes).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "no cierra con una cuenta cerrada sin método de pago",
        async () => {
          // Sin método esa plata no entra a ninguna columna del cierre, y
          // `buildIngestPayment()` la rechazaría a mitad del push.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, metodo: null });

          const result = await closeDay(deps([cita({ eaAppointmentId: 1 })]), {
            date: DIA,
            closedBy: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(false);
          expect(await cierres(db)).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "cierra cuando la lista de pendientes está vacía",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
          await sembrarCuenta(db, {
            eaAppointmentId: 2,
            cerrada: true,
            monto: 240_000,
            metodo: "transferencia",
            propina: 20_000,
          });

          const result = await closeDay(
            deps([cita({ eaAppointmentId: 1 }), cita({ eaAppointmentId: 2 })]),
            { date: DIA, closedBy: OWNER_ID, now: OCHO_PM },
          );

          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("debería haber cerrado");
          expect(result.created).toBe(true);
          expect(result.push.state).toBe("hecho");

          const [cierre] = await cierres(db);
          expect(cierre).toMatchObject({
            close_date: DIA,
            total_efectivo: 180_000,
            total_transferencia: 240_000,
            total_otro: 0,
            total_tips: 20_000,
            appointment_count: 2,
            closed_by: OWNER_ID,
          });
          expect(cierre.pushed_to_ingest_at).toBeInstanceOf(Date);

          // Las cuentas quedaron congeladas bajo su cierre y marcadas como
          // empujadas: es lo que hace que corregirlas exija un ajuste.
          const filas = await cuentas(db);
          expect(filas.every((f) => f.day_close_id === cierre.id)).toBe(true);
          expect(filas.every((f) => f.pushed_to_ingest_at !== null)).toBe(true);

          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1", "ea-appt:2"]);
        },
        TEST_TIMEOUT,
      );

      it(
        "un día sin cuentas cerradas cierra con lote vacío y no manda nada",
        async () => {
          const result = await closeDay(deps([]), {
            date: DIA,
            closedBy: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("debería haber cerrado");
          expect(result.push.state).toBe("vacio");
          expect(ingest.lotes).toHaveLength(0);
          // Un lote vacío no se manda, así que tampoco se marca como empujado:
          // no hay nada que haya llegado.
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeNull();
        },
        TEST_TIMEOUT,
      );
    });

    // ── Idempotencia ───────────────────────────────────────────────────────

    describe("cerrar dos veces", () => {
      it(
        "no duplica el day_close ni el push",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
          const dia = deps([cita({ eaAppointmentId: 1 })]);
          const input = { date: DIA, closedBy: OWNER_ID, now: OCHO_PM };

          const primero = await closeDay(dia, input);
          const segundo = await closeDay(dia, input);

          expect(primero.ok && primero.created).toBe(true);
          // El segundo no crea nada y lo dice: el día ya estaba cerrado.
          expect(segundo.ok && segundo.created).toBe(false);
          if (!segundo.ok) throw new Error("el segundo cierre debería ser un no-op");
          expect(segundo.push.state).toBe("ya");
          expect(primero.ok && segundo.dayCloseId).toBe(
            primero.ok ? primero.dayCloseId : -1,
          );

          expect(await cierres(db)).toHaveLength(1);
          // **Un solo movimiento en el CRM.** Si el push se repitiera, Actual
          // Budget deduplicaría por `imported_id` y no pasaría nada — pero la
          // segunda petición ni se manda, que es lo correcto.
          expect(ingest.lotes).toHaveLength(1);
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1"]);
        },
        TEST_TIMEOUT,
      );

      it(
        "dos cierres concurrentes dejan una sola fila",
        async () => {
          // Dos personas apretando el botón a la vez. La idempotencia la cuida
          // `uq_day_close_date`, no un `SELECT` previo: entre consultar y
          // escribir hay una ventana, y dos peticiones simultáneas la
          // encuentran.
          //
          // La carrera se fuerza con una barrera en `loadAppointments`, que
          // `closeDay()` llama **después** de consultar si el día ya está
          // cerrado. Sin ella el test dependería del azar del planificador:
          // con las dos llamadas serializadas la segunda vería la fila de la
          // primera y tomaría el camino idempotente normal, que es otro caso y
          // ya tiene su test.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });

          const barrera = enBarrera(2);
          const dia: DayCloseDeps = {
            db,
            loadAppointments: async () => {
              await barrera();
              return [cita({ eaAppointmentId: 1 })];
            },
            ingest: fakeIngest(ingest),
          };
          const input = { date: DIA, closedBy: OWNER_ID, now: OCHO_PM };

          const [a, b] = await Promise.all([closeDay(dia, input), closeDay(dia, input)]);

          expect(a.ok && b.ok).toBe(true);
          expect(await cierres(db)).toHaveLength(1);
          // Exactamente uno de los dos creó la fila.
          expect([a.ok && a.created, b.ok && b.created].filter(Boolean)).toHaveLength(1);

          // Y **un solo lote sale hacia el CRM**. La que pierde el INSERT no
          // empuja: los `imported_id` serían los mismos y Actual Budget no
          // duplicaría, pero la ruta de ingest del CRM está sin verificar y no
          // se puede afirmar que sea idempotente.
          expect(ingest.lotes).toHaveLength(1);
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1"]);
          const perdedor = [a, b].find((r) => r.ok && !r.created);
          expect(perdedor?.ok && perdedor.push.state).toBe("pendiente");
        },
        TEST_TIMEOUT,
      );

      it(
        "el día queda cerrado aunque el push falle, y el reintento manda el mismo lote",
        async () => {
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
          ingest.modo = "caido";

          const result = await closeDay(deps([cita({ eaAppointmentId: 1 })]), {
            date: DIA,
            closedBy: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("debería haber cerrado");
          expect(result.push).toMatchObject({ state: "fallo", retryable: true });
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeNull();

          // Y aparece en la cola de pendientes, que es lo que hace que un push
          // fallido no sea igual a no haber empujado.
          const pendientes = await repositories(db).dayCloses.listPendingPush();
          expect(pendientes.map((p) => p.close_date)).toEqual([DIA]);

          ingest.modo = "ok";
          const reintento = await retryDayPush(deps([cita({ eaAppointmentId: 1 })]), {
            date: DIA,
            now: OCHO_PM,
          });

          expect(reintento.state).toBe("hecho");
          expect(idsRecibidos(ingest)).toEqual(["ea-appt:1"]);
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeInstanceOf(Date);
        },
        TEST_TIMEOUT,
      );

      it(
        "con el push apagado el día se cierra igual y queda pendiente",
        async () => {
          // Hoy el contrato del cuerpo no está verificado contra el CRM. Cerrar
          // la caja del estudio no puede depender de eso.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });

          const result = await closeDay(deps([cita({ eaAppointmentId: 1 })], false), {
            date: DIA,
            closedBy: OWNER_ID,
            now: OCHO_PM,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) throw new Error("debería haber cerrado");
          expect(result.push.state).toBe("apagado");
          expect(await cierres(db)).toHaveLength(1);
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeNull();
        },
        TEST_TIMEOUT,
      );

      it(
        "una fila congelada que ya no puede viajar frena el push sin marcarlo",
        async () => {
          // La compuerta no deja cerrar un día con una cuenta sin método, pero
          // la fila se puede corromper **después** del cierre (una edición por
          // SQL, un bug de otra pantalla). El lote se arma desde la base, así
          // que el push tiene que fallar **antes** de mandar nada: media docena
          // de transacciones en Actual y un error a la mitad es un estado del
          // que hay que salir a mano.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });
          await closeDay(deps([cita({ eaAppointmentId: 1 })], false), {
            date: DIA,
            closedBy: OWNER_ID,
            now: OCHO_PM,
          });

          await db
            .updateTable("appointment_finance")
            .set({ payment_method: null })
            .where("ea_appointment_id", "=", 1)
            .execute();

          const outcome = await retryDayPush(deps([cita({ eaAppointmentId: 1 })]), {
            date: DIA,
            now: OCHO_PM,
          });

          // Definitivo, no reintentable: no lo arregla el tiempo, lo arregla
          // corregir la fila.
          expect(outcome).toMatchObject({ state: "fallo", retryable: false });
          expect(ingest.lotes).toHaveLength(0);
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeNull();
        },
        TEST_TIMEOUT,
      );

      it(
        "sin agenda el día no se cierra y no se escribe nada",
        async () => {
          // `loadAppointments` que lanza = EA caído. La única forma de saber qué
          // citas hubo es preguntárselo a EA; cerrar a ciegas empujaría un día
          // al que le falta la mitad, y Actual no actualiza montos.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });

          const result = await closeDay(
            {
              db,
              loadAppointments: () => Promise.reject(new Error("EA no responde")),
              ingest: fakeIngest(ingest),
            },
            { date: DIA, closedBy: OWNER_ID, now: OCHO_PM },
          );

          expect(result.ok).toBe(false);
          if (result.ok) throw new Error("no debería haber cerrado");
          if (result.reason !== "compuerta") throw new Error("debería ser la compuerta");
          expect(result.review.blockers.join(" ")).toContain("agenda no responde");
          expect(await cierres(db)).toHaveLength(0);
          expect(ingest.lotes).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "un error que no es del CRM se propaga en vez de disfrazarse de push fallido",
        async () => {
          // Un `IngestError` es "el CRM dijo no". Cualquier otra cosa —un bug
          // nuestro, un `TypeError`— tiene que reventar: tratarla como push
          // fallido dejaría el día en la cola de reintento para siempre,
          // reintentando un error que no está del otro lado.
          await sembrarCuenta(db, { eaAppointmentId: 1, cerrada: true, monto: 180_000 });

          await expect(
            closeDay(
              {
                db,
                loadAppointments: async () => [cita({ eaAppointmentId: 1 })],
                ingest: {
                  push: () => Promise.reject(new TypeError("bug nuestro")),
                },
              },
              { date: DIA, closedBy: OWNER_ID, now: OCHO_PM },
            ),
          ).rejects.toThrow(TypeError);

          // El día quedó cerrado —la transacción del cierre ya había
          // commiteado— y sin marca de push, que es el estado correcto: el
          // reintento lo agarra.
          expect(await cierres(db)).toHaveLength(1);
          expect((await cierres(db))[0].pushed_to_ingest_at).toBeNull();
        },
        TEST_TIMEOUT,
      );

      it(
        "reintentar un día que no está cerrado no inventa un cierre",
        async () => {
          const outcome = await retryDayPush(deps([]), { date: DIA, now: OCHO_PM });
          expect(outcome.state).toBe("sin-cierre");
          expect(await cierres(db)).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );
    });

    // ── Ajustes posteriores al cierre ──────────────────────────────────────

    describe("el ajuste posterior al cierre", () => {
      /** Cierra el día con una cuenta de $180.000 ya empujada. */
      async function diaCerrado(): Promise<number> {
        const financeId = await sembrarCuenta(db, {
          eaAppointmentId: 1,
          cerrada: true,
          monto: 180_000,
        });
        await closeDay(deps([cita({ eaAppointmentId: 1 })]), {
          date: DIA,
          closedBy: OWNER_ID,
          now: OCHO_PM,
        });
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
          await db
            .updateTable("appointment_finance")
            .set({ payment_method: null })
            .where("ea_appointment_id", "=", 1)
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
  },
): Promise<number> {
  const { appointmentFinance, appointmentFinanceItems } = repositories(db);
  const start = eaLocalToInstant(dt(`2026-09-03 ${opts.hora ?? "09:00:00"}`));
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
