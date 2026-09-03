/**
 * Las definiciones de los reportes. **Una definición, un solo lugar.**
 *
 * El plan lo dice explícitamente y es la razón de que este archivo exista:
 * "todas viven en `lib/metrics.ts` como funciones puras, y ningún reporte las
 * recalcula por su cuenta". Una ocupación calculada de dos formas distintas en
 * dos pantallas no es un bug que alguien vaya a notar; es una discusión sobre
 * si contratar a alguien, sostenida sobre dos números que no significan lo
 * mismo.
 *
 * Las cuatro definiciones que fija el plan, textuales:
 *
 * - **Ocupación** = minutos de servicios realizados ÷ minutos disponibles (el
 *   plan de trabajo menos bloqueos). Una **inasistencia no cuenta como
 *   ocupada** — la silla estuvo vacía — y **un bloqueo reduce el denominador**,
 *   porque una tarde que el estudio cerró no es una tarde que se desaprovechó.
 * - **Clienta nueva** = sin ninguna cita previa en la unión EA + `legacy_appointment`.
 * - **Retención a 60 días** = % de clientas atendidas en el periodo que
 *   volvieron dentro de los 60 días siguientes.
 * - **Ingreso por hora de silla** = ingreso ÷ minutos de servicio. Con dos
 *   estaciones, la capacidad del negocio son **horas de puesto, no personas**, y
 *   ésta es la cifra que convierte el reporte en una decisión: un combo de $95k
 *   en 120 min rinde más por minuto que un montaje de $115k en 150.
 *
 * El instante "ahora" **entra por parámetro** en todas las funciones que lo
 * necesitan. Un reporte que consulta el reloj por su cuenta da un resultado
 * distinto cada vez que se corre y no se puede testear.
 */

import { eaDatePart, eaLocalToInstant } from "./ea/datetime";

import type { EaLocalDate, EaLocalDateTime } from "./ea/datetime";
import type { Cop } from "@/db/types";

export class MetricsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricsError";
  }
}

// ── Intervalos ──────────────────────────────────────────────────────────────
//
// Toda la aritmética de ocupación se hace sobre minutos absolutos, obtenidos
// con `eaLocalToInstant()`, que ancla la hora de pared en America/Bogota sin
// mirar la zona del proceso. Así el mismo dataset da la misma ocupación en la
// VM y en CI.

/** Un tramo de tiempo `[start, end)`. */
export type Interval = {
  start: EaLocalDateTime;
  end: EaLocalDateTime;
};

/** Una cita, con lo único que la ocupación necesita saber de ella. */
export type OccupancyAppointment = Interval & {
  /**
   * `false` = inasistencia o cancelación. **No cuenta como ocupada** y tampoco
   * reduce el denominador: la silla estuvo libre y eso es exactamente lo que el
   * reporte tiene que mostrar.
   */
  attended: boolean;
};

type Range = { s: number; e: number };

function toRange(interval: Interval, what: string): Range {
  const s = eaLocalToInstant(interval.start).getTime() / 60_000;
  const e = eaLocalToInstant(interval.end).getTime() / 60_000;

  if (e < s) {
    throw new MetricsError(`${what} termina antes de empezar: ${interval.start} → ${interval.end}`);
  }

  return { s, e };
}

