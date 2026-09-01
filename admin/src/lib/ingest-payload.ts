/**
 * `appointment_finance` → el cuerpo que se le manda a la ruta de ingest de
 * Strapi, la misma que hoy alimenta `agendapro-pull`.
 *
 * ⚠ **La forma exacta de `Payment` no está verificada contra el CRM.** El plan
 * manda leer `src/api/visit/services/ingest.ts` del repo del CRM para fijar el
 * contrato (§ Fases), y ese repo no está disponible desde acá. Lo que sí está
 * fijado por el plan y este archivo sí garantiza:
 *
 * - `method` **siempre** dentro del enum `efectivo | transferencia | otro`, que
 *   es el mismo de `Payment.method` en Strapi. No se inventan valores nuevos.
 * - **Monto en pesos enteros**, sin centavos y sin la propina adentro.
 * - **Fecha en base caja**, `YYYY-MM-DD`. Se cobra siempre el mismo día, así
 *   que base caja = base servicio y no hay cuentas por cobrar que conciliar.
 * - Los identificadores salen de `lib/ingest-id.ts` y de ningún otro lado.
 *
 * Los **nombres de campo** de `IngestPayment` son provisionales y hay que
 * confirmarlos contra el CRM antes de que C3 conecte el push. Cambiarlos es
 * cambiar este archivo y su test; nada más del panel los toca.
 *
 * Por qué el push es **por cierre diario y no por cita**: Actual Budget no
 * actualiza el monto de una transacción ya importada. Empujando al cerrar cada
 * cuenta, corregir un ticket a las 3 p. m. dejaría a Actual con la cifra vieja
 * para siempre, sin error visible. Empujando al cierre del día, las
 * correcciones intradía salen gratis, y una corrección posterior al cierre
 * viaja como un ajuste con id propio.
 */

import {
  buildEaAdjustmentImportedId,
  buildEaImportedId,
  buildPaymentSourceTxId,
} from "./ingest-id";

import type { Cop, PaymentMethod } from "@/db/types";

/** Los tres valores del enum de Strapi. No hay un cuarto. */
export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  "efectivo",
  "transferencia",
  "otro",
];

export class IngestPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestPayloadError";
  }
}

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === "string" && (PAYMENT_METHODS as readonly string[]).includes(value);
}

/**
 * Lo que hace falta de una fila `appointment_finance` para armar el pago.
 *
 * No se recibe la fila entera: `service_notes` son observaciones internas sobre
 * una clienta y no tienen por qué salir del panel, y `closed_by` es un id de
 * Better Auth que aguas abajo no significa nada.
 */
export type FinanceForIngest = {
  eaAppointmentId: number;
  /** `null` es un error de programación acá: una cuenta sin cerrar no se empuja. */
  amountCharged: Cop | null;
  tip: Cop;
  paymentMethod: PaymentMethod | null;
  /** Fecha de caja `YYYY-MM-DD`. Cae siempre en la fecha de la cita. */
  paidOn: string | null;
  eaProviderId: number | null;
  performedServiceId: number | null;
};

/** El cuerpo de un pago. Ver la advertencia del encabezado sobre los nombres. */
export type IngestPayment = {
  /** Agnóstico de fuente: reemplaza al `tx_id` con forma de Agenda Pro. */
  source: "ea";
  source_tx_id: string;
  /** Con lo que Actual deduplica. Nunca se reusa entre una cita y su ajuste. */
  imported_id: string;
  amount: Cop;
  tip: Cop;
  method: PaymentMethod;
  paid_on: string;
  ea_appointment_id: number;
  ea_provider_id: number | null;
  ea_service_id: number | null;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertPesos(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new IngestPayloadError(`${what} tiene que ser un entero de pesos, y llegó ${value}`);
  }
}

/**
 * Los chequeos que valen para el pago y para su ajuste.
 *
 * Se valida acá y no en el llamador porque este archivo es la última compuerta
 * antes de que la cifra salga del panel: lo que pase de acá ya no vuelve —
 * Actual no actualiza.
 */
