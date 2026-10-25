import type { DayClose, NewDayClose } from "../types";
import { toId, type Db } from "./shared";

/**
 * El cierre diario.
 *
 * Los totales llegan calculados desde `lib/`; acá se guardan. La compuerta —
 * no se cierra el día con una cita completada sin cuenta — tampoco vive acá:
 * es una decisión sobre citas de EA, y se toma antes de llamar a `insert`.
 */
export function dayCloseRepository(db: Db) {
  return {
    /** `date` en `"YYYY-MM-DD"`. Ver la convención de fechas en `types.ts`. */
    async findByDate(date: string): Promise<DayClose | undefined> {
      return db
        .selectFrom("day_close")
        .selectAll()
        .where("close_date", "=", date)
        .executeTakeFirst();
    },

    async findById(id: number): Promise<DayClose | undefined> {
      return db
        .selectFrom("day_close")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst();
    },

    /**
     * Un día se cierra una sola vez: `uq_day_close_date` lo garantiza y este
     * método deja que el choque salga como error en vez de atraparlo. Un
     * segundo cierre del mismo día no es una condición de carrera a absorber
     * en silencio — es alguien apretando el botón dos veces, y merece ver que
     * el día ya estaba cerrado.
     */
    async insert(row: NewDayClose): Promise<number> {
      const result = await db
        .insertInto("day_close")
        .values(row)
        .executeTakeFirstOrThrow();
      return toId(result.insertId);
    },

    /** Rango de calendario, ambos extremos **inclusivos**. */
    async listByDateRange(from: string, to: string): Promise<DayClose[]> {
      return db
        .selectFrom("day_close")
        .selectAll()
        .where("close_date", ">=", from)
        .where("close_date", "<=", to)
        .orderBy("close_date")
        .execute();
    },

    /**
     * Los cierres que todavía no llegaron a ingest.
     *
     * Alimenta el reintento y el tile de Diagnóstico. Un push que falló en
     * silencio es exactamente igual a no haber empujado.
     *
     * `since` es el corte de Agenda Pro (`INGEST_SINCE`): un cierre anterior no
     * está pendiente, no se va a empujar nunca.
     */
    async listPendingPush(since?: string): Promise<DayClose[]> {
      let query = db
        .selectFrom("day_close")
        .selectAll()
        .where("pushed_to_ingest_at", "is", null);
      if (since !== undefined) query = query.where("close_date", ">=", since);
      return query.orderBy("close_date").execute();
    },

    /**
     * Suma a un cierre las cuentas que se cerraron después de él, y lo deja
     * **sin empujar**: lo que se agregó todavía no llegó al CRM, y así el
     * cierre vuelve a la lista de reintento hasta que llegue.
     */
    async addLateAccounts(
      id: number,
      totals: { efectivo: number; transferencia: number; otro: number; tips: number; count: number },
    ): Promise<void> {
      await db
        .updateTable("day_close")
        .set((eb) => ({
          total_efectivo: eb("total_efectivo", "+", totals.efectivo),
          total_transferencia: eb("total_transferencia", "+", totals.transferencia),
          total_otro: eb("total_otro", "+", totals.otro),
          total_tips: eb("total_tips", "+", totals.tips),
          appointment_count: eb("appointment_count", "+", totals.count),
          pushed_to_ingest_at: null,
        }))
        .where("id", "=", id)
        .execute();
    },

    async markPushed(id: number, at: Date): Promise<void> {
      await db
        .updateTable("day_close")
        .set({ pushed_to_ingest_at: at })
        .where("id", "=", id)
        .execute();
    },
  };
}

export type DayCloseRepository = ReturnType<typeof dayCloseRepository>;
