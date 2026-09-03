/**
 * El puente entre el `status` de EA y los cinco ids del panel.
 *
 * A3 dejó esta costura abierta a propósito: su catálogo (`components/ui/status`)
 * sabe *dibujar* `reservada`, pero traducir `"Booked"` → `reservada` es
 * conocimiento de EA, no del sistema de diseño. A1 tampoco la cerró, porque el
 * `status` de EA es texto libre y no hay un tipo cerrado que se pueda modelar.
 *
 * **Esto vive acá, en `clientes/`, porque es la primera pantalla que lo
 * necesitó — pero no es su casa definitiva.** La agenda (C1) y la cuenta de
 * servicio (C2) necesitan exactamente lo mismo. En cuanto exista un módulo de
 * dominio de EA compartido, esta tabla se muda ahí sin cambios: es una función
 * pura de cadena a token.
 *
 * ## Por qué la tabla y no una traducción automática
 *
 * `normalizeStatusId()` de A3 quita tildes y baja a minúsculas, así que
 * `"No asistió"` ya cae en `no-asistio` sola. Lo que no puede hacer sola es
 * cruzar de idioma: la migración `043` de EA siembra
 * `["Booked", "Confirmed", "Rescheduled", "Cancelled", "Draft"]` y el estudio
 * va a configurar la lista en español (§ DEV-LOCAL, paso 2). **Las dos listas
 * van a convivir**, porque el `status` es texto plano guardado por cita:
 * renombrar la opción en EA *no* migra las filas viejas. Una cita de octubre
 * puede decir `"Booked"` y una de noviembre `"Reservada"`, y las dos son la
 * misma cosa.
 *
 * ## Los dos que no tienen equivalente
 *
 * `Rescheduled` y `Draft` no están entre los cinco del panel, y **no se
 * inventan**. Se devuelven como `desconocido`, que es lo que hace que la
 * pastilla salga punteada y que Diagnóstico tenga algo que reportar. Mapear
 * `Rescheduled` a `reservada` "porque se le parece" escondería que la lista de
 * estados de EA no quedó configurada como el motor de comisiones necesita.
 */

import {
  isStatusId,
  normalizeStatusId,
  type StatusToken,
} from "@/components/ui";

/**
 * Alias conocidos, ya normalizados con la misma función que se les aplica a las
 * entradas. Solo lo que EA siembra de fábrica y las variantes que se ven en un
 * export viejo.
 */
const ALIASES: Record<string, StatusToken> = {
  // Lo que siembra la migración 043 de EA.
  booked: "reservada",
  confirmed: "confirmada",
  cancelled: "cancelada",
  canceled: "cancelada",
  // Los dos que el motor de comisiones necesita y EA no trae de fábrica.
  completed: "completada",
  finished: "completada",
  "no-show": "no-asistio",
  noshow: "no-asistio",
  "did-not-attend": "no-asistio",
  // Variantes en español que no caen solas por acentos o número.
  reservado: "reservada",
  confirmado: "confirmada",
  completado: "completada",
  cancelado: "cancelada",
  "no-asistio": "no-asistio",
  "no-vino": "no-asistio",
  "no-se-presento": "no-asistio",
};

/**
 * `"Booked"` → `"reservada"`. Lo que no reconoce, `"desconocido"`.
 *
 * Nunca lanza: un estado desconocido es condición de operación normal en un
 * sistema donde la lista se edita desde la interfaz de EA.
 */
export function eaStatusToken(raw: string | null | undefined): StatusToken {
  if (typeof raw !== "string") return "desconocido";
  const id = normalizeStatusId(raw);
  if (id === "") return "desconocido";
  if (isStatusId(id)) return id;
  return ALIASES[id] ?? "desconocido";
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
