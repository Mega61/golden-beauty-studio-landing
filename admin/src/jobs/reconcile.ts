import "server-only";

import type { Appointment, EaLocalDate } from "@/lib/ea";
import { instantToEaDate } from "@/lib/ea";
import { createEaClient, eaConfigFromEnv, type EaClient } from "@/lib/ea/client";
import { createDb, createPool, requireDatabaseUrl, type Db } from "@/db";

import {
  createServicePriceCache,
  upsertAppointmentFinance,
  type ListPriceLookup,
} from "./snapshot";

/**
 * El reconcile: barrer las citas de EA y darle fila a las que no la tienen.
 *
 * **Esto no es una red de seguridad, es el mecanismo principal.** Los webhooks
 * de EA no reintentan: `Webhooks_client::call()` envuelve el POST en un
 * `catch (Throwable)` que solo escribe en el log de EA. Un panel caído diez
 * minutos —un despliegue, un reinicio de la VM, un pico de carga— pierde todos
 * los eventos de esos diez minutos, para siempre y sin aviso. El webhook
 * adelanta el trabajo; este job es el que garantiza que se haga.
 *
 * De ahí que sea idempotente por diseño y no por cortesía: corre todas las
 * noches, se puede correr a mano las veces que haga falta, y correrlo dos
 * veces seguidas no cambia nada.
 *
 * ## La ventana: hacia atrás **y** hacia adelante
 *
 * El plan lo describe como "las citas de las últimas N noches", y con eso solo
 * ninguna cita se pierde —la del 3 de diciembre entra a la ventana la noche del
 * 3 de diciembre— pero su precio se congelaría el día en que *ocurre* y no el
 * día en que *se reservó*, que es lo que el diseño pide. Una clienta que
 * reserva en diciembre para enero, después del ajuste anual de precios, pagaría
 * la tarifa nueva por una cita reservada con la vieja.
 *
 * Por eso la ventana tiene dos mitades y la de adelante es la más ancha: hacia
 * atrás alcanza con cubrir las noches recientes (lo que el webhook pudo haber
 * perdido), y hacia adelante hay que alcanzar la reserva más lejana que alguien
 * pueda hacer, para que su fila exista dentro de la misma noche.
 *
 * No se puede hacer mejor que eso con la API de EA: `from`/`till` filtran por
 * `start_datetime` / `end_datetime`, **no** por `book_datetime`, así que no hay
 * forma de preguntar "¿qué se reservó hoy?".
 *
 * ## Los bordes de `from` y `till`, verificados en la fuente
 *
 * `Appointments_api_v1::index()` arma `DATE(start_datetime) >= from` y
 * `DATE(end_datetime) <= till`: **grano de día e inclusivos**, y `till` compara
 * contra el *fin*. Una cita que cruza la medianoche del último día queda fuera.
 * Por eso se pide un día extra a cada lado y se recorta en memoria, que es la
 * misma disciplina que usa la agenda.
 *
 * Y una cosa que no hace falta filtrar: `Appointments_model::get()` hace
 * `get_where('appointments', ['is_unavailability' => false])`, así que este
 * listado **nunca** trae bloqueos de técnica. Verificado en el modelo, no
 * supuesto.
 */

/** Cuántas noches hacia atrás. Cubre un fin de semana largo de panel caído. */
const DEFAULT_LOOKBACK_DAYS = 7;

/**
 * Cuántos días hacia adelante. Dos meses cubre con holgura la reserva más
 * lejana que se hace en un estudio de uñas, donde la cita típica se agenda con
 * días o pocas semanas de anticipación.
 */
const DEFAULT_LOOKAHEAD_DAYS = 60;

/**
 * Lo único que el reconcile le pide a EA: listar citas y consultar servicios.
 *
 * Acotado a propósito, y no `EaClient` entero. Escrito así, el tipo dice que
 * este job **no escribe en EA** —no puede, no tiene los métodos— y un doble de
 * prueba se construye con seis funciones en vez de setenta.
 */
export type ReconcileEaClient = Pick<EaClient, "appointments" | "services">;

export type ReconcileOptions = {
  db: Db;
  ea: ReconcileEaClient;
  /** El "ahora" del estudio. Inyectable para que los tests no dependan del reloj. */
  now?: Date;
  lookbackDays?: number;
  lookaheadDays?: number;
  listPrice?: ListPriceLookup;
};

export type ReconcileReport = {
  from: EaLocalDate;
  till: EaLocalDate;
  /** Citas de EA dentro de la ventana, ya recortadas. */
  scanned: number;
  /** Filas creadas: son las que el webhook perdió. */
  created: number;
  /** Filas que ya estaban y quedaron intactas. */
  untouched: number;
  /** Filas puestas al día sin tocar plata (cambió técnica u hora). */
  mirrored: number;
  /** Filas que cambiaron de servicio antes de prestarse y se recongelaron. */
  repriced: number;
  /** `fallback` sin precio que esta vez sí se pudo resolver. */
  repaired: number;
  /** Cuentas ya cerradas en un cierre diario: no se tocan. */
  frozen: number;
  /** Filas que quedaron marcadas `fallback` en esta corrida. Es la alarma. */
  fallback: number;
  startedAt: Date;
  finishedAt: Date;
};