function baseOf(finance: FinanceForIngest, amount: Cop): Omit<IngestPayment, "imported_id"> {
  if (finance.paymentMethod === null) {
    throw new IngestPayloadError(
      `La cita ${finance.eaAppointmentId} no tiene método de pago y no se puede empujar`,
    );
  }

  if (!isPaymentMethod(finance.paymentMethod)) {
    // Solo alcanzable si una fila trae un valor que el enum de la base no
    // debería permitir. Mejor reventar acá que mandarle a Strapi un `method`
    // que su enum rechaza con un 400 en mitad del push del día.
    throw new IngestPayloadError(
      `Método de pago desconocido en la cita ${finance.eaAppointmentId}: ` +
        JSON.stringify(finance.paymentMethod),
    );
  }

  if (finance.paidOn === null || !DATE_RE.test(finance.paidOn)) {
    throw new IngestPayloadError(
      `La cita ${finance.eaAppointmentId} no tiene fecha de caja válida: ` +
        JSON.stringify(finance.paidOn),
    );
  }

  assertPesos(amount, `El monto de la cita ${finance.eaAppointmentId}`);
  assertPesos(finance.tip, `La propina de la cita ${finance.eaAppointmentId}`);

  return {
    source: "ea",
    source_tx_id: buildPaymentSourceTxId(finance.eaAppointmentId),
    amount,
    // La propina viaja **al lado** del monto, nunca sumada: no es ingreso del
    // estudio y meterla adentro inflaría el ingreso del mes con plata que es
    // de la técnica.
    tip: finance.tip,
    method: finance.paymentMethod,
    paid_on: finance.paidOn,
    ea_appointment_id: finance.eaAppointmentId,
    ea_provider_id: finance.eaProviderId,
    ea_service_id: finance.performedServiceId,
  };
}

/** El pago de una cita cerrada, tal como sale en el push del cierre diario. */
export function buildIngestPayment(finance: FinanceForIngest): IngestPayment {
  if (finance.amountCharged === null) {
    throw new IngestPayloadError(
      `La cita ${finance.eaAppointmentId} no tiene cuenta cerrada y no se puede empujar`,
    );
  }

  return {
    ...baseOf(finance, finance.amountCharged),
    imported_id: buildEaImportedId(finance.eaAppointmentId),
  };
}

/**
 * El ajuste de una cita que se corrigió **después** del cierre.
 *
 * `delta` es la diferencia con signo respecto de lo ya empujado, no el total
 * nuevo: Actual importa el ajuste como un movimiento aparte y lo suma al que ya
 * tiene. Mandar el total nuevo duplicaría el ingreso de esa cita.
 *
 * Un `delta` de cero no se empuja: sería un movimiento de cero pesos en Actual,
 * ruido puro en la conciliación.
 */
export function buildIngestAdjustment(
  finance: FinanceForIngest,
  delta: Cop,
  sequence: number,
): IngestPayment {
  assertPesos(delta, `El ajuste de la cita ${finance.eaAppointmentId}`);

  if (delta === 0) {
    throw new IngestPayloadError(
      `El ajuste de la cita ${finance.eaAppointmentId} es de cero y no se empuja`,
    );
  }

  return {
    ...baseOf(finance, delta),
    // La propina no se re-empuja con el ajuste: si cambió, cambió como parte
    // del delta que el llamador calculó.
    tip: 0,
    imported_id: buildEaAdjustmentImportedId(finance.eaAppointmentId, sequence),
  };
}

/**
 * El lote de un cierre diario.
 *
 * Se arma entero antes de mandar nada. Si una sola cuenta del día está mal, el
 * push no sale a medias: media docena de transacciones en Actual y un error a
 * la mitad es un estado del que hay que salir a mano, y Actual no deja borrar
 * lo importado sin ir a buscarlo una por una.
 */
export function buildDayClosePayments(
  finances: readonly FinanceForIngest[],
): IngestPayment[] {
  return finances.map((finance) => buildIngestPayment(finance));
}
