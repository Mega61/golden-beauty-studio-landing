/**
 * El historial de Agenda Pro dentro de los reportes donde es honesto meterlo.
 *
 * ## Qué reportes lo leen y cuáles no
 *
 * `legacy_appointment` trae por cita: fecha y hora de inicio, cliente,
 * servicio y profesional **por nombre**, el estado en texto de Agenda Pro y lo
 * cobrado (`NULL` si no se cobró). No trae hora de fin, ni renglones, ni método
 * de pago, ni precio de lista, ni servicio agendado vs. realizado. De ahí sale
 * la decisión, reporte por reporte:
 *
 * - **Sí:** ventas y número de citas del periodo, por servicio y por
 *   profesional (`salesReport`); asistencia, inasistencia y cancelación por
 *   franja (`noShowReport`, con `legacyNoShowInputs`); y los que ya lo leían —
 *   clientela nueva/regreso, demanda por día y hora, costo por cliente nuevo.
 * - **No:** cierre del día (es la caja de hoy; la de Agenda Pro se cerró
 *   allá), liquidación de comisiones (esa plata ya se liquidó y pagó por
 *   fuera), variación de precio (no hay precio de lista), hora de silla y
 *   ocupación (no hay hora de fin: la duración sería inventada), agendado vs.
 *   realizado y adicionales (no hay renglones). Cada uno lo dice en pantalla.
 *
 * ## ⚠ Esto es lectura para pantalla, nunca plata que sale del panel
 *
 * Nada de acá alimenta `appointment_finance`, caja, el ingest a Strapi/Actual
 * ni comisiones: esos montos ya están en Actual Budget por el scraper de
 * Agenda Pro, y empujarlos otra vez los duplicaría. Ver
 * `lib/legacy-history.money-paths.test.ts`.
 */

