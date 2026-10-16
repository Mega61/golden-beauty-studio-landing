/**
 * Demanda por día de la semana y hora — "cuándo pautar y qué día empujar con
 * una promo".
 *
 * Es aritmética pura sobre filas, como el resto de `aggregate.ts`, y vive en
 * archivo aparte solo porque aquél ya carga los nueve reportes del plan. No
 * define ninguna métrica de `lib/metrics.ts`: cuenta citas y suma plata ya
 * congelada.
 *
 * ## Qué cuenta como demanda, y por qué
 *
 * La pregunta es **cuándo quiere venir la gente**, no cuándo se atendió. De ahí
 * tres decisiones:
 *
 * - **Una inasistencia SÍ es demanda.** Alguien reservó esa hora: el anuncio o
 *   la promo funcionaron, y que no llegara es problema del recordatorio, que
 *   tiene su propio reporte (Inasistencia por franja). Sacarla haría que la
 *   franja con más inasistencias pareciera la menos pedida.
 * - **Una cancelación NO es demanda.** Liberó la silla a tiempo y casi siempre
 *   se reagenda: contarla contaría dos veces a la misma clienta.
 * - **Un estado que el panel no traduce no se cuenta**, y se dice cuántos
 *   fueron. Es la misma regla de `noShowReport`: meterlo en cualquier lado
 *   falsearía el conteo.
 *
 * Lo agendado a futuro (`reservada`, `confirmada`) también cuenta: es demanda
 * que ya existe aunque no haya pasado.
 *
 * ## Agenda Pro entra al conteo, no a la plata
 *
 * Las filas de `legacy_appointment` del periodo entran al mapa de calor con la
 * misma regla (`legacyStatusKind()`): sin ellas, un periodo anterior al corte
 * saldría vacío y el patrón de demanda de años se perdería. **No** entran al
 * ingreso: ningún reporte de plata lee el histórico —su `amount_charged` es
 * nulo cuando el export no lo traía, y el panel nunca recalcula precios—, así
 * que el ingreso por día sale solo de las cuentas cerradas en
 * `appointment_finance`, igual que en los demás reportes.
 *
 * ## Hora de pared de Bogotá, sin `Date`
 *
 * EA guarda hora local sin zona y el dominio la lleva como texto
 * `"YYYY-MM-DD HH:MM:SS"`. La hora se lee del texto y el día de la semana sale
 * de `weekdayKey()` (Zeller), así que el resultado es el mismo en la VM y en CI
 * con cualquier `TZ`.
 */

