/**
 * **"Te extrañamos"**: volver a traer a las clientas que dejaron de venir —puro,
 * testeado—.
 *
 * A cada una se le regala una tarjeta de sellos **nueva** de una campaña de
 * Stampee que ya nace con sellos (los `bonusStamps` de la campaña), y el 10 %
 * de primera visita en su próxima cita, como si fuera nueva. Se le manda todo
 * por WhatsApp desde `/clientes/recuperar`, con el mensaje que la dueña
 * escribe en la misma pantalla.
 *
 * ## Qué vive acá
 *
 * - **A quién se le ofrece** ({@link selectWinbackCandidates}): ya vino, su
 *   última visita atendida fue hace más de `lapsedDays`, no tiene cita
 *   agendada y no pidió que no le escribieran.
 * - **El mensaje** ({@link renderWinbackMessage}): una plantilla con
 *   `{campos}`. Un renglón cuyo campo quedó vacío se quita entero, así
 *   "Válido hasta el {vence}" desaparece solo cuando el regalo no vence, y el
 *   renglón del descuento cuando el descuento está apagado. Nunca lleva precio.
 * - **Cuándo vale el 10 %** ({@link winbackDiscountApplies}): en la primera
 *   visita atendida después de mandarlo y antes de que venza. Se gasta solo.
 *
 * Este módulo no lee el historial: quien pregunta por el 10 % le pasa si la
 * clienta ya vino después de mandárselo. Así no arrastra el historial de Agenda
 * Pro hacia la cuenta (`legacy-history.money-paths.test.ts`).
 */

import type { EaLocalDate, EaLocalDateTime } from "@/lib/ea";

/** La reserva en línea, marcada para saber cuántas llegan por este mensaje. */
export const WINBACK_BOOKING_URL =
  "https://www.goldenbeautystudio.com.co/reservar?utm_source=whatsapp&utm_medium=mensaje&utm_campaign=te-extranamos";

/** Sin configuración guardada: hace cuántos días sin venir se considera "por recuperar". */
export const DEFAULT_LAPSED_DAYS = 45;
/** Sin configuración guardada: cuántos días tiene para usar el descuento. */
export const DEFAULT_VALID_DAYS = 30;

export const WINBACK_FIELDS = [
  { key: "nombre", help: "su primer nombre" },
  { key: "sellos", help: "los sellos que ya trae la tarjeta" },
  { key: "meta", help: "los sellos para el premio" },
  { key: "premio", help: "el premio de la tarjeta" },
  { key: "descuento", help: "el porcentaje de descuento (vacío si está apagado)" },
  { key: "vence", help: "hasta cuándo vale (vacío si no vence)" },
  { key: "link", help: "el link de su tarjeta" },
  { key: "reservar", help: "el link para reservar en línea" },
] as const;

export type WinbackField = (typeof WINBACK_FIELDS)[number]["key"];
export type WinbackValues = Record<WinbackField, string | null>;

export const DEFAULT_WINBACK_TEMPLATE = [
  "¡Hola, {nombre}! 💛",
  "",
  "Te extrañamos en Golden Beauty Studio ✨ Para que vuelvas a consentirte, te abrimos una tarjeta de sellos nueva y ya trae *{sellos} sellos de regalo* 🎁",
  "Y en tu próxima cita tienes *{descuento}% de descuento* en tu servicio, como si fuera tu primera vez 💅",
  "Válido hasta el {vence}.",
  "",
  "👉 Tu tarjeta: {link}",
  "",
  "Reserva cuando quieras aquí: {reservar}",
  "¡Te esperamos! 🤍",
].join("\n");

const FIELD_RE = /\{([a-z]+)\}/g;

/**
 * La plantilla con los campos puestos.
 *
 * - Sin nombre, "¡Hola, {nombre}!" queda "¡Hola!".
 * - Un renglón con un campo vacío (o desconocido) se quita entero.
 * - Dos renglones en blanco seguidos quedan en uno, y no sobra ninguno al
 *   principio ni al final.
 */