/** Ordena y fusiona los solapes. Dos citas encimadas ocupan la silla una vez. */
function merge(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].filter((r) => r.e > r.s).sort((a, b) => a.s - b.s || a.e - b.e);
  const merged: Range[] = [];

  for (const range of sorted) {
    const last = merged[merged.length - 1];

    if (last !== undefined && range.s <= last.e) {
      last.e = Math.max(last.e, range.e);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

/** `a − b`, ambos ya fusionados. */
function subtract(a: readonly Range[], b: readonly Range[]): Range[] {
  const out: Range[] = [];

  for (const range of a) {
    let cursor = range.s;

    for (const hole of b) {
      if (hole.e <= cursor) continue;
      if (hole.s >= range.e) break;

      if (hole.s > cursor) out.push({ s: cursor, e: hole.s });
      cursor = Math.max(cursor, hole.e);

      if (cursor >= range.e) break;
    }

    if (cursor < range.e) out.push({ s: cursor, e: range.e });
  }

  return out;
}

/** `a ∩ b`, ambos ya fusionados. */
function intersect(a: readonly Range[], b: readonly Range[]): Range[] {
  const out: Range[] = [];

  for (const left of a) {
    for (const right of b) {
      const s = Math.max(left.s, right.s);
      const e = Math.min(left.e, right.e);

      if (e > s) out.push({ s, e });
    }
  }

  return merge(out);
}

function totalMinutes(ranges: readonly Range[]): number {
  return ranges.reduce((sum, range) => sum + (range.e - range.s), 0);
}

// ── Ocupación ───────────────────────────────────────────────────────────────

export type OccupancyInput = {
  /** El plan de trabajo, o las horas de apertura de la estación. */
  scheduled: readonly Interval[];
  /** Bloqueos del estudio y no-disponibilidades. **Restan del denominador.** */
  blocked: readonly Interval[];
  appointments: readonly OccupancyAppointment[];
};

export type Occupancy = {
  /** Denominador: plan de trabajo menos bloqueos. */
  availableMinutes: number;
  /** Numerador: minutos atendidos que caen dentro de la ventana disponible. */
  busyMinutes: number;
  /**
   * Minutos atendidos **fuera** de la ventana disponible — la técnica se quedó
   * después de hora, o atendió sobre un bloqueo.
   *
   * Se reportan aparte en vez de sumarse al numerador (daría una ocupación
   * mayor a 100 %, que rompe cualquier promedio) y en vez de descartarse en
   * silencio (serían minutos trabajados que ningún reporte ve). Que aparezcan
   * es la señal de que el plan de trabajo cargado en EA no es el real.
   */
  overflowMinutes: number;
  /**
   * `busy / available`, entre 0 y 1. **`null` cuando no había horas
   * disponibles**, no cero: un domingo cerrado no tiene 0 % de ocupación, no
   * tiene ocupación. Promediar ceros de días cerrados hunde el mes entero.
   */
  rate: number | null;
};

export function computeOccupancy(input: OccupancyInput): Occupancy {
  const scheduled = merge(input.scheduled.map((i) => toRange(i, "Un tramo del plan de trabajo")));
  const blocked = merge(input.blocked.map((i) => toRange(i, "Un bloqueo")));
  const available = subtract(scheduled, blocked);

  const attended = merge(
    input.appointments
      .filter((appointment) => appointment.attended)
      .map((appointment) => toRange(appointment, "Una cita")),
  );

  const busy = intersect(attended, available);
  const availableMinutes = totalMinutes(available);
  const busyMinutes = totalMinutes(busy);

  return {
    availableMinutes,
    busyMinutes,
    overflowMinutes: totalMinutes(attended) - busyMinutes,
    rate: availableMinutes === 0 ? null : busyMinutes / availableMinutes,
  };
}

// ── Clientas ────────────────────────────────────────────────────────────────

/**
 * Una visita, de EA o de `legacy_appointment`.
 *
 * `customerKey` es **el teléfono normalizado a E.164**. La identidad de la
 * clienta en este proyecto es el teléfono y nunca un correo inventado (§ La
 * identidad de la clienta), y la unión EA + legacy solo se puede hacer por ahí:
 * Agenda Pro no comparte identificadores con EA.
 *
 * Quien llama es responsable de pasar **las dos fuentes juntas**. Este módulo
 * no puede verificarlo, y una llamada con solo las citas de EA contaría como
 * nueva a media clientela heredada.
 */
export type VisitRecord = {
  customerKey: string;
  at: EaLocalDateTime;
  /**
   * `false` = inasistencia o cancelación.
   *
   * Solo cuentan las visitas **atendidas**: una clienta que reservó una vez, no
   * llegó, y vuelve seis meses después nunca estuvo en la silla, y el reporte
   * que usa esto ("¿cuánto invertir en captación vs. en volver a traer?") es
   * sobre gente a la que el estudio efectivamente atendió. Quien prefiera la
   * otra lectura pasa todo con `attended: true` y la definición cambia entera
   * en un solo lugar, que es de lo que se trata este archivo.
   */
  attended: boolean;
};

/** Rango de calendario, **ambos extremos inclusivos**. */
export type DateRange = {
  from: EaLocalDate;
  to: EaLocalDate;
};

function withinPeriod(visit: VisitRecord, period: DateRange): boolean {
  const day = eaDatePart(visit.at);
  return day >= period.from && day <= period.to;
}

export type CustomerSplit = {
  /** Clientas cuya primera visita atendida cae dentro del periodo. */
  newCustomers: string[];
  /** Clientas que ya habían sido atendidas antes del periodo. */
  returningCustomers: string[];
};

/**
 * Parte las clientas atendidas en el periodo entre nuevas y que vuelven.
 *
 * Nueva = **sin ninguna visita atendida estrictamente anterior** a su primera
 * visita del periodo, en la unión EA + legacy. Se compara contra su primera
 * visita del periodo y no contra el inicio del periodo, porque son lo mismo
 * cuando la clienta es nueva y no lo son cuando no lo es: una clienta atendida
 * el día 3 y otra vez el día 20 tiene una visita previa dentro del periodo, y
 * eso no la vuelve nueva.
 *
 * Las listas salen ordenadas para que dos corridas del mismo reporte den el
 * mismo orden de filas.
 */
export function splitCustomers(
  visits: readonly VisitRecord[],
  period: DateRange,
): CustomerSplit {
  const attended = visits.filter((visit) => visit.attended);
  const newCustomers: string[] = [];
  const returningCustomers: string[] = [];

  const firstInPeriod = new Map<string, EaLocalDateTime>();

  for (const visit of attended) {
    if (!withinPeriod(visit, period)) continue;

    const current = firstInPeriod.get(visit.customerKey);
    if (current === undefined || visit.at < current) {
      firstInPeriod.set(visit.customerKey, visit.at);
    }
  }

  for (const [customerKey, first] of firstInPeriod) {
    const hadPrevious = attended.some(
      (visit) => visit.customerKey === customerKey && visit.at < first,
    );

    (hadPrevious ? returningCustomers : newCustomers).push(customerKey);
  }

  newCustomers.sort();
  returningCustomers.sort();

  return { newCustomers, returningCustomers };
}

/** ¿Esta clienta es nueva a la fecha `asOf`? El caso de una sola clienta. */
export function isNewCustomer(
  customerKey: string,
  visits: readonly VisitRecord[],
  asOf: EaLocalDateTime,
): boolean {
  return !visits.some(
    (visit) => visit.attended && visit.customerKey === customerKey && visit.at < asOf,
  );
}

export type Retention = {
  /** Clientas atendidas en el periodo. */
  cohort: number;
  /** De ésas, cuántas volvieron dentro de la ventana. */
  returned: number;
  /**
   * Clientas cuya ventana **todavía no se cumplió** a la fecha de corte.
   *
   * Salen del denominador. Contarlas como "no volvió" haría que la retención de
   * un mes recién cerrado se viera catastrófica y mejorara sola dos meses
   * después — un número que se mueve sin que nadie haga nada es un número en el
   * que nadie va a confiar.
   */
  pending: number;
  /** `returned / (cohort − pending)`. `null` si no queda nadie que medir. */
  rate: number | null;
};

const MS_PER_DAY = 86_400_000;

/**
 * Retención a N días (60 por defecto, que es la definición del plan).
 *
 * Para cada clienta de la cohorte se toma su **última** visita atendida dentro
 * del periodo y se pregunta si hay otra visita atendida después de ésa y dentro
 * de la ventana. Se usa la última y no la primera porque con la primera una
 * clienta que vino dos veces el mismo mes contaría como retenida sin haber
 * vuelto nunca después del periodo, y la retención mediría frecuencia en vez de
 * regreso.
 */
export function retentionRate(
  visits: readonly VisitRecord[],
  period: DateRange,
  options: { now: EaLocalDateTime; windowDays?: number },
): Retention {
  const windowDays = options.windowDays ?? 60;

  if (!Number.isSafeInteger(windowDays) || windowDays <= 0) {
    throw new MetricsError(`La ventana de retención tiene que ser días enteros: ${windowDays}`);
  }

  const attended = visits.filter((visit) => visit.attended);
  const lastInPeriod = new Map<string, EaLocalDateTime>();

  for (const visit of attended) {
    if (!withinPeriod(visit, period)) continue;

    const current = lastInPeriod.get(visit.customerKey);
    if (current === undefined || visit.at > current) {
      lastInPeriod.set(visit.customerKey, visit.at);
    }
  }

  const nowMs = eaLocalToInstant(options.now).getTime();
  let returned = 0;
  let pending = 0;

  for (const [customerKey, last] of lastInPeriod) {
    const deadlineMs = eaLocalToInstant(last).getTime() + windowDays * MS_PER_DAY;

    const cameBack = attended.some(
      (visit) =>
        visit.customerKey === customerKey &&
        visit.at > last &&
        eaLocalToInstant(visit.at).getTime() <= deadlineMs,
    );

    // **Una cohorte cuya ventana todavía no se cumplió está pendiente, haya
    // vuelto o no.**
    //
    // El filtro se aplicaba solo a quien *no* había vuelto: quien ya volvió
    // entraba a `returned` de inmediato y el denominador solo contaba a los
    // resueltos. Resultado: un periodo recién cerrado arrancaba cerca del
    // 100 % y **empeoraba solo** a medida que vencían las ventanas de los
    // demás. La misma cohorte congelada daba 100 % en febrero y 50 % en abril
    // sin que cambiara un solo dato — que es justo lo que el comentario de
    // arriba dice que `pending` viene a evitar: "un número que se mueve sin que
    // nadie haga nada es un número en el que nadie va a confiar".
    //
    // Volver antes de tiempo sí es información, y no se pierde: sale en
    // `returned`. Lo que no se hace es meterla en una tasa que todavía no se
    // puede calcular. Encontrado por `gbs-money-auditor` (H4).
    if (deadlineMs > nowMs) {
      pending += 1;
      if (cameBack) returned += 1;
      continue;
    }

    if (cameBack) {
      returned += 1;
    }
  }

  const cohort = lastInPeriod.size;
  const measurable = cohort - pending;

  return {
    cohort,
    returned,
    pending,
    rate: measurable === 0 ? null : returned / measurable,
  };
}

// ── Rentabilidad ────────────────────────────────────────────────────────────

/**
 * Ingreso por hora de silla.
 *
 * `minutes` son minutos de servicio **realizado**, no de agenda: la pregunta es
 * cuánto rinde el puesto mientras se usa. Devuelve `null` con cero minutos —
 * dividir por cero daría `Infinity` y un reporte con "∞ $/h" en una fila es un
 * reporte que nadie vuelve a abrir.
 */
export function revenuePerChairHour(revenue: Cop, minutes: number): number | null {
  if (!Number.isSafeInteger(revenue)) {
    throw new MetricsError(`El ingreso tiene que ser un entero de pesos, y llegó ${revenue}`);
  }

  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new MetricsError(`Los minutos de servicio no pueden ser ${minutes}`);
  }

  return minutes === 0 ? null : revenue / (minutes / 60);
}

/** Una fila de "rentabilidad por hora de silla", agrupada por lo que sea. */
export type ChairHourRow<K> = {
  key: K;
  revenue: Cop;
  minutes: number;
  perHour: number | null;
};

/**
 * Agrupa y ordena de mayor a menor rendimiento.
 *
 * Las filas sin minutos (`perHour: null`) van al final, no al principio: un
 * `null` ordenado como cero las mandaría al fondo por casualidad y como
 * infinito al tope, y la primera fila del reporte es la que se lee.
 */
export function chairHourRanking<K>(
  entries: readonly { key: K; revenue: Cop; minutes: number }[],
): ChairHourRow<K>[] {
  const grouped = new Map<K, { key: K; revenue: Cop; minutes: number }>();

  for (const entry of entries) {
    const current = grouped.get(entry.key);

    if (current === undefined) {
      grouped.set(entry.key, { ...entry });
    } else {
      current.revenue += entry.revenue;
      current.minutes += entry.minutes;
    }
  }

  return [...grouped.values()]
    .map((row) => ({ ...row, perHour: revenuePerChairHour(row.revenue, row.minutes) }))
    .sort((a, b) => {
      if (a.perHour === null && b.perHour === null) return 0;
      if (a.perHour === null) return 1;
      if (b.perHour === null) return -1;
      return b.perHour - a.perHour;
    });
}
