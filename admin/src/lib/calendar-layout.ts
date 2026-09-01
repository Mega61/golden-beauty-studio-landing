/**
 * Layout de la agenda — la estructura que la grilla de C1 pinta.
 *
 * **Es una función pura fuera de React, y esa es la decisión, no un detalle de
 * organización.** El layout de un calendario se rompe en los bordes: una cita
 * que cruza el fin de la jornada, un bloqueo que tapa media cita, una cita de
 * duración cero, una que cruza la medianoche. Esos bordes se fijan con tests,
 * no arrastrando el ratón sobre una grilla en el navegador, porque arrastrando
 * el ratón nadie prueba la medianoche.
 *
 * ## Por qué hay resolución de solapes si "no debería haber solapes"
 *
 * La API REST de EA **no valida choques** (hueco #4 del plan): `Calendar.php`
 * llama a `has_provider_conflict()` antes de guardar, pero
 * `Appointments_api_v1::store()` y `::update()` no tienen ese chequeo y aceptan
 * una cita encima de otra sin protestar. Todas nuestras escrituras van por la
 * API, y además la base ya trae historia hecha por otras vías. Entonces la
 * grilla tiene que saber **dibujar el error** — dos citas encimadas se reparten
 * el ancho de la columna y las dos se ven — en vez de romperse o esconder una.
 * Detectarlo antes de escribir es trabajo de `conflict.ts`; dibujarlo cuando ya
 * pasó es trabajo de acá.
 *
 * ## Unidades
 *
 * Todo se mide en **minutos desde la medianoche del día de la grilla**, en la
 * línea de tiempo absoluta (vía `minutesBetween`, que pasa por instantes). Un
 * número negativo significa "empezó ayer" y uno mayor que el fin del día
 * significa "termina mañana"; las dos cosas pasan y las dos tienen que
 * sobrevivir el recorte.
 *
 * **Nada se formatea acá.** La grilla emite minutos y horas de pared; quien
 * escribe "2 p. m." es `components/ui/format.ts`. Un módulo de layout que
 * devuelve texto ya localizado no se puede reusar para imprimir ni para el
 * reporte de ocupación.
 *
 * ## Un día por llamada
 *
 * `buildDayGrid` arma **un** día. El selector Día · 3 días · Semana de la UX
 * cambia el eje horizontal, y esa composición es de C1: llama N veces y pone
 * los resultados uno al lado del otro. Meter el rango multi-día acá obligaría a
 * que cada bloque supiera a qué día pertenece, y la aritmética de minutos
 * dejaría de ser legible justo donde tiene que serlo.
 */

import {
  addMinutes,
  EA_TIME_ZONE,
  eaLocalDateTime,
  instantToEaLocal,
  minutesBetween,
  parseEaLocalDate,
  type EaLocalDate,
  type EaLocalDateTime,
} from "./ea/datetime";
import type {
  Appointment,
  BlockedPeriod,
  Unavailability,
  WorkingPlan,
  WorkingPlanDay,
  WorkingPlanException,
} from "./ea/types";

// ---------------------------------------------------------------------------
// Capas
// ---------------------------------------------------------------------------

/**
 * El orden de apilamiento, de abajo hacia arriba, tal como lo fija § La agenda.
 *
 * Es un número y no un string porque la UI lo va a poner en un `z-index` y
 * porque el orden **es** el dato: que "excepción de plan" vaya encima de
 * "descanso del plan" es lo que hace que un jueves en que Lina entra a las 11
 * se lea como excepción y no como su descanso de siempre.
 */
export const GRID_LAYER = {
  offHours: 0,
  planBreak: 1,
  planException: 2,
  block: 3,
  appointment: 4,
  now: 5,
} as const;

export type GridLayer = (typeof GRID_LAYER)[keyof typeof GRID_LAYER];

/** Qué es la banda. Decide el tinte. */
export type GridBandKind = "off-hours" | "break" | "blocked" | "unavailable";

/**
 * De dónde salió la banda. Decide la etiqueta y, junto con `kind`, la capa.
 *
 * `plan` y `plan-exception` producen las mismas dos formas (fuera de horario y
 * descanso) y hay que poder distinguirlas: "Lina no trabaja los domingos" y
 * "Lina el jueves entra a las 11" se dibujan distinto aunque geométricamente
 * sean la misma franja gris.
 */
