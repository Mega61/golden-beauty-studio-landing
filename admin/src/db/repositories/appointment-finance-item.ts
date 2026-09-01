import type { AppointmentFinanceItem, NewAppointmentFinanceItem } from "../types";
import type { Db } from "./shared";

/**
 * Los renglones de la cuenta.
 *
 * Nada de totales acá. `Σ line_total − discount == amount_charged` es la
 * invariante que no se puede romper nunca, y vive en `lib/ticket.ts` como
 * función pura con 100 % de cobertura de ramas. Un `SUM()` en un `SELECT` la
 * pondría en el único lugar donde no se puede testear sin una base.
 */
export function appointmentFinanceItemRepository(db: Db) {
  return {
    /**
     * Los renglones de una cuenta, en orden de `id`.
     *
     * El orden importa y no es cosmético: el prorrateo del descuento asigna el
     * peso de residuo de forma determinista, y "determinista" necesita que la
     * lista llegue siempre igual.
     */
    async listByFinanceId(
      appointmentFinanceId: number,
    ): Promise<AppointmentFinanceItem[]> {
      return db
        .selectFrom("appointment_finance_item")
        .selectAll()
        .where("appointment_finance_id", "=", appointmentFinanceId)
        .orderBy("id")
        .execute();
    },

    /** Los renglones de varias cuentas a la vez, para la liquidación. */
    async listByFinanceIds(
      appointmentFinanceIds: number[],
    ): Promise<AppointmentFinanceItem[]> {
      if (appointmentFinanceIds.length === 0) return [];
      return db
        .selectFrom("appointment_finance_item")
        .selectAll()
        .where("appointment_finance_id", "in", appointmentFinanceIds)
        .orderBy("appointment_finance_id")
        .orderBy("id")
        .execute();
    },

    async insertMany(rows: NewAppointmentFinanceItem[]): Promise<void> {
      if (rows.length === 0) return;
      await db.insertInto("appointment_finance_item").values(rows).execute();
    },

    /**
     * Reemplaza los renglones de una cuenta.
     *
     * Es cómo se guarda una edición del ticket antes del cierre: la técnica
     * agrega un diseño, quita otro, y lo que llega es la lista completa. Borrar
     * e insertar es más simple y más correcto que diferenciar renglón por
     * renglón, y no pierde nada porque los renglones no tienen identidad
     * estable de cara al usuario.
     *
     * **Solo funciona antes del cierre**, y eso lo garantiza la base, no este
     * método: `commission_entry` referencia el renglón con `ON DELETE
     * RESTRICT`, así que si ya hay comisión calculada el borrado falla. Después
     * del cierre las correcciones son renglones nuevos con su motivo, nunca una
     * edición en sitio — porque en ese momento los números ya salieron hacia
     * Strapi y Actual Budget.
     *
     * El llamador decide la transacción; ver `shared.ts`.
     */
    async replaceForFinance(
      appointmentFinanceId: number,
      rows: Omit<NewAppointmentFinanceItem, "appointment_finance_id">[],
    ): Promise<void> {
      await db
        .deleteFrom("appointment_finance_item")
        .where("appointment_finance_id", "=", appointmentFinanceId)
        .execute();
      if (rows.length === 0) return;
      await db
        .insertInto("appointment_finance_item")
        .values(
          rows.map((r) => ({ ...r, appointment_finance_id: appointmentFinanceId })),
        )
        .execute();
    },
  };
}

export type AppointmentFinanceItemRepository = ReturnType<
  typeof appointmentFinanceItemRepository
>;
