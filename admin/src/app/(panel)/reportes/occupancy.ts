/**
 * Ocupación: del plan de trabajo de EA a la cifra que decide si cabe otra
 * técnica.
 *
 * Este archivo hace dos cosas, y conviene tener clara la diferencia porque una
 * es traducción y la otra es una definición nueva:
 *
 * 1. **Traducir el `working_plan` de EA a intervalos.** Mecánico. EA guarda un
 *    objeto con clave por día de la semana en inglés y horas `"HH:MM"`, más una
 *    tabla de excepciones por fecha. Convertirlo a los `Interval` que
 *    `computeOccupancy()` espera no es una métrica, es un mapeo — y va acá
 *    porque el único consumidor es este reporte.
 *
 * 2. **Ocupación por hora de estación.** Ésta **sí es una definición nueva**, y
 *    hay que decirlo de frente: no está en `lib/metrics.ts`.
 *
 * ## La métrica que falta en `lib/metrics.ts` (y que hay que mover allá)
 *
 * `computeOccupancy()` de B1 responde "¿qué parte de sus horas usó esta
 * técnica?" y lo hace bien — **fusiona los solapes**, con el comentario "dos
 * citas encimadas ocupan la silla una vez". Para *una* técnica eso es correcto:
 * una técnica atiende a una clienta a la vez (§ Multi-técnica).
 *
 * Pero el plan insiste en otra cosa: "**con dos estaciones, la capacidad del
 * negocio son horas de puesto, no personas**", y "ocupación de estación es la
 * métrica de capacidad de verdad". Ahí fusionar es justo lo que **no** se puede
 * hacer: dos citas simultáneas ocupan **dos** puestos, y el día que se ocupen
 * los dos el estudio está lleno aunque cada técnica esté al 50 %.
 *
 * `lib/metrics.ts` no tiene esa función. **La pedí y no existe todavía**, así
 * que está implementada acá abajo (`stationHourOccupancy`), pura y con tests,
 * y **el lugar donde tiene que vivir es `lib/metrics.ts`** — es una definición
 * de negocio, la va a necesitar la reserva pública de D2 para no vender sillas
 * que no existen, y dos definiciones de "ocupación de estación" en dos
 * pantallas es exactamente lo que ese módulo vino a evitar. Moverla es un
 * `git mv` de treinta líneas más su test; no se hizo acá porque `lib/` no es de
 * este paquete.
 *
 * Mientras vive acá, **no recalcula nada de B1**: el numerador y el
 * denominador salen los dos de llamadas a `computeOccupancy()`. Lo único
 * propio es cómo se combinan.
 *
 * ## Lo que no se puede medir todavía, y por qué
 *
 * "Ocupación **por** estación" —cuál de los dos puestos se usó— **no es
 * calculable con los datos que existen**. Ninguna tabla registra en qué
 * estación se atendió una cita: `appointment_finance` no tiene la columna, EA
 * no tiene el concepto, y `lib/conflict.ts` resuelve el emparejamiento
 * bipartito para *decidir si cabe*, sin persistir a quién le tocó cada puesto.
 * Está reportado. Lo que sí se puede medir —y es lo que la pregunta "¿abro otro
 * puesto?" necesita— es la ocupación **agregada** de las horas de puesto del
 * estudio, que es lo que este archivo entrega.
 */

import {
  computeOccupancy,
  type Interval,
  type Occupancy,
  type OccupancyAppointment,
} from "@/lib/metrics";
import { eaLocalDateTime, type EaLocalDate } from "@/lib/ea";
import type { WorkingPlan, WorkingPlanDay, WorkingPlanException } from "@/lib/ea";

import { weekdayKey } from "./period";

