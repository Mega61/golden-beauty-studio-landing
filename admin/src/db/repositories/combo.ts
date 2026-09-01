import type { Combo, NewCombo } from "../types";
import type { Db } from "./shared";

/**
 * La composición de los combos.
 *
 * Nada acá suma partes. Precio y duración son criterio de la dueña y llegan
 * explícitos; el reparto entre manos y pies lo hace `lib/combo-allocation.ts`,
 * que garantiza que las partes sumen exacto al precio del combo con el peso de
 * residuo asignado de forma determinista.
 */
export function comboRepository(db: Db) {
  return {
    async listAll(): Promise<Combo[]> {
      return db.selectFrom("combo").selectAll().orderBy("id").execute();
    },

    /**
     * El combo detrás de un servicio de EA, si lo hay.
     *
     * Es la pregunta que hace el reporte: una cita de un combo aparece como un
     * solo servicio, y atribuir su ingreso a los servicios de manos y pies
     * subyacentes empieza acá.
     */
    async findByEaServiceId(eaServiceId: number): Promise<Combo | undefined> {
      return db
        .selectFrom("combo")
        .selectAll()
        .where("ea_service_id", "=", eaServiceId)
        .executeTakeFirst();
    },

    /**
     * Alta o actualización por `ea_service_id`.
     *
     * Publicar un combo escribe el servicio en EA primero y esta fila después,
     * así que la llave natural ya existe cuando se llama.
     */
    async upsert(row: NewCombo): Promise<void> {
      const existing = await db
        .selectFrom("combo")
        .select("id")
        .where("ea_service_id", "=", row.ea_service_id)
        .executeTakeFirst();

      if (!existing) {
        await db.insertInto("combo").values(row).execute();
        return;
      }
      await db
        .updateTable("combo")
        .set({
          hands_ea_service_id: row.hands_ea_service_id,
          feet_ea_service_id: row.feet_ea_service_id,
          price: row.price,
          duration_min: row.duration_min,
          allocation_hands_bp: row.allocation_hands_bp,
        })
        .where("id", "=", existing.id)
        .execute();
    },
  };
}

export type ComboRepository = ReturnType<typeof comboRepository>;