export type GridBandOrigin =
  | "plan"
  | "plan-exception"
  | "blocked-period"
  | "unavailability";

/**
 * Una franja de fondo de una columna, ya recortada al rango visible.
 *
 * `startMinute` / `endMinute` son el tramo **visible**. Los `clipped*` dicen
 * que el original se salía, para que la UI pueda dibujar el borde abierto en
 * vez de uno cerrado que mentiría sobre dónde termina.
 */
export type GridBand = {
  /** Estable entre renders: `kind:origin:id:startMinute`. Es la key de React. */
  key: string;
  kind: GridBandKind;
  origin: GridBandOrigin;
  layer: GridLayer;
  /** Id del registro de EA que la produjo, si lo hay. El plan no tiene id. */
  sourceId: number | null;
  label: string | null;
  startMinute: number;
  endMinute: number;
  clippedStart: boolean;
  clippedEnd: boolean;
};

// ---------------------------------------------------------------------------
// Bloques de cita
// ---------------------------------------------------------------------------

/**
 * Una cita ya posicionada.
 *
 * Se separan dos geometrías a propósito:
 *
 * - `startMinute` / `endMinute` / `durationMinutes` son **el dato**, recortado
 *   al rango visible. Una cita de duración cero mide cero y así se reporta.
 * - `renderHeightMinutes` es **el dibujo**: nunca menor que `minEventMinutes`,
 *   porque un bloque de alto cero no se puede tocar, no se puede leer y
 *   equivale a haber perdido la cita.
 *
 * Confundir las dos es cómo se termina con una agenda que dice que una cita
 * dura 15 minutos porque así se veía.
 */
export type GridEvent = {
  key: string;
  appointment: Appointment;
  startMinute: number;
  endMinute: number;
  /** Duración real de la cita completa, **sin** recortar al rango. */
  durationMinutes: number;
  renderHeightMinutes: number;
  clippedStart: boolean;
  clippedEnd: boolean;
  /** Empezó antes de la medianoche del día de la grilla. */
  startsPreviousDay: boolean;
  /** Termina después de la medianoche siguiente. */
  continuesNextDay: boolean;
  /** Carril asignado, `0`-indexado. */
  lane: number;
  /** Cuántos carriles tiene su grupo de solape. `1` si no se solapa con nada. */
  laneCount: number;
  /** `lane / laneCount`, ya listo para un `left: ${offset * 100}%`. */
  offset: number;
  /** `1 / laneCount`. */
  width: number;
  layer: GridLayer;
};

// ---------------------------------------------------------------------------
// Columnas y grilla
// ---------------------------------------------------------------------------

/** La ventana laboral efectiva de una técnica para ese día. */
export type WorkingWindow = {
  /** `null` = día libre. */
  startMinute: number | null;
  endMinute: number | null;
  /** Quién decidió la ventana: el plan semanal o una excepción de ese día. */
  source: "plan" | "plan-exception";
  /** La excepción que mandó, si mandó una. */
  exceptionId: number | null;
};

export type GridColumn = {
  providerId: number;
  providerName: string;
  window: WorkingWindow;
  bands: readonly GridBand[];
  events: readonly GridEvent[];
  /**
   * Citas de esta técnica que tocan el día pero caen **fuera** del rango
   * visible. No es decoración: sin este contador, subir el inicio de la
   * jornada a las 9 escondería en silencio la cita de las 8:30, que es
   * exactamente la clase de pérdida invisible que este proyecto persigue.
   */
  hiddenBefore: number;
  hiddenAfter: number;
};

/** Marca del gutter de horas. El texto lo pone `format.ts`, no este módulo. */
export type GridSlot = {
  minute: number;
  wall: EaLocalDateTime;
  /** Cae en punto. El gutter etiqueta estas y deja mudas las intermedias. */
  isHour: boolean;
};

export type NowLine = {
  minute: number;
  wall: EaLocalDateTime;
};

export type DayGrid = {
  date: EaLocalDate;
  range: DayGridRange;
  /** Filas de `slotMinutes` que cubren el rango. La última puede sobrar. */
  rowCount: number;
  slots: readonly GridSlot[];
  columns: readonly GridColumn[];
  /** `null` si "ahora" no cae dentro del rango de este día. */
  nowLine: NowLine | null;
  /**
   * Lo que llegó y no tiene columna donde vivir: una cita sin `providerId`, o
   * de una técnica que no está en la lista. Se reporta en vez de descartarse
   * en silencio — una cita que desaparece de la agenda sin aviso es el peor
   * modo de falla posible de esta pantalla.
   */
  orphanAppointments: readonly Appointment[];
  orphanUnavailabilities: readonly Unavailability[];
};

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

