import "server-only";

import webpush from "web-push";

import { getDb } from "@/db/client";
import { allowedUserRepository, repositories } from "@/db/repositories";
import type { DeliverableSubscription } from "@/db/repositories";
import { can, findAllowedEntry } from "@/lib/auth-policy";
import { instantToEaDate } from "@/lib/ea";

import { PANEL_BASE_PATH, parseVapidEnv, type VapidConfig } from "./config";
import { buildNewBookingPayload, type NewBookingNotice, type PushPayload } from "./payload";
import { classifyPushError, classifyPushStatus, planPrune, type PushOutcome } from "./prune";

/**
 * El envío de avisos Web Push. Lo único de `lib/push` que toca red y base.
 *
 * ## Nunca lanza
 *
 * `notifyNewWebBooking` corre dentro de `after()` en la ruta de reserva, cuando
 * la clienta ya tiene su 201. Aun así no lanza: un error acá solo puede
 * terminar en el log, y lo que hay que ver en el log es *qué* falló (`[push]`)
 * y no un stack de Next sin contexto.
 */

/** La configuración VAPID del proceso, o `null` si la función está apagada. */
export function vapidConfig(): VapidConfig | null {
  return parseVapidEnv(process.env);
}

/**
 * Cuánto guarda el servicio de push un aviso para un celular apagado. Seis
 * horas: una reserva de la mañana que llega a la noche ya se vio en la agenda,
 * y un aviso viejo que aparece tarde confunde más de lo que informa.
 */
const TTL_SECONDS = 6 * 60 * 60;

async function sendOne(
  sub: Pick<DeliverableSubscription, "endpoint" | "p256dh" | "auth">,
  payload: PushPayload,
  vapid: VapidConfig,
): Promise<PushOutcome> {
  try {
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      {
        vapidDetails: vapid,
        TTL: TTL_SECONDS,
        // `high` despierta al celular en reposo: una reserva es para enterarse ya.
        urgency: "high",
        timeout: 10_000,
      },
    );
    return classifyPushStatus(res.statusCode);
  } catch (error) {
    return classifyPushError(error);
  }
}

/**
 * Manda `payload` a cada suscripción y aplica la poda en tres escrituras.
 * Devuelve cuántas lo aceptaron.
 */
async function deliver(
  subs: readonly DeliverableSubscription[],
  payload: PushPayload,
  vapid: VapidConfig,
): Promise<number> {
  const outcomes = await Promise.all(
    subs.map(async (s) => ({
      id: s.id,
      failureCount: s.failureCount,
      outcome: await sendOne(s, payload, vapid),
    })),
  );

  for (const o of outcomes) {
    if (o.outcome.kind === "ours") {
      // Es un bug nuestro, no del celular: que se vea.
      console.error(`[push] el servicio rechazó el pedido (${o.outcome.statusCode}) para la suscripción ${o.id}`);
    }
  }

  const plan = planPrune(outcomes);
  const repo = repositories(getDb()).pushSubscriptions;
  const now = new Date();
  await Promise.all([
    repo.markSuccess(plan.success, now),
    repo.recordFailure(plan.failure, now),
    repo.deleteByIds(plan.remove),
  ]);
  return plan.success.length;
}

/**
 * Las suscripciones cuya dueña **hoy** alcanza el aviso.
 *
 * El rol se vuelve a leer de `allowed_user` en cada envío, con la misma
 * normalización que el DAL. Quien salió de Equipo deja de recibir nombres de
 * clientas en el aviso siguiente, aunque su fila siga en la tabla.
 */
async function eligibleSubscriptions(): Promise<DeliverableSubscription[]> {
  const db = getDb();
  const [subs, allowlist] = await Promise.all([
    repositories(db).pushSubscriptions.listDeliverable(),
    allowedUserRepository(db).list(),
  ]);
  return subs.filter((s) => {
    const entry = findAllowedEntry(s.email, allowlist);
    return entry !== null && can(entry.role, "avisos:reservas-web");
  });
}

export type WebBookingForPush = Omit<NewBookingNotice, "serviceName"> & {
  /** Para buscar el nombre del servicio solo si hay a quién avisarle. */
  resolveServiceName: () => Promise<string | null>;
};

/**
 * "Nueva reserva" a todos los dispositivos suscritos con permiso.
 *
 * El nombre del servicio se pide a EA **después** de saber que hay a quién
 * avisarle: sin suscripciones (o sin llaves) una reserva no cuesta ni una
 * consulta más.
 */
export async function notifyNewWebBooking(booking: WebBookingForPush): Promise<void> {
  const vapid = vapidConfig();
  if (vapid === null) return;

  try {
    const subs = await eligibleSubscriptions();
    if (subs.length === 0) return;

    let serviceName: string | null = null;
    try {
      serviceName = await booking.resolveServiceName();
    } catch (error) {
      // El aviso sale igual, con "servicio" genérico: enterarse de la reserva
      // importa más que el nombre exacto.
      console.error("[push] no se pudo leer el servicio de la reserva", error);
    }

    const { resolveServiceName: _omit, ...rest } = booking;
    void _omit;
    const payload = buildNewBookingPayload(
      { ...rest, serviceName },
      instantToEaDate(new Date()),
      PANEL_BASE_PATH,
    );
    await deliver(subs, payload, vapid);
  } catch (error) {
    console.error("[push] no se pudo avisar la reserva web", error);
  }
}

/**
 * Un aviso de prueba a **un** dispositivo de quien lo pide, desde Ajustes.
 * Devuelve el resultado para que la pantalla diga si llegó al servicio.
 */
export async function sendTestPush(
  sub: Pick<DeliverableSubscription, "id" | "endpoint" | "p256dh" | "auth" | "failureCount">,
): Promise<PushOutcome> {
  const vapid = vapidConfig();
  if (vapid === null) return { kind: "failed", statusCode: null };
  const payload: PushPayload = {
    title: "Avisos activos",
    body: "Así te va a llegar cada reserva que entre por la página.",
    url: `${PANEL_BASE_PATH}/ajustes`,
    tag: "prueba",
  };
  const outcome = await sendOne(sub, payload, vapid);
  const plan = planPrune([{ id: sub.id, failureCount: sub.failureCount, outcome }]);
  const repo = repositories(getDb()).pushSubscriptions;
  const now = new Date();
  await Promise.all([
    repo.markSuccess(plan.success, now),
    repo.recordFailure(plan.failure, now),
    repo.deleteByIds(plan.remove),
  ]);
  return outcome;
}
