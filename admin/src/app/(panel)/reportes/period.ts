/**
 * El periodo que scopea la pantalla de Reportes.
 *
 * ## Por qué hay cadencia y no un rango libre
 *
 * § El set de reportes propio le pone **cadencia** a cada reporte: diario,
 * quincenal, mensual. No es decoración — es el rango en el que la cifra
 * significa algo. "Ocupación por franja" de un solo día es ruido; "cuadra la
 * caja" de un mes entero no responde ninguna pregunta que alguien se haga.
 *
 * Y la regla de composición de `dataviz` es que **una fila de filtros scopea
 * todo lo que está debajo**: "si un gráfico necesita su propio rango, es otro
 * tablero". Así que la cadencia elige *qué reportes se dibujan*, y todos los
 * que se dibujan comparten el mismo rango. Sin eso, dos tarjetas de la misma
 * pantalla mostrarían números que no se pueden sumar entre sí y nadie sabría
 * cuál mirar.
 *
 * ## Aritmética de calendario, no de instantes
 *
 * Todo acá es aritmética sobre `"YYYY-MM-DD"` con enteros. Ni un `new Date()`
 * intermedio: un corte de quincena es **calendario**, no un instante, y la
 * conversión a `Date` es exactamente donde nace el bug de cinco horas que este
 * proyecto lleva persiguiendo desde el principio (ver la cabecera de
 * `db/client.ts`). Los dos extremos son **inclusivos**, igual que el `DateRange`
 * de `lib/metrics.ts`, para que el rango se le pueda pasar tal cual.
 *
 * ## Los cortes de quincena son un supuesto, y está marcado
 *
 * `1–15` y `16–fin de mes` es lo habitual en Colombia, pero **los cortes reales
 * son una decisión pendiente de la dueña** (§ Decisiones pendientes; es uno de
 * los cuatro bloqueos de D1). Por eso la quincena acepta `desde`/`hasta`
 * explícitos: el día que los cortes se decidan y no sean éstos, el valor por
 * defecto cambia en una función y las URLs viejas siguen sirviendo.
 */

import { parseEaLocalDate, type EaLocalDate } from "@/lib/ea";

export type Cadence = "dia" | "quincena" | "mes";

export const CADENCES: readonly Cadence[] = ["dia", "quincena", "mes"];

export const CADENCE_LABEL: Record<Cadence, string> = {
  dia: "Día",
  quincena: "Quincena",
  mes: "Mes",
};

/** Un rango de calendario con los dos extremos inclusivos, ya rotulado. */
export type Period = {
  cadence: Cadence;
  from: EaLocalDate;
  to: EaLocalDate;
  /** Cómo se escribe en pantalla: `"agosto de 2026"`, `"1 – 15 de agosto"`. */
  label: string;
};

// ── Aritmética de fecha civil ───────────────────────────────────────────────

type Civil = { y: number; m: number; d: number };

const pad = (n: number) => String(n).padStart(2, "0");

function toCivil(date: EaLocalDate): Civil {
  const [y, m, d] = date.split("-").map(Number);
  return { y, m, d };
}

function fromCivil({ y, m, d }: Civil): EaLocalDate {
  return parseEaLocalDate(`${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`);
}

/**
 * Días del mes, con año bisiesto. Se calcula en vez de consultarse porque un
 * `new Date(y, m, 0)` acá arrastraría la zona del proceso a una cuenta que es
 * puramente aritmética.
 */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Suma meses conservando el día, recortándolo si el mes destino es más corto. */
function shiftMonth(civil: Civil, months: number): Civil {
  const total = civil.y * 12 + (civil.m - 1) + months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { y, m, d: Math.min(civil.d, daysInMonth(y, m)) };
}

