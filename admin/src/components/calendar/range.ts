/**
 * El eje horizontal de la agenda: qué días se ven y qué se le pide a EA.
 *
 * El selector Día · 3 días · Semana **no cambia la naturaleza de la vista**
 * (§ La agenda): sigue siendo una grilla de recurso y sigue llamando a
 * `buildDayGrid()` una vez por día. Lo único que cambia es cuántos días entran.
 * Mes no está y no es un olvido: es un resumen de carga, no una grilla editable,
 * y nadie agenda dentro de una celda de mes.
 *
 * ## El día extra no es paranoia
 *
 * `from` y `till` de EA son **de grano día e inclusivos**, y `till` compara
 * contra `end_datetime`. Una cita que empieza a las 11 de la noche del último
 * día y termina a la 1 de la mañana del siguiente entra igual; la que se pierde
 * es la que **empezó el día anterior** y sigue corriendo dentro del rango,
 * porque su `start_datetime` cae fuera. Se pide un día de más a cada lado y se
 * recorta en memoria — `buildDayGrid()` está escrito para que le sobren citas y
 * ya sabe descartar las que no tocan su día.
 *
 * ## Aritmética de calendario, no de instantes
 *
 * Todo se hace con `Date.UTC`, igual que `weekdayKeyOf()` de B3 y
 * `formatDateLong()` de A3. Un `new Date("2026-08-31")` acá leería la zona del
 * proceso y en un contenedor en UTC después de las 7 de la tarde de Bogotá
 * daría el día siguiente: es el bug de cinco horas otra vez, disfrazado de
 * "ayer la agenda amaneció corrida".
 */

import { resolveWorkingWindow, type GridProvider } from "@/lib/calendar-layout";
import { parseEaLocalDate, type EaLocalDate } from "@/lib/ea/datetime";

/** Los tres rangos del selector. */
export const RANGE_MODES = ["dia", "tres", "semana"] as const;

export type RangeMode = (typeof RANGE_MODES)[number];

export const RANGE_MODE_LABEL: Readonly<Record<RangeMode, string>> = {
  dia: "Día",
  tres: "3 días",
  semana: "Semana",
};

/** Cuántos días muestra cada modo. */
export const RANGE_MODE_DAYS: Readonly<Record<RangeMode, number>> = {
  dia: 1,
  tres: 3,
  semana: 7,
};

export function isRangeMode(value: unknown): value is RangeMode {
  return typeof value === "string" && (RANGE_MODES as readonly string[]).includes(value);
}

/**
 * El modo que pide la URL. Cualquier otra cosa es Día.
 *
 * No se lanza por un query mal escrito: alguien que edita la barra de
 * direcciones a mano merece la agenda de hoy, no una pantalla de error.
 */
export function parseRangeMode(raw: string | undefined): RangeMode {
  return isRangeMode(raw) ? raw : "dia";
}

/** La fecha ancla que pide la URL, o el día que se le pase como "hoy". */
export function parseAnchor(raw: string | undefined, today: EaLocalDate): EaLocalDate {
  if (typeof raw !== "string") return today;
  try {
    return parseEaLocalDate(raw);
  } catch {
    return today;
  }
}

// ---------------------------------------------------------------------------
// Aritmética de fechas
// ---------------------------------------------------------------------------

/** `"2026-08-31"` + 3 días. Calendario puro: ni zona ni horario de verano. */
export function addDays(date: EaLocalDate, days: number): EaLocalDate {
  const [y, m, d] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10) as EaLocalDate;
}

/**
 * El lunes de la semana de `date`.
 *
 * Semana ISO, que empieza el lunes, y no la semana de EA, que empieza el
 * domingo. La diferencia importa: el plan de trabajo de EA usa `sunday` como
 * primera clave porque así viaja su JSON, pero una recepcionista colombiana que
 * pide "la semana" espera lunes a domingo, con el domingo al final.
 */