export type DayGridRange = {
  date: EaLocalDate;
  /** Minuto del día donde arranca la grilla. Las 8:00 son `480`. */
  startMinute: number;
  /** Minuto donde termina, exclusivo. Las 8:00 p. m. son `1200`. */
  endMinute: number;
  /**
   * Alto de una fila, en minutos.
   *
   * **No se asume 15.** EA trae `slotInterval` por servicio y la jornada
   * tampoco es fija; una constante acá sería una decisión de producto
   * escondida en un módulo de geometría.
   */
  slotMinutes: number;
};

/** Una técnica y su plan. Es lo que hace falta para pintar su columna. */
export type GridProvider = {
  id: number;
  name: string;
  workingPlan: WorkingPlan | null;
  workingPlanExceptions?: readonly WorkingPlanException[];
};

/**
 * Los cuatro grupos que nombra el plan (`citas`, `bloqueos`, `planes`, `rango`)
 * viajan en un objeto y no como cuatro posicionales: la lista real es más larga
 * — indisponibilidades, "ahora", zona, alto mínimo — y una llamada de siete
 * argumentos posicionales se equivoca sola el día que alguien agregue el
 * octavo.
 */
export type DayGridInput = {
  range: DayGridRange;
  providers: readonly GridProvider[];
  appointments?: readonly Appointment[];
  unavailabilities?: readonly Unavailability[];
  blockedPeriods?: readonly BlockedPeriod[];
  /** Instante para la línea de "ahora". Sin él no se dibuja la línea. */
  now?: Date | null;
  timeZone?: string;
  /**
   * Alto mínimo de un bloque de cita, en minutos. Por defecto una fila.
   * Ver `GridEvent.renderHeightMinutes`.
   */
  minEventMinutes?: number;
};

// ---------------------------------------------------------------------------
// Aritmética de minutos
// ---------------------------------------------------------------------------

/** Error de entrada: un rango que no puede existir. */
export class CalendarLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarLayoutError";
  }
}

function midnightOf(date: EaLocalDate): EaLocalDateTime {
  const [y, m, d] = date.split("-").map(Number);
  return eaLocalDateTime(y, m, d, 0, 0, 0);
}

/**
 * `"HH:MM"` o `"HH:MM:SS"` → minutos desde medianoche.
 *
 * Devuelve `null` para cualquier otra cosa. Los planes de EA son texto libre en
 * la práctica (viajan como JSON dentro de `user_settings`) y una hora corrupta
 * tiene que degradar a "no sé", no reventar la agenda del día entero.
 */
export function parsePlanTime(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 24 || mm > 59) return null;
  return hh * 60 + mm;
}

const WEEKDAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

/**
 * Día de la semana de un `YYYY-MM-DD`, calculado con `Date.UTC`.
 *
 * Aritmética de calendario pura: no toca la zona del proceso, así que da lo
 * mismo en la VM (`America/Bogota`) que en un runner de CI en UTC. Usar
 * `new Date("2026-08-31")` acá sería el bug de cinco horas otra vez.
 */
