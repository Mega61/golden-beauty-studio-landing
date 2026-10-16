/**
 * Cliente mínimo de la Cloud API de WhatsApp: mandar **una plantilla**.
 *
 * Es lo único que el panel le pide a Meta. Los recordatorios y la confirmación
 * salen fuera de la ventana de 24 h de conversación (la clienta no escribió
 * antes), y fuera de esa ventana Meta solo deja mandar plantillas aprobadas.
 * Texto libre por la API no existe para este caso — ver `docs/WHATSAPP.md`.
 *
 * ## Nunca lanza
 *
 * Devuelve `{ ok: true, messageId }` o `{ ok: false, retryable, code, message }`.
 * Quien llama tiene que escribir el resultado en `wa_message`, y un `throw` en
 * medio dejaría la fila en `pendiente` para siempre.
 *
 * ## `retryable` es "Meta dijo que no lo mandó", no "falló"
 *
 * Un timeout **no** es reintentable: Meta pudo haber aceptado el mensaje y la
 * respuesta perderse en el camino. Reintentarlo es arriesgarse a que la
 * clienta reciba dos veces el mismo aviso, que es exactamente lo que la
 * `UNIQUE (cita, tipo)` existe para impedir. Solo se reintenta lo que Meta
 * rechazó explícitamente por límite de tasa o por una caída suya declarada.
 *
 * ## El token y el teléfono no salen de acá
 *
 * Ningún mensaje de error lleva el token, y el teléfono va enmascarado si
 * alguna vez hace falta nombrarlo. El texto de error termina en
 * `wa_message.error`, que se lee a mano en Diagnóstico.
 */

import type { WhatsappConfig } from "./config";

export type SendTemplateInput = {
  /** E.164 con `+`. Meta lo acepta con o sin `+`; se manda sin. */
  to: string;
  templateName: string;
  /** Los `{{1}}…{{n}}` del cuerpo, en orden. */
  bodyParams: readonly string[];
};

export type SendResult =
  | { ok: true; messageId: string }
  | {
      ok: false;
      /** `true` = Meta declaró que **no** lo mandó y vale la pena reintentar más tarde. */
      retryable: boolean;
      /** Código de Meta, o `timeout` / `red` / `http-<status>` / `respuesta`. */
      code: string;
      /** En español, para la pantalla y el log. Sin secretos. */
      message: string;
    };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Cuánto esperar a Meta. Corre en `after()` o en el job, nunca frente a una persona. */
export const SEND_TIMEOUT_MS = 15_000;

/**
 * Qué significa cada código de error de Meta, para nosotros.
 *
 * La lista no es exhaustiva —Meta tiene decenas— y no hace falta que lo sea:
 * lo que no está acá cae en "no reintentable" con el texto de Meta, que es el
 * lado seguro. Están los que tienen una acción distinta.
 */
const META_ERRORS: Record<string, { retryable: boolean; message: string }> = {
  // Límites de tasa: Meta no lo mandó, y más tarde sí lo va a aceptar.
  "4": { retryable: true, message: "Meta frenó por límite de llamadas de la app." },
  "80007": { retryable: true, message: "Meta frenó por límite de tasa de la cuenta de WhatsApp." },
  "130429": { retryable: true, message: "Meta frenó por límite de envíos por segundo." },
  "131056": {
    retryable: true,
    message: "Demasiados mensajes seguidos al mismo número. Meta pide esperar.",
  },
  // Caídas declaradas por Meta.
  "1": { retryable: true, message: "Error temporal de la API de Meta." },
  "2": { retryable: true, message: "La API de Meta no está disponible por ahora." },
  "131016": { retryable: true, message: "El servicio de WhatsApp está caído por ahora." },
  "131000": { retryable: true, message: "Meta respondió un error desconocido." },

  // Credenciales y cuenta: nada se arregla reintentando.
  "190": {
    retryable: false,
    message: "El token de WhatsApp venció o es inválido. Generar uno nuevo del System User.",
  },
  "10": { retryable: false, message: "El token no tiene permiso para mandar mensajes." },
  "200": { retryable: false, message: "El token no tiene permiso sobre este número." },
  "131042": {
    retryable: false,
    message: "Problema con el método de pago de la cuenta de WhatsApp en Meta.",
  },
  "131031": { retryable: false, message: "La cuenta de WhatsApp del estudio está bloqueada." },
  "133010": { retryable: false, message: "El número del estudio no está registrado en la Cloud API." },
  "368": { retryable: false, message: "Meta bloqueó temporalmente la cuenta por política." },
  "100": { retryable: false, message: "Meta rechazó el pedido por un parámetro inválido." },

  // La destinataria.
  "131026": {
    retryable: false,
    message: "No se pudo entregar: el número no tiene WhatsApp o no acepta mensajes de empresas.",
  },
  "131030": {
    retryable: false,
    message: "El número no está en la lista de prueba de Meta (número de prueba).",
  },
  "131047": {
    retryable: false,
    message: "Pasaron más de 24 h desde que la clienta escribió: solo se puede mandar plantilla.",
  },
  "131049": { retryable: false, message: "Meta decidió no entregar este mensaje." },
  "131050": { retryable: false, message: "La clienta dejó de recibir mensajes de empresas." },
  "131051": { retryable: false, message: "Tipo de mensaje no admitido." },
  "131053": { retryable: false, message: "Meta no pudo procesar el contenido." },

  // Plantilla.
  "132000": {
    retryable: false,
    message: "La cantidad de parámetros no coincide con la plantilla aprobada.",
  },
  "132001": {
    retryable: false,
    message: "La plantilla no existe en ese idioma (o todavía no está aprobada).",
  },
  "132005": { retryable: false, message: "El texto de la plantilla con los datos quedó demasiado largo." },
  "132007": { retryable: false, message: "El contenido viola la política de plantillas de Meta." },
  "132012": { retryable: false, message: "Un parámetro no tiene el formato que espera la plantilla." },
  "132015": { retryable: false, message: "La plantilla está pausada por baja calidad." },
  "132016": { retryable: false, message: "La plantilla está deshabilitada por baja calidad." },
  "132018": { retryable: false, message: "Un parámetro trae saltos de línea o espacios de más." },
};

