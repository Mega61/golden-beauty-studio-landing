import { getDb } from "@/db";
import { resourceOfWebhookAction, sharedEaCache } from "@/lib/ea/cache";
import { createEaClient, eaConfigFromEnv } from "@/lib/ea/client";
import { webhookSecretFromEnv } from "@/lib/webhook-verify";

import { handleEaWebhook } from "./handler";

/**
 * `POST /admin/api/webhooks/ea` — el webhook de Easy!Appointments.
 *
 * La ruta lleva el `/admin` de `basePath`, así que en EA se registra
 * `http://gbs-admin:3000/admin/api/webhooks/ea` — el nombre del contenedor
 * sobre la red `web`, la misma por la que Caddy ya alcanza a `golden-agenda`.
 * Nunca el dominio público: la "firma" de EA es un header estático y no un HMAC
 * del cuerpo (ver `lib/webhook-verify.ts`), y que el tráfico no salga del host
 * es la mitad de esa mitigación.
 *
 * ⚠ **La otra mitad todavía no está.** El `next.config.ts` de la landing
 * rewritea `/admin/:path*` entero hacia la VM, así que hoy
 * `goldenbeautystudio.com.co/admin/api/webhooks/ea` **también** llega acá desde
 * internet. El header estático queda como único filtro, que es justo lo que el
 * plan quiso evitar. Excluir `/admin/api/webhooks/` de ese rewrite (o cortarlo
 * en Caddy) es trabajo del paquete de infraestructura, no de éste.
 *
 * Toda la lógica está en `handler.ts`, que recibe un `Request` y devuelve un
 * `Response`. Acá solo se lee el entorno. La razón es el test: el handler se
 * ejercita contra un MySQL real sin levantar Next, y lo que quedaría sin
 * probar en este archivo son cuatro líneas de cableado.
 *
 * `dynamic = "force-dynamic"` no hace falta —los `POST` nunca se cachean— pero
 * está por lo mismo que el `Cache-Control` del handler: la única forma de que
 * este endpoint falle en silencio es que algo del camino decida guardarse una
 * respuesta.
 */
export const dynamic = "force-dynamic";

/**
 * Cuánto esperar a que EA conteste el precio del servicio.
 *
 * Más corto que el timeout general del cliente (10 s) porque este camino corre
 * **dentro de la petición de la clienta que está reservando**: Guzzle espera la
 * respuesta desde `notify_and_sync_appointment()`. Que se le agote el tiempo no
 * pierde la cita — la fila se crea igual, marcada `fallback`, y el reconcile de
 * esa noche la repara.
 */
const LOOKUP_TIMEOUT_MS = 4_000;

export async function POST(request: Request): Promise<Response> {
  let secret;

  try {
    secret = webhookSecretFromEnv();
  } catch (error) {
    // 503 y no 401: el problema es de configuración nuestra, y confundirlos
    // mandaría a buscar el error en la pantalla de webhooks de EA. El mensaje
    // nombra la variable que falta, nunca el valor de ninguna.
    return Response.json(
      { status: "misconfigured", detail: error instanceof Error ? error.message : "" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const config = eaConfigFromEnv();
  // El handler consume el cuerpo; la acción se lee de una copia.
  const copy = request.clone();

  const response = await handleEaWebhook(request, {
    db: getDb(),
    ea: createEaClient({ ...config, timeoutMs: LOOKUP_TIMEOUT_MS }),
    secret,
    // Los tres secretos que este camino podría llegar a tocar. `DATABASE_URL`
    // entra porque lleva la contraseña adentro de la URL y un error del driver
    // podría arrastrarla hasta `webhook_event.error`, que es una tabla que se
    // lee a mano y se pega en un chat cuando algo falla.
    redact: [config.token, secret.token, process.env.DATABASE_URL],
  });

  await invalidateFor(copy, response.status);
  return response;
}

/**
 * Vence la caché de lecturas (`lib/ea/cache.ts`) según el recurso del evento.
 *
 * Es lo que hace que un cambio hecho **en la interfaz de EA** —una cita que la
 * dueña movió desde allá, un bloqueo— se vea en la agenda y en la reserva
 * pública sin esperar al TTL.
 *
 * Solo con el secreto verificado (todo lo que no sea 401). La ruta es
 * alcanzable desde internet (ver arriba), y un POST anónimo que pudiera vaciar
 * la caché sería una forma barata de empujar al panel contra el cupo de 100
 * peticiones de EA. Se invalida aunque el procesamiento haya fallado: el
 * cambio en EA ya ocurrió, falle o no el snapshot de precio.
 */
async function invalidateFor(copy: Request, status: number): Promise<void> {
  if (status === 401) return;
  try {
    const body = JSON.parse(await copy.text()) as { action?: unknown };
    const resource =
      typeof body.action === "string" ? resourceOfWebhookAction(body.action) : null;
    if (resource) sharedEaCache().invalidateResource(resource);
  } catch {
    // Un cuerpo ilegible ya quedó anotado por el handler; no cambió nada en EA
    // que sepamos invalidar.
  }
}
