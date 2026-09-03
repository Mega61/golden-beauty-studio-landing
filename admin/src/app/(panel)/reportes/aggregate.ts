/**
 * Los nueve reportes, como funciones puras de filas a cifras.
 *
 * ## Por qué acá y no en el componente
 *
 * Regla dura del proyecto: **ningún cálculo de plata dentro de un componente o
 * un handler.** Todo lo de este archivo es aritmética sobre filas, sin React,
 * sin base y sin red, y por eso se puede fijar con tests. Los componentes de
 * `Charts.tsx` reciben el resultado y solo lo dibujan.
 *
 * ## Ninguna métrica se recalcula acá
 *
 * Las cuatro definiciones del plan —ocupación, clienta nueva, retención a 60
 * días, ingreso por hora de silla— viven en `lib/metrics.ts` y **se llaman**,
 * no se reimplementan. Lo de este archivo es agrupar, sumar y ordenar; en el
 * momento en que una función de acá empiece a *definir* qué significa algo,
 * está en el archivo equivocado.
 *
 * Tres cosas que sí son propias de este archivo y están marcadas donde
 * aparecen:
 *
 * - **La variación de precio** no es propia: `priceVariance()` es la compuerta
 *   de `validateTicketClose()` de B1, exportada. Hubo un espejo acá
 *   (`variance.ts`) mientras B1 no la exportaba; ya no existe.
 * - **La ocupación por hora de estación** es `stationHourOccupancy()` de
 *   `lib/metrics.ts`; `occupancy.ts` solo traduce el plan de trabajo de EA.
 * - **El origen de la reserva no existe en EA.** Ver `noShowReport`.
 *
 * ## Lo agendado no es lo realizado
 *
 * Todo reporte de plata lee `performed_service_id` — el servicio **realizado**,
 * que es el que la técnica cerró — y nunca `booked_service_id`. La única
 * excepción es el reporte que compara los dos justamente para medir la
 * diferencia.
 */

