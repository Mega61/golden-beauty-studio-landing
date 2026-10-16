/**
 * Los parámetros de las dos plantillas de Meta, y sus textos de referencia.
 *
 * Las plantillas se escriben **en Meta**, no acá: lo que el panel manda son
 * solo los valores de `{{1}}…{{4}}`. Este archivo es el otro lado del
 * contrato, y por eso los cuerpos exactos viven también acá
 * (`TEMPLATE_BODIES`): el test verifica que la cantidad de parámetros que se
 * arma coincide con la de los cuerpos, y `docs/WHATSAPP.md` copia esos mismos
 * textos para pegarlos en el administrador de plantillas. Si Meta recibe otra
 * cantidad, rechaza el mensaje con `132000`.
 *
 * ## Por qué cuatro parámetros y la fecha con la hora en uno solo
 *
 * Meta rechaza plantillas con dos variables pegadas ("{{3}} {{4}}"), y
 * separarlas con texto fijo ("el {{3}} a las {{4}}") rompe la una de la
 * tarde: "a las 1:00 p. m." es el error que delata a una máquina. Así que la
 * fecha y la hora viajan juntas, ya habladas por `spokenTime` — que sabe decir
 * "a la 1:00 p. m." — y el texto fijo queda alrededor.
 *
 * ## Lo que nunca va
 *
 * **Precio**: el de la reserva no es necesariamente el que se cobra
 * (adicionales, promos que se aplican al pagar). **Género**: "querida",
 * "bienvenida" — el estudio atiende a quien llegue. **Saltos de línea** dentro
 * de un parámetro: Meta los rechaza (`132018`).
 */

import { formatDateLong } from "@/components/ui/format";
import { eaDatePart, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea";

import { STUDIO_ADDRESS, presentableFirstName, spokenTime } from "./manual-reminder";

/** Los cuerpos tal como se crean en Meta. `docs/WHATSAPP.md` los copia. */
export const TEMPLATE_BODIES = {
  confirmacion:
    "Hola {{1}}, tu cita de {{2}} en Golden Beauty Studio quedó confirmada para {{3}}, con {{4}}.\n\n" +
    `Te esperamos en ${STUDIO_ADDRESS}.\n\n` +
    "Si necesitas cambiarla, responde a este mensaje.",
  recordatorio:
    "Hola {{1}}, te recordamos tu cita de {{2}} en Golden Beauty Studio {{3}}, con {{4}}.\n\n" +
    `Te esperamos en ${STUDIO_ADDRESS}.\n\n` +
    "Si necesitas cambiarla, responde a este mensaje. Si prefieres no recibir más recordatorios, responde BAJA.",
} as const;

/** Cuántos `{{n}}` tiene un cuerpo. */
export function placeholderCount(body: string): number {
  return new Set(body.match(/\{\{\d+\}\}/g) ?? []).size;
}

/** Lo que hace falta de una cita para armar cualquiera de las dos. */
export type TemplateAppointment = {
  start: EaLocalDateTime;
  customerFirstName: string | null;
  serviceName: string | null;
  providerFirstName: string | null;
};

/**
 * Un parámetro como lo acepta Meta: sin saltos de línea ni tabs, sin más de
 * cuatro espacios seguidos, no vacío, y corto. El tope de 60 no es de Meta
 * (el cuerpo entero puede llegar a 1024): es que un nombre de servicio de 200
 * caracteres en un WhatsApp es un error de datos, no un nombre.
 */
export function cleanParam(value: string, fallback: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  if (flat === "") return fallback;
  return flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat;
}

/**
 * `{{1}}`: el primer nombre, presentable. Sin nombre, "qué tal" — "Hola qué
 * tal, tu cita…" se lee natural, y Meta no acepta un parámetro vacío.
 */
function greetingName(raw: string | null): string {
  return cleanParam(presentableFirstName(raw) ?? "", "qué tal");
}

/** `{{2}}`: el servicio. Sin nombre, "belleza" ("tu cita de belleza"). */
function serviceParam(raw: string | null): string {
  return cleanParam(raw ?? "", "belleza");
}

/** `{{4}}`: la técnica por su primer nombre; sin técnica, el equipo. */
function providerParam(raw: string | null): string {
  return cleanParam(presentableFirstName(raw) ?? "", "nuestro equipo");
}

/**
 * Confirmación: `["Laura", "Semipermanente manos", "el viernes 16 de octubre a las 10:00 a. m.", "Lina"]`.
 */
export function confirmationParams(appointment: TemplateAppointment): string[] {
  return [
    greetingName(appointment.customerFirstName),
    serviceParam(appointment.serviceName),
    cleanParam(`el ${formatDateLong(appointment.start)} ${spokenTime(appointment.start)}`, "la fecha agendada"),
    providerParam(appointment.providerFirstName),
  ];
}

/**
 * Recordatorio: el `{{3}}` dice **hoy**, **mañana** o la fecha, según el día
 * de la cita contra el día en que sale el mensaje (calendario de Bogotá).
 *
 * Se decide por el día real y no por el tipo (`24h` / `2h`): un aviso de 24 h
 * que sale a las 11:50 p. m. para una cita de las 11:30 p. m. del día siguiente
 * es "mañana", pero uno de 2 h que sale a las 11:10 p. m. para la 1:10 a. m. ya
 * no es "hoy". El estudio no atiende a esas horas; la regla igual es la del
 * calendario y no la del tipo, para que nunca diga algo falso.
 *
 * "mañana" lleva la fecha ("mañana viernes 16 de octubre"): el mensaje se lee
 * horas después, a veces pasada la medianoche, y "mañana" a secas deja de ser
 * cierto.
 */
export function reminderParams(
  appointment: TemplateAppointment,
  sendDay: { today: EaLocalDate; tomorrow: EaLocalDate },
): string[] {
  const date = eaDatePart(appointment.start);
  const time = spokenTime(appointment.start);
  const when =
    date === sendDay.today
      ? `hoy ${time}`
      : date === sendDay.tomorrow
        ? `mañana ${formatDateLong(appointment.start)} ${time}`
        : `el ${formatDateLong(appointment.start)} ${time}`;

  return [
    greetingName(appointment.customerFirstName),
    serviceParam(appointment.serviceName),
    cleanParam(when, "en la fecha agendada"),
    providerParam(appointment.providerFirstName),
  ];
}

/**
 * El mensaje tal como lo va a leer la clienta. Solo para pantallas y tests:
 * a Meta se le mandan los parámetros, nunca el texto.
 */
export function renderTemplate(body: string, params: readonly string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (match, n: string) => params[Number(n) - 1] ?? match);
}
