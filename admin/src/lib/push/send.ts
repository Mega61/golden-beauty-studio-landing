import "server-only";

import webpush from "web-push";

import { getDb } from "@/db/client";
import { allowedUserRepository, repositories } from "@/db/repositories";
import type { DeliverableSubscription } from "@/db/repositories";
import { instantToEaDate } from "@/lib/ea";
import { loadAppointmentForMessage } from "@/lib/whatsapp/load-appointment";

import { PANEL_BASE_PATH, parseVapidEnv, type VapidConfig } from "./config";
import {
  buildNewBookingPayload,
  buildOwnBookingPayload,
  type NewBookingNotice,
  type PushPayload,
} from "./payload";
import { bookingRecipients } from "./recipients";
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
 * Quién recibe qué por una cita nueva (`recipients.ts`).
 *
 * El rol y la columna se vuelven a leer de `allowed_user` en cada envío, con
 * la misma normalización que el DAL. Quien salió de Equipo deja de recibir
 * nombres de clientas en el aviso siguiente, aunque su fila siga en la tabla.
 */
async function recipientsFor(input: {
  providerId: number | null;
  source: "web" | "panel";
  actorUserId?: string | null;
}): Promise<{ general: DeliverableSubscription[]; own: DeliverableSubscription[] }> {
  const db = getDb();
  const [subscriptions, allowlist] = await Promise.all([
    repositories(db).pushSubscriptions.listDeliverable(),
    allowedUserRepository(db).list(),
  ]);
  return bookingRecipients({ subscriptions, allowlist, ...input });
}

export type WebBookingForPush = Omit<NewBookingNotice, "serviceName"> & {
  /** La columna de la cita: su profesional recibe "Nueva cita en tu agenda". */
  providerId: number | null;
  /** Para buscar el nombre del servicio solo si hay a quién avisarle. */
  resolveServiceName: () => Promise<string | null>;
};

/**
 * "Nueva reserva" a dueña y recepción, y "Nueva cita en tu agenda" a la
 * profesional de esa columna.
 *
 * El nombre del servicio se pide a EA **después** de saber que hay a quién
 * avisarle: sin suscripciones (o sin llaves) una reserva no cuesta ni una
 * consulta más.
 */
export async function notifyNewWebBooking(booking: WebBookingForPush): Promise<void> {
  const vapid = vapidConfig();
  if (vapid === null) return;

  try {
    const { general, own } = await recipientsFor({ providerId: booking.providerId, source: "web" });
    if (general.length === 0 && own.length === 0) return;

    let serviceName: string | null = null;
    try {
      serviceName = await booking.resolveServiceName();
    } catch (error) {
      // El aviso sale igual, con "servicio" genérico: enterarse de la reserva
      // importa más que el nombre exacto.
      console.error("[push] no se pudo leer el servicio de la reserva", error);
    }

    const { resolveServiceName: _omit, providerId: _provider, ...rest } = booking;
    void _omit;
    void _provider;
    const today = instantToEaDate(new Date());
    await Promise.all([
      general.length === 0
        ? 0
        : deliver(general, buildNewBookingPayload({ ...rest, serviceName }, today, PANEL_BASE_PATH), vapid),
      own.length === 0
        ? 0
        : deliver(own, buildOwnBookingPayload({ ...rest, serviceName }, today, PANEL_BASE_PATH), vapid),
    ]);
  } catch (error) {
    console.error("[push] no se pudo avisar la reserva web", error);
  }
}

/**
 * "Nueva cita en tu agenda" por una cita creada **desde el panel**: a la
 * profesional de esa columna, salvo que la haya agendado ella misma.
 *
 * Corre en `after()` desde la agenda. La cita se lee de EA solo si hay alguien
 * a quién avisarle — la mayoría de las citas del panel no cuestan ni una
 * consulta más. Nunca lanza.
 */
export async function notifyPanelBooking(input: {
  appointmentId: number;
  providerId: number;
  actorUserId: string;
}): Promise<void> {
  const vapid = vapidConfig();
  if (vapid === null) return;

  try {
    const { own } = await recipientsFor({
      providerId: input.providerId,
      source: "panel",
      actorUserId: input.actorUserId,
    });
    if (own.length === 0) return;

    // Fresca, con los adicionales ("Esculpidas en acrílico y Semipermanente pies").
    const appointment = await loadAppointmentForMessage(input.appointmentId);
    const first = appointment.customerFirstName ?? "";
    const last = appointment.customerName.startsWith(first)
      ? appointment.customerName.slice(first.length).trim()
      : "";
    const payload = buildOwnBookingPayload(
      {
        appointmentId: input.appointmentId,
        serviceName: appointment.serviceName,
        customerFirstName: first,
        customerLastName: last,
        start: appointment.start,
      },
      instantToEaDate(new Date()),
      PANEL_BASE_PATH,
    );
    await deliver(own, payload, vapid);
  } catch (error) {
    console.error("[push] no se pudo avisar la cita a su profesional", input.appointmentId, error);
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
  // Con la misma cara que uno de verdad: probar el aviso es ver cómo se va a
  // ver cuando entre una reserva, no leer que "funciona".
  const payload: PushPayload = {
    title: "Así te llega una reserva ✨",
    body: "Semipermanente manos\nLaura M. · mañana 10 a. m. · (esto es una prueba)",
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
