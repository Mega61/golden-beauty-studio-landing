/**
 * El puente entre el `status` de EA y los cinco ids del panel, para la ficha.
 *
 * **Ya no tiene tabla propia: delega en `mapEaStatus()`** de
 * `components/calendar/status-map.ts`. Hubo dos tablas —ésta y la de la
 * agenda— y no coincidían: la agenda leía `Reprogramada`/`Rescheduled` como
 * `reservada` y esta ficha como `desconocido`. Como `Reprogramada` es uno de
 * los seis estados que el estudio configura (`jobs/status-options.ts`), la
 * misma cita contaba distinto según la pantalla. Los alias que solo existían
 * acá (`finished`, `no-vino`, `reservado`…) se mudaron a esa tabla, así que
 * nada que antes se reconociera deja de reconocerse.
 *
 * La decisión que quedó es la de la agenda: reprogramar produce una cita que
 * está en la agenda y nadie confirmó todavía, que es la definición literal de
 * `reservada`. `Draft` sigue en `desconocido` en las dos.
 *
 * Se conserva el nombre `eaStatusToken` porque lo importan la historia y sus
 * tests; es un alias de una línea, no una segunda opinión.
 */

import type { StatusToken } from "@/components/ui";
import { mapEaStatus } from "@/components/calendar/status-map";

/**
 * `"Booked"` → `"reservada"`. Lo que no reconoce, `"desconocido"`.
 *
 * Nunca lanza: un estado desconocido es condición de operación normal en un
 * sistema donde la lista se edita desde la interfaz de EA.
 */
export function eaStatusToken(raw: string | null | undefined): StatusToken {
  return mapEaStatus(typeof raw === "string" ? raw : null);
}

/** ¿Esta cita cuenta como prestada? Es la que habilita la cuenta y la comisión. */
export function isCompletedStatus(raw: string | null | undefined): boolean {
  return eaStatusToken(raw) === "completada";
}

/**
 * ¿Esta cita liberó la silla?
 *
 * `cancelada` sí; `no-asistio` **no**, aunque la silla haya quedado vacía: la
 * hora se perdió igual y contarla como liberada haría que la ocupación del mes
 * se viera mejor de lo que fue.
 */
export function freedTheChair(raw: string | null | undefined): boolean {
  return eaStatusToken(raw) === "cancelada";
}