/** `"HH:MM"` o `"HH:MM:SS"` → minutos del día, o `null` si no se puede leer. */
export function minutesOfDay(time: string | null | undefined): number | null {
  if (typeof time !== "string") return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function intervalOf(date: EaLocalDate, fromMin: number, toMin: number): Interval | null {
  if (toMin <= fromMin) return null;
  const [year, month, day] = date.split("-").map(Number);
  return {
    start: eaLocalDateTime(year, month, day, Math.floor(fromMin / 60), fromMin % 60),
    // Las 24:00 no existen como hora de pared: una jornada que llega a
    // medianoche se cierra a las 23:59:59 en vez de desbordar al día
    // siguiente. Un minuto de diferencia sobre una jornada de nueve horas es
    // ruido; una fecha inválida es una excepción en la mitad del reporte.
    end:
      toMin >= 1440
        ? eaLocalDateTime(year, month, day, 23, 59, 59)
        : eaLocalDateTime(year, month, day, Math.floor(toMin / 60), toMin % 60),
  };
}

/** La jornada de un día: cuándo abre, y qué descansos tiene adentro. */
export type DayWindow = {
  /** Vacío = ese día no se trabaja. */
  open: Interval[];
  /**
   * Descansos. Van al **denominador** de `computeOccupancy` (como bloqueo) y no
   * restados del plan: es la misma cuenta, y así el reporte puede mostrar
   * aparte cuántos minutos del día eran descanso.
   */
  breaks: Interval[];
};

const EMPTY: DayWindow = { open: [], breaks: [] };

function windowFromDay(date: EaLocalDate, day: WorkingPlanDay): DayWindow {
  if (day === null) return EMPTY;

  const from = minutesOfDay(day.start);
  const to = minutesOfDay(day.end);
  if (from === null || to === null) return EMPTY;

  const open = intervalOf(date, from, to);
  if (open === null) return EMPTY;

  const breaks: Interval[] = [];
  for (const rest of day.breaks ?? []) {
    const breakFrom = minutesOfDay(rest.start);
    const breakTo = minutesOfDay(rest.end);
    if (breakFrom === null || breakTo === null) continue;
    // **Se recorta a la jornada.** EA no valida estos rangos: un descanso de
    // 13:00 a 20:00 sobre una jornada que cierra a las 18:00 restaría dos horas
    // que nunca estuvieron disponibles y daría una ocupación inflada.
    const clamped = intervalOf(
      date,
      Math.max(from, breakFrom),
      Math.min(to, breakTo),
    );
    if (clamped !== null) breaks.push(clamped);
  }

  return { open: [open], breaks };
}

/**
 * La jornada de una técnica en una fecha, con las excepciones aplicadas.
 *
 * Las excepciones ganan sobre el plan semanal, que es la semántica de EA
 * (`Working_plan_exceptions_model::get_by_provider()` expande cada fila a los
 * días de su rango y **`start_time` en `null` significa día libre completo**).
 * Con dos excepciones que cubren la misma fecha gana la última de la lista, que
 * es el orden en el que EA las devuelve.
 */
export function dayWindow(
  date: EaLocalDate,
  plan: WorkingPlan | null | undefined,
  exceptions: readonly WorkingPlanException[] = [],
): DayWindow {
  let override: WorkingPlanException | null = null;

  for (const exception of exceptions) {
    const from = exception.startDate;
    const to = exception.endDate ?? exception.startDate;
    if (from === null || to === null) continue;
    if (date >= from && date <= to) override = exception;
  }

  if (override !== null) {
    // `startTime` en `null` = día libre. No es "abre a medianoche".
    if (override.startTime === null) return EMPTY;
    return windowFromDay(date, {
      start: override.startTime,
      end: override.endTime ?? override.startTime,
      breaks: override.breaks ?? [],
    });
  }

  if (plan === null || plan === undefined) return EMPTY;
  return windowFromDay(date, plan[weekdayKey(date)]);
}

/** La jornada de un rango de fechas, concatenada. */
export function windowOverRange(
  dates: readonly EaLocalDate[],
  plan: WorkingPlan | null | undefined,
  exceptions: readonly WorkingPlanException[] = [],
): DayWindow {
  const open: Interval[] = [];
  const breaks: Interval[] = [];

  for (const date of dates) {
    const window = dayWindow(date, plan, exceptions);
    open.push(...window.open);
    breaks.push(...window.breaks);
  }

  return { open, breaks };
}

// ── Ocupación por técnica ───────────────────────────────────────────────────

export type ProviderOccupancy = {
  eaProviderId: number;
  name: string;
  occupancy: Occupancy;
};

/**
 * La ocupación de cada técnica. Es `computeOccupancy()` de B1, sin más: acá no
 * se recalcula nada, solo se arma la entrada.
 */
export function occupancyByProvider(
  providers: readonly {
    eaProviderId: number;
    name: string;
    window: DayWindow;
    blocked: readonly Interval[];
    appointments: readonly OccupancyAppointment[];
  }[],
): ProviderOccupancy[] {
  return providers.map((provider) => ({
    eaProviderId: provider.eaProviderId,
    name: provider.name,
    occupancy: computeOccupancy({
      scheduled: provider.window.open,
      // Los descansos y los bloqueos del estudio hacen el mismo trabajo en la
      // cuenta: reducen el denominador. Una tarde que el estudio cerró no es
      // una tarde que se desaprovechó.
      blocked: [...provider.window.breaks, ...provider.blocked],
      appointments: provider.appointments,
    }),
  }));
}

// ── Ocupación por hora de estación ──────────────────────────────────────────

export type StationOccupancy = {
  /** Puestos del estudio. Hoy son dos. */
  stations: number;
  /**
   * Minutos en que el estudio **estuvo abierto**: la unión de las jornadas de
   * todas las técnicas, menos bloqueos. Unión y no suma: dos técnicas en el
   * mismo turno son un turno, no dos.
   */
  openMinutes: number;
  /** `stations × openMinutes`. La capacidad real del negocio. */
  capacityMinutes: number;
  /**
   * Minutos de puesto usados: la **suma** de los minutos atendidos de cada
   * técnica. Acá no se fusiona — dos citas simultáneas ocupan dos puestos, y
   * fusionarlas es justo el error que hace que "¿me cabe otra técnica?" se
   * responda mal.
   */
  usedMinutes: number;
  /** `used / capacity`. `null` si el estudio no abrió: no es 0 %, es nada. */
  rate: number | null;
  /**
   * Minutos usados **por encima** de la capacidad de puestos.
   *
   * Cualquier valor distinto de cero significa que hubo más citas simultáneas
   * que puestos, es decir que alguien atendió sin silla o que la agenda
   * permitió algo físicamente imposible. Es la señal de que hace falta revisar
   * `lib/conflict.ts` o los datos, no un número que haya que promediar.
   */
  overCapacityMinutes: number;
};

/**
 * Ocupación por hora de estación.
 *
 * ⚠ **Candidata a `lib/metrics.ts` (B1).** Ver la cabecera de este archivo: es
 * una definición de negocio y su lugar es el módulo de definiciones, no una
 * carpeta de pantalla. Está acá porque `lib/` no es de este paquete y la
 * función no existía.
 *
 * `studioWindow` es la jornada del **estudio** —la unión de las de las
 * técnicas— y se le pasa a `computeOccupancy()` con la lista de citas vacía
 * justamente para que sea B1 el que haga la unión y la resta de bloqueos. Así
 * "minutos disponibles" significa exactamente lo mismo acá y en el reporte por
 * técnica.
 */
export function stationHourOccupancy(input: {
  stations: number;
  studioWindow: DayWindow;
  studioBlocked: readonly Interval[];
  perProvider: readonly ProviderOccupancy[];
}): StationOccupancy {
  const stations = Math.max(0, Math.trunc(input.stations));

  const open = computeOccupancy({
    scheduled: input.studioWindow.open,
    blocked: [...input.studioWindow.breaks, ...input.studioBlocked],
    appointments: [],
  });

  const openMinutes = open.availableMinutes;
  const capacityMinutes = stations * openMinutes;

  const usedMinutes = input.perProvider.reduce(
    (sum, provider) => sum + provider.occupancy.busyMinutes,
    0,
  );

  return {
    stations,
    openMinutes,
    capacityMinutes,
    usedMinutes,
    rate: capacityMinutes === 0 ? null : usedMinutes / capacityMinutes,
    overCapacityMinutes: Math.max(0, usedMinutes - capacityMinutes),
  };
}

// ── Franjas ─────────────────────────────────────────────────────────────────

/**
 * Las franjas horarias del reporte. Bloques de dos horas entre las 8 y las 20,
 * más un cajón para lo que caiga afuera.
 *
 * Dos horas y no una porque un estudio de dos puestos con ~10 citas al día
 * reparte una franja de una hora en celdas de cero y uno, y un mapa de calor de
 * ceros no responde nada. Doce columnas tampoco caben a 390 px.
 */
export const SLOTS = [
  { id: "08-10", from: 8 * 60, to: 10 * 60, label: "8 – 10 a. m." },
  { id: "10-12", from: 10 * 60, to: 12 * 60, label: "10 a. m. – 12 m." },
  { id: "12-14", from: 12 * 60, to: 14 * 60, label: "12 m. – 2 p. m." },
  { id: "14-16", from: 14 * 60, to: 16 * 60, label: "2 – 4 p. m." },
  { id: "16-18", from: 16 * 60, to: 18 * 60, label: "4 – 6 p. m." },
  { id: "18-20", from: 18 * 60, to: 20 * 60, label: "6 – 8 p. m." },
] as const;

export type SlotId = (typeof SLOTS)[number]["id"] | "fuera";

/**
 * En qué franja cae una hora de pared.
 *
 * Lo que cae afuera va a `"fuera"` y **no se descarta**: una cita a las 7 a. m.
 * o a las 9 p. m. es información —el horario cargado en EA no es el real, o
 * alguien está trabajando fuera de turno— y descartarla la haría desaparecer
 * del reporte sin dejar rastro.
 */
export function slotOf(wallClock: string): SlotId {
  const minutes = minutesOfDay(wallClock.slice(11)) ?? minutesOfDay(wallClock);
  if (minutes === null) return "fuera";
  for (const slot of SLOTS) {
    if (minutes >= slot.from && minutes < slot.to) return slot.id;
  }
  return "fuera";
}

export function slotLabel(id: SlotId): string {
  return SLOTS.find((slot) => slot.id === id)?.label ?? "Fuera de horario";
}
