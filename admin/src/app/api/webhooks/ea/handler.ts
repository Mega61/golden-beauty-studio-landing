import "server-only";

import type { Db } from "@/db";
import { repositories } from "@/db";
import { appointmentCodec, parseWebhookEnvelope, scrubSecret } from "@/lib/ea";
import type { EaClient } from "@/lib/ea/client";
import {
  hashWebhookBody,
  verifyWebhookSecret,
  type WebhookSecret,
} from "@/lib/webhook-verify";
import { upsertAppointmentFinance, type ListPriceLookup } from "@/jobs/snapshot";

/**
 * El handler del webhook de Easy!Appointments.
 *
 * Vive acá y no en `route.ts` para poder correrlo contra un MySQL de verdad sin
 * levantar Next: recibe un `Request` y devuelve un `Response`, que son APIs web
 * y no de framework. `route.ts` queda como lo que debe ser — leer la
 * configuración del entorno y delegar.
 *
 * ## Lo que este endpoint es y lo que no
 *
 * **Es un adelanto del reconcile, no la fuente de la verdad.** EA no reintenta:
 * `Webhooks_client::call()` traga la excepción y solo la loguea. Cada
 * despliegue del panel es una ventana de eventos perdidos para siempre. Por eso
 * este handler puede darse el lujo de ser estricto —rechaza lo que no entiende
 * en vez de adivinar— y por eso nada del diseño depende de que llegue.
 *
 * ## El orden de las cosas, que no es casual
 *
 * 1. **Verificar el header primero**, antes de leer el cuerpo. Un POST sin
 *    secreto no merece que gastemos memoria en su payload.
 * 2. **Hashear el cuerpo crudo**, no el JSON re-serializado: el hash tiene que
 *    identificar el byte a byte que llegó, y `JSON.stringify(JSON.parse(x))`
 *    normaliza espacios y orden de claves. Dos cuerpos distintos colapsarían en
 *    el mismo hash y el segundo evento se descartaría como duplicado.
 * 3. **Anotar en `webhook_event` antes de procesar.** Si el proceso muere en el
 *    medio, la fila queda sin `processed_at` y aparece en Diagnóstico. Anotar
 *    después dejaría el evento sin rastro justo en el caso que interesa.
 * 4. **Procesar en línea, no en segundo plano.** Guzzle espera la respuesta
 *    —la llamada está dentro de `notify_and_sync_appointment()`, que corre
 *    dentro de la petición de la clienta que está reservando— así que la
 *    tentación de responder 200 y seguir trabajando es real. No se hace: EA no
 *    reintenta, y un 200 antes de escribir convierte cualquier caída en un
 *    evento perdido con buena cara. El trabajo es una consulta a EA (memoizada)
 *    y un INSERT; el presupuesto de tiempo se acota bajándole el timeout al
 *    cliente de EA, no soltando la garantía.
 *
 * ## El cuerpo no se guarda
 *
 * `webhook_event` guarda el **hash**, nunca el cuerpo. Reprocesar no lo
 * necesita: el payload de EA es la fila cruda de `ea_appointments` y **no trae
 * precio**, así que reprocesar es volver a pedirle la cita a la API por su id —
 * exactamente lo que hace el reconcile. Guardarlo metería nombre y teléfono de
 * la clienta en una tabla de log sin política de retención, para no habilitar
 * nada que el id no habilite.
 */

export type EaWebhookDeps = {
  db: Db;
  ea: Pick<EaClient, "services">;
  secret: WebhookSecret;
  listPrice?: ListPriceLookup;
  /** Inyectable para que los tests no dependan del reloj. */
  now?: () => Date;
  /**
   * Secretos a tachar de cualquier texto que termine en la columna `error`.
   * El token de la API de EA y el del webhook: ninguno de los dos puede
   * aparecer en una tabla que alguien va a leer para depurar.
   */
  redact?: readonly (string | undefined)[];
};

/** Lo que se responde. Corto a propósito: EA descarta el cuerpo. */
type WebhookResult = {
  status: "processed" | "duplicate" | "ignored" | "rejected" | "error";
  detail?: string;
};

/** `TEXT` aguanta más, pero un stack entero en una tabla de log no se lee. */
const MAX_ERROR_LENGTH = 1000;

/** `webhook_event.action` es `VARCHAR(64)`. */
const MAX_ACTION_LENGTH = 64;

/**
 * Marcador para un cuerpo que ni siquiera es JSON.
 *
 * No es ninguna de las 18 acciones reales de EA, y eso es deliberado: quien
 * mire la tabla tiene que poder distinguir "llegó basura" de "llegó una acción
 * que no manejamos".
 */
const UNPARSEABLE = "(cuerpo ilegible)";