import { mapEaStatus } from "@/components/calendar";
import type { StatusToken } from "@/components/ui/status";
import { eaDatePart, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea";
import {
  chairHourRanking,
  retentionRate,
  splitCustomers,
  type ChairHourRow,
  type DateRange,
  type Retention,
  type VisitRecord,
} from "@/lib/metrics";
import { priceVariance, type TicketItemInput } from "@/lib/ticket";
import type {
  Cop,
  PaymentMethod,
  SnapshotSource,
  VarianceReasonCode,
} from "@/db/types";

import { slotOf, SLOTS, type SlotId } from "./occupancy";

// ── Filas de entrada ────────────────────────────────────────────────────────
//
// Formas deliberadamente estrechas: lo que el reporte necesita y nada más. Un
// reporte que recibiera la fila completa de EA arrastraría el teléfono y el
// nombre de la clienta a cada agregación, y esos datos no tienen nada que hacer
// en una suma de pesos.

/** Una cita de EA, leída del pool de solo lectura. */
export type AppointmentRow = {
  id: number;
  start: EaLocalDateTime;
  end: EaLocalDateTime;
  /** Texto libre de EA. Puede venir `""`: ver `mapEaStatus`. */
  status: string | null;
  eaProviderId: number | null;
  eaServiceId: number | null;
  /** Teléfono normalizado a E.164, o `null` si la clienta no tiene. */
  customerKey: string | null;
  /** Vacío = el push a Google falló. Es la única señal que existe. */
  googleCalendarId: string | null;
};

export type FinanceItemRow = {
  kind: "servicio" | "adicional" | "manual";
  eaServiceId: number | null;
  pricingId: string | null;
  qty: number;
  unitPrice: Cop;
  lineTotal: Cop;
  /**
   * Obligatoria cuando `kind === "manual"`, y por eso viaja hasta acá.
   *
   * Se caía del proyector, y `varianceReport()` le pasaba `null` a
   * `priceVariance()` → `computeTicketTotals()`, que **lanza** ante un renglón
   * manual sin nota. La excepción salía de un Server Component, así que
   * cualquier periodo con una sola cuenta de cobro manual tumbaba `/reportes`
   * entero — no el reporte de variación: la página.
   */
  note: string | null;
};

/** El encabezado de una cuenta, con sus renglones. */
export type FinanceRow = {
  eaAppointmentId: number;
  eaProviderId: number | null;
  secondaryEaProviderId: number | null;
  startAt: EaLocalDateTime | null;
  bookedServiceId: number | null;
  performedServiceId: number | null;
  snapshot: Cop | null;
  snapshotSource: SnapshotSource;
  discount: Cop;
  /** `null` = la cuenta no está cerrada. **No es cero.** */
  amountCharged: Cop | null;
  tip: Cop;
  paymentMethod: PaymentMethod | null;
  varianceReasonCode: VarianceReasonCode | null;
  closed: boolean;
  items: FinanceItemRow[];
};

/** Lo que el reporte necesita saber de un servicio. */
export type ServiceRow = {
  id: number;
  name: string;
  /** Minutos de catálogo. Es el denominador de la hora de silla. */
  durationMin: number;
};

/** Un renglón de comisión ya congelado por el motor de B1/D1. */
export type CommissionEntryRow = {
  eaProviderId: number;
  baseAmount: Cop;
  amount: Cop;
  /** `null` = **cero marcado**: no había regla aplicable. */
  commissionRuleId: number | null;
  status: "pending" | "paid";
};

export type ProviderRow = { id: number; name: string };

// ── Utilidades ──────────────────────────────────────────────────────────────

function nameOf(providers: readonly ProviderRow[], id: number | null): string {
  if (id === null) return "Sin asignar";
  return providers.find((provider) => provider.id === id)?.name ?? `Técnica #${id}`;
}

function serviceName(services: readonly ServiceRow[], id: number | null): string {
  if (id === null) return "Sin servicio";
  return services.find((service) => service.id === id)?.name ?? `Servicio #${id}`;
}

/** Suma que respeta el signo del renglón: una corrección resta. */
function sumLines(items: readonly FinanceItemRow[], kind?: FinanceItemRow["kind"]): Cop {
  return items.reduce(
    (total, item) => (kind === undefined || item.kind === kind ? total + item.lineTotal : total),
    0,
  );
}

/** El ingreso de una cuenta. `null` (sin cerrar) **no entra**, no suma cero. */
function chargedOf(row: FinanceRow): Cop | null {
  return row.amountCharged;
}

// ── 1 · Cierre del día ──────────────────────────────────────────────────────
//
// La decisión: ¿cuadra la caja? ¿puedo cerrar?

export const PAYMENT_METHODS: readonly PaymentMethod[] = [
  "efectivo",
  "transferencia",
  "otro",
];

export const PAYMENT_LABEL: Record<PaymentMethod, string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  otro: "Otro",
};

export type DailyClose = {
  revenue: Cop;
  tips: Cop;
  /** Cuentas cerradas y cuentas de citas atendidas que siguen sin cerrar. */
  closedCount: number;
  pendingCount: number;
  /**
   * Cuentas cerradas **sin método de pago**. No es una categoría de pago: es un
   * dato que falta, y sumarlo a "otro" lo escondería.
   */
  withoutMethod: number;
  byMethod: { method: PaymentMethod; label: string; amount: Cop; count: number }[];
  byProvider: { eaProviderId: number | null; name: string; revenue: Cop; tips: Cop; count: number }[];
  /**
   * Si el día ya está cerrado, cuándo y por quién queda del lado de Caja: acá
   * solo importa si la compuerta está abierta.
   */
  blockers: string[];
};

