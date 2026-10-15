import type { WorkingPlan, WorkingPlanException } from "@/lib/ea/types";

/**
 * Qué días trabaja una técnica, en la forma mínima que necesita el calendario
 * de la landing para apagar los días cerrados **antes** de que alguien los
 * toque.
 *
 * ## Por qué esto y no la disponibilidad de cada día
 *
 * La disponibilidad real cuesta un abanico de llamadas a EA por día y por
 * técnica, contra un tope de 100 cada 120 s. Pedirla para los 45 días de la
 * tira de fechas tumbaría la agenda del propio estudio. El plan semanal, en
 * cambio, ya viene adentro de `providers.list()` — que el catálogo pide de todas
 * formas — así que apagar los domingos sale gratis.
 *
 * Es una pista, no una promesa: un día "abierto" puede no tener horas libres, y
 * eso lo sigue diciendo la consulta de horarios. Lo que nunca debe pasar es lo
 * contrario —apagar un día que sí tiene horas— y por eso una excepción que abre
 * un día libre gana sobre el plan semanal.
 *
 * ## De la técnica no sale nada más
 *
 * Ni horas de entrada, ni descansos: solo qué días. El plan completo es
 * información de la persona, y la landing no la necesita para nada.
 */
export type PublicSchedule = {
  /** 0 = domingo … 6 = sábado. Los días que el plan semanal deja libres. */
  offWeekdays: number[];
  /** Fechas `YYYY-MM-DD` que una excepción cierra aunque el plan las abra. */
  closedDates: string[];
  /** Fechas `YYYY-MM-DD` que una excepción abre aunque el plan las cierre. */
  openDates: string[];
};

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/** Tope de días que se expanden por excepción: el panel no acepta más allá de 120. */
const MAX_SPAN_DAYS = 130;

export function publicSchedule(
  plan: WorkingPlan | null,
  exceptions: readonly WorkingPlanException[],
  /** Hoy en Bogotá, `YYYY-MM-DD`. Lo pasado no se manda. */
  today: string,
): PublicSchedule {
  // Sin plan, EA no ofrece nada… pero tampoco sabemos qué días cerrar. Mejor
  // no apagar ninguno y que lo diga la consulta de horarios.
  const offWeekdays = plan
    ? WEEKDAYS.flatMap((day, i) => (plan[day] === null ? [i] : []))
    : [];

  const closed = new Set<string>();
  const open = new Set<string>();

  for (const ex of exceptions) {
    if (!ex.startDate) continue;
    const isOff = ex.startTime === null || ex.endTime === null;
    for (const date of expand(ex.startDate, ex.endDate ?? ex.startDate)) {
      if (date < today) continue;
      if (isOff) {
        closed.add(date);
        open.delete(date);
      } else if (!closed.has(date)) {
        open.add(date);
      }
    }
  }

  return {
    offWeekdays,
    closedDates: [...closed].sort(),
    openDates: [...open].sort(),
  };
}

/** Las fechas de un rango inclusivo, a mediodía UTC para no cruzar de día. */
function expand(from: string, till: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${till}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out;
  for (let t = start, n = 0; t <= end && n < MAX_SPAN_DAYS; t += 86_400_000, n += 1) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