/** Suma días. Cruza meses y años sin tocar `Date`. */
export function addDays(date: EaLocalDate, days: number): EaLocalDate {
  const civil = toCivil(date);
  let { y, m, d } = civil;
  d += days;

  while (d < 1) {
    const previous = shiftMonth({ y, m, d: 1 }, -1);
    y = previous.y;
    m = previous.m;
    d += daysInMonth(y, m);
  }

  for (;;) {
    const size = daysInMonth(y, m);
    if (d <= size) break;
    d -= size;
    const next = shiftMonth({ y, m, d: 1 }, 1);
    y = next.y;
    m = next.m;
  }

  return fromCivil({ y, m, d });
}

/** Cuántos días hay de `from` a `to`, con los dos extremos incluidos. */
export function daysBetweenInclusive(from: EaLocalDate, to: EaLocalDate): number {
  // Cuenta de días julianos: pura aritmética entera, sin `Date`.
  const serial = (date: EaLocalDate) => {
    const { y, m, d } = toCivil(date);
    const a = m <= 2 ? y - 1 : y;
    const b = m <= 2 ? m + 12 : m;
    return (
      Math.floor(365.25 * (a + 4716)) +
      Math.floor(30.6001 * (b + 1)) +
      d +
      Math.floor(a / 400) -
      Math.floor(a / 100) +
      2
    );
  };
  return serial(to) - serial(from) + 1;
}

/** Lista los días del rango, en orden. */
export function eachDay(from: EaLocalDate, to: EaLocalDate): EaLocalDate[] {
  const out: EaLocalDate[] = [];
  const count = daysBetweenInclusive(from, to);
  for (let i = 0; i < count; i += 1) out.push(addDays(from, i));
  return out;
}

/** Día de la semana en la clave que usa el `working_plan` de EA. */
export const WEEKDAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

/**
 * El día de la semana de una fecha civil, por congruencia de Zeller.
 *
 * Sin `Date` y sin `Intl` a propósito: `new Date("2026-08-31").getDay()` parsea
 * como UTC y devuelve el día anterior en cualquier zona al oeste de Greenwich —
 * es decir, en Bogotá. Es el mismo error de cinco horas, disfrazado.
 */
export function weekdayKey(date: EaLocalDate): WeekdayKey {
  const { y, m, d } = toCivil(date);
  const shiftedMonth = m < 3 ? m + 12 : m;
  const shiftedYear = m < 3 ? y - 1 : y;
  const k = shiftedYear % 100;
  const j = Math.floor(shiftedYear / 100);
  const h =
    (d +
      Math.floor((13 * (shiftedMonth + 1)) / 5) +
      k +
      Math.floor(k / 4) +
      Math.floor(j / 4) +
      5 * j) %
    7;
  // Zeller: 0 = sábado. `WEEKDAY_KEYS` arranca en domingo, como EA.
  return WEEKDAY_KEYS[(h + 6) % 7];
}

// ── Etiquetas ───────────────────────────────────────────────────────────────

const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
] as const;

export function monthName(month: number): string {
  return MONTHS[month - 1] ?? "";
}

function labelFor(cadence: Cadence, from: EaLocalDate, to: EaLocalDate): string {
  const a = toCivil(from);
  const b = toCivil(to);

  if (cadence === "dia") return `${a.d} de ${monthName(a.m)} de ${a.y}`;
  if (a.y === b.y && a.m === b.m && a.d === 1 && b.d === daysInMonth(a.y, a.m)) {
    return `${monthName(a.m)} de ${a.y}`;
  }
  if (a.y === b.y && a.m === b.m) {
    return `${a.d} – ${b.d} de ${monthName(a.m)} de ${a.y}`;
  }
  return `${a.d} de ${monthName(a.m)} – ${b.d} de ${monthName(b.m)} de ${b.y}`;
}

// ── Parseo ──────────────────────────────────────────────────────────────────

export function parseCadence(raw: string | undefined): Cadence {
  return CADENCES.includes(raw as Cadence) ? (raw as Cadence) : "mes";
}

