import type { AppointmentPayment, NewAppointmentPayment } from "../types";
import type { Db } from "./shared";

/**
 * Los pagos de una cuenta: con qué método entró la plata, y cuánta.
 *
 * Nada de totales acá, por la misma razón que en los renglones: `Σ amount ==
 * amount_charged` es una invariante de plata y vive en `lib/ticket.ts` como
 * función pura. Un `SUM()` en un `SELECT` la pondría en el único lugar donde no
 * se puede testear sin una base.
 *
 * ⚠ **Esta tabla es la única fuente del método de pago.** Nadie lee
 * `appointment_finance.payment_method`: con dos métodos esa columna queda en
 * `null`, y un lector concluiría "sin cobrar" sobre plata que sí se cobró.
 */
export function appointmentPaymentRepository(db: Db) {
  return {
    /**
     * Los pagos de una cuenta, en orden de `id`.
     *
     * El orden no es cosmético: **la propina viaja en el primer pago y en
     * ninguno más** (ver `lib/ingest-payload.ts`), así que "el primero" tiene
     * que ser el mismo en cada lectura o el push del día repartiría la propina
     * distinto según el humor del planificador de MySQL.
     */
    async listByFinanceId(appointmentFinanceId: number): Promise<AppointmentPayment[]> {
      return db
        .selectFrom("appointment_payment")
        .selectAll()
        .where("appointment_finance_id", "=", appointmentFinanceId)
        .orderBy("id")
        .execute();
    },

    /**
     * Los pagos de varias cuentas a la vez.
     *
     * Es la consulta del cierre diario y la de Reportes: sin ella, un día de
     * veinte citas serían veinte viajes a la base para armar los totales por
     * método.
     */
    async listByFinanceIds(appointmentFinanceIds: number[]): Promise<AppointmentPayment[]> {
      if (appointmentFinanceIds.length === 0) return [];
      return db
        .selectFrom("appointment_payment")
        .selectAll()
        .where("appointment_finance_id", "in", appointmentFinanceIds)
        .orderBy("appointment_finance_id")
        .orderBy("id")
        .execute();
    },

    /**
     * Reemplaza los pagos de una cuenta.
     *
     * Misma forma que los renglones y por el mismo motivo: lo que llega de la
     * pantalla es la lista completa, y los pagos no tienen identidad estable de
     * cara a quien cobra. Borrar e insertar no pierde nada y evita diferenciar
     * fila por fila.
     *
     * Una lista vacía deja la cuenta **sin cobrar**, que es un estado legítimo
     * y el que Caja le reclama a recepción: la técnica cierra lo que hizo y el
     * método lo registra quien cobra.
     *
     * El llamador decide la transacción; ver `shared.ts`.
     */
    async replaceForFinance(
      appointmentFinanceId: number,
      rows: Omit<NewAppointmentPayment, "appointment_finance_id">[],
    ): Promise<void> {
      await db
        .deleteFrom("appointment_payment")
        .where("appointment_finance_id", "=", appointmentFinanceId)
        .execute();
      if (rows.length === 0) return;
      await db
        .insertInto("appointment_payment")
        .values(
          rows.map((r) => ({ ...r, appointment_finance_id: appointmentFinanceId })),
        )
        .execute();
    },
  };
}

export type AppointmentPaymentRepository = ReturnType<typeof appointmentPaymentRepository>;
