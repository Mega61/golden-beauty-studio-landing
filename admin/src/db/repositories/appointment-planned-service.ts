import type { Db } from "./shared";

/**
 * `appointment_planned_service`: los servicios de una cita **además** del
 * principal (migración `028`). El "+ pies" de un par que no es combo.
 *
 * No es plata: la hoja de la cuenta los precarga como renglones y pone el precio
 * del catálogo al cerrar. Por eso se reescribe entera en cada guardado de la
 * cita sin perder nada que alguien haya cobrado.
 */
export function appointmentPlannedServiceRepository(db: Db) {
  return {
    /** Los adicionales de varias citas a la vez, en el orden en que se agregaron. */
    async listByAppointments(eaAppointmentIds: readonly number[]): Promise<Map<number, number[]>> {
      const out = new Map<number, number[]>();
      if (eaAppointmentIds.length === 0) return out;
      const rows = await db
        .selectFrom("appointment_planned_service")
        .select(["ea_appointment_id", "ea_service_id"])
        .where("ea_appointment_id", "in", [...new Set(eaAppointmentIds)])
        .orderBy("ea_appointment_id")
        .orderBy("position")
        .execute();
      for (const row of rows) {
        const list = out.get(row.ea_appointment_id) ?? [];
        list.push(row.ea_service_id);
        out.set(row.ea_appointment_id, list);
      }
      return out;
    },

    /** Deja a la cita exactamente con estos adicionales. Vacío = ninguno. */
    async replace(eaAppointmentId: number, eaServiceIds: readonly number[]): Promise<void> {
      await db
        .deleteFrom("appointment_planned_service")
        .where("ea_appointment_id", "=", eaAppointmentId)
        .execute();
      if (eaServiceIds.length === 0) return;
      await db
        .insertInto("appointment_planned_service")
        .values(
          eaServiceIds.map((eaServiceId, position) => ({
            ea_appointment_id: eaAppointmentId,
            position,
            ea_service_id: eaServiceId,
          })),
        )
        .execute();
    },
  };
}

export type AppointmentPlannedServiceRepository = ReturnType<
  typeof appointmentPlannedServiceRepository
>;
