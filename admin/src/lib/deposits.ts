/**
 * **Adelantos** (migración `034`): las reglas, como funciones puras.
 *
 * Un adelanto es plata que la clienta paga antes de su cita para separar el
 * cupo (en temporada). Entra a Actual el día en que se pagó (`abono:<id>`,
 * `jobs/deposits.ts`) y al cobrar la cita es un pago `abono` que no viaja
 * otra vez: del cobro sale solo el resto.
 *
 * Lo que vive acá es lo que decide la plata sin tocar la base: cuánto queda
 * de un adelanto, cuánto cubre de una cuenta, en qué estado está y qué se le
 * puede hacer.
 */

import type { Cop } from "@/db/types";
import { EA_TIME_ZONE, eaLocalToInstant, instantToEaDate, parseEaLocalDateTime } from "@/lib/ea/datetime";

/** Lo que hace falta de una fila para estas reglas. */
export type DepositLike = {
  amount: Cop;
  refunded_amount: Cop | null;
};

/** Lo que queda de un adelanto después de lo devuelto. */
export function depositRemaining(deposit: DepositLike): Cop {
  return Math.max(deposit.amount - (deposit.refunded_amount ?? 0), 0);
}

/** Lo que una cita tiene disponible en adelantos: la suma de lo que queda de cada uno. */
export function availableDeposit(deposits: readonly DepositLike[]): Cop {
  return deposits.reduce((sum, deposit) => sum + depositRemaining(deposit), 0);
}

/**
 * Lo que el adelanto cubre de lo cobrado: todo lo que alcance. `0` = no hay
 * adelanto, o la cuenta quedó en cero.
 *
 * Un adelanto **mayor** que la cuenta no se trunca en silencio: esa diferencia
 * es plata de la clienta que ya está en Actual. `depositExcess()` lo dice y el
 * cierre lo rechaza hasta que alguien registre la devolución.
 */
export function depositPayment(available: Cop, amountCharged: Cop): Cop {
  return Math.min(Math.max(available, 0), Math.max(amountCharged, 0));
}

/** Lo que sobra del adelanto contra la cuenta. `0` = cabe. */
export function depositExcess(available: Cop, amountCharged: Cop): Cop {
  return Math.max(available - Math.max(amountCharged, 0), 0);
}

/**
 * El instante de un pago escrito como día de caja: hoy → ahora; un día pasado
 * → el mediodía de ese día en Bogotá; un día futuro → `null` (no se acepta).
 */
export function depositPaidAt(paidOn: string, now: Date): Date | null {
  const today = instantToEaDate(now);
  if (paidOn > today) return null;
  if (paidOn === today) return now;
  return eaLocalToInstant(parseEaLocalDateTime(`${paidOn} 12:00:00`), EA_TIME_ZONE);
}

export type DepositState = "pendiente" | "aplicado" | "devuelto";

/**
 * En qué está un adelanto:
 *
 * - `devuelto` — se devolvió todo.
 * - `aplicado` — la cuenta de su cita está cerrada: el adelanto ya pagó.
 * - `pendiente` — la plata está y la cita todavía no se cobra.
 */
export function depositState(deposit: DepositLike, accountClosed: boolean): DepositState {
  if (depositRemaining(deposit) === 0) return "devuelto";
  return accountClosed ? "aplicado" : "pendiente";
}

export const DEPOSIT_STATE_LABEL: Record<DepositState, string> = {
  pendiente: "Por usar",
  aplicado: "Usado en la cuenta",
  devuelto: "Devuelto",
};

/** El nombre con el que el adelanto aparece en las notas de Actual. */
export function depositServiceName(appointmentDay: string | null): string {
  return appointmentDay ? `Adelanto cita ${appointmentDay}` : "Adelanto";
}

/**
 * Por qué no se puede registrar un adelanto en esta cita, o `null`.
 *
 * Una cuenta ya cerrada cobró todo con sus métodos: un adelanto escrito
 * después sería la misma plata dos veces en Actual. Lo que corresponde es
 * corregir la cuenta.
 */
export function addBlockReason(input: { cancelled: boolean; accountClosed: boolean }): string | null {
  if (input.cancelled) return "La cita está cancelada. Registra el adelanto en la cita nueva.";
  if (input.accountClosed) {
    return "La cuenta de esta cita ya está cerrada: lo que pagó ya está en el cobro. Corrige la cuenta si hace falta.";
  }
  return null;
}

/**
 * Por qué no se puede devolver (o anular) este adelanto, o `null`.
 *
 * - Uno ya usado en una cuenta cerrada es parte de ese cobro: devolverlo
 *   dejaría la cuenta pagando con plata que ya no está.
 * - Uno que ya llegó a Actual sale como ajuste negativo: solo la dueña.
 */
export function refundBlockReason(input: {
  deposit: DepositLike & { refunded_at: Date | null };
  accountClosed: boolean;
  pushed: boolean;
  canFixAfterSync: boolean;
}): string | null {
  if (input.deposit.refunded_at !== null) return "Este adelanto ya tiene una devolución registrada.";
  if (input.accountClosed) {
    return "La cuenta de la cita ya se cerró con este adelanto. Corrige la cuenta primero.";
  }
  if (input.pushed && !input.canFixAfterSync) {
    return "Este adelanto ya llegó a Actual. Solo la dueña lo puede devolver (sale como ajuste).";
  }
  return null;
}

/**
 * Por qué no se puede pasar este adelanto a otra cita, o `null`. Se pasa
 * entero, con su llave: en Actual nada cambia, solo la cita que paga.
 */
export function moveBlockReason(input: {
  deposit: DepositLike;
  fromAccountClosed: boolean;
  toAccountClosed: boolean;
  sameAppointment: boolean;
}): string | null {
  if (input.sameAppointment) return "El adelanto ya es de esta cita.";
  if (depositRemaining(input.deposit) === 0) return "Este adelanto ya se devolvió entero.";
  if (input.fromAccountClosed) return "Este adelanto ya se usó en la cuenta de su cita.";
  if (input.toAccountClosed) return "La cuenta de esta cita ya está cerrada.";
  return null;
}
