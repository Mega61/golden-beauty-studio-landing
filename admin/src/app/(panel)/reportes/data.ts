import "server-only";

/**
 * Los datos de la pantalla de **Reportes**.
 *
 * Dos fuentes que no se pueden unir con un JOIN: las citas y el catálogo viven
 * en `easyappointments` y se leen por SQL de solo lectura (`ea-sql.ts`); la
 * plata vive en `gbs_admin` y se lee con otro usuario de MySQL, por los
 * repositorios de A2. El cruce se hace acá, en memoria, por
 * `ea_appointment_id`.
 *
 * ## Qué pasa cuando una de las dos no responde
 *
 * El plan lo tiene decidido para todo el panel: **solo lectura con banda de
 * aviso**, no una pantalla de error. Acá eso se traduce en que cada reporte
 * dice qué le falta:
 *
 * - **Sin EA** no hay nombres de servicio, ni duraciones, ni estados, así que
 *   caen la rentabilidad por hora de silla, la ocupación y la inasistencia. El
 *   cierre del día y la variación de precio siguen — son plata de `gbs_admin`.
 * - **Sin `gbs_admin`** no hay plata, y ahí no queda reporte en pie. La
 *   pantalla lo dice de frente en vez de mostrar nueve tarjetas en cero, que
 *   sería peor: un cero se lee como un dato.
 *
 * Lo que **no** se hace es capturar el error y seguir con ceros en silencio.
 * Un reporte que dice `$ 0` porque la base no contestó es una mentira con
 * formato de dato.
 */

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { AppointmentFinance, AppointmentFinanceItem } from "@/db/types";
import { instantToEaLocal, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea";
import type { Interval } from "@/lib/metrics";

import type {
  AppointmentRow,
  CommissionEntryRow,
  FinanceRow,
  ProviderRow,
  ServiceRow,
} from "./aggregate";
import {
  loadAppointments,
  loadBlocks,
  loadPlanExceptions,
  loadProviders,
  loadServices,
  loadVisitHistory,
  type EaBlocks,
  type EaProvider,
} from "./ea-sql";
import { addDays, eachDay, type Period } from "./period";
import { dayWindow, windowOverRange, type DayWindow } from "./occupancy";
import type { WorkingPlanException } from "@/lib/ea";

/** La ventana de retención del plan. Fija: la definición dice 60 días. */
const RETENTION_WINDOW_DAYS = 60;

export type ReportProblem = { source: "ea" | "db"; message: string };

export type ReportData = {
  period: Period;
  /** Días del periodo, en orden. Alimenta la sparkline. */
  days: EaLocalDate[];
  providers: ProviderRow[];
  services: ServiceRow[];
  finance: FinanceRow[];
  /** Las cuentas del periodo **anterior**, solo para el delta de los tiles. */
  previousFinance: FinanceRow[];
  appointments: AppointmentRow[];
  /** Historia completa hasta el fin de la ventana de retención. */
  visitHistory: AppointmentRow[];
  legacyVisits: { customerKey: string | null; at: EaLocalDateTime; attended: boolean }[];
  commissionEntries: CommissionEntryRow[];
  stations: number;
  /** Jornada del estudio y de cada técnica, ya expandidas. */
  studioWindow: DayWindow;
  providerWindows: Map<number, DayWindow>;
  blocks: EaBlocks;
  /** El instante de corte de la retención. Entra por parámetro, nunca del reloj. */
  now: EaLocalDateTime;
  problems: ReportProblem[];
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** La fila de plata de A2 → la forma estrecha que los reportes consumen. */
function toFinanceRow(
  row: AppointmentFinance,
  items: readonly AppointmentFinanceItem[],
): FinanceRow {
  return {
    eaAppointmentId: row.ea_appointment_id,
    eaProviderId: row.ea_provider_id,
    secondaryEaProviderId: row.secondary_ea_provider_id,
    startAt: row.appointment_start_at === null ? null : instantToEaLocal(row.appointment_start_at),
    bookedServiceId: row.booked_service_id,
    performedServiceId: row.performed_service_id,
    snapshot: row.service_price_snapshot,
    snapshotSource: row.snapshot_source,
    discount: row.discount,
    amountCharged: row.amount_charged,
    tip: row.tip,
    paymentMethod: row.payment_method,
    varianceReasonCode: row.variance_reason_code,
    // "Cerrada" es tener `closed_at`. El `amount_charged` puede ser 0 de verdad
    // —un retoque de garantía— y usarlo como señal de cierre haría desaparecer
    // esas cuentas de la ocupación y de la ficha de la clienta.
    closed: row.closed_at !== null,
    items: items.map((item) => ({
      kind: item.kind,
      eaServiceId: item.ea_service_id,
      pricingId: item.pricing_id,
      qty: item.qty,
      unitPrice: item.unit_price_snapshot,
      lineTotal: item.line_total,
    })),
  };
}

/** El instante límite de un día de calendario, para las consultas por rango. */
function dayBounds(from: EaLocalDate, to: EaLocalDate): { start: Date; end: Date } {
  // Se construye con los componentes locales y no parseando el ISO, porque
  // `new Date("2026-08-01")` es medianoche **UTC** y en Bogotá cae el 31 de
  // julio a las 7 p. m. Los repositorios de A2 esperan instantes.
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return {
    start: new Date(fy, fm - 1, fd, 0, 0, 0, 0),
    end: new Date(ty, tm - 1, td + 1, 0, 0, 0, 0),
  };
}

async function loadFinance(
  db: ReturnType<typeof getDb>,
  from: EaLocalDate,
  to: EaLocalDate,
): Promise<FinanceRow[]> {
  const repos = repositories(db);
  const bounds = dayBounds(from, to);
  const rows = await repos.appointmentFinance.listByStartRange(bounds.start, bounds.end);

  // Los renglones de todo el periodo en **una** consulta. Una por cuenta serían
  // doscientas idas y vueltas para pintar una pantalla.
  const items = await repos.appointmentFinanceItems.listByFinanceIds(
    rows.map((row) => row.id),
  );

  const byFinance = new Map<number, AppointmentFinanceItem[]>();
  for (const item of items) {
    const bucket = byFinance.get(item.appointment_finance_id) ?? [];
    bucket.push(item);
    byFinance.set(item.appointment_finance_id, bucket);
  }

  return rows.map((row) => toFinanceRow(row, byFinance.get(row.id) ?? []));
}

/**
 * Los renglones de comisión del periodo, para todas las técnicas.
 *
 * Se pide **una consulta por técnica** porque el repositorio de A2 expone
 * `listByProviderAndPeriod(providerId, from, to)` y no una variante sin
 * provider. Con dos a seis técnicas son dos a seis consultas indexadas; pedirle
 * a A2 un `listByPeriod()` es lo natural y está reportado, pero no justifica
 * bloquear el paquete.
 */
async function loadCommissionEntries(
  db: ReturnType<typeof getDb>,
  providers: readonly ProviderRow[],
  period: Period,
): Promise<CommissionEntryRow[]> {
  const repos = repositories(db);
  const out: CommissionEntryRow[] = [];

  const perProvider = await Promise.all(
    providers.map((provider) =>
      repos.commissionEntries.listByProviderAndPeriod(provider.id, period.from, period.to),
    ),
  );

  for (const rows of perProvider) {
    for (const row of rows) {
      out.push({
        eaProviderId: row.ea_provider_id,
        baseAmount: row.base_amount,
        amount: row.amount,
        commissionRuleId: row.commission_rule_id,
        status: row.status,
      });
    }
  }

  return out;
}

function windowsFor(
  providers: readonly EaProvider[],
  days: readonly EaLocalDate[],
  exceptions: readonly WorkingPlanException[],
): { studioWindow: DayWindow; providerWindows: Map<number, DayWindow> } {
  const providerWindows = new Map<number, DayWindow>();
  const studioOpen: Interval[] = [];
  const studioBreaks: Interval[] = [];

  for (const provider of providers) {
    const own = exceptions.filter(
      (exception) => exception.providerId === provider.id,
    );
    const window = windowOverRange(days, provider.workingPlan, own);
    providerWindows.set(provider.id, window);
    studioOpen.push(...window.open);
    studioBreaks.push(...window.breaks);
  }

  // La jornada del **estudio** es la unión de las de las técnicas, y la unión
  // la hace `computeOccupancy()` de B1 cuando `stationHourOccupancy()` le pasa
  // esta ventana. Acá solo se concatena.
  //
  // Los descansos entran igual: un descanso de una sola técnica no cierra el
  // estudio, y `computeOccupancy()` lo resuelve bien porque resta la unión de
  // los bloqueos de la unión de las jornadas — si otra técnica está abierta a
  // esa hora, el minuto sigue disponible.
  return { studioWindow: { open: studioOpen, breaks: studioBreaks }, providerWindows };
}

/**
 * Todo lo que la pantalla necesita, en un solo viaje.
 *
 * `today` y `now` entran por parámetro: el corte de la retención decide si una
 * cohorte está pendiente, y un reporte que consulta el reloj por su cuenta no
 * se puede reproducir.
 */
export async function loadReports(
  period: Period,
  now: Date = new Date(),
): Promise<ReportData> {
  const problems: ReportProblem[] = [];
  const days = eachDay(period.from, period.to);
  const previousFrom = addDays(period.from, -days.length);
  const previousTo = addDays(period.from, -1);
  const retentionTill = addDays(period.to, RETENTION_WINDOW_DAYS);

  // --- La plata -----------------------------------------------------------
  //
  // Sin esto no queda reporte en pie, así que se pide primero y su fallo se
  // reporta como lo que es.
  let finance: FinanceRow[] = [];
  let previousFinance: FinanceRow[] = [];
  let legacyVisits: ReportData["legacyVisits"] = [];
  let stations = 0;
  let db: ReturnType<typeof getDb> | null = null;

  try {
    db = getDb();
    const repos = repositories(db);
    const [current, previous, legacy, stationCount] = await Promise.all([
      loadFinance(db, period.from, period.to),
      loadFinance(db, previousFrom, previousTo),
      repos.legacyAppointments.listByStartRange(
        new Date(2000, 0, 1),
        dayBounds(retentionTill, retentionTill).end,
      ),
      repos.stations.count(),
    ]);

    finance = current;
    previousFinance = previous;
    stations = stationCount;
    legacyVisits = legacy.map((row) => ({
      customerKey: row.client_phone_e164,
      at: instantToEaLocal(row.started_at),
      // El histórico de Agenda Pro guarda el estado como texto libre suyo, no
      // el de EA. Se considera atendida la que **no** dice que se cayó: el
      // export no trae una lista cerrada de estados, y descartar todo lo que no
      // se reconozca borraría la clientela heredada del reporte, que es
      // exactamente lo que `legacy_appointment` existe para evitar.
      attended: !/cancel|no.?asis|no.?show/i.test(row.status ?? ""),
    }));
  } catch (error) {
    db = null;
    problems.push({ source: "db", message: messageOf(error) });
  }

  // --- La agenda ----------------------------------------------------------
  let providers: EaProvider[] = [];
  let services: ServiceRow[] = [];
  let appointments: AppointmentRow[] = [];
  let visitHistory: AppointmentRow[] = [];
  let exceptions: WorkingPlanException[] = [];
  let blocks: EaBlocks = { byProvider: new Map(), studio: [] };

  try {
    const [providerRows, serviceRows, appointmentRows, history, exceptionLoad, blockLoad] =
      await Promise.all([
        loadProviders(),
        loadServices(),
        loadAppointments(period.from, period.to),
        loadVisitHistory(retentionTill),
        loadPlanExceptions(period.from, period.to),
        loadBlocks(period.from, period.to),
      ]);

    providers = providerRows;
    services = serviceRows;
    appointments = appointmentRows;
    visitHistory = history;
    exceptions = exceptionLoad.data;
    blocks = blockLoad.data;

    for (const message of [...exceptionLoad.problems, ...blockLoad.problems]) {
      problems.push({ source: "ea", message });
    }
  } catch (error) {
    problems.push({ source: "ea", message: messageOf(error) });
  }

  // --- Comisiones ---------------------------------------------------------
  //
  // Depende de las dos: la lista de técnicas viene de EA y los renglones de
  // `gbs_admin`. Sin técnicas no hay a quién consultarle, y ahí la liquidación
  // sale vacía con su propio aviso en la pantalla.
  let commissionEntries: CommissionEntryRow[] = [];
  if (db !== null && providers.length > 0) {
    try {
      commissionEntries = await loadCommissionEntries(
        db,
        providers.map((provider) => ({ id: provider.id, name: provider.name })),
        period,
      );
    } catch (error) {
      problems.push({ source: "db", message: messageOf(error) });
    }
  }

  const { studioWindow, providerWindows } = windowsFor(providers, days, exceptions);

  return {
    period,
    days,
    providers: providers.map((provider) => ({ id: provider.id, name: provider.name })),
    services,
    finance,
    previousFinance,
    appointments,
    visitHistory,
    legacyVisits,
    commissionEntries,
    stations,
    studioWindow,
    providerWindows,
    blocks,
    now: instantToEaLocal(now),
    problems,
  };
}

/** La jornada de una técnica para un solo día. Lo usa el reporte del día. */
export function windowForDay(
  provider: EaProvider,
  date: EaLocalDate,
  exceptions: readonly WorkingPlanException[],
): DayWindow {
  return dayWindow(
    date,
    provider.workingPlan,
    exceptions.filter((exception) => exception.providerId === provider.id),
  );
}
