import { getDb } from "@/db";
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

  return handleEaWebhook(request, {
    db: getDb(),
    ea: createEaClient({ ...config, timeoutMs: LOOKUP_TIMEOUT_MS }),
    secret,
    // Los tres secretos que este camino podría llegar a tocar. `DATABASE_URL`
    // entra porque lleva la contraseña adentro de la URL y un error del driver
    // podría arrastrarla hasta `webhook_event.error`, que es una tabla que se
    // lee a mano y se pega en un chat cuando algo falla.
    redact: [config.token, secret.token, process.env.DATABASE_URL],
  });
}