export function dailyClose(
  finance: readonly FinanceRow[],
  appointments: readonly AppointmentRow[],
  providers: readonly ProviderRow[],
): DailyClose {
  const closed = finance.filter((row) => row.closed && row.amountCharged !== null);

  // "Pendiente" es una cita **atendida** sin cuenta cerrada. Una cancelada o
  // una inasistencia no son pendientes: no hay nada que cobrar, y contarlas
  // dejaría la compuerta del cierre trabada para siempre.
  const attendedIds = new Set(
    appointments
      .filter((appointment) => {
        const token = mapEaStatus(appointment.status);
        return token === "completada" || token === "confirmada" || token === "reservada";
      })
      .map((appointment) => appointment.id),
  );

  const pending = finance.filter(
    (row) => !row.closed && attendedIds.has(row.eaAppointmentId),
  );

  const revenue = closed.reduce((total, row) => total + (chargedOf(row) ?? 0), 0);
  const tips = closed.reduce((total, row) => total + row.tip, 0);

  const byMethod = PAYMENT_METHODS.map((method) => {
    const rows = closed.filter((row) => row.paymentMethod === method);
    return {
      method,
      label: PAYMENT_LABEL[method],
      amount: rows.reduce((total, row) => total + (chargedOf(row) ?? 0), 0),
      count: rows.length,
    };
  });

  const providerIds = [...new Set(closed.map((row) => row.eaProviderId))];
  const byProvider = providerIds
    .map((id) => {
      const rows = closed.filter((row) => row.eaProviderId === id);
      return {
        eaProviderId: id,
        name: nameOf(providers, id),
        revenue: rows.reduce((total, row) => total + (chargedOf(row) ?? 0), 0),
        tips: rows.reduce((total, row) => total + row.tip, 0),
        count: rows.length,
      };
    })
    .sort((a, b) => b.revenue - a.revenue || a.name.localeCompare(b.name, "es"));

  const withoutMethod = closed.filter((row) => row.paymentMethod === null).length;

  const blockers: string[] = [];
  if (pending.length > 0) {
    // **La compuerta es la funcionalidad**: no se cierra el día con una cita
    // atendida sin cuenta. El texto va acá y no en la pantalla porque es la
    // misma frase que Caja necesita.
    blockers.push(
      pending.length === 1
        ? "1 cita atendida sin cuenta cerrada"
        : `${pending.length} citas atendidas sin cuenta cerrada`,
    );
  }
  if (withoutMethod > 0) {
    blockers.push(
      withoutMethod === 1
        ? "1 cuenta cerrada sin método de pago"
        : `${withoutMethod} cuentas cerradas sin método de pago`,
    );
  }

  return {
    revenue,
    tips,
    closedCount: closed.length,
    pendingCount: pending.length,
    withoutMethod,
    byMethod,
    byProvider,
    blockers,
  };
}

// ── 2 · Liquidación de la quincena ──────────────────────────────────────────
//
// La decisión: cuánto se le paga a cada una.

export type SettlementRow = {
  eaProviderId: number;
  name: string;
  /** Base de comisión: lo cobrado en los renglones que comisionan. */
  base: Cop;
  commission: Cop;
  /** Renglones liquidados con **cero marcado**: no había regla aplicable. */
  unmatched: number;
  entries: number;
  paid: Cop;
  pending: Cop;
};

export type Settlement = {
  rows: SettlementRow[];
  totalBase: Cop;
  totalCommission: Cop;
  /**
   * Renglones sin regla aplicable en todo el periodo. Cualquier número
   * distinto de cero es una regla que falta configurar, no una comisión de
   * cero — es la misma distinción que hace `commission_entry`.
   */
  unmatched: number;
};

