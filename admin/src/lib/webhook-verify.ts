import { createHash, timingSafeEqual } from "node:crypto";

/**
 * La "firma" de los webhooks de Easy!Appointments.
 *
 * **No es un HMAC del cuerpo.** La migración `060` de EA agrega dos columnas al
 * webhook — `secret_header` y `secret_token` — y `Webhooks_client::call()` las
 * manda tal cual:
 *
 * ```php
 * if (!empty($webhook['secret_header']) && !empty($webhook['secret_token'])) {
 *     $headers[$webhook['secret_header']] = $webhook['secret_token'];
 * }
 * ```
 *
 * Es decir: un header estático con un valor fijo. **No hay forma de verificar
 * que el cuerpo no fue alterado**, y ninguna cantidad de código nuestro la
 * inventa. Lo que este módulo puede afirmar es una sola cosa —"quien llamó
 * conoce el secreto"— y lo hace en tiempo constante para no volverse un oráculo
 * que revele el secreto byte por byte.
 *
 * Las dos mitigaciones que sí importan viven fuera de acá y hay que
 * mantenerlas:
 *
 * - **El endpoint solo se alcanza desde la red interna del stack.** EA le pega
 *   a `http://admin:3000/admin/api/webhooks/ea`; nunca sale del host, y Caddy
 *   no lo publica.
 * - **El webhook no puede mover plata por sí solo.** Todo lo que hace es
 *   congelar el precio de lista de una cita que ya existe en EA — y el precio
 *   lo resuelve pidiéndole el servicio a la API de EA, no leyéndolo del cuerpo.
 *   Un cuerpo falsificado no puede inventar un monto; a lo sumo puede pedir el
 *   snapshot de una cita que no existe, y entonces la resolución falla y la
 *   fila queda marcada.
 *
 * Nota operativa que se ve en el `if` de arriba: si a alguien se le olvida el
 * `secret_header` **o** el `secret_token` al registrar el webhook en EA, EA no
 * manda header y no avisa. Acá eso se ve como un rechazo, y del otro lado como
 * "las citas no tienen snapshot". Es el primer sospechoso cuando eso pasa.
 */

/** El par header/valor con el que EA firma. Nunca se registra en un log. */
export type WebhookSecret = {
  /** Nombre del header, p. ej. `X-GBS-Webhook`. Case-insensitive al comparar. */
  header: string;
  token: string;
};

/** Por qué se rechazó. **Nunca** incluye el valor recibido ni el esperado. */
export type WebhookRejection = "missing" | "empty" | "mismatch";

export type WebhookVerification =
  | { ok: true }
  | { ok: false; reason: WebhookRejection };

/** Lo mínimo que necesita el verificador. `Headers` de fetch lo cumple. */
export type HeaderSource = { get(name: string): string | null };

/**
 * Faltó configuración del webhook. Es distinto de "el secreto no coincide": un
 * panel mal configurado tiene que responder 503 y quedar visible en
 * Diagnóstico, no 401, que se leería como "EA está mandando mal el header".
 */
export class WebhookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookConfigError";
  }
}

type Env = Record<string, string | undefined>;

/**
 * Lee el secreto del entorno, o **falla**.
 *
 * Falla, y no devuelve `null`: un endpoint que se queda sin secreto no puede
 * degradarse a "acepto todo". La única degradación aceptable acá es dejar de
 * aceptar, porque el reconcile nocturno recupera lo que el webhook no trajo —
 * mientras que nada recupera una fila escrita por alguien de afuera.
 */
export function webhookSecretFromEnv(env: Env = process.env): WebhookSecret {
  const header = env.EA_WEBHOOK_SECRET_HEADER?.trim();
  const token = env.EA_WEBHOOK_SECRET_TOKEN?.trim();

  // Los mensajes nombran la variable que falta, jamás el valor de la que sí
  // está: este texto termina en un log y en la pantalla de Diagnóstico.
  if (!header) {
    throw new WebhookConfigError(
      "Falta EA_WEBHOOK_SECRET_HEADER. Es el nombre del header con el que EA " +
        "firma sus webhooks, y tiene que ser idéntico al configurado en EA.",
    );
  }

  if (!token) {
    throw new WebhookConfigError(
      "Falta EA_WEBHOOK_SECRET_TOKEN. Sin él el panel no puede distinguir un " +
        "evento de EA de cualquier otro POST, así que rechaza todos.",
    );
  }

  return { header, token };
}

/**
 * ¿Los dos textos son iguales, sin filtrar *cuánto* se parecen?
 *
 * `timingSafeEqual` exige buffers del mismo largo y **lanza** si no lo son, lo
 * que por sí solo ya filtraría el largo del secreto. Por eso se comparan los
 * sha256 de ambos, que miden siempre 32 bytes: el tiempo deja de depender del
 * contenido y de la longitud. La comparación de largos que va después no agrega
 * información — a esa altura los digests ya decidieron — y cubre el caso
 * teórico de una colisión de sha256.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/**
 * Verifica el header estático de un POST entrante.
 *
 * Devuelve un resultado en vez de lanzar porque el llamador tiene que
 * responder 401 y seguir vivo: un webhook rechazado es un dato de operación,
 * no una excepción del programa.
 */
export function verifyWebhookSecret(
  headers: HeaderSource,
  secret: WebhookSecret,
): WebhookVerification {
  const received = headers.get(secret.header);

  if (received === null) return { ok: false, reason: "missing" };

  // Un header presente pero vacío es el síntoma de un `secret_token` en blanco
  // del otro lado, y se distingue del ausente a propósito: son dos errores de
  // configuración distintos y se arreglan en lugares distintos.
  if (received.trim() === "") return { ok: false, reason: "empty" };

  // Sin `trim()` en el valor recibido: el secreto es el secreto. Recortarlo
  // haría que `" abc "` y `"abc"` fueran el mismo, y no lo son.
  if (!constantTimeEquals(received, secret.token)) {
    return { ok: false, reason: "mismatch" };
  }

  return { ok: true };
}

/** sha256 hex del cuerpo crudo. Es lo que `webhook_event` guarda **en vez** del cuerpo. */
export function hashWebhookBody(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}
