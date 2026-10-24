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

import { withPlannedServiceNames } from "@/lib/planned-services";
import { groupVisits, visitServiceName } from "@/lib/visits";
import { readableSendError } from "@/lib/whatsapp/cloud-api";
import { whatsappConfigured } from "@/lib/whatsapp/config";

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
  /** Solo en envíos automáticos: "Entregado", "Leído"… según el webhook de Meta. */
  delivery: string | null;
  /** Por qué no lo mandó el automático, en `fallo-automatico`. */
  autoError: string | null;
};

export type RemindersData = {
  today: EaLocalDate;
  tomorrow: EaLocalDate;
  rows: ReminderView[];
  problems: ReminderProblem[];
  /** ¿Está prendido el envío automático por la Cloud API? */
  automatic: boolean;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** El día siguiente, en calendario de Bogotá. Desde el mediodía: ningún salto de hora lo mueve. */
export function nextEaDate(date: EaLocalDate): EaLocalDate {
  return eaDatePart(addMinutes(parseEaLocalDateTime(`${date} 12:00:00`), 24 * 60));
}

/**
 * "Recordada por Lina a las 9:12 a. m.", con fecha si no fue hoy. Las
 * confirmaciones dicen "Confirmada".
 */
export function sentLabelOf(
  existing: Pick<ExistingReminder, "channel" | "sentAt" | "sentByName">,
  today: EaLocalDate,
  verb: "Recordada" | "Confirmada" = "Recordada",
): string {
  const who =
    existing.channel === "manual"
      ? `por ${existing.sentByName ?? "alguien del equipo"}`
      : "automáticamente";
  if (existing.sentAt === null) return `${verb} ${who}`;
  const local = instantToEaLocal(existing.sentAt);
  const when =
    eaDatePart(local) === today
      ? `a las ${formatTime(local)}`
      : `el ${formatDateShort(local)} a las ${formatTime(local)}`;
  return `${verb} ${who} ${when}`;
}

/**
 * Lo que dijo Meta de un envío automático. `null` en los manuales: de un
 * `wa.me` no vuelve ningún estado, y decir "enviado" ahí sería afirmar algo
 * que nadie verificó.
 */
export function deliveryLabelOf(
  existing: Pick<ExistingReminder, "channel" | "status">,
): string | null {
  if (existing.channel !== "cloud_api") return null;
  switch (existing.status) {
    case "pendiente":
      return "Saliendo";
    case "enviado":
      return "Enviado, sin confirmación de entrega todavía";
    case "entregado":
      return "Entregado";
    case "leido":
      return "Leído";
    case "fallido":
      return "No salió";
    default:
      return null;
  }
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
  if (row.state !== "pendiente" && row.state !== "recordada" && row.state !== "fallo-automatico") {
    return null;
  }
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
    // Una visita, un recordatorio (`lib/visits.ts`): manos + pies sin combo son
    // dos citas pegadas, y el aviso va en la primera nombrando las dos — igual
    // que el emisor automático. Sin esto, recepción veía dos filas y la clienta
    // recibía dos mensajes.
    // "+ pies" en la misma cita (migración `028`): el mensaje nombra los dos.
    const raw = await withPlannedServiceNames(ea, days.flat());
    const visits = groupVisits(
      raw.map(({ appointment, service }) => ({
        id: appointment.id,
        customerId: appointment.customerId,
        providerId: appointment.providerId,
        start: appointment.start,
        end: appointment.end,
        serviceName: service?.name ?? null,
      })),
    );
    const continuation = new Set<number>();
    const visitName = new Map<number, string | null>();
    for (const parts of visits.values()) {
      if (parts.length < 2) continue;
      for (const part of parts.slice(1)) continuation.add(part.id);
      visitName.set(parts[0].id, visitServiceName(parts.map((p) => p.serviceName)));
    }

    appointments = raw
      .filter(({ appointment }) => !continuation.has(appointment.id))
      .map(({ appointment, service, customer }) => ({
        eaAppointmentId: appointment.id,
        start: appointment.start,
        status: appointment.status,
        phoneE164: normalizePhoneE164(customer?.phone ?? null),
        customerFirstName: customer?.firstName ?? null,
        customerName:
          [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() ||
          "Sin cliente",
        serviceName: visitName.get(appointment.id) ?? service?.name ?? null,
      }));
  } catch (error) {
    problems.push({ source: "ea", message: messageOf(error) });
    return { today, tomorrow, rows: [], problems, automatic: whatsappConfigured() };
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
      sentLabel:
        row.existing === null || row.state !== "recordada"
          ? null
          : sentLabelOf(row.existing, today),
      delivery: row.existing === null ? null : deliveryLabelOf(row.existing),
      autoError: row.state === "fallo-automatico" ? readableSendError(stored?.error) : null,
    };
  });

  return { today, tomorrow, rows, problems, automatic: whatsappConfigured() };
}