export function settlement(
  entries: readonly CommissionEntryRow[],
  providers: readonly ProviderRow[],
): Settlement {
  const ids = [...new Set(entries.map((entry) => entry.eaProviderId))];

  const rows = ids
    .map((id): SettlementRow => {
      const own = entries.filter((entry) => entry.eaProviderId === id);
      return {
        eaProviderId: id,
        name: nameOf(providers, id),
        base: own.reduce((total, entry) => total + entry.baseAmount, 0),
        commission: own.reduce((total, entry) => total + entry.amount, 0),
        unmatched: own.filter((entry) => entry.commissionRuleId === null).length,
        entries: own.length,
        paid: own
          .filter((entry) => entry.status === "paid")
          .reduce((total, entry) => total + entry.amount, 0),
        pending: own
          .filter((entry) => entry.status === "pending")
          .reduce((total, entry) => total + entry.amount, 0),
      };
    })
    .sort((a, b) => b.commission - a.commission || a.name.localeCompare(b.name, "es"));

  return {
    rows,
    totalBase: rows.reduce((total, row) => total + row.base, 0),
    totalCommission: rows.reduce((total, row) => total + row.commission, 0),
    unmatched: rows.reduce((total, row) => total + row.unmatched, 0),
  };
}

// ── 3 · Rentabilidad por hora de silla ──────────────────────────────────────
//
// La decisión: qué empujar y qué re-tarifar. Es el reporte que Agenda Pro no
// daba y el que más plata mueve.

export type ChairHourReport = {
  rows: (ChairHourRow<number | null> & { name: string; tickets: number })[];
  /** Filas sin minutos de catálogo: no se pueden rankear, y hay que decirlo. */
  withoutDuration: number;
};

export function chairHourReport(
  finance: readonly FinanceRow[],
  services: readonly ServiceRow[],
): ChairHourReport {
  const closed = finance.filter((row) => row.closed && row.amountCharged !== null);

  const durationOf = (id: number | null): number =>
    id === null ? 0 : (services.find((service) => service.id === id)?.durationMin ?? 0);

  const tickets = new Map<number | null, number>();

  const entries = closed.map((row) => {
    // Se agrupa por el servicio **realizado**. Agrupar por el agendado diría
    // que los press-on rinden lo que en realidad rindieron los forrados.
    const key = row.performedServiceId ?? row.bookedServiceId ?? null;
    tickets.set(key, (tickets.get(key) ?? 0) + 1);
    return {
      key,
      // El ingreso de la cuenta completa, adicionales incluidos: el puesto
      // estuvo ocupado el mismo tiempo y cobró todo eso.
      revenue: chargedOf(row) ?? 0,
      minutes: durationOf(key),
    };
  });

  // `chairHourRanking` es de B1: agrupa, calcula el ingreso por hora con
  // `revenuePerChairHour` y ordena mandando los `null` al final. Acá no se
  // recalcula nada de eso.
  const ranked = chairHourRanking(entries);

  return {
    rows: ranked.map((row) => ({
      ...row,
      name: serviceName(services, row.key),
      tickets: tickets.get(row.key) ?? 0,
    })),
    withoutDuration: ranked.filter((row) => row.perHour === null).length,
  };
}

// ── 5 · Servicio agendado vs. realizado ─────────────────────────────────────
//
// La decisión: arreglar el menú o el flujo de reserva, **no a la técnica**.

export type SwapFlow = {
  fromId: number | null;
  toId: number | null;
  from: string;
  to: string;
  count: number;
  /** Diferencia de ingreso frente al precio de lista del agendado. */
  delta: Cop;
};

export type BookedVsPerformed = {
  /** Cuentas cerradas con los dos campos poblados: el denominador. */
  comparable: number;
  changed: number;
  /** `changed / comparable`. `null` si no hay nada que comparar. */
  rate: number | null;
  flows: SwapFlow[];
};

