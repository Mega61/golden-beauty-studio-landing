/**
 * Capa 2 del paquete B4: el webhook y el reconcile contra un **MySQL real**.
 *
 * Lo que se está verificando es una invariante de la base, no del código:
 * `uq_af_ea_appointment` es la llave de idempotencia, y "una fila por cita y ni
 * una más" solo se puede afirmar dejando que MySQL rechace el segundo INSERT.
 * Un doble del driver contestaría lo que le enseñamos, que es exactamente el
 * error que estos tests existen para no cometer.
 *
 * ## Por qué el webhook y el reconcile comparten archivo
 *
 * Cada archivo de test corre en su propio proceso y **en paralelo** con los
 * demás (verificado: dos archivos reportan `process.pid` distintos y su
 * `process.env` no se comparte). Un archivo = un contenedor de MySQL. Los dos
 * caminos de escritura compiten por la misma fila, así que la mitad de lo que
 * hay que probar es lo que pasa cuando se cruzan — y eso necesita que estén en
 * la misma base de todos modos.
 *
 * ## El puerto
 *
 * No hay nada que hacer acá: `startEphemeralMysql()` publica con `0:3306` y le
 * pregunta a Docker qué puerto le tocó, justamente para que dos suites en
 * paralelo no choquen. Vale decirlo porque no siempre fue así, y el síntoma de
 * volver a un puerto fijo es un `port is already allocated` intermitente en la
 * segunda suite, que no dice nada sobre el código que estaba probando.
 */
import { sql, type Kysely } from "kysely";
import type { Pool } from "mysql2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { handleEaWebhook } from "@/app/api/webhooks/ea/handler";
import { createDb, createPool, repositories, runMigrations, type Database } from "@/db";
import {
  eaLocalToInstant,
  parseEaLocalDateTime,
  type Appointment,
  type EaLocalDateTime,
} from "@/lib/ea";
import type { EaClient } from "@/lib/ea/client";
import { EaApiError } from "@/lib/ea/errors";
import type { WebhookSecret } from "@/lib/webhook-verify";
import {
  canRunDbTests,
  skipReason,
  startEphemeralMysql,
  type EphemeralMysql,
} from "@/db/testing/ephemeral-mysql";

import { runReconcile, type ReconcileEaClient } from "./reconcile";

const HOOK_TIMEOUT = 300_000;
const TEST_TIMEOUT = 60_000;

const SECRET: WebhookSecret = { header: "X-GBS-Webhook", token: "secreto-del-webhook" };
const EA_TOKEN = "token-bearer-de-la-api-de-ea";
const OWNER_ID = "usr_owner_0000000000000000000000";

/** Precios de lista de EA, en pesos. Los mismos ids que usan los fixtures. */
const PRECIOS = new Map<number, number | null>([
  [5, 180_000],
  [6, 240_000],
  // Un servicio de cortesía. Cero **es** un precio resuelto, no un precio
  // faltante, y el handler tiene que distinguirlos.
  [7, 0],
]);

// ── Dobles de EA ─────────────────────────────────────────────────────────────

function noImplementado(nombre: string): never {
  throw new Error(`doble de EA: ${nombre} no debería llamarse en este test`);
}

type Fallo = "none" | "down";

/**
 * `services.get`, con un interruptor para simular EA caído.
 *
 * El fallo se modela como el `EaApiError` que el cliente de A1 lanza de verdad,
 * y con un mensaje que **contiene el token**: así el test puede afirmar que el
 * handler no lo deja llegar a `webhook_event.error`.
 */
function fakeServices(estado: { fallo: Fallo; llamadas: number[] }): EaClient["services"] {
  return {
    list: () => noImplementado("services.list"),
    listPage: () => noImplementado("services.listPage"),
    get: async (id: number) => {
      estado.llamadas.push(id);
      if (estado.fallo === "down") {
        throw new EaApiError(`EA no responde (Authorization: Bearer ${EA_TOKEN})`, {
          kind: "network",
        });
      }
      const price = PRECIOS.get(id);
      if (price === undefined) {
        throw new EaApiError("not found", { kind: "not_found", status: 404 });
      }
      return {
        id,
        name: `Servicio ${id}`,
        duration: 90,
        price,
        currency: "COP",
        location: null,
        description: null,
        color: null,
        slotInterval: 15,
        attendantsNumber: 1,
        isPrivate: false,
        serviceCategoryId: 1,
      };
    },
    create: () => noImplementado("services.create"),
    update: () => noImplementado("services.update"),
    remove: () => noImplementado("services.remove"),
  };
}

