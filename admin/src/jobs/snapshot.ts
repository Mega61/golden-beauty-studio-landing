import "server-only";

import type { Appointment } from "@/lib/ea";
import { eaLocalToInstant } from "@/lib/ea";
import type { EaClient } from "@/lib/ea/client";
import { repositories, type AppointmentFinance, type Db, type SnapshotSource } from "@/db";

/**
 * Congelar el precio de una cita — el único lugar donde se hace.
 *
 * Es el hueco #1 del plan, el que lo define entero: **`ea_appointments` no
 * tiene columna de dinero.** El precio vive en el *servicio*, y los servicios se
 * re-tarifan cada año. Una comisión calculada con el precio de hoy sobre una
 * cita del mes pasado está mal, y nada en EA lo delataría.
 *
 * Hay **dos** caminos de escritura hacia la misma cita y este módulo es el que
 * comparten:
 *
 * - el webhook `appointment_save`, que llega en el momento en que se agenda;
 * - el reconcile nocturno, que barre las citas sin fila.
 *
 * El reconcile no es la red de seguridad del webhook: es el mecanismo
 * principal. `Webhooks_client::call()` de EA envuelve el POST en un `catch
 * (Throwable)` que solo escribe en el log, así que **EA no reintenta jamás** y
 * un panel caído diez minutos pierde esos eventos para siempre. El webhook solo
 * adelanta el trabajo del reconcile.
 *
 * ## Este módulo no es `lib/price-snapshot.ts`
 *
 * Son dos preguntas distintas y las dos llevan la palabra "snapshot":
 *
 * | | Cuándo | Qué decide |
 * | --- | --- | --- |
 * | acá | al **escribir** la fila | qué precio se congela, y de dónde salió |
 * | `resolvePriceSnapshot()` (B1) | al **leer** para liquidar | qué hacer cuando la fila no existe o no tiene precio |
 *
 * Los dos comparten la misma regla y ninguno la implementa dos veces: el precio
 * que no vino de un congelado limpio **va marcado**. Acá la marca es la columna
 * `snapshot_source`; allá es el `flag` del resultado. Este módulo es el que
 * escribe la columna que aquél después lee.
 *
 * ## La marca del fallback
 *
 * Si el precio no se puede resolver, la fila se crea igual y queda marcada con
 * `snapshot_source = 'fallback'`. Es lo único que separa "aviso" de
 * "liquidación mal pagada sin que nadie se entere": una cita sin fila se ve
 * (Caja la reclama), pero una cita con precio silenciosamente equivocado no.
 *
 * **Hoy `admin/` no tiene ninguna fuente de precio de lista fuera de EA.**
 * `src/data/pricing.ts` vive en la landing, que es otra aplicación, y
 * `service_map` guarda la correspondencia de ids sin precio. Así que el
 * fallback deja el precio en `null` y la marca puesta, que es la única
 * respuesta honesta. El puerto `listPrice` está para el día que haya una
 * fuente; si se le pasa una, se usa **y la fila sigue marcada `fallback`**,
 * porque no es el precio que EA tenía al agendar.
 */

/** Por cuál de los dos caminos entró esta escritura. */
export type SnapshotChannel = "webhook" | "reconcile";

/**
 * De dónde sacar un precio de lista cuando EA no contesta.
 *
 * Devuelve `null` si tampoco puede. **Nunca lanza**: una fuente de respaldo que
 * revienta convierte un precio faltante en una cita faltante, que es peor.
 */
export type ListPriceLookup = (eaServiceId: number) => Promise<number | null>;

export type SnapshotDeps = {
  db: Db;
  ea: Pick<EaClient, "services">;
  listPrice?: ListPriceLookup;
};

export type SnapshotAction =
  /** No había fila: se creó con su precio congelado. */
  | "created"
  /** La cita cambió de servicio antes de prestarse: se recongeló el precio. */
  | "repriced"
  /** Había fila sin precio (fallback) y esta vez sí se pudo resolver. */
  | "repaired"
  /** Cambió la técnica o la hora: se actualizó la copia local, la plata no. */
  | "mirrored"
  /** Nada que hacer. Es el caso normal de un reenvío o del reconcile. */
  | "unchanged"
  /** La cuenta ya entró a un cierre diario: no se toca ni una columna. */
  | "frozen";

export type SnapshotOutcome = {
  eaAppointmentId: number;
  financeId: number;
  action: SnapshotAction;
  snapshotSource: SnapshotSource;
  /** El precio que quedó en la fila. `null` = no se pudo congelar ninguno. */
  price: number | null;
};