export function bookedVsPerformed(
  finance: readonly FinanceRow[],
  services: readonly ServiceRow[],
): BookedVsPerformed {
  // Una cuenta sin servicio realizado no dice nada sobre el cambio de
  // servicio: dice que la cuenta no se cerró. Fuera del denominador, igual que
  // las cohortes pendientes salen del de la retención.
  const comparable = finance.filter(
    (row) => row.closed && row.bookedServiceId !== null && row.performedServiceId !== null,
  );

  const changed = comparable.filter(
    (row) => row.bookedServiceId !== row.performedServiceId,
  );

  const key = (row: FinanceRow) => `${row.bookedServiceId}→${row.performedServiceId}`;
  const grouped = new Map<string, SwapFlow>();

  for (const row of changed) {
    const id = key(row);
    const current = grouped.get(id);
    const delta = (chargedOf(row) ?? 0) - (row.snapshot ?? 0);

    if (current === undefined) {
      grouped.set(id, {
        fromId: row.bookedServiceId,
        toId: row.performedServiceId,
        from: serviceName(services, row.bookedServiceId),
        to: serviceName(services, row.performedServiceId),
        count: 1,
        delta,
      });
    } else {
      current.count += 1;
      current.delta += delta;
    }
  }

  return {
    comparable: comparable.length,
    changed: changed.length,
    rate: comparable.length === 0 ? null : changed.length / comparable.length,
    flows: [...grouped.values()].sort(
      (a, b) => b.count - a.count || Math.abs(b.delta) - Math.abs(a.delta),
    ),
  };
}

// ── 6 · Adicionales: enganche y monto por técnica ───────────────────────────
//
// La decisión: dónde entrenar, qué ofrecer por defecto.

export type ExtrasRow = {
  eaProviderId: number | null;
  name: string;
  tickets: number;
  /** Cuentas con al menos un adicional. */
  withExtras: number;
  /** `withExtras / tickets`. `null` sin cuentas cerradas. */
  attachRate: number | null;
  amount: Cop;
  /** Monto de adicionales ÷ cuentas cerradas. `null` sin cuentas. */
  perTicket: number | null;
};

export function extrasReport(
  finance: readonly FinanceRow[],
  providers: readonly ProviderRow[],
): { rows: ExtrasRow[]; total: Cop; attachRate: number | null } {
  const closed = finance.filter((row) => row.closed && row.amountCharged !== null);
  const ids = [...new Set(closed.map((row) => row.eaProviderId))];

  const rows = ids
    .map((id): ExtrasRow => {
      const own = closed.filter((row) => row.eaProviderId === id);
      const withExtras = own.filter((row) =>
        row.items.some((item) => item.kind === "adicional" && item.lineTotal > 0),
      ).length;
      const amount = own.reduce((total, row) => total + sumLines(row.items, "adicional"), 0);
      return {
        eaProviderId: id,
        name: nameOf(providers, id),
        tickets: own.length,
        withExtras,
        attachRate: own.length === 0 ? null : withExtras / own.length,
        amount,
        perTicket: own.length === 0 ? null : amount / own.length,
      };
    })
    .sort((a, b) => (b.attachRate ?? -1) - (a.attachRate ?? -1) || b.amount - a.amount);

  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  const withExtras = rows.reduce((sum, row) => sum + row.withExtras, 0);

  return {
    rows,
    total,
    attachRate: closed.length === 0 ? null : withExtras / closed.length,
  };
}

// ── 7 · Variación de precio por técnica, desglosada por motivo ──────────────
//
// La decisión: dónde se escapa la plata.

export const VARIANCE_REASONS: readonly VarianceReasonCode[] = [
  "cambio_servicio",
  "adicionales",
  "cortesia",
  "correccion",
  "otro",
];

export const VARIANCE_LABEL: Record<VarianceReasonCode, string> = {
  cambio_servicio: "Cambio de servicio",
  adicionales: "Adicionales",
  cortesia: "Cortesía",
  correccion: "Corrección",
  otro: "Otro",
};

export type VarianceCell = {
  eaProviderId: number | null;
  reason: VarianceReasonCode | "sin-motivo";
  amount: Cop;
  count: number;
};

