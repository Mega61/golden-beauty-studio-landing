import type { DayClose, NewDayClose } from "../types";
import { toId, type Db } from "./shared";

/**
 * El cierre diario.
 *
 * Desde 2026-11-09 la fila la arma la sincronización nocturna (`syncDay()`),
 * no una persona: es el contenedor del lote de un día y de sus totales. Los
 * totales llegan calculados desde `jobs/day-close.ts`; acá se guardan.
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
     * Una fila por día: `uq_day_close_date` lo garantiza y este método deja
     * que el choque salga como error. `syncDay()` lo atrapa y sigue con la
     * fila que ganó.
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
     * Deja el cierre **sin empujar**: se le sumaron cuentas que todavía no
     * llegaron al CRM, y así vuelve a la lista de reintento hasta que lleguen.
     */
    async markUnpushed(id: number): Promise<void> {
      await db
        .updateTable("day_close")
        .set({ pushed_to_ingest_at: null })
        .where("id", "=", id)
        .execute();
    },

    /**
     * Reescribe los totales de un cierre con lo que hoy tienen sus cuentas.
     *
     * Desde que la cuenta se puede corregir desde Hoy después del cierre
     * (2026-11-09), los totales guardados se recalculan en vez de sumarse: son
     * lo que Caja muestra para cuadrar el cajón, no lo que viajó a Actual —eso
     * lo dicen el lote y sus ajustes—. **No toca `pushed_to_ingest_at`.**
     */
    async setTotals(
      id: number,
      totals: { efectivo: number; transferencia: number; otro: number; tips: number; count: number },
    ): Promise<void> {
      await db
        .updateTable("day_close")
        .set({
          total_efectivo: totals.efectivo,
          total_transferencia: totals.transferencia,
          total_otro: totals.otro,
          total_tips: totals.tips,
          appointment_count: totals.count,
        })
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
