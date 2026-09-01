/**
 * Errores del cliente de EA.
 *
 * **Por qué están tipados y no son un `Error` cualquiera.** El panel tiene que
 * poder entrar en modo solo-lectura cuando EA no responde, y "no responde" no
 * es lo mismo que "el token está mal". Un 401 es un problema de configuración
 * que hay que mostrarle a la dueña; un 500 o una conexión rechazada es EA
 * caído, y ahí la agenda tiene que seguir dibujándose con lo último que se leyó
 * en vez de mostrar una pantalla de error. Distinguirlos con `error.message`
 * es cómo se termina con un `includes("401")` en un componente.
 *
 * **El token nunca aparece acá.** No se pone en la URL, no se copia al mensaje,
 * y los headers no se adjuntan al error. Por si algún día EA devolviera el
 * token en el cuerpo de un error (su handler de 401 responde texto plano, pero
 * el de 500 imprime la excepción con debug info), `scrubSecret()` lo tacha
 * antes de que el cuerpo llegue al error. Es defensa en profundidad: el error
 * de un cliente HTTP termina en un log, y un log con el token adentro es una
 * credencial publicada.
 */

/**
 * Qué salió mal, en la granularidad que el panel necesita para decidir.
 *
 * - `config` — falta `EA_API_URL` o `EA_API_TOKEN`, o la URL no es una URL. Se
 *   detecta antes de salir a la red.
 * - `unauthorized` — 401. Token equivocado o revocado en Ajustes de EA.
 * - `forbidden` — 403.
 * - `not_found` — 404. Recurso borrado, o id que ya no existe.
 * - `bad_request` — 4xx del resto. Lo que mandamos está mal; reintentar no
 *   ayuda.
 * - `server` — 5xx. EA vivo pero roto.
 * - `network` — no hubo respuesta: DNS, conexión rechazada, contenedor abajo.
 * - `timeout` — hubo conexión pero no respondió a tiempo.
 * - `malformed` — respondió 200 con algo que no es el JSON esperado.
 * - `pagination_overflow` — el listado no se agotó dentro del tope de páginas.
 *   Es un error a propósito: la alternativa sería devolver una agenda
 *   incompleta, y una cita que falta sin avisar es peor que una excepción.
 */
export type EaErrorKind =
  | "config"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "server"
  | "network"
  | "timeout"
  | "malformed"
  | "pagination_overflow";

export type EaErrorContext = {
  kind: EaErrorKind;
  status?: number;
  method?: string;
  /** Ruta relativa (`appointments/12`). **Nunca** lleva credenciales. */
  path?: string;
  /** Cuerpo de la respuesta, ya tachado y recortado. */
  body?: string;
  cause?: unknown;
};

/** Hasta acá se guarda del cuerpo de un error. Un stack trace de PHP es largo. */
const MAX_BODY_CHARS = 500;

/**
 * Tacha un secreto de un texto.
 *
 * Compara por longitud mínima para no reemplazar la cadena vacía y volver
 * ilegible cualquier mensaje. Se aplica al cuerpo y al mensaje de la causa.
 */
export function scrubSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join("«token»");
}

export class EaApiError extends Error {
  readonly kind: EaErrorKind;
  readonly status?: number;
  readonly method?: string;
  readonly path?: string;
  readonly body?: string;

  constructor(message: string, context: EaErrorContext) {
    super(message, context.cause !== undefined ? { cause: context.cause } : undefined);
    this.name = "EaApiError";
    this.kind = context.kind;
    this.status = context.status;
    this.method = context.method;
    this.path = context.path;
    this.body = context.body;
  }

  /**
   * ¿Vale la pena reintentar, o el panel debería pasar a solo-lectura?
   *
   * Un 4xx nuestro no se arregla repitiéndolo. Un 5xx, un timeout o una red
   * caída sí — y son los tres que tienen que disparar el modo degradado en vez
   * de una pantalla de error.
   */
  get isTransient(): boolean {
    return this.kind === "network" || this.kind === "timeout" || this.kind === "server";
  }

  /** ¿El problema es de configuración y no de EA? Lo mira Diagnóstico. */
  get isConfiguration(): boolean {
    return this.kind === "config" || this.kind === "unauthorized" || this.kind === "forbidden";
  }
}

/** Traduce un código HTTP al tipo de error. */
export function kindForStatus(status: number): EaErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "bad_request";
}

/**
 * Traduce lo que `fetch` lanza cuando no hubo respuesta.
 *
 * `fetch` tira un `TypeError` genérico tanto si el DNS falló como si el
 * contenedor rechazó la conexión; la distinción fina está en `cause.code` de
 * undici y no siempre viene. Todo eso es `network`, que es lo que el panel
 * necesita saber. El `AbortError` del timeout sí se separa, porque significa
 * "EA está vivo pero lento" y eso se diagnostica distinto.
 */
export function kindForThrown(error: unknown): EaErrorKind {
  if (error instanceof DOMException && error.name === "AbortError") return "timeout";
  if (error instanceof Error && error.name === "AbortError") return "timeout";
  if (error instanceof Error && error.name === "TimeoutError") return "timeout";
  return "network";
}

/** Recorta y tacha el cuerpo de una respuesta de error antes de guardarlo. */
export function safeBody(body: string, secret: string | undefined): string {
  const scrubbed = scrubSecret(body, secret);
  return scrubbed.length > MAX_BODY_CHARS ? `${scrubbed.slice(0, MAX_BODY_CHARS)}…` : scrubbed;
}
