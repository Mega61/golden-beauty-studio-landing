import "server-only";

import { formatDateLong, formatDateShort, formatTime } from "@/components/ui/format";
import { getDb } from "@/db/client";
import { repositories, type WaMessageWithSender } from "@/db/repositories";
import { createEaClient, listRecentlyBooked } from "@/lib/ea/client";
import { instantToEaDate, instantToEaLocal, type EaLocalDate } from "@/lib/ea";
import { withPlannedServiceNames } from "@/lib/planned-services";
import { readableSendError } from "@/lib/whatsapp/cloud-api";
import {
  planManualConfirmations,
  recentSince,
  type ConfirmationAppointment,
  type ManualConfirmationState,
} from "@/lib/whatsapp/manual-confirmation";
import { buildConfirmationText, waMeLink } from "@/lib/whatsapp/manual-reminder";

import { normalizePhoneE164 } from "../clientes/identity";
import { deliveryLabelOf, sentLabelOf, type ReminderProblem } from "./data";

/**
 * Los datos de **Reservas nuevas**: lo que se agendó en la última semana y
 * todavía no ha pasado, cruzado con las confirmaciones que ya salieron.
 *
 * Mismas dos fuentes que los recordatorios —EA y `gbs_admin`— y la misma
 * regla: sin base no se puede registrar la confirmación antes de abrir
 * WhatsApp, así que la pantalla lo dice y apaga los botones.
 */

/** Una fila lista para dibujar. Serializable: viaja a un componente cliente. */
export type ConfirmationView = {
  eaAppointmentId: number;
  state: ManualConfirmationState;
  /** "Jueves 29 de octubre · 10:30 a. m." */
  whenLabel: string;
  /** "Reservó hoy a las 2:14 p. m." */
  bookedLabel: string;
  customerName: string;
  /** La visita entera: "Esculpidas en acrílico y Semipermanente pies". */
  serviceName: string;
  status: string;
  link: string | null;
  sentLabel: string | null;
  delivery: string | null;
  autoError: string | null;
};

export type ConfirmationsData = {
  rows: ConfirmationView[];
  problems: ReminderProblem[];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "Reservó hoy a las 2:14 p. m." / "Reservó el 20 oct a las 9:00 a. m." */
export function bookedLabelOf(bookedAt: string, today: EaLocalDate): string {
  const day = bookedAt.slice(0, 10);
  const time = formatTime(bookedAt);
  return day === today ? `Reservó hoy a las ${time}` : `Reservó el ${formatDateShort(bookedAt)} a las ${time}`;
}

export async function loadConfirmations(now: Date = new Date()): Promise<ConfirmationsData> {
  const today = instantToEaDate(now);
  const problems: ReminderProblem[] = [];

  let appointments: ConfirmationAppointment[] = [];
  try {
    const ea = createEaClient();
    // "+ pies" en la misma cita (migración `028`): el mensaje nombra los dos.
    const found = await withPlannedServiceNames(
      ea,
      await listRecentlyBooked(ea, {
        since: instantToEaLocal(recentSince(now)),
        with: ["service", "customer"],
      }),
    );
    appointments = found.flatMap(({ appointment, service, customer }) =>
      appointment.bookedAt === null
        ? []
        : [
            {
              eaAppointmentId: appointment.id,
              start: appointment.start,
              end: appointment.end,
              bookedAt: appointment.bookedAt,
              status: appointment.status,
              phoneE164: normalizePhoneE164(customer?.phone ?? null),
              customerFirstName: customer?.firstName ?? null,
              customerName:
                [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() ||
                "Sin cliente",
              serviceName: service?.name ?? null,
              customerId: appointment.customerId,
              providerId: appointment.providerId,
            },
          ],
    );
  } catch (error) {
    problems.push({ source: "ea", message: messageOf(error) });
    return { rows: [], problems };
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

  const stored = new Map(
    sent.filter((row) => row.kind === "confirmacion").map((row) => [row.eaAppointmentId, row]),
  );

  const planned = planManualConfirmations({ appointments, existing: sent, optedOut, now });

  const rows = planned.map((row): ConfirmationView => {
    const { appointment } = row;
    const message = stored.get(appointment.eaAppointmentId) ?? null;
    const phone =
      row.state === "confirmada"
        ? (message?.phoneE164 ?? null)
        : row.state === "pendiente" || row.state === "fallo-automatico"
          ? appointment.phoneE164
          : null;
    const capitalized = formatDateLong(appointment.start);
    return {
      eaAppointmentId: appointment.eaAppointmentId,
      state: row.state,
      whenLabel: `${capitalized.charAt(0).toUpperCase()}${capitalized.slice(1)} · ${formatTime(appointment.start)}`,
      bookedLabel: bookedLabelOf(appointment.bookedAt, today),
      customerName: appointment.customerName,
      serviceName: row.serviceName ?? "Sin servicio",
      status: appointment.status,
      link:
        phone === null
          ? null
          : waMeLink(
              phone,
              buildConfirmationText({
                customerFirstName: appointment.customerFirstName,
                serviceName: row.serviceName,
                start: appointment.start,
              }),
            ),
      sentLabel:
        row.state === "confirmada" && row.existing !== null
          ? sentLabelOf(row.existing, today, "Confirmada")
          : null,
      delivery: row.existing === null ? null : deliveryLabelOf(row.existing),
      autoError: row.state === "fallo-automatico" ? readableSendError(message?.error) : null,
    };
  });

  return { rows, problems };
}

/** Para el conteo de Hoy: cuántas reservas nuevas esperan su confirmación. */
export function pendingConfirmations(data: ConfirmationsData): number | null {
  if (data.problems.length > 0) return null;
  return data.rows.filter((r) => r.state === "pendiente" || r.state === "fallo-automatico").length;
}

