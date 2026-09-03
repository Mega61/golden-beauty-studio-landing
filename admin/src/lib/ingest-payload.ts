/**
 * `appointment_finance` → el cuerpo que se le manda a la ruta de ingest de
 * Strapi, la misma que hoy alimenta `agendapro-pull`.
 *
 * **La forma de `Payment` está verificada** contra
 * `src/api/payment/content-types/payment/schema.json` del CRM
 * (`Mega61/golden-beauty-studio-crm`, público). El content type tiene
 * exactamente `tx_id` (string, requerido, **UNIQUE**), `sale_id`, `paid_at`
 * (date), `amount` (integer), `tip` (integer, default 0), `method` (enum
 * `efectivo | transferencia | otro`), `payment_status`, `synced_to_actual` y
 * `actual_txn_id`.
 *
 * **No existen** las columnas `source`, `source_tx_id`, `imported_id`,
 * `ea_appointment_id`, `ea_provider_id` ni `ea_service_id` que este archivo
 * mandaba antes: la migración que el plan describía como "generalizar los
 * campos con forma de Agenda Pro" nunca se hizo. `IngestPayment` es hoy los
 * cinco campos que la fila realmente tiene, y nada más.
 *
 * `imported_id` **no lo escribe el panel**: lo deriva aguas abajo
 * `automation/actual-sync/sync.mjs`, como `` `agendapro-tx:${tx_id}` ``, con
 * un prefijo único y sin conciencia de la fuente. Nuestro `tx_id` viaja
 * adentro de ese prefijo (`agendapro-tx:ea-appt:501`) — feo, pero único contra
 * los ids numéricos del histórico, y no exige tocar `actual-sync`.
 *
 * Lo que este archivo garantiza:
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
  buildPaymentAdjustmentSourceTxId,
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

/**
 * El cuerpo de un pago: los cinco campos de `Payment` y ninguno más.
 *
 * `source_tx_id` es el nombre local de lo que en Strapi se llama `tx_id`. Se
 * mantiene el nombre largo acá adentro porque "tx_id" a secas ya significa
 * otra cosa en este dominio — el id opaco del scraper de Agenda Pro — y
 * confundir los dos es exactamente el error que duplica ingresos.
 *
 * **Es la llave única de la fila.** Dos cosas distintas con el mismo
 * `source_tx_id` no producen dos filas: la segunda le pisa el monto a la
 * primera, porque `upsertPayment()` del CRM llavea por ahí.
 */
export type IngestPayment = {
  source_tx_id: string;
  amount: Cop;
  tip: Cop;
  method: PaymentMethod;
  /** `paid_at` en Strapi. Fecha de caja, `YYYY-MM-DD`. */
  paid_on: string;
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
function baseOf(
  finance: FinanceForIngest,
  amount: Cop,
  sourceTxId: string,
): IngestPayment {
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
    source_tx_id: sourceTxId,
    amount,
    // La propina viaja **al lado** del monto, nunca sumada: no es ingreso del
    // estudio y meterla adentro inflaría el ingreso del mes con plata que es
    // de la técnica.
    tip: finance.tip,
    method: finance.paymentMethod,
    paid_on: finance.paidOn,
  };
}

/** El pago de una cita cerrada, tal como sale en el push del cierre diario. */
export function buildIngestPayment(finance: FinanceForIngest): IngestPayment {
  if (finance.amountCharged === null) {
    throw new IngestPayloadError(
      `La cita ${finance.eaAppointmentId} no tiene cuenta cerrada y no se puede empujar`,
    );
  }

  return baseOf(
    finance,
    finance.amountCharged,
    buildPaymentSourceTxId(finance.eaAppointmentId),
  );
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
    ...baseOf(
      finance,
      delta,
      // Llave propia, con la secuencia adentro: reusar la del pago le pisaría
      // el monto a la fila original en vez de agregar un movimiento.
      buildPaymentAdjustmentSourceTxId(finance.eaAppointmentId, sequence),
    ),
    // La propina no se re-empuja con el ajuste: si cambió, cambió como parte
    // del delta que el llamador calculó.
    tip: 0,
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
  const payments = finances.map((finance) => buildIngestPayment(finance));

  // **Dos movimientos con el mismo `source_tx_id` no pueden salir en el mismo
  // lote.** Es la llave UNIQUE de `Payment` y la que usa `upsertPayment()`:
  // el segundo no crearía una fila, **le pisaría el monto al primero**. Y
  // aguas abajo Actual deduplica por el `imported_id` que deriva de ella, así
  // que se come el segundo **en silencio** — no hay error, no hay fila, y la
  // plata simplemente no está.
  //
  // Es la única función que construye un *conjunto* de esas llaves, así que es
  // la única que puede comprobarlo. Hoy la UNIQUE de `appointment_finance` lo
  // hace inalcanzable desde la consulta del cierre, pero esta función recibe un
  // arreglo, no una consulta — y el día que alguien la llame con un reproceso
  // armado a mano, esta línea es lo que separa "falla ruidosa" de "faltan
  // 200.000 pesos en Actual y nadie sabe desde cuándo".
  //
  // Encontrado por `gbs-money-auditor` (H7).
  const seen = new Map<string, number>();

  for (const [index, payment] of payments.entries()) {
    const previous = seen.get(payment.source_tx_id);

    if (previous !== undefined) {
      throw new IngestPayloadError(
        `El lote del cierre trae dos movimientos con el mismo tx_id ` +
          `(${payment.source_tx_id}): posiciones ${previous} y ${index}. ` +
          "El segundo le pisaría el monto al primero sin avisar.",
      );
    }

    seen.set(payment.source_tx_id, index);
  }

  return payments;
}
