/**
 * La confirmación por WhatsApp que manda una persona: "Reservas nuevas" en
 * Recordatorios.
 *
 * Es el hermano de `manual-reminder.ts` para el momento de la reserva. Cuando
 * alguien reserva —por la página o desde la agenda del panel— la dueña le
 * escribe a la clienta "tu cita quedó confirmada" desde el WhatsApp del
 * estudio. Mientras Meta no apruebe las plantillas, eso es un toque por
 * reserva; con la Cloud API prendida lo hace `confirmation.ts` solo, y esta
 * lista muestra si salió.
 *
 * ## Por fecha de reserva, no de cita
 *
 * Los recordatorios miran cuándo **es** la cita; esto mira cuándo **se agendó**.
 * Entran las reservas de los últimos `RECENT_BOOKING_DAYS` días cuya cita no ha
 * empezado: una confirmación de una cita que ya pasó no le sirve a nadie, y una
 * reserva de hace un mes ya tuvo su oportunidad.
 *
 * ## Las mismas reglas que el automático
 *
 * Mismo `kind` (`confirmacion`) en `wa_message`, así la `UNIQUE (cita, tipo)`
 * cruza los dos canales y nunca salen dos confirmaciones. Mismos estados de EA
 * que llevan aviso, misma baja, mismo "sin teléfono". Y **una visita, un
 * mensaje** (`lib/visits.ts`): manos + pies sin combo son dos citas pegadas, y
 * la confirmación va en la primera y nombra las dos.
 *
 * Puro: entra la data, sale la decisión.
 */

import type { WaMessageStatus } from "@/db/types";
import { isSendableStatus } from "@/jobs/reminders";
import { eaLocalToInstant, type EaLocalDateTime } from "@/lib/ea";
import { groupVisits, visitServiceName } from "@/lib/visits";

import type { ExistingReminder, ManualReminderAppointment } from "./manual-reminder";

/** Cuántos días hacia atrás cuenta una reserva como "nueva". */
export const RECENT_BOOKING_DAYS = 7;

/** Una cita con lo que hace falta para agruparla en visitas y ubicar su reserva. */
export type ConfirmationAppointment = ManualReminderAppointment & {
  end: EaLocalDateTime;
  /** `book_datetime` de EA: cuándo se agendó. */
  bookedAt: EaLocalDateTime;
  customerId: number | null;
  providerId: number | null;
};

/**
 * - `pendiente` — hay que mandarla.
 * - `fallo-automatico` — la Cloud API lo intentó y no salió; se manda a mano
 *   sobre la misma fila.
 * - `confirmada` — ya hay una fila que dice que salió.
 * - `no-enviada` — hay fila y dice que no salió por algo que no se retoma.
 * - `sin-telefono`, `opt-out`, `estado-no-aplica` — como en los recordatorios.
 */
export type ManualConfirmationState =
  | "pendiente"
  | "fallo-automatico"
  | "confirmada"
  | "no-enviada"
  | "sin-telefono"
  | "opt-out"
  | "estado-no-aplica";

export type ManualConfirmationRow = {
  /** La primera cita de la visita: la que lleva el mensaje. */
  appointment: ConfirmationAppointment;
  /** Los servicios de la visita entera: "Esculpidas en acrílico y Semipermanente pies". */
  serviceName: string | null;
  /** Ids de todas las citas de la visita, la primera incluida. */
  partIds: number[];
  state: ManualConfirmationState;
  existing: ExistingReminder | null;
};

const SENT_STATUSES: ReadonlySet<WaMessageStatus> = new Set([
  "pendiente",
  "enviado",
  "entregado",
  "leido",
]);

/**
 * El estado de la confirmación de una cita. Lo usan la lista y la acción que
 * envía, para que las dos digan lo mismo.
 *
 * Lo que ya pasó va primero: una clienta que se dio de baja después de recibir
 * la confirmación sigue habiéndola recibido.
 */
export function confirmationStateOf(input: {
  status: string;
  phoneE164: string | null;
  existing: Pick<ExistingReminder, "channel" | "status"> | null;
  optedOut: ReadonlySet<string>;
}): ManualConfirmationState {
  const autoFailed =
    input.existing !== null &&
    input.existing.channel === "cloud_api" &&
    input.existing.status === "fallido";

  if (input.existing !== null && !autoFailed) {
    return SENT_STATUSES.has(input.existing.status) ? "confirmada" : "no-enviada";
  }
  if (!isSendableStatus(input.status)) return "estado-no-aplica";
  if (input.phoneE164 === null) return "sin-telefono";
  if (input.optedOut.has(input.phoneE164)) return "opt-out";
  return autoFailed ? "fallo-automatico" : "pendiente";
}

/** Desde cuándo una reserva cuenta como nueva. */
export function recentSince(now: Date): Date {
  return new Date(now.getTime() - RECENT_BOOKING_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Las reservas nuevas, una fila por visita, de la más reciente a la más vieja.
 *
 * La reserva más nueva arriba porque es la que la clienta está esperando: quien
 * acaba de reservar tiene el celular en la mano.
 */
export function planManualConfirmations(input: {
  appointments: readonly ConfirmationAppointment[];
  existing: readonly ExistingReminder[];
  optedOut: ReadonlySet<string>;
  now: Date;
}): ManualConfirmationRow[] {
  const since = recentSince(input.now).getTime();
  const upcoming = input.appointments.filter(
    (a) =>
      eaLocalToInstant(a.start).getTime() > input.now.getTime() &&
      eaLocalToInstant(a.bookedAt).getTime() >= since,
  );

  const byId = new Map(upcoming.map((a) => [a.eaAppointmentId, a]));
  const confirmations = new Map(
    input.existing
      .filter((row) => row.kind === "confirmacion")
      .map((row) => [row.eaAppointmentId, row]),
  );

  const visits = groupVisits(
    upcoming.map((a) => ({
      id: a.eaAppointmentId,
      customerId: a.customerId,
      providerId: a.providerId,
      start: a.start,
      end: a.end,
      serviceName: a.serviceName,
    })),
  );

  const rows: ManualConfirmationRow[] = [];
  for (const parts of visits.values()) {
    const leader = byId.get(parts[0].id);
    if (!leader) continue;
    const existing = confirmations.get(leader.eaAppointmentId) ?? null;
    rows.push({
      appointment: leader,
      serviceName: visitServiceName(parts.map((p) => p.serviceName)),
      partIds: parts.map((p) => p.id),
      state: confirmationStateOf({
        status: leader.status,
        phoneE164: leader.phoneE164,
        existing,
        optedOut: input.optedOut,
      }),
      existing,
    });
  }

  // Una visita se ordena por su reserva más nueva: si la segunda mitad se
  // agregó después, la visita sube.
  const newestBooking = (row: ManualConfirmationRow) =>
    row.partIds
      .map((id) => byId.get(id)?.bookedAt ?? row.appointment.bookedAt)
      .reduce((a, b) => (a > b ? a : b));

  return rows.sort(
    (a, b) =>
      newestBooking(b).localeCompare(newestBooking(a)) ||
      b.appointment.eaAppointmentId - a.appointment.eaAppointmentId,
  );
}