export async function handleEaWebhook(
  request: Request,
  deps: EaWebhookDeps,
): Promise<Response> {
  const verification = verifyWebhookSecret(request.headers, deps.secret);

  if (!verification.ok) {
    // El motivo va en el cuerpo porque el único que lo lee somos nosotros con
    // `curl` desde adentro del stack; EA descarta la respuesta. Nunca incluye
    // el valor recibido: ver `webhook-verify.ts`.
    return json({ status: "rejected", detail: verification.reason }, 401);
  }

  const now = deps.now ?? (() => new Date());
  const events = repositories(deps.db).webhookEvents;

  // El `try` arranca antes de leer el cuerpo y antes de anotar el evento, y no
  // solo alrededor del procesamiento. Si MySQL está caído, `record()` lanza; sin
  // este alcance la excepción se escaparía del handler y Next respondería un 500
  // pelado, imprimiendo el error crudo en el log del contenedor. Que el texto
  // pase por `redactedMessage()` no puede depender de por dónde falló.
  let eventId: number | null = null;

  try {
    const rawBody = await request.text();
    const bodyHash = hashWebhookBody(rawBody);
    const { action, entityId, parsed } = peek(rawBody);

    const event = await events.record({
      action,
      eaEntityId: entityId,
      bodyHash,
      receivedAt: now(),
    });
    eventId = event.id;

    if (event.duplicate) {
      // Mismo cuerpo, misma acción, misma entidad: ya se procesó. Los reenvíos
      // que hay que soportar son los **nuestros** —el reproceso manual desde
      // esta misma tabla— porque los de EA no existen.
      return json({ status: "duplicate" }, 200);
    }

    const result = await dispatch(deps, parsed);
    await events.markProcessed(event.id, now());
    return json(result, 200);
  } catch (error) {
    const detail = redactedMessage(error, deps.redact);

    if (eventId !== null) {
      // No se marca `processed_at`: es lo que hace que la fila salga en
      // `listUnprocessed()` y en Diagnóstico. Un evento que falló y se marca
      // como procesado es un evento perdido con buena cara.
      //
      // El `catch` vacío es deliberado y no es negligencia: se llega acá
      // cuando algo ya falló, y si lo que falló fue la propia base, escribirle
      // el error vuelve a fallar. Perder la anotación es feo; convertirlo en
      // una excepción sin manejar que tape el error original, peor.
      await events.markFailed(eventId, detail).catch(() => {});
    }

    return json({ status: "error", detail }, 500);
  }
}

/**
 * Mira el cuerpo lo justo para poder **anotarlo** aunque después no se pueda
 * procesar.
 *
 * Un cuerpo roto igual merece su fila de rastro, y con la acción y el id que se
 * le hayan podido sacar: son los dos datos con los que alguien va a buscar qué
 * pasó. La validación de verdad la hace `parseWebhookEnvelope` más adelante.
 */
function peek(rawBody: string): {
  action: string;
  entityId: number | null;
  parsed: unknown;
} {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { action: UNPARSEABLE, entityId: null, parsed: undefined };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { action: UNPARSEABLE, entityId: null, parsed };
  }

  const envelope = parsed as Record<string, unknown>;
  const rawAction = envelope.action;
  const action =
    typeof rawAction === "string" && rawAction.trim() !== ""
      ? rawAction.slice(0, MAX_ACTION_LENGTH)
      : UNPARSEABLE;

  const payload = envelope.payload;
  let entityId: number | null = null;

  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const id = (payload as Record<string, unknown>).id;
    // EA manda la fila cruda de MySQL y el driver de PHP serializa los enteros
    // como cadena en algunas configuraciones. Se aceptan las dos formas.
    const n = typeof id === "string" ? Number(id) : id;
    if (typeof n === "number" && Number.isInteger(n) && n > 0) entityId = n;
  }

  return { action, entityId, parsed };
}

/**
 * Qué hacer con cada acción.
 *
 * De las 18 acciones de EA, **una sola** tiene efecto acá. Las demás se anotan
 * y se responden: el rastro vale por sí mismo, y el día que Clientes o
 * Servicios necesiten reaccionar a un `customer_save` van a encontrar el evento
 * ya llegando.
 */
async function dispatch(deps: EaWebhookDeps, body: unknown): Promise<WebhookResult> {
  // Lanza con acción desconocida o payload que no es una fila. Que sea después
  // de anotar el evento es el punto: el rastro queda con el error adentro.
  const envelope = parseWebhookEnvelope(body);

  if (envelope.action !== "appointment_save") {
    return { status: "ignored", detail: envelope.action };
  }

  // `GET /appointments` de EA filtra `is_unavailability = false` y los bloqueos
  // de técnica disparan `unavailability_save`, así que esto no debería pasar
  // nunca. El guardia cuesta una línea y el error que evita —un bloqueo con
  // precio congelado y una fila en el libro de caja— cuesta un reporte.
  if (isTruthy(envelope.payload.is_unavailability)) {
    return { status: "ignored", detail: "unavailability" };
  }

  const appointment = appointmentCodec.fromRow(envelope.payload);
  const outcome = await upsertAppointmentFinance(deps, appointment, "webhook");

  return { status: "processed", detail: outcome.action };
}

/** EA manda `0`/`1`, `"0"`/`"1"` o `false`/`true` según por dónde salga la fila. */
function isTruthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0" && value !== "false";
  return false;
}

/**
 * El mensaje de un error, sin secretos y sin novela.
 *
 * `EaApiError` puede traer el cuerpo de la respuesta de EA, y el cliente de A1
 * ya lo tacha — pero este texto va a quedar guardado en `webhook_event.error`,
 * que es una tabla que se lee a mano y se pega en un chat cuando algo falla.
 * Tacharlo dos veces no cuesta nada; que se filtre una, sí.
 */
function redactedMessage(error: unknown, redact: readonly (string | undefined)[] = []): string {
  const base = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const clean = redact.reduce<string>((text, secret) => scrubSecret(text, secret), base);
  return clean.slice(0, MAX_ERROR_LENGTH);
}

function json(body: WebhookResult, status: number): Response {
  return Response.json(body, {
    status,
    // Un webhook cacheado sería un webhook que no llega. `no-store` es
    // redundante con el `POST` (Next no cachea otros métodos) y sigue estando
    // por si algún proxy del camino tuviera otra idea.
    headers: { "Cache-Control": "no-store" },
  });
}
