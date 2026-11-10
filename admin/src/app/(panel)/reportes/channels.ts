/**
 * **De dónde llegan las reservas web**: cuántas trajo cada canal, cuántas eran
 * primera visita, y cuánto pagaron.
 *
 * Funciones puras, como el resto de los reportes. El canal sale de
 * `channelOf()` de `lib/booking-attribution.ts` sobre la fila cruda de
 * `booking_attribution` (migración `031`); "primera visita" es la misma lista
 * de `splitCustomers()` que usa "Costo por primera visita", que entra ya
 * calculada para que las dos tarjetas no puedan contar distinto.
 *
 * Solo las reservas hechas desde la página tienen fila. Las demás citas del
 * periodo —agendadas por el estudio desde WhatsApp o una llamada, o hechas
 * antes de que se midiera— se cuentan aparte y no se reparten entre canales:
 * inventarles un origen sería peor que decir que no se sabe.
 */

import { mapEaStatus } from "@/components/calendar/status-map";
import type { Cop } from "@/db/types";
import {
  BOOKING_CHANNELS,
  channelOf,
  type BookingAttribution,
  type BookingChannel,
} from "@/lib/booking-attribution";

import { isPaidTicket, type AppointmentRow, type FinanceRow } from "./aggregate";

export type ChannelRow = {
  channel: BookingChannel;
  /** Reservas web no canceladas. */
  bookings: number;
  /** De esas, cuántas eran de alguien que vino por primera vez en el periodo. */
  firstVisits: number;
  /** Lo cobrado en las cuentas cerradas de esas citas. */
  paid: Cop;
};

export type ChannelReport = {
  rows: ChannelRow[];
  webBookings: number;
  /** Citas del periodo sin fila: agendadas en el panel, o antes de medir. */
  withoutOrigin: number;
};

export function channelReport(input: {
  /** Citas del periodo. */
  appointments: readonly AppointmentRow[];
  /** Por cita. La que no está no vino de la página (o no se pudo leer). */
  attributions: ReadonlyMap<number, BookingAttribution>;
  finance: readonly FinanceRow[];
  /** Teléfonos de quienes vinieron por primera vez en el periodo. */
  newCustomers: ReadonlySet<string>;
}): ChannelReport {
  const paidBy = new Map<number, Cop>();
  for (const row of input.finance) {
    if (!isPaidTicket(row) || row.amountCharged === null) continue;
    paidBy.set(row.eaAppointmentId, row.amountCharged);
  }

  const acc = new Map<BookingChannel, ChannelRow>();
  let withoutOrigin = 0;

  for (const appointment of input.appointments) {
    if (mapEaStatus(appointment.status) === "cancelada") continue;
    const attribution = input.attributions.get(appointment.id);
    if (attribution === undefined) {
      withoutOrigin += 1;
      continue;
    }
    const channel = channelOf(attribution);
    const row = acc.get(channel) ?? { channel, bookings: 0, firstVisits: 0, paid: 0 };
    row.bookings += 1;
    if (appointment.customerKey !== null && input.newCustomers.has(appointment.customerKey)) {
      row.firstVisits += 1;
    }
    row.paid += paidBy.get(appointment.id) ?? 0;
    acc.set(channel, row);
  }

  const rows = BOOKING_CHANNELS.flatMap((channel) => {
    const row = acc.get(channel);
    return row ? [row] : [];
  }).sort((a, b) => b.bookings - a.bookings);

  return {
    rows,
    webBookings: rows.reduce((sum, row) => sum + row.bookings, 0),
    withoutOrigin,
  };
}
