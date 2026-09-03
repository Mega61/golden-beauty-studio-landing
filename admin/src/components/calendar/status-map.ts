/**
 * La costura que A3 dejó abierta: **qué cadena de EA es cuál de los cinco
 * estados del panel.**
 *
 * `components/ui/status.ts` dice, textualmente, que traducir `"Booked"` a
 * `reservada` "es dominio de EA (A1/C1), no del sistema de diseño". Esto es esa
 * tabla, y vive acá —en `components/calendar/`— porque la agenda es la primera
 * pantalla que la necesita y es de las rutas que este paquete posee. Si mañana
 * la usan Caja o Reportes, el movimiento natural es a `lib/`; es un `git mv`.
 *
 * ## Por qué hay dos alfabetos
 *
 * `appointment_status_options` es un ajuste de texto libre y hoy hay **dos**
 * listas en juego:
 *
 * - La que siembra la migración `043` de EA: `Booked`, `Confirmed`,
 *   `Rescheduled`, `Cancelled`, `Draft`.
 * - La que `docs/DEV-LOCAL.md` manda configurar en el estudio: `Reservada`,
 *   `Confirmada`, `Reprogramada`, `Completada`, `No asistió`, `Cancelada`.
 *
 * Una instalación puede estar en cualquiera de las dos, o a medio camino: EA
 * **no migra** el `status` de las citas viejas cuando alguien edita la lista, así
 * que después de reconfigurarla conviven filas con `"Booked"` y filas con
 * `"Reservada"`. Por eso la tabla cubre las dos y no se elige una.
 *
 * ## Lo que NO hace
 *
 * No inventa estados. Lo que no reconoce cae en `desconocido`, que se dibuja
 * con filete punteado y tono neutro — la señal que Diagnóstico necesita el día
 * que alguien renombre un estado en EA. Un mapa que adivinara convertiría ese
 * aviso en una pastilla mentirosa.
 *
 * ## Dos decisiones que el plan no fijaba
 *
 * - **`Rescheduled` / `Reprogramada` → `reservada`.** Reprogramar produce una
 *   cita que está en la agenda y que nadie confirmó todavía, que es la
 *   definición literal de `reservada` en `status.ts`. El dato "se movió" ya lo
 *   cuenta la agenda: el bloque está en otro sitio.
 * - **`Draft` → `desconocido`, no `reservada`.** Un borrador de EA es una
 *   reserva a medio hacer que su propio flujo puede descartar; pintarlo como
 *   reservada afirmaría que hay una clienta esperando. Punteado es exactamente
 *   lo que es: algo que no debería estar ahí.
 */

import { STATUS_META, normalizeStatusId, type StatusToken } from "../ui/status";

/**
 * Cadena normalizada de EA → token del panel.
 *
 * Las claves ya vienen normalizadas (`normalizeStatusId`: sin tildes, sin
 * mayúsculas, con guiones), así que `"No asistió"`, `"NO ASISTIO"` y
 * `"no_asistio"` entran por la misma puerta.
 */
export const EA_STATUS_MAP: Readonly<Record<string, StatusToken>> = {
  // Los cinco que siembra la migración 043 de EA.
  booked: "reservada",
  confirmed: "confirmada",
  rescheduled: "reservada",
  cancelled: "cancelada",
  canceled: "cancelada",
  // Los seis que `docs/DEV-LOCAL.md` manda configurar en el estudio.
  reservada: "reservada",
  confirmada: "confirmada",
  reprogramada: "reservada",
  completada: "completada",
  "no-asistio": "no-asistio",
  cancelada: "cancelada",
  // Variantes que aparecen en instalaciones de EA en inglés y que significan
  // exactamente lo mismo. Se aceptan porque el costo de no aceptarlas es una
  // agenda punteada, y el de aceptarlas es una línea.
  completed: "completada",
  "no-show": "no-asistio",
  noshow: "no-asistio",
};

/**
 * El token con el que se dibuja una cita. Nunca lanza.
 *
 * Un `status` vacío también cae en `desconocido`: el codec de A1 usa `""` como
 * fallback cuando EA no manda el campo, y una cita sin estado es justo lo que
 * Diagnóstico tiene que ver.
 */
export function mapEaStatus(raw: string | null | undefined): StatusToken {
  if (!raw) return "desconocido";
  return EA_STATUS_MAP[normalizeStatusId(raw)] ?? "desconocido";
}

/** Cómo se escribe en pantalla. Atajo sobre `STATUS_META`. */
export function eaStatusLabel(raw: string | null | undefined): string {
  return STATUS_META[mapEaStatus(raw)].label;
}

/**
 * Las cadenas de una tanda de citas que el panel no supo traducir, sin repetir
 * y en orden de aparición.
 *
 * Existe para que la agenda pueda decir "3 citas con un estado que no
 * reconozco: «Pendiente»" en vez de dejar tres bloques punteados sin
 * explicación, y para que D4 tenga de dónde sacar el mismo aviso sin volver a
 * escribir la tabla. Se devuelve la cadena **cruda**, no la normalizada: quien
 * la lea la va a buscar tal cual en la interfaz de EA.
 */
export function unmappedStatuses(
  raws: readonly (string | null | undefined)[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of raws) {
    if (mapEaStatus(raw) !== "desconocido") continue;
    const label = raw ?? "";
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }

  return out;
}
