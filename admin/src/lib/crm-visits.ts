import { mapEaStatus } from "@/components/calendar/status-map";
import { eaDatePart, type EaLocalDate } from "@/lib/ea";
import type { AppointmentWithRelations } from "@/lib/ea/client";

/**
 * Las citas de EA → las visitas del CRM (`POST /api/ingest/panel-visits`).
 *
 * Hasta el 2026-10-24 el CRM conocía a las clientas por el reporte de reservas
 * que el scraper bajaba de Agenda Pro cada noche. De ahí salen el win-back (la
 * cuenta regresiva hasta el próximo retoque) y la sincronización con Stampee
 * (los sellos de fidelización). Sin Agenda Pro, el panel es la única fuente, y
 * este módulo decide —puro, testeado— qué le cuenta.
 *
 * **Nunca lleva plata a la contabilidad**: `price_real` es lo cobrado y el CRM
 * lo guarda en la visita para mostrarlo, no lo suma a nada. La plata va por
 * `POST /api/ingest/payments` en el cierre del día.
 */

export type CrmVisitStatus = "completed" | "upcoming" | "cancelled";

export type CrmVisit = {
  /** `ea-appt:<id>`. El CRM llavea la visita por acá. */
  booking_id: string;
  phone: string;
  full_name: string;
  email: string | null;
  service_name: string;
  service_date: EaLocalDate;
  status: CrmVisitStatus;
  price_list: number | null;
  price_real: number | null;
};

/** Lo que el panel sabe de la cuenta de una cita, si tiene. */
export type CrmFinance = {
  closed: boolean;
  priceList: number | null;
  amountCharged: number | null;
};

/**
 * El estado de la visita para el CRM.
 *
 * - **Cuenta cerrada = vino**, diga lo que diga EA: es la misma regla de
 *   `lib/attendance.ts` (una cuenta cerrada es asistencia aunque EA siga en
 *   "Reservada").
 * - **No asistió cuenta como cancelada.** El CRM no tiene "no vino", y para el
 *   win-back una visita que no ocurrió no puede arrancar la cuenta regresiva.
 * - Lo demás —reservada, confirmada, pasada sin marcar— es `upcoming`: el CRM
 *   solo hace algo con `completed`.
 */
export function crmVisitStatus(eaStatus: string, closed: boolean): CrmVisitStatus {
  if (closed) return "completed";
  const token = mapEaStatus(eaStatus);
  if (token === "cancelada" || token === "no-asistio") return "cancelled";
  if (token === "completada") return "completed";
  return "upcoming";
}

/** `YYYY-MM-DD` ± días, en calendario. */
export function shiftDate(date: EaLocalDate, days: number): EaLocalDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10) as EaLocalDate;
}

/**
 * La ventana del push: desde el corte —nunca antes— hasta `lookahead` días.
 *
 * El CRM cancela las visitas *estrictamente adentro* de `window` que el push ya
 * no trae (una cita borrada o movida). Por eso `window` va un día más ancha a
 * cada lado que el rango que se lee, y por eso el rango **no empieza antes del
 * corte**: lo anterior es historia de Agenda Pro y el barrido no la puede tocar.
 */
export function crmVisitsRange(input: {
  today: EaLocalDate;
  since: EaLocalDate;
  lookbackDays: number;
  lookaheadDays: number;
}): { from: EaLocalDate; till: EaLocalDate; window: { start: EaLocalDate; end: EaLocalDate } } {
  const back = shiftDate(input.today, -input.lookbackDays);
  const from = back > input.since ? back : input.since;
  const till = shiftDate(input.today, input.lookaheadDays);
  return { from, till, window: { start: shiftDate(from, -1), end: shiftDate(till, 1) } };
}

function fullName(customer: { firstName: string | null; lastName: string | null }): string {
  return [customer.firstName, customer.lastName].filter(Boolean).join(" ").trim();
}

/**
 * Las visitas a mandar. Sin clienta o sin teléfono no hay visita: el CRM llavea
 * a la clienta por teléfono y una fila sin él se descartaría allá igual.
 */
export function buildCrmVisits(
  rows: readonly AppointmentWithRelations[],
  finances: ReadonlyMap<number, CrmFinance>,
): CrmVisit[] {
  const out: CrmVisit[] = [];
  for (const { appointment, customer, service } of rows) {
    const phone = customer?.phone?.trim();
    if (!customer || !phone) continue;
    const finance = finances.get(appointment.id);
    out.push({
      booking_id: `ea-appt:${appointment.id}`,
      phone,
      full_name: fullName(customer),
      email: customer.email?.trim() || null,
      service_name: service?.name?.trim() || "Servicio",
      service_date: eaDatePart(appointment.start),
      status: crmVisitStatus(appointment.status, finance?.closed ?? false),
      price_list: finance?.priceList ?? service?.price ?? null,
      price_real: finance?.closed ? finance.amountCharged : null,
    });
  }
  return out;
}
