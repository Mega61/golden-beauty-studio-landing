/**
 * El webhook de WhatsApp (Meta), en funciones puras: firma, estados, bajas.
 *
 * La ruta (`app/api/public/whatsapp/webhook/route.ts`) solo cablea: lee el
 * cuerpo crudo, llama acá, y escribe lo que esto decide.
 *
 * ## La firma es un HMAC del cuerpo, no un header estático
 *
 * A diferencia del webhook de EA (ver `lib/webhook-verify.ts`), Meta **sí**
 * firma: `X-Hub-Signature-256: sha256=<hex>` es el HMAC-SHA256 del cuerpo
 * crudo con el secreto de la app. Se calcula sobre los **bytes tal como
 * llegaron**: un `JSON.parse` + `JSON.stringify` cambia espacios y escapes, y la
 * firma deja de coincidir con un cuerpo perfectamente legítimo.
 *
 * Esta ruta sí es pública —Meta la llama desde internet— y la firma es lo
 * único que separa un evento de Meta de cualquier POST. Sin `WHATSAPP_APP_SECRET`
 * la ruta rechaza todo; no se degrada a "acepto".
 *
 * ## Los estados nunca van para atrás
 *
 * Meta no garantiza el orden: un `delivered` puede llegar después del `read`,
 * y un reintento suyo puede repetir un `sent` horas después. Cada estado
 * entrante se aplica solo si el actual está **antes** en la escalera
 * `pendiente → enviado → entregado → leido`. Eso hace al webhook idempotente
 * y lo deja inmune al desorden con un solo `UPDATE … WHERE status IN (…)`.
 */

import { createHmac } from "node:crypto";

import type { WaMessageStatus } from "@/db/types";
import { constantTimeEquals } from "@/lib/webhook-verify";

import { mapMetaError } from "./cloud-api";

// ── Firma ───────────────────────────────────────────────────────────────────

export type SignatureCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "malformed" | "mismatch" };

export function signatureFor(rawBody: string, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
}

/**
 * ¿El cuerpo lo firmó quien conoce el secreto de la app?
 *
 * La comparación es en tiempo constante (`constantTimeEquals`, la misma del
 * webhook de EA): un `===` deja medir cuántos caracteres coinciden.
 */