export function weekdayKeyOf(date: EaLocalDate): (typeof WEEKDAY_KEYS)[number] {
  const [y, m, d] = date.split("-").map(Number);
  return WEEKDAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

type Span = { startMinute: number; endMinute: number };

function intersect(span: Span, within: Span): Span | null {
  const start = Math.max(span.startMinute, within.startMinute);
  const end = Math.min(span.endMinute, within.endMinute);
  // Se descarta el tramo vacío **y** el invertido. Un `end === start` acá es
  // una banda de cero minutos: invisible y sin nada que aportar. Las citas de
  // duración cero sí sobreviven, porque ahí la existencia es el dato.
  return end > start ? { startMinute: start, endMinute: end } : null;
}

// ---------------------------------------------------------------------------
// Plan de trabajo
// ---------------------------------------------------------------------------

/**
 * La excepción que rige para esa fecha, si hay alguna.
 *
 * `endDate` en `null` se lee como "solo ese día". Las fechas se comparan como
 * cadenas porque `YYYY-MM-DD` ordena lexicográficamente igual que
 * cronológicamente — misma razón que `compareEaLocal` en A1.
 */
export function findPlanException(
  exceptions: readonly WorkingPlanException[] | undefined,
  date: EaLocalDate,
): WorkingPlanException | null {
  if (!exceptions) return null;

  for (const exception of exceptions) {
    const start = exception.startDate;
    if (!start) continue;
    const end = exception.endDate ?? start;
    if (date >= start && date <= end) return exception;
  }

  return null;
}

type ResolvedPlan = {
  window: WorkingWindow;
  breaks: readonly Span[];
  breakOrigin: GridBandOrigin;
};

/**
 * Ventana laboral efectiva + descansos para una técnica en una fecha.
 *
 * Una excepción **reemplaza** al plan del día, no lo complementa: sus horas y
 * sus descansos mandan enteros. Es lo que hace EA y es lo que espera quien
 * escribe "el jueves entro a las 11": no quiere conservar el descanso de las
 * 12 del plan viejo si la excepción trae los suyos.
 */
export function resolveWorkingWindow(
  provider: Pick<GridProvider, "workingPlan" | "workingPlanExceptions">,
  date: EaLocalDate,
): ResolvedPlan {
  const exception = findPlanException(provider.workingPlanExceptions, date);

  if (exception) {
    const start = parsePlanTime(exception.startTime);
    const end = parsePlanTime(exception.endTime);
    // `startTime`/`endTime` en `null` significan **día libre**, y ese `null` es
    // información, no un dato faltante (ver `WorkingPlanException` en A1).
    const off = start === null || end === null || end <= start;

    return {
      window: {
        startMinute: off ? null : start,
        endMinute: off ? null : end,
        source: "plan-exception",
        exceptionId: exception.id,
      },
      breaks: off ? [] : spansFromBreaks(exception.breaks),
      breakOrigin: "plan-exception",
    };
  }

  const day: WorkingPlanDay = provider.workingPlan
    ? provider.workingPlan[weekdayKeyOf(date)]
    : null;

  const start = parsePlanTime(day?.start);
  const end = parsePlanTime(day?.end);
  const off = !day || start === null || end === null || end <= start;

  return {
    window: {
      startMinute: off ? null : start,
      endMinute: off ? null : end,
      source: "plan",
      exceptionId: null,
    },
    breaks: off ? [] : spansFromBreaks(day.breaks),
    breakOrigin: "plan",
  };
}

function spansFromBreaks(
  breaks: ReadonlyArray<{ start: string; end: string }> | undefined,
): Span[] {
  if (!breaks) return [];
  const spans: Span[] = [];

  for (const item of breaks) {
    const start = parsePlanTime(item?.start);
    const end = parsePlanTime(item?.end);
    if (start === null || end === null || end <= start) continue;
    spans.push({ startMinute: start, endMinute: end });
  }

  return spans;
}

// ---------------------------------------------------------------------------
// Carriles
// ---------------------------------------------------------------------------

type Laned = { lane: number; laneCount: number };

/**
 * Reparto de carriles por barrido.
 *
 * Ordenar por inicio, asignar a cada bloque el carril libre más bajo, y cuando
 * aparece un bloque que no se solapa con **ninguno** de los anteriores, cerrar
 * el grupo y repartir el ancho entre los carriles que ese grupo llegó a usar.
 * El ancho es `1 / carriles del grupo`, no `1 / carriles de la columna`: si a
 * las 9 hay dos citas encimadas y a las 4 hay una sola, la de las 4 usa la
 * columna completa.
 *
 * El toque de bordes **no** es solape: una cita que termina a las 10 y otra que
 * empieza a las 10 van las dos a carril 0 y ocupan el ancho entero. Es la misma
 * regla que usa EA en `has_provider_conflict()`
 * (`start < new_end AND end > new_start`) y la que pide § Interacción.
 */
export function assignLanes(spans: readonly Span[]): Laned[] {
  const order = spans
    .map((span, index) => ({ span, index }))
    .sort(
      (a, b) =>
        a.span.startMinute - b.span.startMinute ||
        a.span.endMinute - b.span.endMinute ||
        a.index - b.index,
    );

  const out: Laned[] = spans.map(() => ({ lane: 0, laneCount: 1 }));

  /** Fin del último bloque de cada carril del grupo abierto. */
  let laneEnds: number[] = [];
  /** Índices (en `spans`) de los bloques del grupo abierto. */
  let group: number[] = [];

  const closeGroup = (): void => {
    for (const index of group) out[index].laneCount = laneEnds.length;
    laneEnds = [];
    group = [];
  };

  for (const { span, index } of order) {
    // Si arranca cuando ya terminó todo lo anterior, el grupo se cierra: nada
    // de lo que viene puede tocar a nada de lo que quedó atrás.
    if (laneEnds.length > 0 && span.startMinute >= Math.max(...laneEnds)) {
      closeGroup();
    }

    let lane = laneEnds.findIndex((end) => end <= span.startMinute);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(span.endMinute);
    } else {
      laneEnds[lane] = span.endMinute;
    }

    out[index].lane = lane;
    group.push(index);
  }

  closeGroup();
  return out;
}

