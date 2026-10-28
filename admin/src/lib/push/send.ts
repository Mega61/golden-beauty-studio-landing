import "server-only";

import webpush from "web-push";

import { getDb } from "@/db/client";
import { allowedUserRepository, repositories } from "@/db/repositories";
import type { DeliverableSubscription } from "@/db/repositories";
import { instantToEaDate } from "@/lib/ea";
import { mapEaStatus } from "@/components/calendar/status-map";
import { createEaClient, type EaClient } from "@/lib/ea/client";
import type { Appointment } from "@/lib/ea/types";
import { loadPlannedServices, namesWithExtras } from "@/lib/planned-services";

import { createCoalescer, type Coalescer } from "./coalesce";
import { PANEL_BASE_PATH, parseVapidEnv, type VapidConfig } from "./config";
import {
  buildCancelPayload,
  buildChangePayload,
  buildNewBookingPayload,
  buildOwnBookingPayload,
  buildPanelBookingPayload,
  diffAppointment,
  type AppointmentState,
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
  previousProviderId?: number | null;
  actorUserIds?: readonly string[];
}): Promise<{
  general: DeliverableSubscription[];
  own: DeliverableSubscription[];
  left: DeliverableSubscription[];
}> {
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
    const { general, own } = await recipientsFor({ providerId: booking.providerId });
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

// ---------------------------------------------------------------------------
// Lo que pasa en la agenda del panel: citas nuevas, cambios y cancelaciones
// ---------------------------------------------------------------------------

/** Quien hizo el cambio desde el panel. Nunca recibe el aviso. */
export type PushActor = { userId: string; name: string | null };

function stateOf(appointment: Appointment, extras: readonly number[]): AppointmentState {
  return {
    start: String(appointment.start),
    end: String(appointment.end),
    providerId: appointment.providerId,
    serviceId: appointment.serviceId,
    customerId: appointment.customerId,
    extraServiceIds: extras,
    cancelled: mapEaStatus(appointment.status) === "cancelada",
  };
}

/** La cita tal como está en EA ahora, con sus adicionales. Fresca: sin caché. */
async function loadState(
  ea: EaClient,
  appointmentId: number,
): Promise<{ appointment: Appointment; state: AppointmentState }> {
  const [appointment, planned] = await Promise.all([
    ea.appointments.get(appointmentId),
    loadPlannedServices([appointmentId]),
  ]);
  const extras = planned.get(appointmentId) ?? [];
  return { appointment, state: stateOf(appointment, extras) };
}

/** El nombre de pila de una técnica, o `null`: el aviso sale igual sin él. */
async function providerFirstName(ea: EaClient, providerId: number | null): Promise<string | null> {
  if (providerId === null) return null;
  try {
    return (await ea.providers.get(providerId)).firstName ?? null;
  } catch {
    return null;
  }
}

/**
 * Lo que dice el aviso de una cita: servicio (con los adicionales —"Esculpidas
 * en acrílico y Semipermanente pies"—), clienta y técnica. Nunca el teléfono.
 */
async function describe(
  ea: EaClient,
  appointment: Appointment,
  extras: readonly number[],
): Promise<Omit<NewBookingNotice, "appointmentId" | "start">> {
  const nameOf = (id: number) =>
    ea.services
      .get(id)
      .then((s) => s.name ?? null)
      .catch(() => null);
  const [customer, mainName, extraNames, providerName] = await Promise.all([
    appointment.customerId === null
      ? null
      : ea.customers.get(appointment.customerId).catch(() => null),
    appointment.serviceId === null ? null : nameOf(appointment.serviceId),
    Promise.all(extras.map(nameOf)),
    providerFirstName(ea, appointment.providerId),
  ]);
  return {
    serviceName: namesWithExtras(mainName, extras, (id) => extraNames[extras.indexOf(id)] ?? null),
    customerFirstName: customer?.firstName ?? "",
    customerLastName: customer?.lastName ?? "",
    providerName,
  };
}

/**
 * Una cita creada **desde el panel**: "Nueva cita ✨" a dueña y recepción, y
 * "Nueva cita en tu agenda" a la profesional de esa columna — a nadie que la
 * haya agendado.
 *
 * Corre en `after()` desde la agenda. La cita se lee de EA solo si hay alguien
 * a quién avisarle. Nunca lanza.
 */
export async function notifyPanelBooking(input: {
  appointmentId: number;
  providerId: number;
  actor: PushActor;
}): Promise<void> {
  const vapid = vapidConfig();
  if (vapid === null) return;

  try {
    const { general, own } = await recipientsFor({
      providerId: input.providerId,
      actorUserIds: [input.actor.userId],
    });
    if (general.length === 0 && own.length === 0) return;

    const ea = createEaClient();
    const { appointment, state } = await loadState(ea, input.appointmentId);
    const notice = {
      appointmentId: input.appointmentId,
      start: state.start,
      ...(await describe(ea, appointment, state.extraServiceIds)),
    };
    const today = instantToEaDate(new Date());
    await Promise.all([
      general.length === 0
        ? 0
        : deliver(
            general,
            buildPanelBookingPayload({ ...notice, actorName: input.actor.name }, today, PANEL_BASE_PATH),
            vapid,
          ),
      own.length === 0 ? 0 : deliver(own, buildOwnBookingPayload(notice, today, PANEL_BASE_PATH), vapid),
    ]);
  } catch (error) {
    console.error("[push] no se pudo avisar la cita nueva", input.appointmentId, error);
  }
}

/**
 * Cómo estaba la cita **antes** de editarla, para poder decir qué cambió.
 *
 * Se llama justo antes de escribir en EA, y solo cuesta una lectura si los
 * avisos están prendidos. `null` si están apagados o si la lectura falló; el
 * aviso sale igual, como "Cita modificada". Nunca lanza.
 */
export async function snapshotForPush(appointmentId: number): Promise<AppointmentState | null> {
  if (vapidConfig() === null) return null;
  try {
    return (await loadState(createEaClient(), appointmentId)).state;
  } catch (error) {
    console.error("[push] no se pudo leer la cita antes del cambio", appointmentId, error);
    return null;
  }
}

/**
 * Cuánto se esperan más cambios de la misma cita antes de avisar. Más que el
 * "Deshacer" de la grilla (9 s) más lo que tarda en guardarse: mover y
 * deshacer cae en la misma ventana y no suena nada.
 */
const CHANGE_WINDOW_MS = 15_000;

const COALESCER = Symbol.for("gbs.push.change-coalescer");

/**
 * En `globalThis`, como la caché de EA: Next empaqueta cada ruta por su lado y
 * una variable de módulo serían varias ventanas para la misma cita.
 */
function changeCoalescer(): Coalescer<AppointmentState | null> {
  const holder = globalThis as unknown as Record<symbol, Coalescer<AppointmentState | null> | undefined>;
  holder[COALESCER] ??= createCoalescer<AppointmentState | null>({ windowMs: CHANGE_WINDOW_MS });
  return holder[COALESCER];
}

/**
 * Una cita **editada o movida** desde el panel.
 *
 * - Dueña y recepción: "Cita movida" / "reasignada" / "modificada", con la hora
 *   de antes y la de ahora, con quién, y quién lo hizo.
 * - La técnica de la columna: "Se movió una cita tuya"; si la cita le llegó de
 *   otra columna, "Nueva cita en tu agenda".
 * - La técnica de la que salió: "Una cita salió de tu agenda".
 *
 * Los cambios seguidos de la misma cita se juntan (`coalesce.ts`): el aviso
 * sale 15 s después del último, comparando contra cómo estaba antes del
 * primero. Si al final quedó como estaba —mover y "Deshacer"— no sale nada.
 * Corre en `after()`. Nunca lanza.
 */
export async function notifyAppointmentChange(input: {
  appointmentId: number;
  before: AppointmentState | null;
  actor: PushActor;
}): Promise<void> {
  const vapid = vapidConfig();
  if (vapid === null) return;

  try {
    const settled = await changeCoalescer().settle(input.appointmentId, input.before, input.actor);
    if (settled === null) return;

    const ea = createEaClient();
    const { appointment, state } = await loadState(ea, input.appointmentId);

    // Cancelada desde el formulario de edición (el selector de estado): para
    // quien la recibe es una cancelación, no un cambio. Y una cita que ya
    // estaba cancelada no le importa a nadie que se edite.
    if (state.cancelled) {
      if (settled.first?.cancelled === true) return;
      const actors = { actorUserIds: settled.actorUserIds, actorName: settled.actorName };
      await sendCancellation(ea, appointment, state, actors, vapid);
      return;
    }

    const change = diffAppointment(settled.first, state);
    if (change === null) return;

    const previousProviderId = settled.first?.providerId ?? state.providerId;
    const { general, own, left } = await recipientsFor({
      providerId: state.providerId,
      previousProviderId,
      actorUserIds: settled.actorUserIds,
    });
    if (general.length === 0 && own.length === 0 && left.length === 0) return;

    const [facts, previousProviderName] = await Promise.all([
      describe(ea, appointment, state.extraServiceIds),
      change.reassigned ? providerFirstName(ea, previousProviderId) : Promise.resolve(null),
    ]);
    const notice = {
      ...facts,
      appointmentId: input.appointmentId,
      start: state.start,
      previousStart: settled.first?.start ?? null,
      previousProviderName,
      actorName: settled.actorName,
    };
    const today = instantToEaDate(new Date());
    const send = (subs: DeliverableSubscription[], audience: "team" | "own" | "left") =>
      subs.length === 0
        ? 0
        : deliver(subs, buildChangePayload(audience, change, notice, today, PANEL_BASE_PATH), vapid);
    await Promise.all([send(general, "team"), send(own, "own"), send(left, "left")]);
  } catch (error) {
    console.error("[push] no se pudo avisar el cambio de la cita", input.appointmentId, error);
  }
}

/**
 * Una cita **cancelada** desde el panel: "Cita cancelada" a dueña y recepción,
 * y "Se canceló una cita tuya" a la técnica de la columna. Sin ventana: cancelar
 * pide confirmación y no tiene "Deshacer". Corre en `after()`. Nunca lanza.
 */
export async function notifyAppointmentCancelled(input: {
  appointmentId: number;
  actor: PushActor;
}): Promise<void> {
  const vapid = vapidConfig();
  if (vapid === null) return;

  try {
    const ea = createEaClient();
    const { appointment, state } = await loadState(ea, input.appointmentId);
    await sendCancellation(
      ea,
      appointment,
      state,
      { actorUserIds: [input.actor.userId], actorName: input.actor.name },
      vapid,
    );
  } catch (error) {
    console.error("[push] no se pudo avisar la cancelación", input.appointmentId, error);
  }
}

/** Los dos avisos de una cancelación, a la columna que la cita tiene en EA. */
async function sendCancellation(
  ea: EaClient,
  appointment: Appointment,
  state: AppointmentState,
  actors: { actorUserIds: readonly string[]; actorName: string | null },
  vapid: VapidConfig,
): Promise<void> {
  const { general, own } = await recipientsFor({
    providerId: state.providerId,
    actorUserIds: actors.actorUserIds,
  });
  if (general.length === 0 && own.length === 0) return;

  const notice = {
    ...(await describe(ea, appointment, state.extraServiceIds)),
    appointmentId: appointment.id,
    start: state.start,
    actorName: actors.actorName,
  };
  const today = instantToEaDate(new Date());
  await Promise.all([
    general.length === 0
      ? 0
      : deliver(general, buildCancelPayload("team", notice, today, PANEL_BASE_PATH), vapid),
    own.length === 0 ? 0 : deliver(own, buildCancelPayload("own", notice, today, PANEL_BASE_PATH), vapid),
  ]);
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