export type VarianceReport = {
  providers: { eaProviderId: number | null; name: string; amount: Cop }[];
  reasons: { reason: VarianceReasonCode | "sin-motivo"; label: string; amount: Cop }[];
  cells: VarianceCell[];
  total: Cop;
  /** El peor caso: la mayor variación de una sola cuenta. */
  worst: number;
  /**
   * Cuentas que cobraron menos que la lista **sin motivo registrado**.
   *
   * `validateTicketClose()` de B1 no deja cerrar una así, así que cualquier
   * número distinto de cero significa una fila escrita por fuera del panel —
   * por SQL, o por una versión anterior de la compuerta. Es un hallazgo, no una
   * categoría.
   */
  withoutReason: number;
};

export function varianceReport(
  finance: readonly FinanceRow[],
  providers: readonly ProviderRow[],
): VarianceReport {
  const closed = finance.filter((row) => row.closed && row.amountCharged !== null);

  const cells = new Map<string, VarianceCell>();
  let withoutReason = 0;
  let worst = 0;

  for (const row of closed) {
    // `priceVariance` **es** la compuerta de `validateTicketClose()` de B1,
    // exportada: acá no se define ninguna variación, se le pregunta a B1.
    //
    // El renglón se traduce a la forma de B1 y `note` va en `null` porque
    // `FinanceItemRow` no la trae — es el mismo dato que se pasaba antes, así
    // que el número no cambia. Ojo: con un renglón `kind: "manual"` eso hace
    // lanzar a `computeTicketTotals()` ("un renglón manual exige una nota"),
    // que es el comportamiento que ya había y está reportado como hallazgo, no
    // arreglado acá: arreglarlo cambia las cifras del reporte.
    const amount = priceVariance(
      row.items.map(
        (item): TicketItemInput => ({
          kind: item.kind,
          qty: item.qty,
          unitPriceSnapshot: item.unitPrice,
          note: item.note,
        }),
      ),
      row.amountCharged ?? 0,
    );
    if (amount <= 0) continue;

    if (row.varianceReasonCode === null) withoutReason += 1;
    worst = Math.max(worst, amount);

    const reason: VarianceReasonCode | "sin-motivo" =
      row.varianceReasonCode ?? "sin-motivo";
    const id = `${row.eaProviderId}|${reason}`;
    const current = cells.get(id);

    if (current === undefined) {
      cells.set(id, { eaProviderId: row.eaProviderId, reason, amount, count: 1 });
    } else {
      current.amount += amount;
      current.count += 1;
    }
  }

  const list = [...cells.values()];
  const providerIds = [...new Set(list.map((cell) => cell.eaProviderId))];

  const providerRows = providerIds
    .map((id) => ({
      eaProviderId: id,
      name: nameOf(providers, id),
      amount: list
        .filter((cell) => cell.eaProviderId === id)
        .reduce((total, cell) => total + cell.amount, 0),
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "es"));

  const allReasons: (VarianceReasonCode | "sin-motivo")[] = [
    ...VARIANCE_REASONS,
    "sin-motivo",
  ];
  const presentReasons = allReasons.filter((reason) =>
    list.some((cell) => cell.reason === reason),
  );

  const reasonRows = presentReasons.map((reason) => ({
    reason,
    label: reason === "sin-motivo" ? "Sin motivo" : VARIANCE_LABEL[reason],
    amount: list
      .filter((cell) => cell.reason === reason)
      .reduce((total, cell) => total + cell.amount, 0),
  }));

  return {
    providers: providerRows,
    reasons: reasonRows,
    cells: list,
    total: list.reduce((total, cell) => total + cell.amount, 0),
    worst,
    withoutReason,
  };
}

// ── 8 · Clientas nuevas vs. que vuelven, y retención a 60 días ──────────────
//
// La decisión: cuánto invertir en captación vs. en volver a traer.

export type CustomersReport = {
  newCustomers: number;
  returningCustomers: number;
  /** `nuevas / (nuevas + vuelven)`. `null` sin clientas atendidas. */
  newShare: number | null;
  retention: Retention;
  /**
   * Visitas del periodo **sin teléfono**, que no entran a ninguna de las dos
   * cuentas.
   *
   * La identidad de la clienta es el teléfono (§ La identidad de la clienta) y
   * sin él no hay forma de saber si volvió. Contarlas como nuevas inflaría la
   * captación con la misma clienta cuatro veces.
   */
  withoutKey: number;
};

export function customersReport(
  visits: readonly VisitRecord[],
  withoutKey: number,
  period: DateRange,
  now: EaLocalDateTime,
): CustomersReport {
  // Las dos funciones son de B1 y aquí solo se llaman. La definición de
  // "clienta nueva" y la de "retención a 60 días" viven allá, una sola vez.
  const split = splitCustomers(visits, period);
  const retention = retentionRate(visits, period, { now });

  const attended = split.newCustomers.length + split.returningCustomers.length;

  return {
    newCustomers: split.newCustomers.length,
    returningCustomers: split.returningCustomers.length,
    newShare: attended === 0 ? null : split.newCustomers.length / attended,
    retention,
    withoutKey,
  };
}

// ── 9 · Inasistencia por franja (y por origen: no se puede) ─────────────────
//
// La decisión: si el recordatorio funciona, y si algún horario no vale la pena
// abrir.

export type NoShowSlot = {
  slot: SlotId;
  label: string;
  /** Citas de esa franja que llegaron a la fecha: el denominador. */
  scheduled: number;
  noShows: number;
  cancelled: number;
  /** `noShows / scheduled`. `null` si esa franja no tuvo citas. */
  rate: number | null;
};

export type NoShowReport = {
  slots: NoShowSlot[];
  scheduled: number;
  noShows: number;
  cancelled: number;
  rate: number | null;
  /**
   * Estados de EA que el panel no supo traducir, sin repetir.
   *
   * Salen aparte porque una cita con estado desconocido **no** se puede contar
   * ni como asistida ni como inasistencia, y meterla en cualquiera de los dos
   * lados falsearía la tasa. Es también la señal de que alguien editó
   * `appointment_status_options` en EA.
   */
  unmapped: string[];
  /**
   * ⚠ **El origen de la reserva no se puede reportar, y no es un olvido.**
   *
   * El plan pide "inasistencia por franja **y por origen de reserva**". La
   * segunda mitad no es construible: **`ea_appointments` no tiene ninguna
   * columna de origen** — ni `booking_source`, ni `source`, ni `channel`.
   * Verificado leyendo la fuente de EA 1.6.0: la tabla se crea en
   * `application/migrations/001_specific_calendar_sync.php` y la lista completa
   * de campos expuestos está en `Appointments_model::$api_resource`
   * (`application/models/Appointments_model.php:35-51`); no hay tal campo en
   * ninguna de las dos. `id_google_calendar` **no** sirve de proxy: dice si la
   * cita se espejó en Google, no de dónde vino la reserva.
   *
   * Así que este reporte entrega la mitad que existe y **dice en pantalla** que
   * la otra no. Fingir un origen sacándolo de un proxy sería peor que no
   * mostrarlo: la decisión que habilita es apagar un canal de reserva, y
   * apagar el canal equivocado cuesta plata de verdad.
   */
  originAvailable: false;
};

export function noShowReport(appointments: readonly AppointmentRow[]): NoShowReport {
  const byToken = (row: AppointmentRow): StatusToken => mapEaStatus(row.status);

  const unmapped: string[] = [];
  const seen = new Set<string>();
  for (const row of appointments) {
    if (byToken(row) !== "desconocido") continue;
    const label = row.status ?? "";
    if (seen.has(label)) continue;
    seen.add(label);
    unmapped.push(label);
  }

  const countable = appointments.filter((row) => byToken(row) !== "desconocido");

  const ids: SlotId[] = [...SLOTS.map((slot) => slot.id), "fuera"];

  const slots = ids
    .map((slot): NoShowSlot => {
      const own = countable.filter((row) => slotOf(row.start) === slot);
      const noShows = own.filter((row) => byToken(row) === "no-asistio").length;
      return {
        slot,
        label: SLOTS.find((entry) => entry.id === slot)?.label ?? "Fuera de horario",
        scheduled: own.length,
        noShows,
        cancelled: own.filter((row) => byToken(row) === "cancelada").length,
        rate: own.length === 0 ? null : noShows / own.length,
      };
    })
    // La franja "fuera de horario" solo aparece si de verdad hubo algo ahí: una
    // fila vacía permanente enseña a ignorar la última fila de la tabla.
    .filter((slot) => slot.slot !== "fuera" || slot.scheduled > 0);

  const noShows = countable.filter((row) => byToken(row) === "no-asistio").length;

  return {
    slots,
    scheduled: countable.length,
    noShows,
    cancelled: countable.filter((row) => byToken(row) === "cancelada").length,
    rate: countable.length === 0 ? null : noShows / countable.length,
    unmapped,
    originAvailable: false,
  };
}

// ── Visitas para el reporte de clientas ─────────────────────────────────────

/**
 * Convierte citas de EA y filas heredadas en los `VisitRecord` que
 * `lib/metrics.ts` espera.
 *
 * **Las dos fuentes tienen que entrar juntas.** `splitCustomers()` lo dice: una
 * llamada con solo las citas de EA contaría como nueva a media clientela
 * heredada. Esta función recibe las dos y por eso existe.
 *
 * Una visita sin teléfono se descarta y se cuenta aparte: la identidad de la
 * clienta es el teléfono, y sin él no hay forma de saber si volvió.
 */
export function toVisits(
  appointments: readonly AppointmentRow[],
  legacy: readonly { customerKey: string | null; at: EaLocalDateTime; attended: boolean }[],
): { visits: VisitRecord[]; withoutKey: number } {
  const visits: VisitRecord[] = [];
  let withoutKey = 0;

  for (const row of appointments) {
    if (row.customerKey === null || row.customerKey.trim() === "") {
      withoutKey += 1;
      continue;
    }
    const token = mapEaStatus(row.status);
    visits.push({
      customerKey: row.customerKey,
      at: row.start,
      // Solo "completada" cuenta como atendida. `confirmada` y `reservada` son
      // el futuro: una cita de la semana que viene no es una visita.
      attended: token === "completada",
    });
  }

  for (const row of legacy) {
    if (row.customerKey === null || row.customerKey.trim() === "") {
      withoutKey += 1;
      continue;
    }
    visits.push({ customerKey: row.customerKey, at: row.at, attended: row.attended });
  }

  return { visits, withoutKey };
}

/** Cuántas citas cayeron en cada día del periodo. Alimenta la sparkline. */
export function dailySeries(
  finance: readonly FinanceRow[],
  days: readonly EaLocalDate[],
): number[] {
  const byDay = new Map<string, number>();

  for (const row of finance) {
    if (!row.closed || row.startAt === null || row.amountCharged === null) continue;
    const day = eaDatePart(row.startAt);
    byDay.set(day, (byDay.get(day) ?? 0) + row.amountCharged);
  }

  return days.map((day) => byDay.get(day) ?? 0);
}

/** Cuántas cuentas quedaron marcadas `fallback` o sin snapshot en el periodo. */
export function snapshotHealth(finance: readonly FinanceRow[]): {
  fallback: number;
  withoutSnapshot: number;
} {
  return {
    fallback: finance.filter((row) => row.snapshotSource === "fallback").length,
    withoutSnapshot: finance.filter((row) => row.snapshot === null).length,
  };
}