import type { Cop } from "@/db/types";
import { eaDatePart, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea";
import {
  firstNameKey,
  isShadowedByEa,
  legacyReportKind,
  matchLegacyProvider,
  normalizeName,
  type LegacyReportKind,
} from "@/lib/legacy-history";

import { mapEaStatus } from "@/components/calendar";
import {
  isPaidTicket,
  type AppointmentRow,
  type FinanceRow,
  type ProviderRow,
  type ServiceRow,
} from "./aggregate";

/** Una fila heredada, en la forma estrecha que los reportes necesitan. */
export type LegacyReportRow = {
  sourceId: string;
  start: EaLocalDateTime;
  serviceName: string;
  /** Como venía de Agenda Pro. */
  providerName: string | null;
  /** La profesional actual por nombre de pila, si hay una sola que case. */
  eaProviderId: number | null;
  /** `null` = no se cobró (o el export no lo trajo). **No es cero.** */
  amountCharged: Cop | null;
  kind: LegacyReportKind;
  customerKey: string | null;
  clientName: string | null;
};

/** La fila de la base, ya en hora de pared. */
export type LegacyRawRow = {
  sourceId: string;
  start: EaLocalDateTime;
  serviceName: string;
  providerName: string | null;
  amountCharged: Cop | null;
  status: string | null;
  customerKey: string | null;
  clientName: string | null;
};

/**
 * Filas crudas → filas de reporte, quedándose con las del rango y sin las que
 * ya existen como cita de EA.
 *
 * Las reservas futuras de Agenda Pro se recrearon en EA el día del corte: sin
 * este descarte, esas citas contarían dos veces en "citas del periodo".
 * `providers` viene con el nombre completo de EA; el de pila es la primera
 * palabra, igual que en la agenda.
 */
export function legacyReportRows(
  raw: readonly LegacyRawRow[],
  range: { from: EaLocalDate; to: EaLocalDate },
  appointments: readonly AppointmentRow[],
  providers: readonly ProviderRow[],
): LegacyReportRow[] {
  const byFirstName = providers.map((provider) => ({
    id: provider.id,
    firstName: firstNameKey(provider.name),
  }));
  const ea = appointments.map((appointment) => ({
    start: appointment.start,
    phone: appointment.customerKey,
    customerName: null,
  }));

  const out: LegacyReportRow[] = [];
  for (const row of raw) {
    const day = eaDatePart(row.start);
    if (day < range.from || day > range.to) continue;
    if (isShadowedByEa({ start: row.start, phone: row.customerKey, clientName: row.clientName }, ea)) {
      continue;
    }
    out.push({
      sourceId: row.sourceId,
      start: row.start,
      serviceName: row.serviceName,
      providerName: row.providerName,
      eaProviderId: matchLegacyProvider(row.providerName, byFirstName),
      amountCharged: row.amountCharged,
      kind: legacyReportKind(row.status),
      customerKey: row.customerKey,
      clientName: row.clientName,
    });
  }
  return out;
}

/** Lo cobrado de una fila heredada que cuenta como venta: atendida y con monto. */
function legacySale(row: LegacyReportRow): Cop | null {
  return row.kind === "atendida" ? row.amountCharged : null;
}

// ── Ventas y citas ──────────────────────────────────────────────────────────

export type SalesGroup = {
  key: string;
  name: string;
  /** Total: panel + Agenda Pro. */
  revenue: Cop;
  /** La parte de Agenda Pro dentro de `revenue`. */
  legacyRevenue: Cop;
  /** Cuentas cerradas del panel + citas atendidas de Agenda Pro. */
  count: number;
  legacyCount: number;
};

export type SalesReport = {
  total: Cop;
  panelTotal: Cop;
  legacyTotal: Cop;
  /** Todas las citas del periodo, cualquiera sea su estado. */
  appointments: number;
  legacyAppointments: number;
  /** Atendidas: EA `completada` + Agenda Pro que no dice que se cayó ni que era reserva. */
  attended: number;
  legacyAttended: number;
  /**
   * Citas de Agenda Pro atendidas **sin monto**. No se suman como cero: el
   * total es "por lo menos" esto, y la pantalla lo dice.
   */
  legacyUnpriced: number;
  byService: SalesGroup[];
  byProvider: SalesGroup[];
};

function bump(
  groups: Map<string, SalesGroup>,
  key: string,
  name: string,
  amount: Cop,
  legacy: boolean,
): void {
  const current = groups.get(key) ?? {
    key,
    name,
    revenue: 0,
    legacyRevenue: 0,
    count: 0,
    legacyCount: 0,
  };
  current.revenue += amount;
  current.count += 1;
  if (legacy) {
    current.legacyRevenue += amount;
    current.legacyCount += 1;
  }
  groups.set(key, current);
}

function sorted(groups: Map<string, SalesGroup>): SalesGroup[] {
  return [...groups.values()].sort(
    (a, b) => b.revenue - a.revenue || b.count - a.count || a.name.localeCompare(b.name, "es"),
  );
}

/**
 * Ventas totales del periodo: cuentas cerradas del panel + citas atendidas de
 * Agenda Pro con monto.
 *
 * Del lado del panel se lee lo de siempre —`amount_charged` de cuentas
 * cerradas, por servicio **realizado**— y del lado de Agenda Pro lo cobrado de
 * cada cita atendida. Los servicios se juntan por nombre normalizado (sin
 * tildes ni mayúsculas), porque Agenda Pro no comparte ids con EA; los que no
 * casan quedan como renglón propio en vez de forzarse a uno parecido.
 */
export function salesReport(
  finance: readonly FinanceRow[],
  appointments: readonly AppointmentRow[],
  legacy: readonly LegacyReportRow[],
  providers: readonly ProviderRow[],
  services: readonly ServiceRow[],
): SalesReport {
  const byService = new Map<string, SalesGroup>();
  const byProvider = new Map<string, SalesGroup>();

  const closed = finance.filter(isPaidTicket);
  let panelTotal = 0;

  for (const row of closed) {
    const amount = row.amountCharged ?? 0;
    panelTotal += amount;

    const serviceId = row.performedServiceId ?? row.bookedServiceId;
    const serviceName =
      serviceId === null
        ? "Sin servicio"
        : (services.find((service) => service.id === serviceId)?.name ?? `Servicio #${serviceId}`);
    bump(byService, `s:${normalizeName(serviceName)}`, serviceName, amount, false);

    const providerName =
      row.eaProviderId === null
        ? "Sin asignar"
        : (providers.find((provider) => provider.id === row.eaProviderId)?.name ??
          `Profesional #${row.eaProviderId}`);
    bump(byProvider, `p:${row.eaProviderId ?? "sin"}`, providerName, amount, false);
  }

  let legacyTotal = 0;
  let legacyAttended = 0;
  let legacyUnpriced = 0;

  for (const row of legacy) {
    if (row.kind !== "atendida") continue;
    legacyAttended += 1;
    const amount = legacySale(row);
    if (amount === null) {
      legacyUnpriced += 1;
      continue;
    }
    legacyTotal += amount;

    const serviceName = row.serviceName.trim() || "Sin servicio";
    bump(byService, `s:${normalizeName(serviceName)}`, serviceName, amount, true);

    // Casada por nombre de pila con una profesional actual, suma en su renglón;
    // si no (Kati), queda con el nombre de Agenda Pro.
    const providerKey =
      row.eaProviderId !== null
        ? `p:${row.eaProviderId}`
        : `n:${normalizeName(row.providerName) || "sin"}`;
    const providerName =
      row.eaProviderId !== null
        ? (providers.find((provider) => provider.id === row.eaProviderId)?.name ??
          row.providerName ??
          "Sin registrar")
        : (row.providerName?.trim() || "Sin registrar");
    bump(byProvider, providerKey, providerName, amount, true);
  }

  const panelAttended = appointments.filter(
    (appointment) => mapEaStatus(appointment.status) === "completada",
  ).length;

  return {
    total: panelTotal + legacyTotal,
    panelTotal,
    legacyTotal,
    appointments: appointments.length + legacy.length,
    legacyAppointments: legacy.length,
    attended: panelAttended + legacyAttended,
    legacyAttended,
    legacyUnpriced,
    byService: sorted(byService),
    byProvider: sorted(byProvider),
  };
}

/** Solo el total, para el delta contra el periodo anterior. */
export function salesTotal(
  finance: readonly FinanceRow[],
  legacy: readonly LegacyReportRow[],
): Cop {
  const panel = finance
    .filter(isPaidTicket)
    .reduce((total, row) => total + (row.amountCharged ?? 0), 0);
  return legacy.reduce((total, row) => total + (legacySale(row) ?? 0), panel);
}

/** Ventas por día del periodo, las dos fuentes juntas. Alimenta la sparkline. */
export function salesSeries(
  finance: readonly FinanceRow[],
  legacy: readonly LegacyReportRow[],
  days: readonly EaLocalDate[],
): number[] {
  const byDay = new Map<string, number>();
  for (const row of finance) {
    if (!isPaidTicket(row) || row.startAt === null || row.amountCharged === null) continue;
    const day = eaDatePart(row.startAt);
    byDay.set(day, (byDay.get(day) ?? 0) + row.amountCharged);
  }
  for (const row of legacy) {
    const amount = legacySale(row);
    if (amount === null) continue;
    const day = eaDatePart(row.start);
    byDay.set(day, (byDay.get(day) ?? 0) + amount);
  }
  return days.map((day) => byDay.get(day) ?? 0);
}

// ── Inasistencia ────────────────────────────────────────────────────────────

/**
 * El estado de una fila heredada en el vocabulario de `noShowReport`.
 *
 * "Atendida" de Agenda Pro es `completada` del panel; "reservada" sigue siendo
 * reservada (cuenta en el denominador, igual que una reserva de EA).
 */
const NO_SHOW_TOKEN: Record<LegacyReportKind, "completada" | "no-asistio" | "cancelada" | "reservada"> = {
  atendida: "completada",
  "no-asistio": "no-asistio",
  cancelada: "cancelada",
  reservada: "reservada",
};

export function legacyNoShowInputs(
  legacy: readonly LegacyReportRow[],
): { start: EaLocalDateTime; token: "completada" | "no-asistio" | "cancelada" | "reservada" }[] {
  return legacy.map((row) => ({ start: row.start, token: NO_SHOW_TOKEN[row.kind] }));
}
