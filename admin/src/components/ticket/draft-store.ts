/**
 * El borrador que sobrevive al envío fallido.
 *
 * **No es un extra: es requisito.** El wifi del estudio se cae, y nada de lo
 * que la técnica escribió entre dos clientas puede perderse por eso. Este
 * archivo es todo el mecanismo, y está separado de React a propósito — es la
 * parte que hay que poder probar sin un navegador.
 *
 * ## Las dos gavetas
 *
 * | Gaveta | Qué guarda | Cuándo se borra |
 * | --- | --- | --- |
 * | `draft` | lo que se está escribiendo ahora | cuando la cuenta quedó guardada |
 * | `outbox` | lo que ya se mandó a guardar y todavía no llegó | cuando el servidor contestó |
 *
 * Son dos y no una porque responden preguntas distintas. El `draft` contesta
 * "¿qué había escrito cuando se cerró la pestaña?"; el `outbox` contesta "¿qué
 * falta mandar?". Con una sola gaveta, reabrir la hoja de una cuenta que está
 * en cola mostraría un formulario vacío o pisaría el envío en curso.
 *
 * **El `draft` se conserva hasta que el servidor confirma.** Si el envío falla
 * y la técnica reabre la hoja, ve exactamente lo que había escrito y puede
 * corregirlo; el reintento toma la versión nueva.
 *
 * ## Los tres desenlaces de un envío
 *
 * Un `catch` alrededor de la Server Action no alcanza, porque mezcla dos cosas
 * opuestas: "no llegó" y "llegó y el servidor dijo que no". La primera se
 * reintenta para siempre; la segunda **nunca**, o la cola queda golpeando un
 * error de validación cada treinta segundos hasta que alguien mire la consola.
 * De ahí `SendOutcome`, con `reintentar` y `rechazado` separados.
 *
 * ## El alcance
 *
 * Las claves llevan el id de la sesión. El estudio comparte una tablet, y un
 * borrador de una técnica no puede aparecerle a la siguiente ni salir en su
 * cola — el servidor lo rechazaría con `requireOwnProvider()`, pero el rechazo
 * ya sería un dato de otra persona en pantalla.
 */

import { DRAFT_VERSION, type TicketDraft } from "./draft";
import type { PaymentMethod, VarianceReasonCode } from "@/db/types";

/**
 * Lo mínimo de `Storage` que hace falta.
 *
 * Se declara en vez de usar `Storage` para que un test le pase un objeto plano:
 * `localStorage` no existe en Node y montar jsdom para probar cuatro `if` sería
 * pagar un entorno entero por nada.
 */
export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const PREFIX = "gbs.ticket.v1";

/** Un envío que espera confirmación del servidor. */
export type PendingTicket = {
  draft: TicketDraft;
  /**
   * Identifica **este intento de cierre**, no la cita.
   *
   * Viaja a la bitácora para que dos filas de `audit_log` que salieron del
   * mismo dedo (el reintento automático y el manual) se puedan reconocer como
   * una sola intención.
   */
  clientRequestId: string;
  queuedAt: number;
  attempts: number;
  lastAttemptAt: number | null;
  lastError: string | null;
};

export type SendOutcome =
  /** El servidor guardó. Se limpian las dos gavetas. */
  | { status: "ok" }
  /**
   * El servidor contestó que no: validación, permiso, cuenta ya cerrada.
   * **No se reintenta.** Se limpia la cola y se le muestra el motivo a la
   * técnica, con el borrador intacto para que pueda corregir.
   */
  | { status: "rechazado"; message: string }
  /** No llegó, o el servidor falló feo. Se queda en la cola. */
  | { status: "reintentar"; message: string };

export type FlushReport = {
  sent: number[];
  rejected: Array<{ eaAppointmentId: number; message: string }>;
  retrying: Array<{ eaAppointmentId: number; message: string }>;
};

// ---------------------------------------------------------------------------
// Claves
// ---------------------------------------------------------------------------

/**
 * Un alcance que se pueda meter en una clave sin romperla.
 *
 * El id de Better Auth es alfanumérico, pero un separador ajeno dentro del
 * alcance partiría la clave y haría que `listPending()` leyera basura de otra
 * gaveta. Se sanea acá una vez y no en cada llamador.
 */
