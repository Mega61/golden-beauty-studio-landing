import { sql, type Insertable } from "kysely";

import type { LegacyPayment, LegacyPaymentTable, NewLegacyPayment } from "../types";
import type { Db } from "./shared";

/**
 * Los pagos del historial de Agenda Pro (migración `025`).
 *
 * Solo para pantalla: reportes y ficha de la clienta. **Nunca** lo leen la
 * caja, el ingest a Strapi/Actual ni las comisiones — esa plata ya está en
 * Actual Budget por el scraper de Agenda Pro, y leerla desde un camino de
 * plata la duplicaría. `lib/legacy-history.money-paths.test.ts` lo vigila.
 */
export function legacyPaymentRepository(db: Db) {
  return {
    /**
     * Alta idempotente por `(source_tx_id, part)`.
     *
     * Correr el import dos veces no duplica nada, y una corrida **converge** a
     * lo que dicen los archivos más las correcciones: si entre una corrida y la
     * otra cambió el archivo de correcciones (un medio, una cortesía, un pago
     * partido), los campos de origen se reescriben con lo nuevo. Lo único que
     * no se pisa es un enlace a la reserva que ya existe: si el criterio de
     * casado cambió, la diferencia se mira a mano. Un enlace vacío sí se
     * completa — es el caso de importar los pagos antes que las reservas.
     *
     * Devuelve las filas que MySQL contó como tocadas (1 por alta, 2 por fila
     * cambiada, 0 por no-op), que es lo que el CLI resume.
     */
    async upsert(rows: NewLegacyPayment[]): Promise<number> {
      if (rows.length === 0) return 0;
      // `VALUES(col)`: el valor que traía la fila que chocó. Tipado columna por
      // columna para que un cambio de tipo en la tabla rompa acá y no en MySQL.
      const fromNew = <C extends keyof LegacyPaymentTable & string>(column: C) =>
        sql<Insertable<LegacyPaymentTable>[C]>`VALUES(${sql.ref(column)})`;
      const result = await db
        .insertInto("legacy_payment")
        .values(rows)
        .onDuplicateKeyUpdate({
          sale_id: fromNew("sale_id"),
          paid_at: fromNew("paid_at"),
          amount: fromNew("amount"),
          tip: fromNew("tip"),
          method: fromNew("method"),
          method_agendapro: fromNew("method_agendapro"),
          method_raw: fromNew("method_raw"),
          is_courtesy: fromNew("is_courtesy"),
          client_name: fromNew("client_name"),
          service_name: fromNew("service_name"),
          provider_name: fromNew("provider_name"),
          booked_at: fromNew("booked_at"),
          legacy_appointment_id: sql<number | null>`COALESCE(legacy_appointment_id, VALUES(legacy_appointment_id))`,
        })
        .executeTakeFirstOrThrow();
      return Number(result.numInsertedOrUpdatedRows ?? 0);
    },

    /**
     * Borra las partes que sobran de un pago que ya no está partido.
     *
     * Si una corrida partió la transacción en dos medios y la siguiente ya no
     * (se corrigió el archivo de correcciones), la parte `1` quedaría sumando
     * plata que no existe. `parts` dice cuántas partes tiene hoy cada
     * transacción; se borra toda parte `>=` ese número. Devuelve cuántas.
     */
    async pruneParts(parts: ReadonlyMap<string, number>): Promise<number> {
      const extra = await db
        .selectFrom("legacy_payment")
        .select(["id", "source_tx_id", "part"])
        .where("part", ">", 0)
        .execute();
      const stale = extra
        .filter((row) => {
          const count = parts.get(row.source_tx_id);
          return count !== undefined && row.part >= count;
        })
        .map((row) => row.id);
      if (stale.length === 0) return 0;
      await db.deleteFrom("legacy_payment").where("id", "in", stale).execute();
      return stale.length;
    },

    /** Los pagos de un rango de **fecha de pago**, `[from, to)`. */
    async listByPaidRange(from: Date, to: Date): Promise<LegacyPayment[]> {
      return db
        .selectFrom("legacy_payment")
        .selectAll()
        .where("paid_at", ">=", from)
        .where("paid_at", "<", to)
        .orderBy("paid_at")
        .orderBy("source_tx_id")
        .orderBy("part")
        .execute();
    },

    /** Los pagos enlazados a estas reservas del historial. Para la ficha. */
    async listByAppointmentIds(ids: readonly number[]): Promise<LegacyPayment[]> {
      if (ids.length === 0) return [];
      return db
        .selectFrom("legacy_payment")
        .selectAll()
        .where("legacy_appointment_id", "in", [...ids])
        .orderBy("paid_at")
        .execute();
    },
  };
}

export type LegacyPaymentRepository = ReturnType<typeof legacyPaymentRepository>;