/** Suma días a un instante. Días de calendario, no de 24 h exactas: ver abajo. */
function shiftDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * 86_400_000);
}

/**
 * Corre el reconcile sobre la ventana configurada.
 *
 * Devuelve un reporte en vez de escribir en un log porque el llamador cambia:
 * el cron quiere un resumen en la salida, Diagnóstico quiere los números en
 * una tarjeta, y el test quiere afirmarlos. Un `console.log` no sirve para
 * ninguno de los tres.
 */
export async function runReconcile(options: ReconcileOptions): Promise<ReconcileReport> {
  const startedAt = new Date();
  const now = options.now ?? startedAt;
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const lookaheadDays = options.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS;

  // La ventana se expresa en días **del estudio**: `instantToEaDate` resuelve
  // en America/Bogota, no en la zona del proceso. En un contenedor en UTC
  // después de las 19:00 de Bogotá esos dos días son distintos, y el reconcile
  // barrería el día equivocado justo en la franja en la que corre.
  const from = instantToEaDate(shiftDays(now, -lookbackDays));
  const till = instantToEaDate(shiftDays(now, lookaheadDays));

  // El día extra a cada lado es por el grano de día de EA y por el `till` que
  // compara contra `end_datetime`. Se pide de más y se recorta acá.
  const raw = await options.ea.appointments.list({
    from: instantToEaDate(shiftDays(now, -lookbackDays - 1)),
    till: instantToEaDate(shiftDays(now, lookaheadDays + 1)),
    sort: ["start"],
  });

  const appointments = raw.filter((a) => inWindow(a, from, till));

  const report: ReconcileReport = {
    from,
    till,
    scanned: appointments.length,
    created: 0,
    untouched: 0,
    mirrored: 0,
    repriced: 0,
    repaired: 0,
    frozen: 0,
    fallback: 0,
    startedAt,
    finishedAt: startedAt,
  };

  // Una sola memo de precios para toda la corrida: decenas de citas sobre el
  // mismo puñado de servicios.
  const servicePrice = createServicePriceCache(options.ea);
  const deps = {
    db: options.db,
    ea: options.ea,
    listPrice: options.listPrice,
    servicePrice,
  };

  // En serie y no en paralelo: son pocas decenas de citas por noche, comparten
  // el pool de MySQL, y una ráfaga de `GET /services` contra EA competiría con
  // las clientas que están reservando desde la landing.
  for (const appointment of appointments) {
    const outcome = await upsertAppointmentFinance(deps, appointment, "reconcile");

    switch (outcome.action) {
      case "created":
        report.created += 1;
        break;
      case "mirrored":
        report.mirrored += 1;
        break;
      case "repriced":
        report.repriced += 1;
        break;
      case "repaired":
        report.repaired += 1;
        break;
      case "frozen":
        report.frozen += 1;
        break;
      case "unchanged":
        report.untouched += 1;
        break;
      default:
        assertNever(outcome.action);
    }

    // Solo cuenta como alarma lo que **esta** corrida dejó marcado. Una fila
    // vieja en `fallback` que hoy no se pudo reparar ya se contó la noche que
    // se creó; volver a contarla convertiría el número en un acumulado y
    // dejaría de significar "esta noche pasó algo".
    if (
      outcome.snapshotSource === "fallback" &&
      (outcome.action === "created" || outcome.action === "repriced")
    ) {
      report.fallback += 1;
    }
  }

  report.finishedAt = new Date();
  return report;
}

/**
 * ¿La cita cae dentro de la ventana pedida?
 *
 * Se compara por el **día de inicio**, que es como el panel piensa la agenda, y
 * con los dos extremos inclusivos, igual que EA. La comparación es de cadenas
 * `YYYY-MM-DD` a propósito: son horas de pared, no instantes, y pasarlas por
 * `Date` para compararlas es cómo se cuela el desfase de cinco horas.
 */
function inWindow(appointment: Appointment, from: EaLocalDate, till: EaLocalDate): boolean {
  const day = appointment.start.slice(0, 10);
  return day >= from && day <= till;
}

function assertNever(value: never): never {
  throw new Error(`Acción de snapshot no contemplada: ${String(value)}`);
}

function positiveIntFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Punto de entrada para correrlo a mano o desde el cron.
 *
 * Abre y cierra su propia conexión: es un proceso que arranca, hace su trabajo
 * y se muere, no el pool compartido del servidor web.
 *
 * Está exportado en vez de auto-ejecutarse para que importar este módulo no
 * dispare una corrida — el mismo motivo por el que `src/db/migrate.ts` separa
 * `main()` de su CLI.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<ReconcileReport> {
  const pool = createPool(requireDatabaseUrl(env));
  const db = createDb(pool);
  const ea = createEaClient(eaConfigFromEnv(env));

  try {
    return await runReconcile({
      db,
      ea,
      lookbackDays: positiveIntFromEnv(env.RECONCILE_LOOKBACK_DAYS),
      lookaheadDays: positiveIntFromEnv(env.RECONCILE_LOOKAHEAD_DAYS),
    });
  } finally {
    await db.destroy();
  }
}