/**
 * El precio de lista de un servicio, en pesos enteros, o `null`.
 *
 * `null` significa **"no se pudo resolver"**, y por eso `0` tiene que poder
 * volver como `0`: un servicio de cortesía con precio cero es un precio
 * resuelto, no un precio faltante. Confundir los dos con un `||` es cómo un
 * cero legítimo se convierte en un fallback y viceversa.
 *
 * Redondeo a pesos porque Colombia no tiene centavos y la columna es `INT`. EA
 * guarda el precio en un `DECIMAL`, así que un `180000.00` llega como número y
 * un `1234.5` — que no debería existir — se redondea en vez de romper el INSERT.
 */
function normalizePrice(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/**
 * Memoiza `GET /services/{id}` por la vida del proceso que la crea.
 *
 * El reconcile de una semana toca decenas de citas sobre el mismo puñado de
 * servicios: sin memo serían decenas de llamadas idénticas a EA, en serie,
 * dentro de la ventana nocturna. Se crea **una por corrida** y se descarta, así
 * que no puede envejecer entre corridas — que es justo lo que no se quiere en
 * algo que decide un precio.
 *
 * Un fallo se memoiza como `null` igual que un éxito: si EA está caído, lo está
 * para las cincuenta citas, y reintentar cincuenta veces solo alarga la corrida.
 */
export function createServicePriceCache(
  ea: Pick<EaClient, "services">,
): (eaServiceId: number) => Promise<number | null> {
  const cache = new Map<number, Promise<number | null>>();

  return (eaServiceId) => {
    const hit = cache.get(eaServiceId);
    if (hit) return hit;

    // Sin `fields=`: recortar la respuesta ahorraría bytes que no molestan a
    // cambio de un supuesto más sobre EA, y acá los supuestos sobre EA son lo
    // caro. Un servicio son doce campos.
    const pending = ea.services
      .get(eaServiceId)
      .then((service) => normalizePrice(service.price))
      // Sin `console.error` acá: el error de EA puede traer cuerpo de respuesta,
      // y quien llama ya reporta el fallback, que es la información que sirve.
      .catch(() => null);

    cache.set(eaServiceId, pending);
    return pending;
  };
}

/** Qué precio congelar y con qué marca. Nunca lanza. */
async function resolveSnapshot(
  deps: SnapshotDeps & { servicePrice: (id: number) => Promise<number | null> },
  eaServiceId: number | null,
  channel: SnapshotChannel,
): Promise<{ price: number | null; source: SnapshotSource }> {
  // Una cita sin servicio no tiene precio que congelar, y no es un error del
  // panel: EA admite `id_services` nulo. La fila se crea marcada.
  if (eaServiceId === null) return { price: null, source: "fallback" };

  const price = await deps.servicePrice(eaServiceId);
  if (price !== null) return { price, source: channel };

  const fromList = deps.listPrice ? await deps.listPrice(eaServiceId).catch(() => null) : null;
  // Con precio de lista o sin él, la marca es `fallback`: lo que la marca dice
  // no es "no hay número", es "este número no es el que EA tenía al agendar".
  return { price: fromList, source: "fallback" };
}

/** Las tres columnas que son copia local de la cita de EA. */
function mirrorOf(appointment: Appointment) {
  return {
    ea_provider_id: appointment.providerId,
    appointment_start_at: eaLocalToInstant(appointment.start),
    booked_service_id: appointment.serviceId,
  };
}

/**
 * Crea o pone al día **exactamente una** fila `appointment_finance`.
 *
 * La idempotencia no la cuida este código: la cuida el índice único
 * `uq_af_ea_appointment`, a través de `appointmentFinance.ensure()`, que
 * inserta y atrapa el choque en vez de consultar primero. Un `SELECT` seguido
 * de un `INSERT` deja una ventana entre los dos, y el webhook y el reconcile
 * pueden pasar por la misma cita al mismo tiempo.
 *
 * Reglas de actualización, en orden de precedencia:
 *
 * 1. **La cuenta ya entró a un cierre diario ⇒ no se toca nada.** En ese
 *    momento los números ya salieron hacia Strapi y Actual Budget; editarlos en
 *    sitio los desincroniza en silencio. Corregir es tarea de `owner` y entra
 *    como ajuste, nunca por acá.
 * 2. **El precio congelado no se recalcula nunca.** Ni por un reenvío, ni por
 *    una reprogramación, ni porque hoy el servicio valga otra cosa.
 * 3. **Sí se repara un `fallback` sin precio**, que no es recalcular: es poner
 *    por primera vez un número que nunca se logró congelar.
 * 4. **Sí se recongela cuando la cita cambió de servicio antes de prestarse**
 *    (`closed_at IS NULL`). El snapshot del servicio viejo no describe nada de
 *    lo que va a pasar; el del nuevo se congela ahora, que es cuando se reservó.
 * 5. La técnica y la hora se espejan siempre: son la única forma de indexar la
 *    agenda y la liquidación sin un JOIN cross-schema, que no existe.
 */
export async function upsertAppointmentFinance(
  deps: SnapshotDeps & { servicePrice?: (id: number) => Promise<number | null> },
  appointment: Appointment,
  channel: SnapshotChannel,
): Promise<SnapshotOutcome> {
  const servicePrice = deps.servicePrice ?? createServicePriceCache(deps.ea);
  const resolveDeps = { ...deps, servicePrice };
  const repo = repositories(deps.db).appointmentFinance;
  const mirror = mirrorOf(appointment);

  const found = await repo.findByEaAppointmentId(appointment.id);

  if (!found) {
    const { price, source } = await resolveSnapshot(
      resolveDeps,
      appointment.serviceId,
      channel,
    );
    const { row, created } = await repo.ensure({
      ea_appointment_id: appointment.id,
      ...mirror,
      service_price_snapshot: price,
      snapshot_source: source,
    });

    if (created) {
      return {
        eaAppointmentId: appointment.id,
        financeId: row.id,
        action: "created",
        snapshotSource: source,
        price,
      };
    }

    // Perdimos la carrera: entre el `find` y el `ensure`, el otro camino creó
    // la fila. `ensure` devolvió la de él, y desde acá se sigue como si
    // siempre hubiera existido — que es exactamente lo que pasó.
    return updateExisting(resolveDeps, repo, row, appointment, mirror, channel);
  }

  return updateExisting(resolveDeps, repo, found, appointment, mirror, channel);
}

type FinanceRepo = ReturnType<typeof repositories>["appointmentFinance"];

async function updateExisting(
  deps: SnapshotDeps & { servicePrice: (id: number) => Promise<number | null> },
  repo: FinanceRepo,
  existing: AppointmentFinance,
  appointment: Appointment,
  mirror: ReturnType<typeof mirrorOf>,
  channel: SnapshotChannel,
): Promise<SnapshotOutcome> {
  const base = {
    eaAppointmentId: appointment.id,
    financeId: existing.id,
  };

  if (existing.day_close_id !== null) {
    return {
      ...base,
      action: "frozen",
      snapshotSource: existing.snapshot_source,
      price: existing.service_price_snapshot,
    };
  }

  const patch: {
    ea_provider_id?: number | null;
    appointment_start_at?: Date;
    booked_service_id?: number | null;
    service_price_snapshot?: number | null;
    snapshot_source?: SnapshotSource;
  } = {};

  if (existing.ea_provider_id !== mirror.ea_provider_id) {
    patch.ea_provider_id = mirror.ea_provider_id;
  }

  if (
    existing.appointment_start_at === null ||
    existing.appointment_start_at.getTime() !== mirror.appointment_start_at.getTime()
  ) {
    patch.appointment_start_at = mirror.appointment_start_at;
  }

  const cambioDeServicio = existing.booked_service_id !== mirror.booked_service_id;
  const sinPrecio =
    existing.snapshot_source === "fallback" && existing.service_price_snapshot === null;

  // La cuenta cerrada por la técnica todavía admite espejo (la cita de EA es la
  // que manda para la agenda) pero ya no admite recongelar: lo que se prestó
  // ya se prestó, y el número de referencia con el que se cerró es el que tiene
  // que quedar en el reporte de variación.
  const puedeTocarPlata = existing.closed_at === null;
  let action: SnapshotAction = "unchanged";

  if (cambioDeServicio && puedeTocarPlata) {
    const { price, source } = await resolveSnapshot(deps, appointment.serviceId, channel);
    patch.booked_service_id = mirror.booked_service_id;
    patch.service_price_snapshot = price;
    patch.snapshot_source = source;
    action = "repriced";
  } else if (sinPrecio && puedeTocarPlata) {
    const { price, source } = await resolveSnapshot(deps, appointment.serviceId, channel);
    if (price !== null) {
      patch.service_price_snapshot = price;
      patch.snapshot_source = source;
      action = "repaired";
    }
  }

  if (Object.keys(patch).length === 0) {
    return {
      ...base,
      action: "unchanged",
      snapshotSource: existing.snapshot_source,
      price: existing.service_price_snapshot,
    };
  }

  await repo.update(existing.id, patch);

  return {
    ...base,
    action: action === "unchanged" ? "mirrored" : action,
    snapshotSource: patch.snapshot_source ?? existing.snapshot_source,
    price:
      patch.service_price_snapshot !== undefined
        ? patch.service_price_snapshot
        : existing.service_price_snapshot,
  };
}
