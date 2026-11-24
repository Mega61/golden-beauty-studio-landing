import type { AppointmentDeposit, PaymentMethod } from "@/db/types";
import { depositRemaining, depositState, type DepositState } from "@/lib/deposits";
import { instantToEaDate, instantToEaLocal } from "@/lib/ea";

/**
 * Un adelanto como lo ve la pantalla (la agenda y Caja → Adelantos). Plano:
 * cruza el borde servidor → cliente.
 */
export type DepositView = {
  id: number;
  eaAppointmentId: number;
  /** Hora de pared de la cita al registrar el adelanto (`YYYY-MM-DD HH:mm`), o `null`. */
  appointmentStart: string | null;
  amount: number;
  /** Lo que queda después de la devolución. */
  remaining: number;
  method: PaymentMethod;
  /** Día de caja en que entró. */
  paidOn: string;
  paidRef: string | null;
  customerName: string | null;
  state: DepositState;
  /** Ya viajó a Actual. Borrarlo ya no se puede: se devuelve. */
  pushed: boolean;
  refund: { amount: number; method: PaymentMethod; on: string; reason: string | null; pushed: boolean } | null;
};

export function depositViewOf(row: AppointmentDeposit, accountClosed: boolean): DepositView {
  return {
    id: row.id,
    eaAppointmentId: row.ea_appointment_id,
    appointmentStart:
      row.appointment_start_at === null ? null : instantToEaLocal(row.appointment_start_at).slice(0, 16),
    amount: row.amount,
    remaining: depositRemaining(row),
    method: row.method,
    paidOn: instantToEaDate(row.paid_at),
    paidRef: row.paid_ref,
    customerName: row.customer_name,
    state: depositState(row, accountClosed),
    pushed: row.pushed_to_ingest_at !== null,
    refund:
      row.refunded_at === null || row.refunded_amount === null || row.refund_method === null
        ? null
        : {
            amount: row.refunded_amount,
            method: row.refund_method,
            on: instantToEaDate(row.refunded_at),
            reason: row.refund_reason,
            pushed: row.refund_pushed_at !== null,
          },
  };
}

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  otro: "Otro",
};
