import type { BookingAttributionRow } from "../types";
import type { BookingAttribution } from "@/lib/booking-attribution";
import type { Db } from "./shared";

/**
 * `booking_attribution`: de dónde llegó cada reserva web (migración `031`).
 *
 * Lee y escribe filas, nada más. Qué canal es cada fila lo decide
 * `lib/booking-attribution.ts`, que es puro y está testeado.
 */
export function bookingAttributionRepository(db: Db) {
  return {
    /** Las filas de unas citas. Las que no tienen fila no vinieron de la página. */
    async listByAppointments(
      eaAppointmentIds: readonly number[],
    ): Promise<Map<number, BookingAttributionRow>> {
      const out = new Map<number, BookingAttributionRow>();
      if (eaAppointmentIds.length === 0) return out;
      const rows = await db
        .selectFrom("booking_attribution")
        .selectAll()
        .where("ea_appointment_id", "in", [...new Set(eaAppointmentIds)])
        .execute();
      for (const row of rows) out.set(row.ea_appointment_id, row);
      return out;
    },

    /** Una vez por cita: la primera escritura gana, un reintento no la pisa. */
    async record(eaAppointmentId: number, attribution: BookingAttribution): Promise<void> {
      await db
        .insertInto("booking_attribution")
        .values({
          ea_appointment_id: eaAppointmentId,
          utm_source: attribution.source,
          utm_medium: attribution.medium,
          utm_campaign: attribution.campaign,
          utm_content: attribution.content,
          referrer_host: attribution.referrerHost,
          landing_path: attribution.landingPath,
          click_id: attribution.clickId,
        })
        .ignore()
        .execute();
    },
  };
}
