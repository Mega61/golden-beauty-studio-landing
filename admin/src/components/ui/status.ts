/**
 * Catálogo visual de los estados de la cita.
 *
 * **Esto no es el dominio, es la presentación.** El `status` de una cita en EA
 * es texto libre (ver `lib/ea/types.ts`) y la traducción de ese texto a un
 * estado del panel es de A1/C1, no de acá. Este archivo solo contesta: dado un
 * identificador de estado, ¿qué pastilla se dibuja?
 *
 * Hay un detalle del plan que hay que mirar de frente: § UX nombra cinco
 * estados —`Reservada`, `Confirmada`, `Completada`, `Cancelada`, `No asistió`—
 * y la migración 043 de EA siembra otros cinco: `Booked`, `Confirmed`,
 * `Rescheduled`, `Cancelled`, `Draft`. No son la misma lista: a EA le faltan
 * "Completada" y "No asistió" y le sobran "Rescheduled" y "Draft". La lectura
 * razonable es que `appointment_status_options` se va a configurar con las
 * cinco del plan, pero eso es una decisión de operación con consecuencias en el
 * motor de comisiones, y no es de este paquete tomarla. Queda reportada.
 *
 * Mientras tanto este catálogo hace lo único seguro: normaliza la cadena que
 * reciba y, si no la conoce, devuelve el token `desconocido` — filete punteado
 * y tono neutro — en vez de inventarle un color. Un estado que aparece
 * punteado en la agenda es exactamente la señal que Diagnóstico necesita.
 */

export const STATUS_IDS = [
  "reservada",
  "confirmada",
  "completada",
  "cancelada",
  "no-asistio",
] as const;

export type StatusId = (typeof STATUS_IDS)[number];
/** Lo que se puede pintar, incluyendo el comodín. */
export type StatusToken = StatusId | "desconocido";

export type StatusMeta = {
  id: StatusToken;
  /** Cómo se escribe en pantalla. Español de Colombia, sin capa de i18n. */
  label: string;
  /** Qué significa. Alimenta el `title` de la pastilla y la galería. */
  description: string;
};

export const STATUS_META: Record<StatusToken, StatusMeta> = {
  reservada: {
    id: "reservada",
    label: "Reservada",
    description: "Está en la agenda y todavía nadie la confirmó.",
  },
  confirmada: {
    id: "confirmada",
    label: "Confirmada",
    description: "La clienta confirmó que viene.",
  },
  completada: {
    id: "completada",
    label: "Completada",
    description: "El servicio se hizo. Es la que habilita la cuenta.",
  },
  cancelada: {
    id: "cancelada",
    label: "Cancelada",
    description: "Se cayó con aviso. La silla quedó libre a tiempo.",
  },
  "no-asistio": {
    id: "no-asistio",
    label: "No asistió",
    description: "La clienta no llegó y la silla se perdió.",
  },
  desconocido: {
    id: "desconocido",
    label: "Sin reconocer",
    description:
      "El estado que trae EA no está en la lista del panel. Revisar Diagnóstico.",
  },
};

/**
 * Convierte cualquier cadena a la forma del id: sin tildes, sin mayúsculas,
 * con guiones. `"No asistió"`, `"NO ASISTIO"` y `"no-asistio"` caen en el
 * mismo lugar.
 *
 * Es un normalizador de texto, no un mapa de dominio: no sabe nada de EA ni
 * traduce `"Booked"` a `"reservada"`. Esa tabla vive donde vive el resto del
 * conocimiento sobre EA.
 */
export function normalizeStatusId(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** ¿Es uno de los cinco que el panel sabe dibujar? */
export function isStatusId(value: string): value is StatusId {
  return (STATUS_IDS as readonly string[]).includes(value);
}

/**
 * El token que hay que pintar para una cadena cualquiera. Nunca lanza: un
 * estado desconocido es una condición de operación normal en un sistema donde
 * la lista se edita desde la interfaz de EA.
 */
export function resolveStatus(raw: string | null | undefined): StatusMeta {
  if (!raw) return STATUS_META.desconocido;
  const id = normalizeStatusId(raw);
  return isStatusId(id) ? STATUS_META[id] : STATUS_META.desconocido;
}

/**
 * Contraste medido de cada etiqueta sobre su propio tinte, con la fórmula de
 * WCAG 2.x. Se deja en el código, y no solo en un comentario del CSS, para que
 * el día que alguien cambie un hex el número quede desmentido por un test en
 * vez de por nadie.
 *
 * Los valores salen de la sesión de `dataviz` que fijó la paleta; el test de
 * este archivo los recalcula desde los hex y falla si no coinciden.
 */
export const STATUS_HEX: Record<
  StatusToken,
  { tint: string; line: string; ink: string; dot: string }
> = {
  reservada: {
    tint: "#f3eeea",
    line: "#c8c1ba",
    ink: "#61584f",
    dot: "#544b43",
  },
  confirmada: {
    tint: "#e3f1ff",
    line: "#93c8fa",
    ink: "#005d9a",
    dot: "#1f7fc8",
  },
  completada: {
    tint: "#d4f9e7",
    line: "#98d2b6",
    ink: "#006747",
    dot: "#2f8a66",
  },
  cancelada: {
    tint: "#f2ebfe",
    line: "#cdb5f4",
    ink: "#6a4798",
    dot: "#6a3f9e",
  },
  "no-asistio": {
    tint: "#ffeae4",
    line: "#f6ae9a",
    ink: "#973b21",
    dot: "#c8461f",
  },
  desconocido: {
    tint: "#f6f3ef",
    line: "#b9ada0",
    ink: "#574c41",
    dot: "#8a7a68",
  },
};
