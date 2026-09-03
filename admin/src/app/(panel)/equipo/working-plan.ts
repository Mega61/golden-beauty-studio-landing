/**
 * El plan de trabajo semanal de una técnica y sus excepciones, listos para
 * pintar.
 *
 * Es lo que hace que "no me sale disponibilidad" tenga una respuesta en vez de
 * un encogimiento de hombros: cada provider tiene **su propio** `workingPlan`,
 * sus excepciones y su lista `services[]`, y las tres cosas pueden explicar el
 * síntoma.
 *
 * Puro y testeado porque decide qué horas se ven como laborables, y equivocarse
 * ahí se ve como "la agenda está mal" y no como "este formateador está mal".
 */

import type {
  WorkingPlan,
  WorkingPlanDay,
  WorkingPlanException,
} from "@/lib/ea";

/** Lunes primero: es como se lee un horario, aunque EA guarde el domingo primero. */
export const WEEK_ORDER = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export type WeekDayKey = (typeof WEEK_ORDER)[number];

const DAY_LABEL: Record<WeekDayKey, string> = {
  monday: "Lunes",
  tuesday: "Martes",
  wednesday: "Miércoles",
  thursday: "Jueves",
  friday: "Viernes",
  saturday: "Sábado",
  sunday: "Domingo",
};

export type PlannedDay = {
  key: WeekDayKey;
  label: string;
  /** `false` = día libre. En EA eso es un `null`, y es información, no un hueco. */
  works: boolean;
  start: string | null;
  end: string | null;
  breaks: Array<{ start: string; end: string }>;
  /** Minutos laborables netos: la jornada menos los descansos. */
  netMinutes: number;
};

export type WeekPlan = {
  days: PlannedDay[];
  /** Minutos netos de la semana. Es la base del cálculo de ocupación. */
  weeklyNetMinutes: number;
  /** `true` si EA no tiene plan para esta técnica: nunca va a mostrar horarios. */
  missing: boolean;
};

/** `"09:30"` → `570`. `null` para cualquier cosa que no sea `HH:MM`. */
export function minutesOfDay(time: string | null | undefined): number | null {
  if (typeof time !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Minutos netos de un día.
 *
 * Un descanso que se sale de la jornada se recorta en vez de restar de más: EA
 * no valida esos rangos, y un plan con un descanso de 13:00 a 20:00 sobre una
 * jornada que termina a las 18:00 daría horas negativas. Cero es el piso.
 */
export function netMinutesOfDay(day: WorkingPlanDay): number {
  if (day === null) return 0;
  const start = minutesOfDay(day.start);
  const end = minutesOfDay(day.end);
  if (start === null || end === null || end <= start) return 0;

  let net = end - start;
  for (const rest of day.breaks) {
    const from = minutesOfDay(rest.start);
    const to = minutesOfDay(rest.end);
    if (from === null || to === null || to <= from) continue;
    const overlap = Math.min(to, end) - Math.max(from, start);
    if (overlap > 0) net -= overlap;
  }
  return Math.max(0, net);
}

export function buildWeekPlan(plan: WorkingPlan | null | undefined): WeekPlan {
  const days: PlannedDay[] = WEEK_ORDER.map((key) => {
    const day = plan ? plan[key] : null;
    return {
      key,
      label: DAY_LABEL[key],
      works: day !== null && day !== undefined,
      start: day?.start ?? null,
      end: day?.end ?? null,
      breaks: day ? day.breaks.map((b) => ({ start: b.start, end: b.end })) : [],
      netMinutes: netMinutesOfDay(day ?? null),
    };
  });

  return {
    days,
    weeklyNetMinutes: days.reduce((total, day) => total + day.netMinutes, 0),
    missing: !plan,
  };
}

// ---------------------------------------------------------------------------
// Excepciones
// ---------------------------------------------------------------------------

export type PlanException = {
  id: number;
  /** `YYYY-MM-DD`. Una excepción sin fecha no se puede ubicar y se descarta. */
  startDate: string;
  endDate: string;
  /**
   * `true` cuando la excepción es un día libre.
   *
   * En EA eso son `startTime`/`endTime` en `null`, y ese `null` **es** el dato:
   * "ese jueves no trabaja", no "ese jueves falta el horario".
   */
  dayOff: boolean;
  startTime: string | null;
  endTime: string | null;
  breaks: Array<{ start: string; end: string }>;
};

/**
 * Excepciones ordenadas de la más próxima a la más lejana, descartando las que
 * no se pueden ubicar en el calendario.
 *
 * `from` recorta el pasado: una excepción de hace ocho meses no ayuda a nadie a
 * entender la agenda de esta semana, y la lista completa entierra las tres que
 * importan.
 */
export function upcomingExceptions(
  exceptions: readonly WorkingPlanException[],
  from: string,
): PlanException[] {
  return exceptions
    .filter((exception) => exception.startDate !== null)
    .map((exception) => {
      const startDate = exception.startDate as string;
      return {
        id: exception.id,
        startDate,
        endDate: (exception.endDate as string | null) ?? startDate,
        dayOff: exception.startTime === null || exception.endTime === null,
        startTime: exception.startTime,
        endTime: exception.endTime,
        breaks: exception.breaks.map((b) => ({ start: b.start, end: b.end })),
      };
    })
    .filter((exception) => exception.endDate >= from)
    .sort((a, b) =>
      a.startDate === b.startDate ? a.id - b.id : a.startDate.localeCompare(b.startDate),
    );
}