/**
 * `appointments.list`, imitando los bordes reales de EA.
 *
 * `from` compara contra `DATE(start_datetime)` y `till` contra
 * `DATE(end_datetime)`, los dos inclusivos y de grano día
 * (`Appointments_api_v1::index()`). Reproducirlo acá es lo que hace que el test
 * del día extra signifique algo: con un doble que filtrara por el inicio en los
 * dos extremos, la cita que cruza la medianoche entraría igual y el recorte del
 * reconcile parecería innecesario.
 *
 * Tampoco devuelve bloqueos: `Appointments_model::get()` filtra
 * `is_unavailability = false`.
 */
function fakeAppointments(citas: Appointment[]): EaClient["appointments"] {
  return {
    list: async (query = {}) => {
      const from = typeof query.from === "string" ? query.from : undefined;
      const till = typeof query.till === "string" ? query.till : undefined;
      return citas.filter((c) => {
        if (from && c.start.slice(0, 10) < from) return false;
        if (till && c.end.slice(0, 10) > till) return false;
        return true;
      });
    },
    listPage: () => noImplementado("appointments.listPage"),
    get: () => noImplementado("appointments.get"),
    create: () => noImplementado("appointments.create"),
    update: () => noImplementado("appointments.update"),
    remove: () => noImplementado("appointments.remove"),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function dt(value: string): EaLocalDateTime {
  return parseEaLocalDateTime(value);
}

/** La fila cruda snake_case tal como EA la manda: `Appointments_model::find()`. */
function filaCruda(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 101,
    book_datetime: "2026-08-30 18:22:11",
    start_datetime: "2026-08-31 09:00:00",
    end_datetime: "2026-08-31 10:30:00",
    location: "",
    meeting_link: null,
    notes: "",
    hash: "8f2a0c1e",
    color: "#7B68EE",
    status: "Booked",
    is_unavailability: 0,
    id_users_provider: 3,
    id_users_customer: 42,
    id_services: 5,
    id_google_calendar: null,
    id_caldav_calendar: null,
    ...overrides,
  };
}

function cita(overrides: Partial<Appointment> = {}): Appointment {
  return {
    id: 101,
    bookedAt: dt("2026-08-30 18:22:11"),
    start: dt("2026-08-31 09:00:00"),
    end: dt("2026-08-31 10:30:00"),
    hash: "8f2a0c1e",
    location: null,
    meetingLink: null,
    color: "#7B68EE",
    status: "Booked",
    notes: null,
    customerId: 42,
    providerId: 3,
    serviceId: 5,
    googleCalendarId: null,
    caldavCalendarId: null,
    ...overrides,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://admin:3000/admin/api/webhooks/ea", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function firmado(body: unknown): Request {
  return post(body, { [SECRET.header]: SECRET.token });
}

// ── La suite ─────────────────────────────────────────────────────────────────

describe.skipIf(!canRunDbTests())(
  `webhook y reconcile contra MySQL real${skipReason() ? ` (saltado: ${skipReason()})` : ""}`,
  () => {
    let container: EphemeralMysql;
    let pool: Pool;
    let db: Kysely<Database>;
    let ea: { fallo: Fallo; llamadas: number[] };

    /** Las dependencias del handler, con el doble de EA del test en curso. */
    const deps = () => ({
      db,
      ea: { services: fakeServices(ea) },
      secret: SECRET,
      redact: [EA_TOKEN, SECRET.token],
    });

    const eaClient = (citas: Appointment[]): ReconcileEaClient => ({
      appointments: fakeAppointments(citas),
      services: fakeServices(ea),
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
      ea = { fallo: "none", llamadas: [] };
      await limpiar(db);
      await sembrarDuena(db);
    }, TEST_TIMEOUT);

    afterEach(() => {
      // Un test que dejó el doble de EA caído y no lo dijo haría fallar al
      // siguiente por una razón que no tiene nada que ver con él.
      ea.fallo = "none";
    });

    // ── El webhook ─────────────────────────────────────────────────────────

    describe("el handler del webhook", () => {
      it(
        "crea exactamente una fila con el precio congelado y la marca `webhook`",
        async () => {
          const res = await handleEaWebhook(
            firmado({ action: "appointment_save", payload: filaCruda() }),
            deps(),
          );

          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ status: "processed", detail: "created" });

          const filas = await todas(db);
          expect(filas).toHaveLength(1);
          expect(filas[0]).toMatchObject({
            ea_appointment_id: 101,
            ea_provider_id: 3,
            booked_service_id: 5,
            service_price_snapshot: 180_000,
            snapshot_source: "webhook",
          });
          // La hora de la cita se copia como hora de pared del estudio, que es
          // la única forma de que `appointment_start_at` sea comparable con la
          // de EA sin un JOIN cross-schema que no existe.
          expect(filas[0].appointment_start_at?.getTime()).toBe(
            eaLocalToInstant(dt("2026-08-31 09:00:00")).getTime(),
          );

          const eventos = await db.selectFrom("webhook_event").selectAll().execute();
          expect(eventos).toHaveLength(1);
          expect(eventos[0].action).toBe("appointment_save");
          expect(eventos[0].ea_entity_id).toBe(101);
          expect(eventos[0].processed_at).toBeInstanceOf(Date);
          expect(eventos[0].error).toBeNull();
        },
        TEST_TIMEOUT,
      );

      it(
        "congela un precio de cero como cero, no como fallback",
        async () => {
          await handleEaWebhook(
            firmado({ action: "appointment_save", payload: filaCruda({ id_services: 7 }) }),
            deps(),
          );

          const [fila] = await todas(db);
          expect(fila.service_price_snapshot).toBe(0);
          expect(fila.snapshot_source).toBe("webhook");
        },
        TEST_TIMEOUT,
      );

      it(
        "un reenvío del mismo evento no crea una segunda fila",
        async () => {
          const evento = { action: "appointment_save", payload: filaCruda() };

          const primera = await handleEaWebhook(firmado(evento), deps());
          const segunda = await handleEaWebhook(firmado(evento), deps());
          const tercera = await handleEaWebhook(firmado(evento), deps());

          expect(await primera.json()).toEqual({ status: "processed", detail: "created" });
          expect(await segunda.json()).toEqual({ status: "duplicate" });
          expect(await tercera.json()).toEqual({ status: "duplicate" });

          expect(await todas(db)).toHaveLength(1);
          // Y un solo rastro: mismo cuerpo, misma acción, misma entidad.
          expect(await db.selectFrom("webhook_event").selectAll().execute()).toHaveLength(1);
          // Los reenvíos ni siquiera vuelven a preguntarle el precio a EA.
          expect(ea.llamadas).toEqual([5]);
        },
        TEST_TIMEOUT,
      );

      it(
        "dos eventos simultáneos sobre la misma cita dejan una sola fila",
        async () => {
          // La ventana entre "consultar" e "insertar" es real, y la cierra el
          // índice único, no el código. Los dos cuerpos son distintos para que
          // no los frene la deduplicación de `webhook_event` y lleguen los dos
          // al INSERT.
          const [a, b] = await Promise.all([
            handleEaWebhook(
              firmado({ action: "appointment_save", payload: filaCruda() }),
              deps(),
            ),
            handleEaWebhook(
              firmado({
                action: "appointment_save",
                payload: filaCruda({ notes: "editada al mismo tiempo" }),
              }),
              deps(),
            ),
          ]);

          expect(a.status).toBe(200);
          expect(b.status).toBe(200);
          expect(await todas(db)).toHaveLength(1);
        },
        TEST_TIMEOUT,
      );

      it(
        "una reprogramación mueve la hora pero NO vuelve a tarifar",
        async () => {
          await handleEaWebhook(
            firmado({ action: "appointment_save", payload: filaCruda() }),
            deps(),
          );

          // El ajuste anual de precios ocurre entre los dos eventos. Congelar
          // otra vez sería exactamente el bug que el diseño entero evita.
          PRECIOS.set(5, 210_000);
          try {
            const res = await handleEaWebhook(
              firmado({
                action: "appointment_save",
                payload: filaCruda({
                  start_datetime: "2026-09-02 15:00:00",
                  end_datetime: "2026-09-02 16:30:00",
                  id_users_provider: 9,
                }),
              }),
              deps(),
            );
            expect(await res.json()).toEqual({ status: "processed", detail: "mirrored" });
          } finally {
            PRECIOS.set(5, 180_000);
          }

          const filas = await todas(db);
          expect(filas).toHaveLength(1);
          expect(filas[0].service_price_snapshot).toBe(180_000);
          expect(filas[0].snapshot_source).toBe("webhook");
          expect(filas[0].ea_provider_id).toBe(9);
          expect(filas[0].appointment_start_at?.getTime()).toBe(
            eaLocalToInstant(dt("2026-09-02 15:00:00")).getTime(),
          );
        },
        TEST_TIMEOUT,
      );

      it(
        "un cambio de servicio antes de prestarlo sí recongela",
        async () => {
          await handleEaWebhook(
            firmado({ action: "appointment_save", payload: filaCruda() }),
            deps(),
          );

          const res = await handleEaWebhook(
            firmado({ action: "appointment_save", payload: filaCruda({ id_services: 6 }) }),
            deps(),
          );
          expect(await res.json()).toEqual({ status: "processed", detail: "repriced" });

          const [fila] = await todas(db);
          expect(fila.booked_service_id).toBe(6);
          expect(fila.service_price_snapshot).toBe(240_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "con EA caído crea la fila igual, marcada `fallback` y sin precio",
        async () => {
          ea.fallo = "down";

          const res = await handleEaWebhook(
            firmado({ action: "appointment_save", payload: filaCruda() }),
            deps(),
          );
          expect(res.status).toBe(200);

          const [fila] = await todas(db);
          // Nunca un precio silencioso: o el número que EA tenía, o la marca.
          expect(fila.service_price_snapshot).toBeNull();
          expect(fila.snapshot_source).toBe("fallback");
        },
        TEST_TIMEOUT,
      );

      it(
        "usa el precio de lista que se le pase, y aun así marca `fallback`",
        async () => {
          ea.fallo = "down";

          await handleEaWebhook(firmado({ action: "appointment_save", payload: filaCruda() }), {
            ...deps(),
            listPrice: async () => 175_000,
          });

          const [fila] = await todas(db);
          expect(fila.service_price_snapshot).toBe(175_000);
          // La marca no dice "no hay número": dice "este número no es el que EA
          // tenía al agendar". Es lo que separa el aviso de la liquidación mal
          // pagada sin que nadie se entere.
          expect(fila.snapshot_source).toBe("fallback");
        },
        TEST_TIMEOUT,
      );

      it(
        "rechaza sin header, con header vacío y con el secreto de otro webhook",
        async () => {
          const evento = { action: "appointment_save", payload: filaCruda() };

          for (const req of [
            post(evento),
            post(evento, { [SECRET.header]: "" }),
            post(evento, { [SECRET.header]: "secreto-de-otro-webhook" }),
          ]) {
            const res = await handleEaWebhook(req, deps());
            expect(res.status).toBe(401);
          }

          // Ni una fila de plata, ni una de rastro: un POST que no probó
          // conocer el secreto no llega a tocar la base.
          expect(await todas(db)).toHaveLength(0);
          expect(await db.selectFrom("webhook_event").selectAll().execute()).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "anota el rastro y NO marca procesado cuando el cuerpo es ilegible",
        async () => {
          const res = await handleEaWebhook(firmado("{esto no es json"), deps());
          expect(res.status).toBe(500);

          const [evento] = await db.selectFrom("webhook_event").selectAll().execute();
          expect(evento.action).toBe("(cuerpo ilegible)");
          expect(evento.ea_entity_id).toBeNull();
          // Sin `processed_at` es como aparece en Diagnóstico. Marcarlo
          // procesado sería un evento perdido con buena cara.
          expect(evento.processed_at).toBeNull();
          expect(evento.error).toBeTruthy();
          expect(await todas(db)).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "rechaza una acción que el `openapi.yml` de EA inventa",
        async () => {
          // `appointment_create` está en los ejemplos del spec de EA y **no
          // existe**: las 18 buenas están en `constants.php`. Un webhook
          // registrado con ese nombre queda mudo; si igual llegara, acá se ve.
          const res = await handleEaWebhook(
            firmado({ action: "appointment_create", payload: filaCruda() }),
            deps(),
          );
          expect(res.status).toBe(500);

          const [evento] = await db.selectFrom("webhook_event").selectAll().execute();
          expect(evento.action).toBe("appointment_create");
          expect(evento.ea_entity_id).toBe(101);
          expect(evento.processed_at).toBeNull();
          expect(await todas(db)).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "anota las acciones que no maneja, sin tocar el libro de caja",
        async () => {
          for (const action of ["customer_save", "service_save", "appointment_delete"]) {
            const res = await handleEaWebhook(firmado({ action, payload: { id: 7 } }), deps());
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ status: "ignored", detail: action });
          }

          expect(await todas(db)).toHaveLength(0);
          const eventos = await db.selectFrom("webhook_event").selectAll().execute();
          expect(eventos).toHaveLength(3);
          expect(eventos.every((e) => e.processed_at !== null)).toBe(true);
        },
        TEST_TIMEOUT,
      );

      it(
        "ignora un bloqueo de técnica disfrazado de cita",
        async () => {
          const res = await handleEaWebhook(
            firmado({
              action: "appointment_save",
              payload: filaCruda({ is_unavailability: 1, id_services: null }),
            }),
            deps(),
          );
          expect(await res.json()).toEqual({ status: "ignored", detail: "unavailability" });
          expect(await todas(db)).toHaveLength(0);
        },
        TEST_TIMEOUT,
      );

      it(
        "nunca guarda el token de EA ni el secreto del webhook en el rastro",
        async () => {
          ea.fallo = "down";
          // El doble de EA lanza con el token adentro del mensaje, que es lo
          // que hace un cliente HTTP descuidado. Si el handler lo dejara pasar,
          // el token quedaría en una tabla que se lee a mano para depurar y se
          // pega en un chat cuando algo falla.
          const res = await handleEaWebhook(
            firmado({
              action: "appointment_save",
              payload: filaCruda({ id_services: 6 }),
            }),
            {
              ...deps(),
              // Sin fallback posible: se fuerza el camino del error de verdad.
              listPrice: async () => {
                throw new EaApiError(`tampoco (Bearer ${EA_TOKEN})`, { kind: "network" });
              },
            },
          );

          // Con EA caído la fila se crea marcada; el error del doble se traga
          // dentro de `resolveSnapshot`, así que acá se comprueba el otro
          // camino: cualquier texto que sí llegue a la columna va tachado.
          expect(res.status).toBe(200);

          const eventos = await db.selectFrom("webhook_event").selectAll().execute();
          const volcado = JSON.stringify(eventos);
          expect(volcado).not.toContain(EA_TOKEN);
          expect(volcado).not.toContain(SECRET.token);
        },
        TEST_TIMEOUT,
      );

      it(
        "tacha los secretos del texto que sí termina en la columna `error`",
        async () => {
          // Una acción inválida hace fallar a `parseWebhookEnvelope` **después**
          // de anotar el evento, que es el camino por el que un mensaje llega
          // de verdad a `webhook_event.error`.
          await handleEaWebhook(
            firmado({
              action: `accion-inventada-${EA_TOKEN}`.slice(0, 60),
              payload: { id: 3 },
            }),
            deps(),
          );

          const [evento] = await db.selectFrom("webhook_event").selectAll().execute();
          expect(evento.error).toBeTruthy();
          expect(evento.error).not.toContain(EA_TOKEN);
          expect(evento.error).toContain("«token»");
        },
        TEST_TIMEOUT,
      );
    });

    // ── El reconcile ───────────────────────────────────────────────────────

    describe("el reconcile", () => {
      /** El "ahora" de todas las corridas. Sin él el test dependería del reloj. */
      const AHORA = eaLocalToInstant(dt("2026-08-31 23:30:00"));

      const correr = (citas: Appointment[], extra: Partial<Parameters<typeof runReconcile>[0]> = {}) =>
        runReconcile({
          db,
          ea: eaClient(citas),
          now: AHORA,
          lookbackDays: 7,
          lookaheadDays: 60,
          ...extra,
        });

      it(
        "crea las filas de las citas cuyo webhook se perdió",
        async () => {
          // La 101 llegó por webhook; las otras dos se perdieron porque el
          // panel estuvo caído — que es el modo de falla **esperado**, no el
          // raro: EA no reintenta.
          await handleEaWebhook(
            firmado({ action: "appointment_save", payload: filaCruda() }),
            deps(),
          );

          const reporte = await correr([
            cita(),
            cita({ id: 202, start: dt("2026-08-31 11:00:00"), end: dt("2026-08-31 12:00:00") }),
            cita({
              id: 303,
              serviceId: 6,
              start: dt("2026-09-01 09:00:00"),
              end: dt("2026-09-01 10:00:00"),
            }),
          ]);

          expect(reporte.scanned).toBe(3);
          expect(reporte.created).toBe(2);
          expect(reporte.untouched).toBe(1);
          expect(reporte.fallback).toBe(0);

          const filas = await todas(db);
          expect(filas.map((f) => f.ea_appointment_id)).toEqual([101, 202, 303]);
          expect(filas.map((f) => f.snapshot_source)).toEqual([
            "webhook",
            "reconcile",
            "reconcile",
          ]);
          expect(filas.map((f) => f.service_price_snapshot)).toEqual([
            180_000, 180_000, 240_000,
          ]);
        },
        TEST_TIMEOUT,
      );

      it(
        "no pisa el precio que el webhook ya congeló",
        async () => {
          await handleEaWebhook(
            firmado({ action: "appointment_save", payload: filaCruda() }),
            deps(),
          );

          PRECIOS.set(5, 999_000);
          try {
            const reporte = await correr([cita()]);
            expect(reporte.created).toBe(0);
            expect(reporte.untouched).toBe(1);
          } finally {
            PRECIOS.set(5, 180_000);
          }

          const [fila] = await todas(db);
          expect(fila.service_price_snapshot).toBe(180_000);
          expect(fila.snapshot_source).toBe("webhook");
        },
        TEST_TIMEOUT,
      );

      it(
        "correrlo dos veces seguidas no cambia nada",
        async () => {
          const citas = [
            cita(),
            cita({ id: 202, start: dt("2026-08-29 11:00:00"), end: dt("2026-08-29 12:00:00") }),
          ];

          const primera = await correr(citas);
          expect(primera.created).toBe(2);

          const antes = await todas(db);
          const segunda = await correr(citas);

          expect(segunda.created).toBe(0);
          expect(segunda.untouched).toBe(2);
          expect(await todas(db)).toEqual(antes);
        },
        TEST_TIMEOUT,
      );

      it(
        "repara una fila que quedó marcada `fallback` sin precio",
        async () => {
          ea.fallo = "down";
          await handleEaWebhook(
            firmado({ action: "appointment_save", payload: filaCruda() }),
            deps(),
          );
          expect((await todas(db))[0].snapshot_source).toBe("fallback");

          // EA vuelve. Esto no es "recalcular en retrospectiva": es poner por
          // primera vez un número que nunca se logró congelar. Sin esta pasada,
          // la fila se quedaría sin precio para siempre — el reconcile solo
          // busca citas *sin fila*, y ésta tiene una.
          ea.fallo = "none";
          const reporte = await correr([cita()]);

          expect(reporte.repaired).toBe(1);
          const [fila] = await todas(db);
          expect(fila.service_price_snapshot).toBe(180_000);
          expect(fila.snapshot_source).toBe("reconcile");
        },
        TEST_TIMEOUT,
      );

      it(
        "no toca una cuenta que ya entró a un cierre diario",
        async () => {
          await handleEaWebhook(
            firmado({ action: "appointment_save", payload: filaCruda() }),
            deps(),
          );
          const [fila] = await todas(db);
          const dayCloseId = await cerrarElDia(db, fila.id);

          // La cita cambia de todo en EA después del cierre. Da igual: en ese
          // momento los números ya salieron hacia Strapi y Actual Budget, y
          // editarlos en sitio los desincroniza en silencio.
          const reporte = await correr([
            cita({ serviceId: 6, providerId: 77, start: dt("2026-08-31 20:00:00") }),
          ]);

          expect(reporte.frozen).toBe(1);
          const [despues] = await todas(db);
          expect(despues.day_close_id).toBe(dayCloseId);
          expect(despues.booked_service_id).toBe(5);
          expect(despues.ea_provider_id).toBe(3);
          expect(despues.service_price_snapshot).toBe(180_000);
        },
        TEST_TIMEOUT,
      );

      it(
        "cubre las reservas futuras, no solo las noches pasadas",
        async () => {
          // Una cita para dentro de un mes cuyo `appointment_save` se perdió.
          // Con una ventana solo hacia atrás, su fila no existiría hasta la
          // noche en que la cita ocurre — y su precio se congelaría con la
          // tarifa de ese día, no con la del día en que se reservó.
          const reporte = await correr([
            cita({ id: 404, start: dt("2026-09-28 09:00:00"), end: dt("2026-09-28 10:00:00") }),
          ]);

          expect(reporte.created).toBe(1);
          expect((await todas(db))[0].ea_appointment_id).toBe(404);
        },
        TEST_TIMEOUT,
      );

      it(
        "deja fuera lo que cae fuera de la ventana",
        async () => {
          const reporte = await correr([
            // Ocho noches atrás: fuera del `lookbackDays: 7`.
            cita({ id: 505, start: dt("2026-08-23 09:00:00"), end: dt("2026-08-23 10:00:00") }),
            // Sesenta y un días adelante: fuera del `lookaheadDays: 60`.
            cita({ id: 606, start: dt("2026-10-31 09:00:00"), end: dt("2026-10-31 10:00:00") }),
            cita({ id: 707, start: dt("2026-08-24 09:00:00"), end: dt("2026-08-24 10:00:00") }),
          ]);

          expect(reporte.scanned).toBe(1);
          expect((await todas(db)).map((f) => f.ea_appointment_id)).toEqual([707]);
        },
        TEST_TIMEOUT,
      );

      it(
        "no pierde la cita que cruza la medianoche del último día",
        async () => {
          // EA compara `till` contra `end_datetime`, así que sin el día extra
          // esta cita no vendría en la respuesta. Es el borde que documenta A1
          // y la razón de pedir de más y recortar en memoria.
          const reporte = await correr([
            cita({
              id: 808,
              start: dt("2026-10-30 23:00:00"),
              end: dt("2026-10-31 00:30:00"),
            }),
          ]);

          expect(reporte.scanned).toBe(1);
          expect((await todas(db))[0].ea_appointment_id).toBe(808);
        },
        TEST_TIMEOUT,
      );

      it(
        "cuenta el fallback de la noche y le pregunta a EA una vez por servicio",
        async () => {
          ea.fallo = "down";
          const reporte = await correr([
            cita({ id: 111, start: dt("2026-08-30 09:00:00"), end: dt("2026-08-30 10:00:00") }),
            cita({ id: 222, start: dt("2026-08-30 11:00:00"), end: dt("2026-08-30 12:00:00") }),
            cita({
              id: 333,
              serviceId: 6,
              start: dt("2026-08-30 13:00:00"),
              end: dt("2026-08-30 14:00:00"),
            }),
          ]);

          expect(reporte.created).toBe(3);
          expect(reporte.fallback).toBe(3);
          // Dos servicios distintos, dos llamadas: la memo de la corrida evita
          // que un EA caído se lleve una llamada por cita.
          expect(ea.llamadas).toEqual([5, 6]);

          const filas = await todas(db);
          expect(filas.every((f) => f.snapshot_source === "fallback")).toBe(true);
          expect(filas.every((f) => f.service_price_snapshot === null)).toBe(true);
        },
        TEST_TIMEOUT,
      );
    });
  },
);

// ── Ayudantes de base ────────────────────────────────────────────────────────

async function todas(db: Kysely<Database>) {
  return db
    .selectFrom("appointment_finance")
    .selectAll()
    .orderBy("ea_appointment_id")
    .execute();
}

async function limpiar(db: Kysely<Database>): Promise<void> {
  const tablas = [
    "appointment_finance_item",
    "appointment_finance",
    "day_close",
    "webhook_event",
    "audit_log",
    "user",
  ];
  await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
  for (const tabla of tablas) {
    await sql.raw(`TRUNCATE TABLE \`${tabla}\``).execute(db);
  }
  await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);
}

/** `day_close.closed_by` tiene FK hacia `user`, así que la dueña tiene que existir. */
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

/** Cierra el día y engancha la cuenta, que es lo que la congela. */
async function cerrarElDia(db: Kysely<Database>, financeId: number): Promise<number> {
  const { dayCloses, appointmentFinance } = repositories(db);
  const dayCloseId = await dayCloses.insert({
    close_date: "2026-08-31",
    total_efectivo: 180_000,
    total_transferencia: 0,
    total_otro: 0,
    total_tips: 0,
    appointment_count: 1,
    closed_by: OWNER_ID,
    closed_at: eaLocalToInstant(dt("2026-08-31 20:00:00")),
  });
  await appointmentFinance.attachToDayClose([financeId], dayCloseId);
  return dayCloseId;
}