/** El error de Meta → nuestro resultado. Exportada para el test y para el webhook. */
export function mapMetaError(
  code: number | string | null | undefined,
  metaMessage?: string | null,
): { retryable: boolean; code: string; message: string } {
  const key = code === null || code === undefined ? "" : String(code);
  const known = META_ERRORS[key];
  const detail = (metaMessage ?? "").trim().slice(0, 200);
  if (known) return { retryable: known.retryable, code: key, message: known.message };
  return {
    retryable: false,
    code: key === "" ? "desconocido" : key,
    message: detail === "" ? "Meta rechazó el mensaje." : `Meta rechazó el mensaje: ${detail}`,
  };
}

/** El cuerpo del POST. Exportado para el test: es el contrato con Meta. */
export function templateRequestBody(input: SendTemplateInput, lang: string) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to.replace(/^\+/, ""),
    type: "template",
    template: {
      name: input.templateName,
      language: { code: lang },
      components:
        input.bodyParams.length === 0
          ? []
          : [
              {
                type: "body",
                parameters: input.bodyParams.map((text) => ({ type: "text", text })),
              },
            ],
    },
  };
}

type MetaErrorBody = {
  error?: { code?: number; error_subcode?: number; message?: string; error_data?: { details?: string } };
};
type MetaOkBody = { messages?: Array<{ id?: string }> };

/** Clasifica una respuesta HTTP de Meta. Pura, para testear sin red. */
export function classifyResponse(status: number, body: unknown): SendResult {
  if (status >= 200 && status < 300) {
    const id = (body as MetaOkBody | null)?.messages?.[0]?.id;
    if (typeof id === "string" && id !== "") return { ok: true, messageId: id };
    // 200 sin id: Meta lo aceptó pero no hay con qué seguirle el estado. Se
    // trata como no reintentable: reintentar podría duplicarlo.
    return { ok: false, retryable: false, code: "respuesta", message: "Meta respondió 200 sin id de mensaje." };
  }

  const err = (body as MetaErrorBody | null)?.error;
  if (err && (err.code !== undefined || err.message !== undefined)) {
    const mapped = mapMetaError(err.code ?? null, err.error_data?.details ?? err.message ?? null);
    return { ok: false, ...mapped };
  }

  // Sin cuerpo de error de Graph: un proxy, un 502 de Meta.
  return {
    ok: false,
    retryable: status === 429 || status >= 500,
    code: `http-${status}`,
    message: `Meta respondió ${status} sin detalle.`,
  };
}

/**
 * Manda una plantilla. Nunca lanza.
 *
 * `fetchImpl` entra por parámetro para el test; en producción es el `fetch`
 * global de Node.
 */
export async function sendTemplate(
  config: WhatsappConfig,
  input: SendTemplateInput,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = SEND_TIMEOUT_MS,
): Promise<SendResult> {
  const url = `https://graph.facebook.com/${config.graphVersion}/${config.phoneNumberId}/messages`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(templateRequestBody(input, config.templateLang)),
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (error) {
    const timeout =
      error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    // Ninguno de los dos es reintentable: no se sabe si Meta lo recibió.
    return timeout
      ? {
          ok: false,
          retryable: false,
          code: "timeout",
          message: "Meta no respondió a tiempo. Puede haber salido: no se reintenta solo.",
        }
      : {
          ok: false,
          retryable: false,
          code: "red",
          message: "No se pudo hablar con Meta (red). Puede haber salido: no se reintenta solo.",
        };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return classifyResponse(response.status, body);
}

// ── El texto de error que se guarda ─────────────────────────────────────────

const RETRYABLE_PREFIX = "reintentable";
const FINAL_PREFIX = "definitivo";

/**
 * `wa_message.error` lleva si el fallo es reintentable al principio del texto.
 *
 * En el texto y no en una columna nueva: la tabla ya tiene `error`, una
 * migración para un booleano que solo lee el job sería esquema de más, y el
 * prefijo se lee igual de bien a ojo en Diagnóstico.
 */
export function encodeSendError(result: Extract<SendResult, { ok: false }>): string {
  const prefix = result.retryable ? RETRYABLE_PREFIX : FINAL_PREFIX;
  return `${prefix}:${result.code}: ${result.message}`.slice(0, 500);
}

export function isRetryableError(error: string | null | undefined): boolean {
  return typeof error === "string" && error.startsWith(`${RETRYABLE_PREFIX}:`);
}

/** El texto para una persona, sin el prefijo técnico. */
export function readableSendError(error: string | null | undefined): string | null {
  if (typeof error !== "string" || error === "") return null;
  const match = /^(?:reintentable|definitivo):[^:]*:\s*([\s\S]*)$/.exec(error);
  return match ? match[1] : error;
}