export function renderWinbackMessage(template: string, values: WinbackValues): string {
  const lines = template.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const raw of lines) {
    let line = raw;
    if (!values.nombre) line = line.replace(/,?\s*\{nombre\}/g, "");
    let missing = false;
    line = line.replace(FIELD_RE, (whole, key: string) => {
      const value = (values as Record<string, string | null | undefined>)[key];
      if (value === undefined || value === null || value === "") {
        missing = true;
        return whole;
      }
      return value;
    });
    if (missing) continue;
    if (line.trim() === "" && (out.length === 0 || out[out.length - 1].trim() === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

/** Los campos que la plantilla usa y que este módulo no conoce: un error de tipeo. */
export function unknownFields(template: string): string[] {
  const known = new Set<string>(WINBACK_FIELDS.map((f) => f.key));
  const found = new Set<string>();
  for (const match of template.matchAll(FIELD_RE)) if (!known.has(match[1])) found.add(match[1]);
  return [...found];
}

const MONTHS = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

/** `YYYY-MM-DD` + n días de calendario. Sin zona horaria: es una fecha civil. */
export function addCalendarDays(date: EaLocalDate | string, days: number): EaLocalDate {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10) as EaLocalDate;
}

/** `2026-12-10` → `10 de diciembre`. */
export function formatDayMonth(date: EaLocalDate | string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${d} de ${MONTHS[m - 1]}`;
}

// ── El 10 % ─────────────────────────────────────────────────────────────────

export type WinbackOfferTerms = {
  discountPercent: number;
  /** Cuándo se mandó, en hora de Bogotá. */
  sentAt: EaLocalDateTime;
  /** Último día que vale, inclusivo. `null` = no vence. */
  expiresOn: EaLocalDate | string | null;
};

/**
 * ¿Le toca el 10 % de "Te extrañamos" a una cita en `asOf`?
 *
 * Sí cuando: se le prometió descuento, la cita es después de mandárselo, no
 * venció, y no ha venido (visita atendida) entre el envío y esta cita —esa
 * primera visita es la que lo usa—.
 */
export function winbackDiscountApplies(
  offer: WinbackOfferTerms | null,
  asOf: EaLocalDateTime,
  attendedSinceSent: boolean,
): boolean {
  if (offer === null || offer.discountPercent <= 0) return false;
  if (asOf < offer.sentAt) return false;
  if (offer.expiresOn !== null && asOf.slice(0, 10) > offer.expiresOn) return false;
  return !attendedSinceSent;
}

// ── A quién ─────────────────────────────────────────────────────────────────

export type WinbackPerson = {
  phone: string;
  firstName: string;
  lastName: string;
  lastAttended: EaLocalDateTime | null;
  hasUpcoming: boolean;
  visits: number;
};

export type WinbackSent = {
  sentAt: EaLocalDateTime;
  /** Volvió (visita atendida) después de mandárselo. */
  cameBack: boolean;
};

export type WinbackCandidate = WinbackPerson & {
  daysAway: number;
  sent: WinbackSent | null;
};

const daysBetween = (from: EaLocalDate | string, to: EaLocalDate | string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Las clientas por recuperar, y las que ya recibieron el regalo.
 *
 * - **Por recuperar**: última visita atendida hace más de `lapsedDays`, sin
 *   cita agendada, sin baja de WhatsApp y sin regalo mandado. Primero las que
 *   más han venido (una fiel que se fue es la más fácil de traer de vuelta), y
 *   entre iguales la que se fue hace menos.
 * - **Enviadas**: a quienes ya se les mandó, sin importar si siguen lejos, con
 *   si volvieron. Las más recientes primero.
 */
export function selectWinbackCandidates(input: {
  people: readonly WinbackPerson[];
  today: EaLocalDate;
  lapsedDays: number;
  optedOut: ReadonlySet<string>;
  sent: ReadonlyMap<string, WinbackSent>;
}): { pending: WinbackCandidate[]; sent: WinbackCandidate[] } {
  const pending: WinbackCandidate[] = [];
  const sent: WinbackCandidate[] = [];
  for (const person of input.people) {
    if (person.lastAttended === null) continue;
    const daysAway = daysBetween(person.lastAttended.slice(0, 10), input.today);
    const offer = input.sent.get(person.phone) ?? null;
    if (offer !== null) {
      sent.push({ ...person, daysAway, sent: offer });
      continue;
    }
    if (daysAway <= input.lapsedDays || person.hasUpcoming || input.optedOut.has(person.phone)) continue;
    pending.push({ ...person, daysAway, sent: null });
  }
  pending.sort((a, b) => b.visits - a.visits || a.daysAway - b.daysAway);
  sent.sort((a, b) => (a.sent!.sentAt < b.sent!.sentAt ? 1 : -1));
  return { pending, sent };
}