/** `"YYYY-MM-DD"` válida, o `null`. Nunca lanza: la URL la escribe cualquiera. */
export function parseDay(raw: string | undefined): EaLocalDate | null {
  if (raw === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const { y, m, d } = toCivil(raw as EaLocalDate);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return raw as EaLocalDate;
}

/**
 * El periodo de la pantalla.
 *
 * `today` **entra por parámetro**, igual que el `now` de `lib/metrics.ts`: un
 * reporte que consulta el reloj por su cuenta da un resultado distinto cada vez
 * que se corre y no se puede testear.
 *
 * Una fecha basura en la URL cae en el periodo de hoy en vez de reventar. La
 * pantalla la abre alguien que pegó un link de WhatsApp, no un cliente de API.
 */
export function resolvePeriod(
  input: { cadencia?: string; ancla?: string; desde?: string; hasta?: string },
  today: EaLocalDate,
): Period {
  const cadence = parseCadence(input.cadencia);

  // Un rango explícito gana sobre la cadencia: es la salida para el día en que
  // los cortes de quincena reales no sean 1–15 / 16–fin.
  const desde = parseDay(input.desde);
  const hasta = parseDay(input.hasta);
  if (desde !== null && hasta !== null && desde <= hasta) {
    return { cadence, from: desde, to: hasta, label: labelFor(cadence, desde, hasta) };
  }

  const anchor = parseDay(input.ancla) ?? today;
  const { y, m, d } = toCivil(anchor);

  if (cadence === "dia") {
    return { cadence, from: anchor, to: anchor, label: labelFor("dia", anchor, anchor) };
  }

  if (cadence === "quincena") {
    const first = d <= 15;
    const from = fromCivil({ y, m, d: first ? 1 : 16 });
    const to = fromCivil({ y, m, d: first ? 15 : daysInMonth(y, m) });
    return { cadence, from, to, label: labelFor("quincena", from, to) };
  }

  const from = fromCivil({ y, m, d: 1 });
  const to = fromCivil({ y, m, d: daysInMonth(y, m) });
  return { cadence, from, to, label: labelFor("mes", from, to) };
}

/**
 * El periodo anterior o siguiente, para las flechas de la fila de filtros.
 *
 * Se calcula desplazando el **ancla** y volviendo a resolver, no restando la
 * duración: media quincena tiene 15 días y la otra 13, 14, 15 o 16, así que
 * restar días haría que "quincena anterior" fuera a veces un rango que no
 * coincide con ninguna quincena.
 */
export function shiftPeriod(period: Period, direction: -1 | 1): Period {
  if (period.cadence === "dia") {
    const anchor = addDays(period.from, direction);
    return resolvePeriod({ cadencia: "dia", ancla: anchor }, anchor);
  }

  if (period.cadence === "quincena") {
    const anchor =
      direction === -1 ? addDays(period.from, -1) : addDays(period.to, 1);
    return resolvePeriod({ cadencia: "quincena", ancla: anchor }, anchor);
  }

  const anchor =
    direction === -1 ? addDays(period.from, -1) : addDays(period.to, 1);
  return resolvePeriod({ cadencia: "mes", ancla: anchor }, anchor);
}

/** La URL de la pantalla para un periodo. El ancla siempre es su primer día. */
export function periodHref(period: Period, base = "/reportes"): string {
  const params = new URLSearchParams({
    cadencia: period.cadence,
    ancla: period.from,
  });
  return `${base}?${params.toString()}`;
}

/**
 * Qué reportes le corresponden a cada cadencia, según la tabla de
 * § El set de reportes propio. Es la tabla del plan, transcrita.
 */
export const REPORTS_BY_CADENCE: Record<Cadence, readonly string[]> = {
  dia: ["cierre-del-dia"],
  quincena: ["liquidacion", "variacion-de-precio"],
  mes: [
    "rentabilidad-por-hora",
    "ocupacion",
    "agendado-vs-realizado",
    "adicionales",
    "clientas",
    "inasistencia",
  ],
};