export function scopeKey(sessionUserId: string): string {
  const clean = sessionUserId.replace(/[^A-Za-z0-9_-]/g, "");
  return clean === "" ? "anon" : clean;
}

export function draftKey(scope: string, eaAppointmentId: number): string {
  return `${PREFIX}.${scope}.draft.${eaAppointmentId}`;
}

export function outboxKey(scope: string, eaAppointmentId: number): string {
  return `${PREFIX}.${scope}.outbox.${eaAppointmentId}`;
}

// ---------------------------------------------------------------------------
// Acceso tolerante al almacenamiento
// ---------------------------------------------------------------------------

/**
 * `localStorage` no siempre está.
 *
 * En una ventana privada de Safari, con las cookies de sitio bloqueadas, o en
 * la captura de miniatura de un artefacto, cualquiera de los tres métodos
 * **lanza**. Un throw acá se llevaría por delante la hoja entera y perdería
 * justo lo que este archivo existe para no perder, así que cada acceso se
 * envuelve y el fallo se convierte en "no se pudo persistir" — que la pantalla
 * sí puede comunicar.
 */
function safeGet(storage: DraftStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: DraftStorage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(storage: DraftStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Nada que hacer: la clave queda y la próxima lectura la descartará por
    // versión o por forma. Es preferible a tumbar el guardado por no poder
    // limpiar.
  }
}

/**
 * Las claves actuales, tomadas de una sola vez.
 *
 * Se copia la lista antes de tocar nada: `removeItem` reindexa, y recorrer con
 * `key(i)` mientras se borra se salta la mitad de las entradas.
 */
function allKeys(storage: DraftStorage): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Validación de lo que vuelve del disco
// ---------------------------------------------------------------------------

const REASON_CODES: readonly string[] = [
  "cambio_servicio",
  "adicionales",
  "cortesia",
  "correccion",
  "otro",
];