// ---------------------------------------------------------------------------
// buildDayGrid
// ---------------------------------------------------------------------------

/**
 * Arma la grilla de un día.
 *
 * Acepta que le lleguen citas **fuera del rango pedido**, y no es una
 * concesión: `from`/`till` de EA son de grano día e inclusivos, y `till`
 * compara contra `end_datetime`, así que una cita que cruza la medianoche del
 * último día se pierde si se pide el rango exacto. La agenda pide siempre un
 * día extra y recorta en memoria — acá. Lo que no toca el día se descarta; lo
 * que lo toca pero cae fuera de la jornada visible se cuenta en
 * `hiddenBefore` / `hiddenAfter`; lo que lo cruza se recorta con
 * `clippedStart` / `clippedEnd` puestos.
 */
export function buildDayGrid(input: DayGridInput): DayGrid {
  const { range } = input;
  const date = parseEaLocalDate(range.date);
  const timeZone = input.timeZone ?? EA_TIME_ZONE;

  if (!Number.isFinite(range.slotMinutes) || range.slotMinutes <= 0) {
    throw new CalendarLayoutError(
      `slotMinutes tiene que ser un número positivo, llegó ${String(range.slotMinutes)}`,
    );
  }

  if (!Number.isFinite(range.startMinute) || !Number.isFinite(range.endMinute)) {
    throw new CalendarLayoutError("startMinute y endMinute tienen que ser números");
  }

  if (range.endMinute <= range.startMinute) {
    throw new CalendarLayoutError(
      `La jornada tiene que terminar después de empezar: ${range.startMinute} → ${range.endMinute}`,
    );
  }

  const visible: Span = { startMinute: range.startMinute, endMinute: range.endMinute };
  const midnight = midnightOf(date);
  const minEvent = input.minEventMinutes ?? range.slotMinutes;

  /** Minutos entre las dos medianoches. 1440 salvo en una zona con saltos. */
  const dayLength = minutesBetween(midnight, addMinutes(midnight, 24 * 60, timeZone), timeZone);
  const wholeDay: Span = { startMinute: 0, endMinute: dayLength };

  const toMinute = (value: EaLocalDateTime): number =>
    minutesBetween(midnight, value, timeZone);

  // ── Gutter ───────────────────────────────────────────────────────────────
  const rowCount = Math.ceil((range.endMinute - range.startMinute) / range.slotMinutes);
  const slots: GridSlot[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    const minute = range.startMinute + row * range.slotMinutes;
    slots.push({
      minute,
      wall: addMinutes(midnight, minute, timeZone),
      isHour: ((minute % 60) + 60) % 60 === 0,
    });
  }

  // ── Reparto por columna ──────────────────────────────────────────────────
  type Bucket = { events: Appointment[]; blocks: Unavailability[] };

  // Un balde por columna, en el mismo orden que `providers`, más un índice por
  // id para el reparto. Dos estructuras y no una para que el índice de columna
  // sea la clave del balde: si la lista trajera la misma técnica dos veces, sus
  // citas caen en la primera columna y la segunda queda vacía, en vez de
  // duplicarse — que es lo que haría un `Map` leído N veces.
  const buckets: Bucket[] = input.providers.map(() => ({ events: [], blocks: [] }));
  const byProvider = new Map<number, Bucket>();
  input.providers.forEach((provider, index) => {
    if (!byProvider.has(provider.id)) byProvider.set(provider.id, buckets[index]);
  });

  const orphanAppointments: Appointment[] = [];
  const orphanUnavailabilities: Unavailability[] = [];

  for (const appointment of input.appointments ?? []) {
    const bucket =
      appointment.providerId === null ? undefined : byProvider.get(appointment.providerId);
    if (bucket) bucket.events.push(appointment);
    else orphanAppointments.push(appointment);
  }

  for (const unavailability of input.unavailabilities ?? []) {
    const bucket =
      unavailability.providerId === null
        ? undefined
        : byProvider.get(unavailability.providerId);
    if (bucket) bucket.blocks.push(unavailability);
    else orphanUnavailabilities.push(unavailability);
  }

  // Los bloqueos son del **estudio**: no tienen `providerId` y por eso tapan a
  // todas las técnicas de una. Se replican en cada columna en vez de vivir en
  // una banda aparte que cruce la grilla, porque cada columna es su propio
  // contexto de apilamiento y una banda flotante encima pelearía con el sticky
  // del encabezado.
  const studioBands: GridBand[] = [];

  for (const period of input.blockedPeriods ?? []) {
    const span = intersect(
      { startMinute: toMinute(period.start), endMinute: toMinute(period.end) },
      visible,
    );
    if (!span) continue;

    studioBands.push({
      key: `blocked:${period.id}:${span.startMinute}`,
      kind: "blocked",
      origin: "blocked-period",
      layer: GRID_LAYER.block,
      sourceId: period.id,
      label: period.name,
      startMinute: span.startMinute,
      endMinute: span.endMinute,
      clippedStart: toMinute(period.start) < span.startMinute,
      clippedEnd: toMinute(period.end) > span.endMinute,
    });
  }

  const columns: GridColumn[] = input.providers.map((provider, index) => {
    const bucket = buckets[index];
    const plan = resolveWorkingWindow(provider, date);
    const bands: GridBand[] = [];

    // Fuera de horario: el complemento de la ventana dentro del rango visible.
    const offHours: Span[] =
      plan.window.startMinute === null || plan.window.endMinute === null
        ? [visible]
        : [
            { startMinute: visible.startMinute, endMinute: plan.window.startMinute },
            { startMinute: plan.window.endMinute, endMinute: visible.endMinute },
          ];

    for (const raw of offHours) {
      const span = intersect(raw, visible);
      if (!span) continue;
      bands.push({
        key: `off:${provider.id}:${span.startMinute}`,
        kind: "off-hours",
        origin: plan.window.source,
        layer: GRID_LAYER.offHours,
        sourceId: plan.window.exceptionId,
        label: null,
        startMinute: span.startMinute,
        endMinute: span.endMinute,
        clippedStart: raw.startMinute < span.startMinute,
        clippedEnd: raw.endMinute > span.endMinute,
      });
    }

    // Descansos: se recortan primero a la ventana laboral y después al rango.
    // Sin el primer recorte, un descanso que se sale del horario pintaría dos
    // grises encima del mismo tramo y el borde se vería doble.
    const window: Span | null =
      plan.window.startMinute === null || plan.window.endMinute === null
        ? null
        : { startMinute: plan.window.startMinute, endMinute: plan.window.endMinute };

    if (window) {
      for (const raw of plan.breaks) {
        const inside = intersect(raw, window);
        const span = inside ? intersect(inside, visible) : null;
        if (!span) continue;
        bands.push({
          key: `break:${provider.id}:${span.startMinute}`,
          kind: "break",
          origin: plan.breakOrigin,
          layer:
            plan.breakOrigin === "plan-exception"
              ? GRID_LAYER.planException
              : GRID_LAYER.planBreak,
          sourceId: plan.window.exceptionId,
          label: null,
          startMinute: span.startMinute,
          endMinute: span.endMinute,
          clippedStart: raw.startMinute < span.startMinute,
          clippedEnd: raw.endMinute > span.endMinute,
        });
      }
    }

    for (const unavailability of bucket.blocks) {
      const rawStart = toMinute(unavailability.start);
      const rawEnd = toMinute(unavailability.end);
      const span = intersect({ startMinute: rawStart, endMinute: rawEnd }, visible);
      if (!span) continue;
      bands.push({
        key: `unavailable:${unavailability.id}:${span.startMinute}`,
        kind: "unavailable",
        origin: "unavailability",
        layer: GRID_LAYER.block,
        sourceId: unavailability.id,
        label: unavailability.notes,
        startMinute: span.startMinute,
        endMinute: span.endMinute,
        clippedStart: rawStart < span.startMinute,
        clippedEnd: rawEnd > span.endMinute,
      });
    }

    bands.push(...studioBands);
    bands.sort((a, b) => a.layer - b.layer || a.startMinute - b.startMinute);

    // ── Citas ──────────────────────────────────────────────────────────────
    type Placed = { appointment: Appointment; raw: Span; span: Span; render: Span };
    const placed: Placed[] = [];
    let hiddenBefore = 0;
    let hiddenAfter = 0;

    for (const appointment of bucket.events) {
      const rawStart = toMinute(appointment.start);
      const rawEnd = toMinute(appointment.end);
      const raw: Span = { startMinute: rawStart, endMinute: rawEnd };

      // Una cita de duración cero no tiene intersección con nada bajo la regla
      // de "solape estricto", así que se la trata como un punto: entra si su
      // inicio cae dentro del rango. Perderla sería peor que dibujarla mal.
      const zero = rawEnd <= rawStart;
      const span = zero
        ? rawStart >= visible.startMinute && rawStart < visible.endMinute
          ? { startMinute: rawStart, endMinute: rawStart }
          : null
        : intersect(raw, visible);

      if (!span) {
        // ¿Toca el día pero cae fuera de la jornada visible? Eso se cuenta.
        // ¿No toca el día? Es el día extra que se le pidió a EA: se descarta.
        const touchesDay = zero
          ? rawStart >= wholeDay.startMinute && rawStart < wholeDay.endMinute
          : intersect(raw, wholeDay) !== null;
        if (!touchesDay) continue;
        if (rawEnd <= visible.startMinute) hiddenBefore += 1;
        else hiddenAfter += 1;
        continue;
      }

      placed.push({
        appointment,
        raw,
        span,
        render: {
          startMinute: span.startMinute,
          endMinute: Math.max(span.endMinute, span.startMinute + minEvent),
        },
      });
    }

    // El reparto de carriles usa la geometría **dibujada**, no la real: si no,
    // una cita de duración cero no se solaparía con nadie, se quedaría en el
    // carril 0 a ancho completo y taparía la cita que sí está pasando a esa
    // hora. `conflict.ts` hace lo contrario, y con razón — allá el dato es si
    // dos cosas se pisan de verdad, no si se ven encimadas.
    const lanes = assignLanes(placed.map((item) => item.render));

    const events: GridEvent[] = placed.map((item, index) => {
      const { lane, laneCount } = lanes[index];
      return {
        key: `appointment:${item.appointment.id}`,
        appointment: item.appointment,
        startMinute: item.span.startMinute,
        endMinute: item.span.endMinute,
        durationMinutes: Math.max(0, item.raw.endMinute - item.raw.startMinute),
        renderHeightMinutes: item.render.endMinute - item.render.startMinute,
        clippedStart: item.raw.startMinute < item.span.startMinute,
        clippedEnd: item.raw.endMinute > item.span.endMinute,
        startsPreviousDay: item.raw.startMinute < wholeDay.startMinute,
        continuesNextDay: item.raw.endMinute > wholeDay.endMinute,
        lane,
        laneCount,
        offset: lane / laneCount,
        width: 1 / laneCount,
        layer: GRID_LAYER.appointment,
      };
    });

    events.sort((a, b) => a.startMinute - b.startMinute || a.lane - b.lane);

    return {
      providerId: provider.id,
      providerName: provider.name,
      window: plan.window,
      bands,
      events,
      hiddenBefore,
      hiddenAfter,
    };
  });

  return {
    date,
    range,
    rowCount,
    slots,
    columns,
    nowLine: resolveNowLine(input.now ?? null, date, visible, timeZone),
    orphanAppointments,
    orphanUnavailabilities,
  };
}

/**
 * La línea de "ahora", solo si cae dentro del rango visible de **este** día.
 *
 * El instante se convierte a hora de pared del estudio con la zona explícita:
 * el contenedor puede estar en UTC y la línea tiene que salir donde la ve la
 * recepción, no donde la ve el proceso.
 */
function resolveNowLine(
  now: Date | null,
  date: EaLocalDate,
  visible: Span,
  timeZone: string,
): NowLine | null {
  if (!now || Number.isNaN(now.getTime())) return null;

  const wall = instantToEaLocal(now, timeZone);
  if (wall.slice(0, 10) !== date) return null;

  const minute = minutesBetween(midnightOf(date), wall, timeZone);
  if (minute < visible.startMinute || minute > visible.endMinute) return null;

  return { minute, wall };
}
