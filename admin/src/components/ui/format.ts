/**
 * Formateadores de presentación del panel.
 *
 * **Por qué viven bajo `components/ui/` y no bajo `lib/`:** `admin/src/lib/**`
 * pertenece a otros paquetes (A1 y B1) y este no puede escribir ahí. Son
 * funciones puras sin React y sin dependencias, así que mudarlas a
 * `lib/format.ts` cuando la propiedad lo permita es un `git mv` y nada más.
 *
 * Dos reglas del plan viven acá y en ningún otro lado:
 *
 * - **Pesos sin centavos.** `$ 120.000`. Ni en pantalla ni en el redondeo de
 *   comisiones existe la fracción de peso. El cálculo de plata NO es de este
 *   archivo — acá solo se pinta un entero que ya venía decidido.
 * - **Hora en 12 h** (`2 p. m.`), y EA se configura igual, para que la
 *   confirmación que recibe la clienta y la agenda que ve la recepción digan
 *   lo mismo.
 *
 * El tipo de entrada de las horas es la **hora de pared** (`"2026-08-31 14:30:00"`),
 * que es el tipo canónico que fijó A1: EA guarda datetimes locales sin zona y
 * convertirlos a `Date` en el borde equivocado es de donde salen los bugs de
 * cinco horas. Estas funciones parsean el string a mano justamente para no
 * pasar nunca por `new Date(...)`, que aplicaría la zona del proceso.
 */

const LOCALE = "es-CO";

// ---------------------------------------------------------------------------
// Dinero
// ---------------------------------------------------------------------------

const COP = new Intl.NumberFormat(LOCALE, {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

/**
 * `120000` → `"$ 120.000"`.
 *
 * `Intl` en `es-CO` emite `U+00A0` (espacio duro) entre el signo y la cifra.
 * Se normaliza a un espacio normal para que el texto se pueda copiar, buscar y
 * comparar en un test sin depender de qué versión de ICU trae el runtime.
 */
export function formatCOP(pesos: number): string {
  if (!Number.isFinite(pesos)) return "—";
  return COP.format(Math.round(pesos)).replace(/ /g, " ");
}

/**
 * Igual que `formatCOP` pero sin el signo, para columnas de tabla donde el
 * encabezado ya dice que la columna es plata y repetir `$` treinta veces solo
 * agrega ruido.
 */
export function formatPesos(pesos: number): string {
  if (!Number.isFinite(pesos)) return "—";
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(
    Math.round(pesos),
  );
}

/** Lee lo que la usuaria escribió en un campo de dinero. Devuelve pesos enteros. */
export function parsePesos(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "");
  if (digits === "") return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Hora y fecha
// ---------------------------------------------------------------------------

/** `"2026-08-31 14:30:00"` → `{ y, m, d, hh, mm }`, o `null` si no calza. */
export function parseWallClock(value: string): {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
} | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, hh, mi] = m;
  const out = {
    y: +y,
    m: +mo,
    d: +d,
    hh: +hh,
    mm: +mi,
  };
  if (out.m < 1 || out.m > 12 || out.d < 1 || out.d > 31) return null;
  if (out.hh > 23 || out.mm > 59) return null;
  return out;
}

/**
 * `14` → `"2 p. m."` · `14, 30` → `"2:30 p. m."`
 *
 * El meridiano va con los puntos y el espacio duro que usa el español de
 * Colombia (`p. m.`, no `PM`). Los minutos en punto se omiten: en el gutter de
 * la agenda "9 a. m." ocupa menos y se lee más rápido que "9:00 a. m.".
 */
export function formatHour12(hour24: number, minutes = 0): string {
  const h = ((Math.trunc(hour24) % 24) + 24) % 24;
  const mm = Math.trunc(minutes);
  const meridiem = h < 12 ? "a. m." : "p. m.";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mm === 0
    ? `${h12} ${meridiem}`
    : `${h12}:${String(mm).padStart(2, "0")} ${meridiem}`;
}

/** `"2026-08-31 14:30:00"` → `"2:30 p. m."`. Devuelve `"—"` si no parsea. */
export function formatTime(wallClock: string): string {
  const p = parseWallClock(wallClock);
  return p ? formatHour12(p.hh, p.mm) : "—";
}

/**
 * `"2026-08-31 14:00:00"`, `"2026-08-31 15:30:00"` → `"2 – 3:30 p. m."`.
 *
 * El meridiano se escribe una sola vez cuando los dos extremos caen del mismo
 * lado del mediodía. Es la misma regla del gutter de horas y ahorra media línea
 * en cada bloque de la agenda.
 */
export function formatTimeRange(startWall: string, endWall: string): string {
  const a = parseWallClock(startWall);
  const b = parseWallClock(endWall);
  if (!a || !b) return "—";
  const sameHalf = a.hh < 12 === b.hh < 12;
  const start = sameHalf
    ? formatHour12(a.hh, a.mm).replace(/ [ap]\. m\.$/, "")
    : formatHour12(a.hh, a.mm);
  return `${start} – ${formatHour12(b.hh, b.mm)}`;
}

const WEEKDAYS = [
  "domingo",
  "lunes",
  "martes",
  "miércoles",
  "jueves",
  "viernes",
  "sábado",
];
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
];

/**
 * `"2026-08-31 14:00:00"` → `"lunes 31 de agosto"`.
 *
 * El día de la semana se calcula con `Date.UTC`, que es aritmética de
 * calendario pura: no toca la zona horaria del proceso, así que da lo mismo en
 * la VM (America/Bogota) que en un runner de CI en UTC.
 */
export function formatDateLong(wallClock: string, withYear = false): string {
  const p = parseWallClock(wallClock);
  if (!p) return "—";
  const dow = WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  const base = `${dow} ${p.d} de ${MONTHS[p.m - 1]}`;
  return withYear ? `${base} de ${p.y}` : base;
}

/** `"2026-08-31 14:00:00"` → `"31 ago"`. Para celdas de tabla. */
export function formatDateShort(wallClock: string): string {
  const p = parseWallClock(wallClock);
  if (!p) return "—";
  return `${p.d} ${MONTHS[p.m - 1].slice(0, 3)}`;
}

/** `90` → `"1 h 30 min"` · `45` → `"45 min"` · `120` → `"2 h"`. */
export function formatDuration(minutes: number): string {
  const m = Math.max(0, Math.trunc(minutes));
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest} min`;
  if (rest === 0) return `${h} h`;
  return `${h} h ${rest} min`;
}

// ---------------------------------------------------------------------------
// Teléfono
// ---------------------------------------------------------------------------

/**
 * `"+573001234567"` → `"+57 300 123 4567"`.
 *
 * La identidad de la clienta es el teléfono en E.164 (§ La identidad de la
 * clienta), así que se guarda sin espacios y se pinta con ellos. Un número que
 * no calce con el patrón colombiano se devuelve tal cual: mejor mostrar algo
 * raro que romper la ficha.
 */
export function formatPhoneCO(e164: string): string {
  const m = /^\+57(\d{3})(\d{3})(\d{4})$/.exec(e164.trim());
  return m ? `+57 ${m[1]} ${m[2]} ${m[3]}` : e164;
}
