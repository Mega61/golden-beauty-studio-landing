/**
 * Fechas y horas de Easy!Appointments.
 *
 * **EA guarda hora de pared, sin zona.** Las columnas `start_datetime`,
 * `end_datetime` y `book_datetime` son `DATETIME` de MySQL con el formato
 * `Y-m-d H:i:s`, y ni la fila cruda ni el payload camelCase de la API traen
 * offset ni sufijo `Z`. `"2026-08-31 14:00:00"` significa "las dos de la tarde
 * en el estudio" y nada más.
 *
 * De ahí sale la regla de este módulo, que es la decisión de diseño que evita
 * la clase entera de bugs de cinco horas:
 *
 * > **El tipo canónico del dominio es la hora de pared, no un `Date`.**
 *
 * Un `Date` es un instante absoluto. Convertir `"2026-08-31 14:00:00"` a `Date`
 * exige elegir una zona, y si esa elección la hace implícitamente el runtime
 * (`new Date("2026-08-31 14:00:00")` usa la zona de la máquina) el resultado
 * cambia entre la VM (`America/Bogota`), CI (`UTC`) y el portátil de quien
 * desarrolla. El síntoma no es una excepción: es un cierre de caja que no
 * cuadra y una cita dibujada en la franja equivocada.
 *
 * Entonces: el dominio transporta `EaLocalDateTime` (la cadena, marcada como
 * tipo aparte para que no se confunda con cualquier string), y quien necesite
 * un instante absoluto — comparar contra `Date.now()`, ordenar contra algo que
 * sí tiene zona — lo pide **explícitamente** con `eaLocalToInstant()`, que
 * siempre resuelve en `America/Bogota` salvo que se le diga otra cosa.
 *
 * Todas las conversiones de acá usan `Intl` con la zona pasada explícitamente,
 * nunca la zona por defecto del proceso. Por eso los tests dan el mismo
 * resultado con `TZ=UTC` y con `TZ=America/Bogota`, que es justo la invariante
 * que pide el paquete.
 */

/**
 * Zona del estudio. Colombia no tiene horario de verano desde 1993, así que en
 * la práctica es un offset fijo de −05:00 — pero no está escrito a mano en
 * ningún lado a propósito: si la base de datos de zonas cambiara, `Intl` lo
 * sabe y una constante `-5` no.
 */
export const EA_TIME_ZONE = "America/Bogota";

declare const eaLocalDateTimeBrand: unique symbol;

/**
 * `"YYYY-MM-DD HH:mm:ss"` — hora de pared en la zona del estudio.
 *
 * Está marcada (`brand`) para que el compilador distinga una fecha de EA de
 * cualquier otra cadena. Sin la marca, pasar un ISO 8601 con `T` y `Z` donde va
 * un datetime de EA compila sin chistar y falla en producción.
 */
export type EaLocalDateTime = string & { readonly [eaLocalDateTimeBrand]: "datetime" };

declare const eaLocalDateBrand: unique symbol;

/** `"YYYY-MM-DD"` — la forma que aceptan `from`, `till` y `date`. */
export type EaLocalDate = string & { readonly [eaLocalDateBrand]: "date" };

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Error de parseo. Separado de `EaApiError`: esto es data mal formada, no red. */
export class EaDateTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EaDateTimeError";
  }
}

type Wall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function isRealDate({ year, month, day, hour, minute, second }: Wall): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  // Rebota el 31 de febrero: `Date.UTC` normaliza en silencio hacia adelante,
  // así que la única forma de detectarlo es comparar el resultado.
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/** ¿La cadena tiene la forma exacta que emite EA? */
export function isEaLocalDateTime(value: unknown): value is EaLocalDateTime {
  if (typeof value !== "string") return false;
  const m = DATETIME_RE.exec(value);
  if (!m) return false;
  return isRealDate(wallFromMatch(m));
}

/** ¿La cadena es un `YYYY-MM-DD` real? */
export function isEaLocalDate(value: unknown): value is EaLocalDate {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  return isRealDate({
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: 0,
    minute: 0,
    second: 0,
  });
}

function wallFromMatch(m: RegExpExecArray): Wall {
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6]),
  };
}

/**
 * Valida y marca. Acepta el separador `T` además del espacio porque algunas
 * respuestas de EA viajan con `T` según de dónde salgan, y normaliza a espacio
 * — la forma que EA acepta de vuelta al escribir.
 */
export function parseEaLocalDateTime(value: unknown): EaLocalDateTime {
  if (typeof value !== "string") {
    throw new EaDateTimeError(`Se esperaba un datetime de EA y llegó ${typeof value}`);
  }

  const m = DATETIME_RE.exec(value);

  if (!m || !isRealDate(wallFromMatch(m))) {
    throw new EaDateTimeError(`Datetime de EA inválido: ${JSON.stringify(value)}`);
  }

  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` as EaLocalDateTime;
}

/** Igual que el anterior, para `YYYY-MM-DD`. */
export function parseEaLocalDate(value: unknown): EaLocalDate {
  if (typeof value !== "string" || !isEaLocalDate(value)) {
    throw new EaDateTimeError(`Fecha de EA inválida: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Construye un datetime de EA desde componentes de hora de pared. */
export function eaLocalDateTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): EaLocalDateTime {
  const wall: Wall = { year, month, day, hour, minute, second };

  if (!isRealDate(wall)) {
    throw new EaDateTimeError(
      `Componentes de fecha inválidos: ${year}-${month}-${day} ${hour}:${minute}:${second}`,
    );
  }

  return `${pad(year, 4)}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}` as EaLocalDateTime;
}

