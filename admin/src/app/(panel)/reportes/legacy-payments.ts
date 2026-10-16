/**
 * Cómo se pagaron las ventas del historial de Agenda Pro: efectivo contra
 * transferencia, propinas y ticket promedio, por periodo y por mes.
 *
 * Lee `legacy_payment` (migración `025`, llenada por `scripts/historial-pagos.js`
 * desde los reportes de ventas y transacciones de Agenda Pro). Es la mitad que
 * le faltaba a "Ventas y citas del periodo": esa dice **cuánto** se vendió en
 * Agenda Pro, esta dice **cómo entró**.
 *
 * ## Por fecha de pago, no por fecha de la cita
 *
 * La pregunta es "¿cuánto entró en efectivo en julio?", y la plata entra el
 * día que se paga. Una cita del 30 de junio pagada el 1 de julio es plata de
 * julio acá y venta de junio en "Ventas y citas del periodo". Por eso la
 * pantalla dice la base de cada cifra, y los totales pueden no cuadrar al peso
 * en los bordes de un mes. Forzarlos a la fecha de la cita haría cuadrar los
 * números a costa de contestar otra pregunta.
 *
 * ## Las cortesías van aparte
 *
 * Una venta de cortesía (`is_courtesy`: la dueña, su hermana, Juan) se
 * registró en Agenda Pro con su precio, pero el estudio recibió $0 — la técnica
 * sí cobró su comisión sobre el precio de lista, por fuera del panel. No entra
 * a lo cobrado, ni al reparto por medio, ni al ticket promedio; se muestra
 * como una línea propia, "Cortesías (sin cobro a la clienta)".
 *
 * ## La propina va aparte
 *
 * Igual que en la caja del panel: la propina es de la técnica, no entra a lo
 * cobrado ni al ticket promedio.
 *
 * ## ⚠ Lectura para pantalla, nunca plata que sale del panel
 *
 * Esa plata ya está en Actual Budget por el scraper de Agenda Pro. Nada de acá
 * alimenta caja, ingest ni comisiones; `lib/legacy-history.money-paths.test.ts`
 * lo vigila.
 */

import type { Cop, PaymentMethod } from "@/db/types";
import { eaDatePart, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea";

import { PAYMENT_LABEL, PAYMENT_METHODS } from "./aggregate";
import { monthName } from "./period";

/** Un pago heredado, en la forma estrecha que el reporte necesita. */
export type LegacyPaymentRow = {
  /** La venta de Agenda Pro, para contar ventas y no pagos en el ticket. */
  saleKey: string;
  paidAt: EaLocalDateTime;
  amount: Cop;
  tip: Cop;
  /** El medio **real** (`legacy_payment.method`, ya corregido). */
  method: PaymentMethod;
  /** Cortesía: el estudio no recibió plata. Fuera de todo total. */
  courtesy: boolean;
};

export type LegacyMethodSplit = {
  method: PaymentMethod;
  label: string;
  amount: Cop;
  count: number;
  /** Parte del total, 0–1. `null` si el total es cero. */
  share: number | null;
};

export type LegacyPaymentTotals = {
  /** Lo que entró: sin cortesías ni propinas. */
  total: Cop;
  tips: Cop;
  /** Pagos que no son cortesía. Un pago partido en dos medios cuenta dos. */
  payments: number;
  /** Ventas cobradas distintas: un pago dividido es una venta con dos pagos. */
  sales: number;
  /** Ventas de cortesía y su precio nominal, que no entró. */
  courtesy: { sales: number; amount: Cop };
  /** Lo cobrado por venta, redondeado al peso. `null` sin ventas. */
  averageTicket: Cop | null;
  /** Siempre los tres métodos, en el orden del panel, aunque alguno sea cero. */
  byMethod: LegacyMethodSplit[];
};

export type LegacyPaymentMonth = LegacyPaymentTotals & {
  /** `"YYYY-MM"`. */
  month: string;
  /** "julio 2026". */
  label: string;
  /** ¿Toca el periodo elegido? La pantalla lo resalta. */
  inPeriod: boolean;
};

export type LegacyPaymentReport = {
  /** Los pagos del periodo elegido. */
  period: LegacyPaymentTotals;
  /** Todos los meses con pagos de Agenda Pro, del más viejo al más nuevo. */
  months: LegacyPaymentMonth[];
};

function totalsOf(rows: readonly LegacyPaymentRow[]): LegacyPaymentTotals {
  let total = 0;
  let tips = 0;
  let payments = 0;
  const sales = new Set<string>();
  const courtesySales = new Set<string>();
  let courtesyAmount = 0;
  const byMethod = new Map<PaymentMethod, { amount: number; count: number }>(
    PAYMENT_METHODS.map((method) => [method, { amount: 0, count: 0 }]),
  );

  for (const row of rows) {
    tips += row.tip;
    if (row.courtesy) {
      courtesySales.add(row.saleKey);
      courtesyAmount += row.amount;
      continue;
    }
    total += row.amount;
    payments += 1;
    sales.add(row.saleKey);
    const entry = byMethod.get(row.method)!;
    entry.amount += row.amount;
    entry.count += 1;
  }

  return {
    total,
    tips,
    payments,
    sales: sales.size,
    courtesy: { sales: courtesySales.size, amount: courtesyAmount },
    averageTicket: sales.size === 0 ? null : Math.round(total / sales.size),
    byMethod: PAYMENT_METHODS.map((method) => {
      const entry = byMethod.get(method)!;
      return {
        method,
        label: PAYMENT_LABEL[method],
        amount: entry.amount,
        count: entry.count,
        share: total === 0 ? null : entry.amount / total,
      };
    }),
  };
}

/**
 * El reparto del periodo y el de cada mes de la historia.
 *
 * Los meses van completos —no recortados al periodo— porque "¿cuándo dejó de
 * entrar efectivo?" se contesta mirando la serie entera, y con un periodo de
 * un mes la serie tendría una sola fila. El mes del periodo va marcado.
 */
export function legacyPaymentReport(
  rows: readonly LegacyPaymentRow[],
  range: { from: EaLocalDate; to: EaLocalDate },
): LegacyPaymentReport {
  const inRange = rows.filter((row) => {
    const day = eaDatePart(row.paidAt);
    return day >= range.from && day <= range.to;
  });

  const byMonth = new Map<string, LegacyPaymentRow[]>();
  for (const row of rows) {
    const month = row.paidAt.slice(0, 7);
    const bucket = byMonth.get(month) ?? [];
    bucket.push(row);
    byMonth.set(month, bucket);
  }

  const fromMonth = range.from.slice(0, 7);
  const toMonth = range.to.slice(0, 7);

  const months = [...byMonth.keys()].sort().map((month): LegacyPaymentMonth => {
    const [year, number] = month.split("-").map(Number);
    return {
      ...totalsOf(byMonth.get(month)!),
      month,
      label: `${monthName(number)} ${year}`,
      inPeriod: month >= fromMonth && month <= toMonth,
    };
  });

  return { period: totalsOf(inRange), months };
}
