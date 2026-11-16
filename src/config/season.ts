/**
 * Temporada decorativa del sitio (por ahora solo Navidad).
 *
 * Se prende y se apaga sola por fecha, en hora de Bogotá, para que nadie tenga
 * que acordarse de quitar los adornos el 7 de enero. `NEXT_PUBLIC_SEASON` la
 * fuerza: `navidad` la prende fuera de fecha (para revisar en un preview) y
 * `off` la apaga aunque sea diciembre. Cualquier otro valor — o la variable
 * vacía — deja mandar al calendario.
 *
 * Las páginas que la usan son ISR (`revalidate` en el segmento), así que el
 * cambio de fecha se ve sin redeploy: el primer render después de la
 * medianoche del 1 de diciembre ya sale decorado.
 */
export type Season = "navidad";

/** Colombia no tiene horario de verano: UTC−5 todo el año. */
const BOGOTA_OFFSET_MS = -5 * 60 * 60 * 1000;

/** Mes (1–12) y día del calendario en Bogotá para un instante dado. */
function bogotaDate(now: Date): { month: number; day: number } {
  const local = new Date(now.getTime() + BOGOTA_OFFSET_MS);
  return { month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

type Override = Season | "off" | null;

export function parseSeasonOverride(raw: string | undefined): Override {
  const v = raw?.trim().toLowerCase();
  if (v === "navidad") return "navidad";
  if (v === "off" || v === "false" || v === "0" || v === "none") return "off";
  return null;
}

/** Navidad: del 1 de diciembre al 6 de enero inclusive (Reyes). */
export function seasonFor(now: Date, override?: string): Season | null {
  const forced = parseSeasonOverride(override);
  if (forced === "off") return null;
  if (forced) return forced;
  const { month, day } = bogotaDate(now);
  if (month === 12 || (month === 1 && day < 7)) return "navidad";
  return null;
}

/**
 * El calendario de adviento de la tarjeta Golden: puertas del 2 al 24 de
 * diciembre. La banda que lo anuncia vive del 1 (la víspera de la primera
 * puerta) al 24; después, "una puerta nueva cada dos días" sería mentira.
 * Con la temporada forzada a `navidad` se ve siempre, para poder revisarla.
 */
export function adventFor(now: Date, override?: string): boolean {
  const forced = parseSeasonOverride(override);
  if (forced === "off") return false;
  if (forced === "navidad") return true;
  const { month, day } = bogotaDate(now);
  return month === 12 && day <= 24;
}

export function currentSeason(now: Date = new Date()): Season | null {
  return seasonFor(now, process.env.NEXT_PUBLIC_SEASON);
}

export function currentAdvent(now: Date = new Date()): boolean {
  return adventFor(now, process.env.NEXT_PUBLIC_SEASON);
}

/**
 * ¿Todavía se puede anunciar el calendario de adviento? Desde que arranca la
 * temporada (en noviembre se anuncia lo que viene) hasta el 24 de diciembre.
 * Del 25 en adelante la temporada sigue (adornos hasta Reyes), pero decir "tu
 * tarjeta trae calendario de adviento" ya sería mentira. Lo usa la nota de
 * `#mi-tarjeta`; la banda y la fila del /bio usan {@link adventFor} (1–24 dic).
 */
export function adventNoteFor(now: Date, override?: string): boolean {
  const forced = parseSeasonOverride(override);
  if (forced === "off") return false;
  if (forced === "navidad") return true;
  if (seasonFor(now) === null) return false;
  const { month, day } = bogotaDate(now);
  return month === 11 || (month === 12 && day <= 24);
}

export function currentAdventNote(now: Date = new Date()): boolean {
  return adventNoteFor(now, process.env.NEXT_PUBLIC_SEASON);
}