export function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  appSecret: string,
): SignatureCheck {
  if (header === null || header.trim() === "") return { ok: false, reason: "missing" };
  const received = header.trim();
  if (!/^sha256=[0-9a-fA-F]{64}$/.test(received)) return { ok: false, reason: "malformed" };
  const expected = signatureFor(rawBody, appSecret);
  // Meta manda el hex en minúsculas; se normaliza por si un proxy lo cambiara.
  return constantTimeEquals(`sha256=${received.slice(7).toLowerCase()}`, expected)
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

/**
 * El `GET` de suscripción: Meta manda `hub.mode=subscribe`, `hub.verify_token`
 * y `hub.challenge`, y espera de vuelta el `challenge` tal cual. Devuelve el
 * texto a responder o `null` (403).
 */
export function verificationChallenge(
  params: URLSearchParams,
  verifyToken: string,
): string | null {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (mode !== "subscribe" || token === null || challenge === null) return null;
  if (!constantTimeEquals(token, verifyToken)) return null;
  // El challenge es un número; cualquier otra cosa no se refleja (no se le
  // devuelve a internet un texto arbitrario que llegó por la URL).
  return /^[A-Za-z0-9_-]{1,128}$/.test(challenge) ? challenge : null;
}

// ── Estados ─────────────────────────────────────────────────────────────────

/** El estado de Meta → el nuestro. Los demás (`deleted`, `warning`…) se ignoran. */
export function mapMetaStatus(status: string): WaMessageStatus | null {
  switch (status) {
    case "sent":
      return "enviado";
    case "delivered":
      return "entregado";
    case "read":
      return "leido";
    case "failed":
      return "fallido";
    default:
      return null;
  }
}

/**
 * Desde qué estados se puede llegar a `next`.
 *
 * `fallido` solo desde `pendiente` o `enviado`: un mensaje que ya se entregó
 * no "falla" después, y si Meta lo dijera igual, lo que pasó (llegó) gana.
 * `omitido` y `fallido` nunca son origen: ninguna confirmación de Meta
 * resucita una fila que nosotros decidimos no mandar o que ya se dio por
 * perdida (y que quizás recepción ya mandó a mano).
 */
export function allowedPredecessors(next: WaMessageStatus): WaMessageStatus[] {
  switch (next) {
    case "enviado":
      return ["pendiente"];
    case "entregado":
      return ["pendiente", "enviado"];
    case "leido":
      return ["pendiente", "enviado", "entregado"];
    case "fallido":
      return ["pendiente", "enviado"];
    default:
      return [];
  }
}

/** El estado que queda: `next` si avanza, `null` si no cambia nada. */
export function nextStatus(
  current: WaMessageStatus,
  incoming: WaMessageStatus,
): WaMessageStatus | null {
  return allowedPredecessors(incoming).includes(current) ? incoming : null;
}

// ── Bajas ───────────────────────────────────────────────────────────────────

/**
 * Las palabras que dan de baja, **como mensaje completo**.
 *
 * Mensaje completo y no "contiene": "no puedo ir mañana" no es una baja, y
 * tratarlo como una le quitaría los avisos a quien justamente los necesita.
 * "NO" solo está porque es la respuesta más corta a "¿quieres seguir
 * recibiendo?"; el recordatorio no pregunta nada por sí/no, así que es raro
 * que alguien lo mande suelto por otro motivo. Si pasa, la baja se ve en
 * `/recordatorios` como "Pidió no recibir recordatorios" y recepción lo aclara
 * por el mismo chat — que con Coexistence está en el WhatsApp del estudio.
 */
const OPT_OUT_WORDS = new Set(["BAJA", "STOP", "NO", "DAR DE BAJA", "NO MAS", "NO MAS MENSAJES"]);

export function normalizeKeyword(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isOptOutKeyword(text: string): boolean {
  return OPT_OUT_WORDS.has(normalizeKeyword(text));
}

// ── El cuerpo ───────────────────────────────────────────────────────────────

export type StatusEvent = {
  providerMessageId: string;
  status: WaMessageStatus;
  /** Solo en `fallido`: el texto que va a `wa_message.error`. */
  error: string | null;
};

export type InboundText = {
  /** Dígitos, sin `+`, como los manda Meta. */
  from: string;
  text: string;
};

export type ParsedWebhook = {
  statuses: StatusEvent[];
  inbound: InboundText[];
};

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Lo que interesa de un POST de Meta: estados de mensajes nuestros y textos
 * entrantes. Todo lo demás se ignora sin error — Meta agrega campos y tipos de
 * evento sin avisar, y un webhook que rechaza lo que no conoce hace que Meta
 * reintente para siempre.
 *
 * `phoneNumberId`, si está, filtra: una cuenta de WhatsApp puede tener más de
 * un número y solo nos importan los eventos del nuestro.
 */
export function parseWebhookPayload(body: unknown, phoneNumberId: string | null): ParsedWebhook {
  const out: ParsedWebhook = { statuses: [], inbound: [] };
  if (!isObj(body)) return out;

  for (const entry of arr(body.entry)) {
    if (!isObj(entry)) continue;
    for (const change of arr(entry.changes)) {
      if (!isObj(change) || change.field !== "messages" || !isObj(change.value)) continue;
      const value = change.value;

      const metadata = isObj(value.metadata) ? value.metadata : {};
      const target = str(metadata.phone_number_id);
      if (phoneNumberId !== null && target !== null && target !== phoneNumberId) continue;

      for (const raw of arr(value.statuses)) {
        if (!isObj(raw)) continue;
        const id = str(raw.id);
        const status = mapMetaStatus(str(raw.status) ?? "");
        if (id === null || id === "" || status === null) continue;

        let error: string | null = null;
        if (status === "fallido") {
          const first = arr(raw.errors)[0];
          const e = isObj(first) ? first : {};
          const data = isObj(e.error_data) ? e.error_data : {};
          const mapped = mapMetaError(
            typeof e.code === "number" || typeof e.code === "string" ? e.code : null,
            str(data.details) ?? str(e.message) ?? str(e.title),
          );
          // Un fallo informado por el webhook es siempre definitivo para el
          // job: el mensaje ya había sido aceptado, y reintentarlo es la
          // clase de duplicado que esta tabla existe para impedir.
          error = `definitivo:${mapped.code}: ${mapped.message}`.slice(0, 500);
        }
        out.statuses.push({ providerMessageId: id, status, error });
      }

      for (const raw of arr(value.messages)) {
        if (!isObj(raw) || raw.type !== "text") continue;
        const from = str(raw.from);
        const text = isObj(raw.text) ? str(raw.text.body) : null;
        if (from === null || text === null || !/^\d{7,15}$/.test(from)) continue;
        out.inbound.push({ from, text });
      }
    }
  }

  return out;
}

// ── Aplicar ─────────────────────────────────────────────────────────────────

/** Lo que el webhook escribe. `waMessageRepository` lo cumple. */
export type WebhookStore = {
  applyProviderStatus(input: {
    providerMessageId: string;
    status: WaMessageStatus;
    from: readonly WaMessageStatus[];
    error: string | null;
  }): Promise<number>;
  addOptout(phoneE164: string, reason: string | null): Promise<boolean>;
};

export type WebhookApplied = { updated: number; ignored: number; optouts: number };

/**
 * Escribe lo que trajo el POST. Idempotente: un estado repetido no matchea el
 * `WHERE status IN (…)` y una baja repetida choca con la llave primaria.
 *
 * `normalizePhone` entra por parámetro para no arrastrar el módulo de
 * identidad (y su árbol) a los tests de este archivo.
 */
export async function applyWebhook(
  parsed: ParsedWebhook,
  store: WebhookStore,
  normalizePhone: (raw: string) => string | null,
): Promise<WebhookApplied> {
  const result: WebhookApplied = { updated: 0, ignored: 0, optouts: 0 };

  for (const event of parsed.statuses) {
    const changed = await store.applyProviderStatus({
      providerMessageId: event.providerMessageId,
      status: event.status,
      from: allowedPredecessors(event.status),
      error: event.error,
    });
    if (changed > 0) result.updated += changed;
    else result.ignored += 1;
  }

  for (const message of parsed.inbound) {
    if (!isOptOutKeyword(message.text)) continue;
    const phone = normalizePhone(`+${message.from}`);
    if (phone === null) continue;
    if (await store.addOptout(phone, "Respondió por WhatsApp pidiendo no recibir más")) {
      result.optouts += 1;
    }
  }

  return result;
}