/** La parte de fecha. Es lo que `from` / `till` / `date` realmente comparan. */
export function eaDatePart(value: EaLocalDateTime): EaLocalDate {
  return value.slice(0, 10) as EaLocalDate;
}

/** La parte de hora, `"HH:mm:ss"`. */
export function eaTimePart(value: EaLocalDateTime): string {
  return value.slice(11);
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      // `hourCycle: "h23"` y no `hour12: false`: con `hour12: false` varios
      // runtimes devuelven "24" para la medianoche, que rompe la aritmética
      // silenciosamente una vez al día.
      hourCycle: "h23",
      era: "short",
    });
    partsCache.set(timeZone, formatter);
  }

  return formatter;
}

function wallInZone(instant: Date, timeZone: string): Wall {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    return part ? Number(part.value) : 0;
  };

  const era = parts.find((p) => p.type === "era")?.value;
  const year = get("year");

  return {
    // Fechas antes de Cristo no aparecen en una agenda de manicure, pero el
    // signo importa para que la aritmética del offset no se descuadre si
    // alguien pasa un `Date` corrupto.
    year: era === "BC" || era === "B" ? 1 - year : year,
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function wallToUtcMs(wall: Wall): number {
  const date = new Date(
    Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second),
  );

  // `Date.UTC` mapea los años 0..99 a 1900..1999. Sin este ajuste una fecha del
  // año 45 se movería mil novecientos años y el offset calculado sería basura.
  if (wall.year >= 0 && wall.year <= 99) {
    date.setUTCFullYear(wall.year);
  }

  return date.getTime();
}

/** Offset de la zona, en milisegundos, para un instante dado. */
function offsetMs(instant: Date, timeZone: string): number {
  return wallToUtcMs(wallInZone(instant, timeZone)) - instant.getTime();
}

/**
 * Hora de pared → instante absoluto.
 *
 * Dos pasadas: la primera estima el offset tratando la pared como si fuera UTC,
 * la segunda lo corrige con el offset que rige en el instante estimado. Con eso
 * queda exacto también en zonas con horario de verano (Bogotá no lo tiene, pero
 * el algoritmo no depende de eso, y el módulo se usa igual para formatear
 * fechas de clientas con `timezone` propio).
 *
 * En un salto de primavera la hora local no existe; se resuelve hacia adelante,
 * que es lo que hace `date-fns-tz` y lo que espera cualquiera que mire un
 * calendario.
 */
export function eaLocalToInstant(value: EaLocalDateTime, timeZone: string = EA_TIME_ZONE): Date {
  const m = DATETIME_RE.exec(value);

  if (!m) {
    throw new EaDateTimeError(`Datetime de EA inválido: ${JSON.stringify(value)}`);
  }

  const guess = wallToUtcMs(wallFromMatch(m));
  const firstPass = guess - offsetMs(new Date(guess), timeZone);

  return new Date(guess - offsetMs(new Date(firstPass), timeZone));
}

/**
 * Instante absoluto → hora de pared de EA.
 *
 * Es la dirección que usa el panel al escribir: la técnica toca "ahora" y hay
 * que guardar la hora de pared del estudio, no el UTC del contenedor.
 */
export function instantToEaLocal(instant: Date, timeZone: string = EA_TIME_ZONE): EaLocalDateTime {
  if (Number.isNaN(instant.getTime())) {
    throw new EaDateTimeError("Se esperaba un Date válido");
  }

  const wall = wallInZone(instant, timeZone);

  return eaLocalDateTime(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second);
}

/** El `YYYY-MM-DD` del estudio para un instante — el "hoy" de la agenda. */
export function instantToEaDate(instant: Date, timeZone: string = EA_TIME_ZONE): EaLocalDate {
  return eaDatePart(instantToEaLocal(instant, timeZone));
}

/**
 * Suma minutos a una hora de pared **en la línea de tiempo absoluta**.
 *
 * Se hace pasando por el instante y volviendo, no sumando a los componentes:
 * "una cita de 90 minutos" es una duración real, y en un salto de horario
 * sumar a los componentes daría una hora de fin que no existió.
 */
export function addMinutes(
  value: EaLocalDateTime,
  minutes: number,
  timeZone: string = EA_TIME_ZONE,
): EaLocalDateTime {
  const instant = eaLocalToInstant(value, timeZone);
  return instantToEaLocal(new Date(instant.getTime() + minutes * 60_000), timeZone);
}

/** Minutos entre dos horas de pared, en la línea de tiempo absoluta. */
export function minutesBetween(
  from: EaLocalDateTime,
  till: EaLocalDateTime,
  timeZone: string = EA_TIME_ZONE,
): number {
  const a = eaLocalToInstant(from, timeZone).getTime();
  const b = eaLocalToInstant(till, timeZone).getTime();
  return Math.round((b - a) / 60_000);
}

/**
 * Orden cronológico de dos horas de pared de la **misma** zona.
 *
 * Comparar las cadenas alcanza y es más barato que construir dos `Date`: el
 * formato `YYYY-MM-DD HH:mm:ss` ordena lexicográficamente igual que
 * cronológicamente. Vale solo dentro de una zona sin saltos, que es el caso.
 */
export function compareEaLocal(a: EaLocalDateTime, b: EaLocalDateTime): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
