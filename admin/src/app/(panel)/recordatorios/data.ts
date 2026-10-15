import "server-only";

import { formatDateShort, formatTime } from "@/components/ui/format";
import { getDb } from "@/db/client";
import { repositories, type WaMessageWithSender } from "@/db/repositories";
import type { WaMessageKind } from "@/db/types";
import { createEaClient, listDayAppointments } from "@/lib/ea/client";
import {
  addMinutes,
  eaDatePart,
  instantToEaDate,
  instantToEaLocal,
  parseEaLocalDateTime,
  type EaLocalDate,
} from "@/lib/ea";
import {
  buildReminderText,
  planManualReminders,
  waMeLink,
  type ExistingReminder,
  type ManualReminderAppointment,
  type ManualReminderDay,
  type ManualReminderRow,
  type ManualReminderState,
} from "@/lib/whatsapp/manual-reminder";

import { normalizePhoneE164 } from "../clientes/identity";

/**
 * Los datos de **Recordatorios**: las citas de hoy (las que faltan) y las de
 * mañana, cruzadas con lo que ya se mandó y con las bajas.
 *
 * Dos fuentes que no se unen con un JOIN, igual que en Hoy: las citas vienen
 * de la API de EA y los mensajes de `gbs_admin`. A diferencia de Hoy, **sin
 * `gbs_admin` la pantalla no sirve**: un aviso que no se puede registrar antes
 * de abrir WhatsApp es un aviso que el emisor automático mandaría de nuevo el
 * día que exista. Así que si la base no responde, se dice y no se ofrece el
 * botón.
 */

export type ReminderProblem = { source: "ea" | "db"; message: string };

/** Una fila lista para dibujar. Todo serializable: viaja a un componente cliente. */
export type ReminderView = {
  eaAppointmentId: number;
  day: ManualReminderDay;
  kind: WaMessageKind;
  state: ManualReminderState;
  /** `"10:00 a. m."` */
  timeLabel: string;
  customerName: string;
  serviceName: string;
  /** El estado crudo de EA, para la píldora. */
  status: string;
  /** El enlace de `wa.me`. Solo en `pendiente` y en `recordada` con número. */
  link: string | null;
  /** "Recordada por Recepción a las 9:12 a. m." */
  sentLabel: string | null;
};

export type RemindersData = {
  today: EaLocalDate;
  tomorrow: EaLocalDate;
  rows: ReminderView[];
  problems: ReminderProblem[];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** El día siguiente, en calendario de Bogotá. Desde el mediodía: ningún salto de hora lo mueve. */
export function nextEaDate(date: EaLocalDate): EaLocalDate {
  return eaDatePart(addMinutes(parseEaLocalDateTime(`${date} 12:00:00`), 24 * 60));
}

/** "Recordada por Lina a las 9:12 a. m.", con fecha si no fue hoy. */
export function sentLabelOf(
  existing: Pick<ExistingReminder, "channel" | "sentAt" | "sentByName">,
  today: EaLocalDate,
): string {
  const who =
    existing.channel === "manual"
      ? `por ${existing.sentByName ?? "alguien del equipo"}`
      : "automáticamente";
  if (existing.sentAt === null) return `Recordada ${who}`;
  const local = instantToEaLocal(existing.sentAt);
  const when =
    eaDatePart(local) === today
      ? `a las ${formatTime(local)}`
      : `el ${formatDateShort(local)} a las ${formatTime(local)}`;
  return `Recordada ${who} ${when}`;
}

function existingOf(row: WaMessageWithSender): ExistingReminder {
  return {
    eaAppointmentId: row.eaAppointmentId,
    kind: row.kind,
    status: row.status,
    channel: row.channel,
    sentAt: row.sentAt,
    sentByName: row.sentByName,
  };
}

/**
 * El enlace de una fila.
 *
 * En `recordada` se reabre con el número **al que se mandó**, no con el que la
 * ficha tenga hoy: "abrir de nuevo" es volver a esa conversación.
 */
export function linkFor(
  row: ManualReminderRow,
  sentToPhone: string | null,
): string | null {
  if (row.state !== "pendiente" && row.state !== "recordada") return null;
  const phone = row.state === "recordada" ? sentToPhone : row.appointment.phoneE164;
  if (phone === null) return null;
  return waMeLink(
    phone,
    buildReminderText({
      customerFirstName: row.appointment.customerFirstName,
      serviceName: row.appointment.serviceName,
      start: row.appointment.start,
      day: row.day,
    }),
  );
}

export async function loadReminders(now: Date = new Date()): Promise<RemindersData> {
  const today = instantToEaDate(now);
  const tomorrow = nextEaDate(today);
  const problems: ReminderProblem[] = [];

  let appointments: ManualReminderAppointment[] = [];
  try {
    const ea = createEaClient();
    // El loader de Hoy y Caja: agota la paginación o lanza, nunca medio día.
    const days = await Promise.all(
      [today, tomorrow].map((date) =>
        listDayAppointments(ea, { date, providerId: null, with: ["service", "customer"] }),
      ),
    );
    appointments = days.flat().map(({ appointment, service, customer }) => ({
      eaAppointmentId: appointment.id,
      start: appointment.start,
      status: appointment.status,
      phoneE164: normalizePhoneE164(customer?.phone ?? null),
      customerFirstName: customer?.firstName ?? null,
      customerName:
        [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() ||
        "Sin clienta",
      serviceName: service?.name ?? null,
    }));
  } catch (error) {
    problems.push({ source: "ea", message: messageOf(error) });
    return { today, tomorrow, rows: [], problems };
  }

  let sent: WaMessageWithSender[] = [];
  let optedOut = new Set<string>();
  try {
    const repos = repositories(getDb());
    [sent, optedOut] = await Promise.all([
      repos.waMessages.listByAppointmentIds(appointments.map((a) => a.eaAppointmentId)),
      repos.waMessages.listOptedOut(
        appointments.flatMap((a) => (a.phoneE164 === null ? [] : [a.phoneE164])),
      ),
    ]);
  } catch (error) {
    problems.push({ source: "db", message: messageOf(error) });
  }

  const sentByKey = new Map(sent.map((row) => [`${row.eaAppointmentId}:${row.kind}`, row]));

  const planned = planManualReminders({
    appointments,
    existing: sent.map(existingOf),
    optedOut,
    now,
    today,
    tomorrow,
  });

  const rows = planned.map((row): ReminderView => {
    const stored = sentByKey.get(`${row.appointment.eaAppointmentId}:${row.kind}`) ?? null;
    return {
      eaAppointmentId: row.appointment.eaAppointmentId,
      day: row.day,
      kind: row.kind,
      state: row.state,
      timeLabel: formatTime(row.appointment.start),
      customerName: row.appointment.customerName,
      serviceName: row.appointment.serviceName ?? "Sin servicio",
      status: row.appointment.status,
      link: linkFor(row, stored?.phoneE164 ?? null),
      sentLabel: row.existing === null ? null : sentLabelOf(row.existing, today),
    };
  });

  return { today, tomorrow, rows, problems };
}