export function startOfWeek(date: EaLocalDate): EaLocalDate {
  const [y, m, d] = date.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = domingo
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

/**
 * Los días visibles, en orden.
 *
 * Día y 3 días arrancan en la fecha ancla —"desde hoy", que es como se lee una
 * agenda de trabajo—; Semana se alinea al lunes, porque una semana que empieza
 * un miércoles no es una semana.
 */
export function datesFor(mode: RangeMode, anchor: EaLocalDate): EaLocalDate[] {
  const first = mode === "semana" ? startOfWeek(anchor) : anchor;
  return Array.from({ length: RANGE_MODE_DAYS[mode] }, (_, i) => addDays(first, i));
}

/**
 * El ancla de la vista anterior o siguiente.
 *
 * Se salta el rango entero, no un día: en Semana, "siguiente" tiene que dar la
 * semana que viene. En Día y 3 días el paso es de un día — con 3 días la
 * recepción quiere correr la ventana, no saltar tres días y perder de vista
 * mañana.
 */
export function shiftAnchor(
  mode: RangeMode,
  anchor: EaLocalDate,
  direction: -1 | 1,
): EaLocalDate {
  return addDays(anchor, direction * (mode === "semana" ? 7 : 1));
}

// ---------------------------------------------------------------------------
// Lo que se le pide a EA
// ---------------------------------------------------------------------------

/** El rango que va en `from` / `till`, ya con el día extra a cada lado. */
export type FetchWindow = { from: EaLocalDate; till: EaLocalDate };

/**
 * El rango a pedirle a EA para pintar estos días.
 *
 * Un día extra a cada lado, siempre. Ver la cabecera del archivo: sin el de
 * atrás se pierde la cita que cruzó la medianoche, y el de adelante cuesta lo
 * mismo y cubre el caso simétrico el día que la jornada visible se extienda
 * pasada la medianoche.
 */
export function fetchWindow(dates: readonly EaLocalDate[]): FetchWindow {
  if (dates.length === 0) {
    throw new Error("fetchWindow() necesita al menos un día.");
  }
  const sorted = [...dates].sort();
  return {
    from: addDays(sorted[0], -1),
    till: addDays(sorted[sorted.length - 1], 1),
  };
}

/**
 * ¿Esta cita toca alguno de los días visibles?
 *
 * El recorte fino lo hace `buildDayGrid()`, día por día. Esto es el filtro
 * grueso de "descartá lo que vino de más": ahorra pasarle a cada llamada del
 * motor las citas de los dos días de relleno, que en una semana son dos
 * séptimos de la carga.
 *
 * Se compara por fecha de pared (`YYYY-MM-DD` ordena lexicográficamente igual
 * que cronológicamente) y con solape **inclusivo en el inicio**: una cita de
 * duración cero a las 00:00 toca su día aunque no se solape con nada.
 */
export function touchesDates(
  span: { start: string; end: string },
  dates: readonly EaLocalDate[],
): boolean {
  if (dates.length === 0) return false;
  const sorted = [...dates].sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const startDay = span.start.slice(0, 10);
  const endDay = span.end.slice(0, 10);
  return startDay <= last && endDay >= first;
}

// ---------------------------------------------------------------------------
// La jornada visible
// ---------------------------------------------------------------------------

/**
 * El piso de la jornada: 8 de la mañana a 8 de la noche.
 *
 * Son las horas que nombra § La agenda y las que dan 48 filas de 15 minutos.
 * Es un **piso**, no un recorte: si una técnica trabaja desde las 7, la ventana
 * se abre para incluirla. Al revés no — una jornada de 10 a 4 no encoge la
 * grilla, porque el hueco de las 8 sigue siendo un hueco donde se puede agendar
 * una excepción, y una agenda que cambia de forma según quién trabaje hoy hace
 * perder el sitio.
 */
export const DEFAULT_DAY_START = 8 * 60;
export const DEFAULT_DAY_END = 20 * 60;

/** Cuánto se abre la ventana cada vez que se pide ver una cita oculta. */
export const REVEAL_STEP_MINUTES = 60;

export type VisibleWindow = { startMinute: number; endMinute: number };

/**
 * De qué hora a qué hora se dibuja la grilla.
 *
 * Une el piso fijo con los planes de trabajo reales de los días visibles, y
 * después suma lo que se haya pedido descubrir con los contadores de citas
 * ocultas. Nunca se sale del día: una jornada que empezara en −60 haría que el
 * gutter escribiera horas de ayer.
 *
 * `providers` y `dates` son los mismos que recibe `buildDayGrid()`, y la
 * ventana se resuelve con su misma `resolveWorkingWindow()`: si la grilla y
 * esta función discreparan sobre dónde empieza la jornada, la franja de "fuera
 * de horario" quedaría corrida respecto del borde de la grilla.
 */
export function visibleWindow(
  providers: readonly Pick<GridProvider, "workingPlan" | "workingPlanExceptions">[],
  dates: readonly EaLocalDate[],
  expandBefore = 0,
  expandAfter = 0,
): VisibleWindow {
  let start = DEFAULT_DAY_START;
  let end = DEFAULT_DAY_END;

  for (const provider of providers) {
    for (const date of dates) {
      const { window } = resolveWorkingWindow(provider, date);
      if (window.startMinute === null || window.endMinute === null) continue;
      start = Math.min(start, window.startMinute);
      end = Math.max(end, window.endMinute);
    }
  }

  return {
    startMinute: Math.max(0, start - expandBefore * REVEAL_STEP_MINUTES),
    // El tope es 24 h: `buildDayGrid()` mide el día con aritmética de instantes
    // y pedirle más de una vuelta de reloj sería pedirle el día siguiente.
    endMinute: Math.min(24 * 60, end + expandAfter * REVEAL_STEP_MINUTES),
  };
}
