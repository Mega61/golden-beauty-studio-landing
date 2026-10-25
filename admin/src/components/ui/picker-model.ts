import { formatHour12 } from "./format";

/**
 * La lógica pura de los selectores propios (`Combobox`, `DateField`,
 * `TimeField`): buscar, armar la lista de horas y armar el mes.
 *
 * Vive aparte de los componentes para poder testearla sin un DOM. Los
 * componentes existen porque el `<select>` y los `<input type="date|time">`
 * nativos abren el selector **del sistema** en el celular —la rueda de iOS, el
 * diálogo de Android—, que no deja buscar y se ve distinto en cada teléfono.
 * Con veinte servicios en una rueda, encontrar "Semipermanente pies" es girar
 * a ciegas.
 */

export type PickerOption<V> = {
  value: V;
  label: string;
  /** Segunda línea, más tenue: duración, precio. También se busca en ella. */
  detail?: string;
  /** Texto extra que la búsqueda considera y que no se dibuja. */
  keywords?: string;
};

/** Minúsculas, sin tildes y con los espacios colapsados: "Pedicúra  SPA" → "pedicura spa". */
export function normalizeSearch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ¿La opción coincide con lo escrito? Cada palabra de la búsqueda tiene que
 * aparecer, en cualquier orden: "pies semi" encuentra "Semipermanente pies".
 *
 * Las letras se buscan en cualquier parte ("permanente" encuentra
 * "Semipermanente"); lo que lleva números, solo al **principio** de una
 * palabra: "9:30" no puede encontrar "19:30", ni "30" un precio de "130.000".
 */
export function matchesQuery(option: PickerOption<unknown>, query: string): boolean {
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const haystack = normalizeSearch(
    [option.label, option.detail ?? "", option.keywords ?? ""].join(" "),
  );
  const tokens = haystack.split(" ");
  return words.every((word) =>
    /\d/.test(word) ? tokens.some((token) => token.startsWith(word)) : haystack.includes(word),
  );
}

export function filterOptions<V>(
  options: readonly PickerOption<V>[],
  query: string,
): PickerOption<V>[] {
  return options.filter((option) => matchesQuery(option, query));
}

// ── Horas ───────────────────────────────────────────────────────────────────

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isHHMM(value: string): boolean {
  return HHMM.test(value);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function fromMinutes(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Las formas en que alguien escribe una hora, para que la búsqueda las
 * encuentre todas: "930", "0930", "9:30", "21:30", "2130", "pm".
 */
export function timeKeywords(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const mm = String(m).padStart(2, "0");
  const meridiem = h < 12 ? "am a.m." : "pm p.m.";
  return [`${h12}:${mm}`, `${h12}${mm}`, hhmm, hhmm.replace(":", ""), `${h}${mm}`, meridiem].join(" ");
}

/**
 * Las horas del día cada `step` minutos, dentro de `[from, to]`.
 *
 * `include` mete una hora que no cae en la grilla —una cita vieja a las 9:10—
 * en su lugar, para que el selector nunca muestre en blanco un valor que sí
 * tiene.
 */
export function timeOptions(
  step: number,
  options: { from?: string; to?: string; include?: string | null } = {},
): PickerOption<string>[] {
  const from = toMinutes(options.from ?? "00:00");
  const to = toMinutes(options.to ?? "23:59");
  const values = new Set<number>();
  for (let t = from; t <= to; t += Math.max(1, step)) values.add(t);
  if (options.include && isHHMM(options.include)) values.add(toMinutes(options.include));

  return [...values]
    .sort((a, b) => a - b)
    .map((t) => {
      const value = fromMinutes(t);
      return {
        value,
        label: formatHour12(Math.floor(t / 60), t % 60),
        keywords: timeKeywords(value),
      };
    });
}

/**
 * Lo que alguien escribió como hora, a `HH:MM`: "910", "9:10", "9:10 pm",
 * "21:10", "2 pm". Sin a. m./p. m. se lee en 24 h. `null` si no es una hora.
 *
 * Es lo que deja que la lista vaya cada 15 minutos y aun así se pueda agendar
 * a las 9:10: se escribe y aparece "Usar 9:10 a. m.".
 */
export function parseTypedTime(query: string): string | null {
  const q = normalizeSearch(query);
  const digits = q.replace(/\D/g, "");
  if (digits.length === 0 || digits.length > 4) return null;
  const pm = /\d\s*p\b|\bp\.?\s*m\b|pm/.test(q);
  const am = /\d\s*a\b|\ba\.?\s*m\b|am/.test(q);

  let h: number;
  let m: number;
  if (digits.length <= 2) {
    h = Number(digits);
    m = 0;
  } else {
    h = Number(digits.slice(0, digits.length - 2));
    m = Number(digits.slice(-2));
  }
  if (pm || am) {
    if (h < 1 || h > 12) return null;
    if (pm && h < 12) h += 12;
    if (am && h === 12) h = 0;
  }
  if (h > 23 || m > 59) return null;
  return fromMinutes(h * 60 + m);
}

// ── Calendario ──────────────────────────────────────────────────────────────

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): { y: number; m: number; d: number } | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCMonth() === m - 1 && at.getUTCDate() === d ? { y, m, d } : null;
}

export function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Un día antes o después, en calendario. Sin husos: es una fecha, no un instante. */
export function shiftIsoDate(value: string, days: number): string {
  const p = parseIsoDate(value);
  if (!p) return value;
  const at = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return isoDate(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

export function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const index = y * 12 + (m - 1) + delta;
  return { y: Math.floor(index / 12), m: (index % 12) + 1 };
}

/**
 * El mes en semanas de lunes a domingo, como lo lee alguien en Colombia.
 * `null` son las casillas fuera del mes.
 */
export function monthGrid(y: number, m: number): (string | null)[][] {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // getUTCDay: 0 = domingo. Corrido para que el lunes sea 0.
  const lead = (first.getUTCDay() + 6) % 7;

  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => isoDate(y, m, i + 1)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}