import { mapEaStatus } from "@/components/calendar";
import { eaDatePart, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea";
import type { DateRange, Interval } from "@/lib/metrics";
import type { Cop } from "@/db/types";

import { isPaidTicket, type FinanceRow, type LegacyStatusKind } from "./aggregate";
import { weekdayKey, type WeekdayKey } from "./period";

/** La semana como la piensa el estudio: de lunes a domingo. */
export const WEEK_ORDER: readonly WeekdayKey[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export const WEEKDAY_LABEL: Record<WeekdayKey, string> = {
  monday: "Lunes",
  tuesday: "Martes",
  wednesday: "Miércoles",
  thursday: "Jueves",
  friday: "Viernes",
  saturday: "Sábado",
  sunday: "Domingo",
};

export const WEEKDAY_SHORT: Record<WeekdayKey, string> = {
  monday: "Lun",
  tuesday: "Mar",
  wednesday: "Mié",
  thursday: "Jue",
  friday: "Vie",
  saturday: "Sáb",
  sunday: "Dom",
};

/** `9 → "9 a. m."`, `12 → "12 m."`, `14 → "2 p. m."` — como las franjas. */
export function hourLabel(hour: number): string {
  if (hour === 0) return "12 a. m.";
  if (hour === 12) return "12 m.";
  return hour < 12 ? `${hour} a. m.` : `${hour - 12} p. m.`;
}

/** La hora de pared de un `"YYYY-MM-DD HH:MM:SS"`. Sin `Date`. */
function hourOf(at: EaLocalDateTime): number {
  return Number(at.slice(11, 13));
}

/** Minutos desde la medianoche de un `"YYYY-MM-DD HH:MM:SS"`. */
function minuteOf(at: EaLocalDateTime): number {
  return Number(at.slice(11, 13)) * 60 + Number(at.slice(14, 16));
}

function within(day: EaLocalDate, period: DateRange): boolean {
  return day >= period.from && day <= period.to;
}

export type DemandInput = {
  period: DateRange;
  /** Citas de EA del periodo, con su estado crudo. */
  appointments: readonly { start: EaLocalDateTime; status: string | null }[];
  /** Filas de Agenda Pro. Se filtran al periodo acá. */
  legacy: readonly { at: EaLocalDateTime; kind: LegacyStatusKind }[];
  /** Cuentas del periodo. Solo las cerradas suman ingreso. */
  finance: readonly FinanceRow[];
  /**
   * Las jornadas del estudio en el periodo (la unión de las de las técnicas,
   * sin unir: se aceptan repetidas). Deciden qué días y qué horas estuvo
   * **abierto**, que es lo que separa "nadie vino" de "estaba cerrado".
   */
  open: readonly Interval[];
};

export type DemandCell = {
  /** Citas que empezaron en esa hora de ese día de la semana. */
  count: number;
  /** ¿Algún día de ese tipo el estudio estuvo abierto a esa hora? */
  open: boolean;
};

export type DemandDay = {
  weekday: WeekdayKey;
  label: string;
  count: number;
  /**
   * Cuántos días de ese tipo tuvo el periodo **abiertos**. Es el denominador:
   * un mes tiene cuatro o cinco sábados, y comparar totales premiaría al día
   * que el calendario repitió una vez más.
   */
  openDays: number;
  /** `count / openDays`. `null` si ese día no abrió nunca en el periodo. */
  perOpenDay: number | null;
  /** Ingreso de las cuentas cerradas que empezaron ese día de la semana. */
  revenue: Cop;
  tickets: number;
};

export type DemandReport = {
  /** Las horas que se dibujan: las abiertas y las que tuvieron citas, sin huecos. */
  hours: number[];
  /** `cells[weekdayIndex][hourIndex]`, en el orden de `WEEK_ORDER` y `hours`. */
  cells: DemandCell[][];
  days: DemandDay[];
  /** El día abierto con más citas por día abierto. `null` sin demanda. */
  busiest: DemandDay | null;
  /** El día abierto con menos. `null` si hay menos de dos días abiertos. */
  slowest: DemandDay | null;
  /** La hora pico del periodo, sumando todos los días. */
  peakHour: number | null;
  total: number;
  /** De `total`, cuántas fueron inasistencias. Están dentro, y se dice. */
  noShows: number;
  /** De `total`, cuántas salieron de Agenda Pro. */
  fromLegacy: number;
  /** Fuera del conteo: canceladas. */
  cancelled: number;
  /** Fuera del conteo: estados de EA que el panel no traduce. */
  unmapped: number;
  /**
   * `false` cuando no hubo jornada que leer (EA caído, plan vacío). Entonces
   * "abierto" se aproxima con "tuvo citas", y la pantalla lo avisa.
   */
  hasOpenInfo: boolean;
};

type Counted = { at: EaLocalDateTime; noShow: boolean; legacy: boolean };

/**
 * Arma el reporte de demanda.
 *
 * Las celdas sin jornada y sin citas salen `open: false` —la pantalla las
 * dibuja vacías y punteadas— y no en cero: un domingo cerrado no tuvo "cero
 * demanda", no tuvo estudio. Es la misma distinción que hace
 * `computeOccupancy()` al devolver `null`.
 */
export function demandReport(input: DemandInput): DemandReport {
  const { period } = input;
  const counted: Counted[] = [];
  let cancelled = 0;
  let unmapped = 0;

  for (const row of input.appointments) {
    if (!within(eaDatePart(row.start), period)) continue;
    const token = mapEaStatus(row.status);
    if (token === "cancelada") {
      cancelled += 1;
    } else if (token === "desconocido") {
      unmapped += 1;
    } else {
      counted.push({ at: row.start, noShow: token === "no-asistio", legacy: false });
    }
  }

  for (const row of input.legacy) {
    if (!within(eaDatePart(row.at), period)) continue;
    if (row.kind === "cancelada") {
      cancelled += 1;
    } else {
      counted.push({ at: row.at, noShow: row.kind === "no-asistio", legacy: true });
    }
  }

  // --- Jornada: qué fechas y qué horas estuvieron abiertas ------------------
  const openDates = new Set<EaLocalDate>();
  const openHours = new Map<WeekdayKey, Set<number>>();

  for (const interval of input.open) {
    const date = eaDatePart(interval.start);
    if (!within(date, period)) continue;
    const startMin = minuteOf(interval.start);
    // Un tramo que termina a medianoche se escribe con la fecha siguiente; para
    // la hora de pared vale como 24:00 del mismo día.
    const endMin =
      eaDatePart(interval.end) > date ? 24 * 60 : minuteOf(interval.end);
    if (endMin <= startMin) continue;

    openDates.add(date);
    const weekday = weekdayKey(date);
    const hours = openHours.get(weekday) ?? new Set<number>();
    for (let hour = Math.floor(startMin / 60); hour * 60 < endMin; hour += 1) {
      hours.add(hour);
    }
    openHours.set(weekday, hours);
  }

  const hasOpenInfo = openDates.size > 0;

  // Sin jornada, "abierto" es "tuvo citas": es la única pista que queda.
  if (!hasOpenInfo) {
    for (const row of counted) openDates.add(eaDatePart(row.at));
  }

  // --- Conteo --------------------------------------------------------------
  const byCell = new Map<string, number>();
  const byWeekday = new Map<WeekdayKey, number>();
  const byHour = new Map<number, number>();

  for (const row of counted) {
    const weekday = weekdayKey(eaDatePart(row.at));
    const hour = hourOf(row.at);
    byCell.set(`${weekday}|${hour}`, (byCell.get(`${weekday}|${hour}`) ?? 0) + 1);
    byWeekday.set(weekday, (byWeekday.get(weekday) ?? 0) + 1);
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
  }

  // --- Plata ---------------------------------------------------------------
  //
  // Solo cuentas cerradas con monto, como todos los reportes de plata: una
  // cuenta sin cerrar no cobró cero, no cobró. El precio es el congelado.
  const revenue = new Map<WeekdayKey, { amount: Cop; tickets: number }>();
  for (const row of input.finance) {
    // Una cortesía de la casa no es venta: no cuenta como ticket del día.
    if (!isPaidTicket(row) || row.amountCharged === null || row.startAt === null) continue;
    const day = eaDatePart(row.startAt);
    if (!within(day, period)) continue;
    const weekday = weekdayKey(day);
    const current = revenue.get(weekday) ?? { amount: 0, tickets: 0 };
    current.amount += row.amountCharged;
    current.tickets += 1;
    revenue.set(weekday, current);
  }

  // --- Horas a dibujar -----------------------------------------------------
  const hourSet = new Set<number>(byHour.keys());
  for (const hours of openHours.values()) for (const hour of hours) hourSet.add(hour);
  const hours: number[] = [];
  if (hourSet.size > 0) {
    const min = Math.min(...hourSet);
    const max = Math.max(...hourSet);
    // Sin huecos: una hora de almuerzo sin citas tiene que verse como fila
    // vacía, no desaparecer y pegar la mañana con la tarde.
    for (let hour = min; hour <= max; hour += 1) hours.push(hour);
  }

  const cells = WEEK_ORDER.map((weekday) =>
    hours.map((hour): DemandCell => {
      const count = byCell.get(`${weekday}|${hour}`) ?? 0;
      return {
        count,
        // Una cita fuera de la jornada abre la celda: pasó, y esconderla
        // escondería justo la señal de que el plan de EA no es el real.
        open: count > 0 || (openHours.get(weekday)?.has(hour) ?? false),
      };
    }),
  );

  // --- Por día de la semana ------------------------------------------------
  const openDaysBy = new Map<WeekdayKey, number>();
  for (const date of openDates) {
    const weekday = weekdayKey(date);
    openDaysBy.set(weekday, (openDaysBy.get(weekday) ?? 0) + 1);
  }

  const days = WEEK_ORDER.map((weekday): DemandDay => {
    const count = byWeekday.get(weekday) ?? 0;
    const openDays = openDaysBy.get(weekday) ?? 0;
    const money = revenue.get(weekday) ?? { amount: 0, tickets: 0 };
    return {
      weekday,
      label: WEEKDAY_LABEL[weekday],
      count,
      openDays,
      perOpenDay: openDays === 0 ? null : count / openDays,
      revenue: money.amount,
      tickets: money.tickets,
    };
  });

  const ranked = days
    .filter((day) => day.perOpenDay !== null)
    // Empate en citas por día: decide la plata, y después el orden de la
    // semana, para que dos corridas den siempre el mismo nombre.
    .sort(
      (a, b) =>
        (b.perOpenDay ?? 0) - (a.perOpenDay ?? 0) ||
        b.revenue / Math.max(1, b.openDays) - a.revenue / Math.max(1, a.openDays) ||
        WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday),
    );

  const busiest = ranked[0] !== undefined && ranked[0].count > 0 ? ranked[0] : null;
  // "El más flojo" solo tiene sentido contra otro: con un solo día abierto, el
  // más lleno y el más flojo serían el mismo y el tile se contradiría.
  const slowest =
    busiest !== null && ranked.length >= 2 ? (ranked[ranked.length - 1] ?? null) : null;

  let peakHour: number | null = null;
  for (const [hour, count] of byHour) {
    if (
      peakHour === null ||
      count > (byHour.get(peakHour) ?? 0) ||
      (count === (byHour.get(peakHour) ?? 0) && hour < peakHour)
    ) {
      peakHour = hour;
    }
  }

  return {
    hours,
    cells,
    days,
    busiest,
    slowest,
    peakHour,
    total: counted.length,
    noShows: counted.filter((row) => row.noShow).length,
    fromLegacy: counted.filter((row) => row.legacy).length,
    cancelled,
    unmapped,
    hasOpenInfo,
  };
}