const METHODS: readonly string[] = ["efectivo", "transferencia", "otro"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intOrNull(value: unknown): number | null {
  return Number.isSafeInteger(value) ? (value as number) : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Convierte lo que había en el disco en un borrador, o `null`.
 *
 * Es estricto a propósito. Lo que sale de `localStorage` lo pudo escribir una
 * versión anterior del panel, una extensión del navegador o alguien con la
 * consola abierta, y un borrador a medio tipar que llega hasta
 * `computeTicketTotals()` revienta la hoja. Lo que no calza se descarta entero:
 * medio borrador es peor que ninguno, porque parece confiable.
 */
export function parseDraft(raw: unknown): TicketDraft | null {
  if (!isRecord(raw)) return null;
  if (raw.version !== DRAFT_VERSION) return null;

  const eaAppointmentId = intOrNull(raw.eaAppointmentId);
  if (eaAppointmentId === null || eaAppointmentId <= 0) return null;

  const performedServiceId =
    raw.performedServiceId === null ? null : intOrNull(raw.performedServiceId);
  if (raw.performedServiceId !== null && performedServiceId === null) return null;

  if (!isRecord(raw.extras)) return null;
  const extras: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.extras)) {
    const qty = intOrNull(value);
    if (qty === null || qty <= 0) continue;
    if (!/^\d+$/.test(key)) continue;
    extras[key] = qty;
  }

  let manual: TicketDraft["manual"] = null;
  if (raw.manual !== null && raw.manual !== undefined) {
    if (!isRecord(raw.manual)) return null;
    const amount = intOrNull(raw.manual.amount);
    if (amount === null) return null;
    manual = { note: str(raw.manual.note), amount };
  }

  const totalOverride =
    raw.totalOverride === null || raw.totalOverride === undefined
      ? null
      : intOrNull(raw.totalOverride);
  if (raw.totalOverride !== null && raw.totalOverride !== undefined && totalOverride === null) {
    return null;
  }

  const reason = raw.varianceReasonCode;
  const varianceReasonCode =
    typeof reason === "string" && REASON_CODES.includes(reason)
      ? (reason as VarianceReasonCode)
      : null;

  const method = raw.paymentMethod;
  const paymentMethod =
    typeof method === "string" && METHODS.includes(method) ? (method as PaymentMethod) : null;

  const tip = intOrNull(raw.tip) ?? 0;
  const updatedAt = intOrNull(raw.updatedAt) ?? 0;

  return {
    version: DRAFT_VERSION,
    eaAppointmentId,
    performedServiceId,
    extras,
    manual,
    totalOverride,
    varianceReasonCode,
    varianceReason: str(raw.varianceReason),
    notes: str(raw.notes),
    paymentMethod,
    tip: tip < 0 ? 0 : tip,
    updatedAt,
  };
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parsePending(raw: unknown): PendingTicket | null {
  if (!isRecord(raw)) return null;
  const draft = parseDraft(raw.draft);
  if (draft === null) return null;

  return {
    draft,
    clientRequestId: str(raw.clientRequestId) || `sin-id-${draft.eaAppointmentId}`,
    queuedAt: intOrNull(raw.queuedAt) ?? 0,
    attempts: Math.max(intOrNull(raw.attempts) ?? 0, 0),
    lastAttemptAt: intOrNull(raw.lastAttemptAt),
    lastError: typeof raw.lastError === "string" ? raw.lastError : null,
  };
}

// ---------------------------------------------------------------------------
// Borrador
// ---------------------------------------------------------------------------

/** Devuelve `false` si el navegador no dejó escribir. La pantalla lo avisa. */
export function writeDraft(
  storage: DraftStorage,
  scope: string,
  draft: TicketDraft,
): boolean {
  return safeSet(storage, draftKey(scope, draft.eaAppointmentId), JSON.stringify(draft));
}

/** Lo que había escrito. Una entrada corrupta se borra en vez de arrastrarse. */
export function readDraft(
  storage: DraftStorage,
  scope: string,
  eaAppointmentId: number,
): TicketDraft | null {
  const key = draftKey(scope, eaAppointmentId);
  const parsed = parseDraft(parseJson(safeGet(storage, key)));
  if (parsed === null) {
    safeRemove(storage, key);
    return null;
  }
  return parsed;
}

export function dropDraft(
  storage: DraftStorage,
  scope: string,
  eaAppointmentId: number,
): void {
  safeRemove(storage, draftKey(scope, eaAppointmentId));
}

// ---------------------------------------------------------------------------
// Cola de salida
// ---------------------------------------------------------------------------

/**
 * Pone la cuenta en la cola. **Se llama antes de intentar el envío**, no
 * después de que falle.
 *
 * Es la diferencia entre perder y no perder: si el navegador se cierra en el
 * medio del `await`, o el celular se bloquea, o la pestaña se descarta por
 * memoria, lo que ya estaba en la cola se reintenta al volver. Encolar solo en
 * el `catch` deja una ventana exacta —la del envío— en la que el trabajo existe
 * únicamente en memoria.
 */
export function enqueue(
  storage: DraftStorage,
  scope: string,
  draft: TicketDraft,
  clientRequestId: string,
  now = Date.now(),
): PendingTicket {
  const pending: PendingTicket = {
    draft,
    clientRequestId,
    queuedAt: now,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
  };
  safeSet(storage, outboxKey(scope, draft.eaAppointmentId), JSON.stringify(pending));
  return pending;
}

export function readPending(
  storage: DraftStorage,
  scope: string,
  eaAppointmentId: number,
): PendingTicket | null {
  const key = outboxKey(scope, eaAppointmentId);
  const parsed = parsePending(parseJson(safeGet(storage, key)));
  if (parsed === null) {
    safeRemove(storage, key);
    return null;
  }
  return parsed;
}

/** Todo lo que falta mandar, lo más viejo primero. */
export function listPending(storage: DraftStorage, scope: string): PendingTicket[] {
  const prefix = `${PREFIX}.${scope}.outbox.`;
  const out: PendingTicket[] = [];

  for (const key of allKeys(storage)) {
    if (!key.startsWith(prefix)) continue;
    const parsed = parsePending(parseJson(safeGet(storage, key)));
    if (parsed === null) {
      safeRemove(storage, key);
      continue;
    }
    out.push(parsed);
  }

  return out.sort((a, b) => a.queuedAt - b.queuedAt || a.draft.eaAppointmentId - b.draft.eaAppointmentId);
}

/** Anota un intento fallido y devuelve la entrada actualizada. */
export function recordFailure(
  storage: DraftStorage,
  scope: string,
  pending: PendingTicket,
  message: string,
  now = Date.now(),
): PendingTicket {
  const next: PendingTicket = {
    ...pending,
    attempts: pending.attempts + 1,
    lastAttemptAt: now,
    lastError: message,
  };
  safeSet(storage, outboxKey(scope, pending.draft.eaAppointmentId), JSON.stringify(next));
  return next;
}

/**
 * Cierra el caso: la cuenta llegó, o el servidor la rechazó de forma definitiva.
 *
 * `keepDraft` distingue los dos. Con `ok` no queda nada que conservar; con un
 * rechazo el borrador **se queda**, porque la técnica va a tener que corregir
 * algo y borrarle lo escrito sería castigarla por un error de validación.
 */
export function resolvePending(
  storage: DraftStorage,
  scope: string,
  eaAppointmentId: number,
  keepDraft: boolean,
): void {
  safeRemove(storage, outboxKey(scope, eaAppointmentId));
  if (!keepDraft) dropDraft(storage, scope, eaAppointmentId);
}

/**
 * Cuánto esperar antes del próximo intento automático.
 *
 * Crece 5 s · 10 s · 20 s · 40 s y se planta en **2 minutos**. El tope importa
 * más que la curva: la técnica sigue en el estudio, el wifi vuelve en un
 * minuto, y una espera de media hora convertiría "se reintenta solo" en "hay
 * que recargar la página". El reintento manual está siempre disponible y no
 * mira este número.
 */
export function retryDelayMs(attempts: number): number {
  const step = Math.max(attempts, 0);
  return Math.min(5_000 * 2 ** step, 120_000);
}

export function isRetryDue(pending: PendingTicket, now = Date.now()): boolean {
  if (pending.lastAttemptAt === null) return true;
  return now - pending.lastAttemptAt >= retryDelayMs(pending.attempts);
}

/**
 * Intenta mandar todo lo que está en cola.
 *
 * En serie y no en paralelo: son dos o tres cuentas como mucho, y si la red
 * está mal, tres envíos simultáneos que fallan a la vez solo triplican el ruido
 * y gastan la batería del celular más rápido.
 *
 * `force` salta la espera del backoff. Lo usan el botón "Reintentar" y el
 * evento `online` del navegador — cuando el wifi acaba de volver, esperar
 * cuarenta segundos más no protege a nadie.
 */
export async function flushOutbox(
  storage: DraftStorage,
  scope: string,
  send: (pending: PendingTicket) => Promise<SendOutcome>,
  options: { now?: number; force?: boolean } = {},
): Promise<FlushReport> {
  const now = options.now ?? Date.now();
  const report: FlushReport = { sent: [], rejected: [], retrying: [] };

  for (const pending of listPending(storage, scope)) {
    const id = pending.draft.eaAppointmentId;

    if (!options.force && !isRetryDue(pending, now)) continue;

    let outcome: SendOutcome;

    try {
      outcome = await send(pending);
    } catch (error) {
      // Que `send` lance es el caso normal de una Server Action sin red: el
      // `fetch` de React rechaza. Se trata como reintentable, que es lo que es.
      outcome = {
        status: "reintentar",
        message: error instanceof Error ? error.message : "No se pudo enviar",
      };
    }

    if (outcome.status === "ok") {
      resolvePending(storage, scope, id, false);
      report.sent.push(id);
      continue;
    }

    if (outcome.status === "rechazado") {
      resolvePending(storage, scope, id, true);
      report.rejected.push({ eaAppointmentId: id, message: outcome.message });
      continue;
    }

    recordFailure(storage, scope, pending, outcome.message, now);
    report.retrying.push({ eaAppointmentId: id, message: outcome.message });
  }

  return report;
}

/**
 * Un id de intento razonablemente único sin depender de `crypto`.
 *
 * `crypto.randomUUID()` no existe en contextos no seguros, y el panel se abre
 * por IP en la red del estudio más de una vez. Esto no necesita ser
 * impredecible: solo necesita no repetirse entre dos envíos del mismo dedo.
 */
export function newRequestId(now = Date.now()): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
