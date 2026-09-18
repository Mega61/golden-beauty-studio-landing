/**
 * Fijar la lista de estados de citas de Easy!Appointments.
 *
 * ## Por qué es un job y no un botón
 *
 * EA guarda el estado de cada cita como **texto plano en la fila**, y la lista
 * (`appointment_status_options`) es solo lo que ofrece el desplegable. Cambiar
 * la lista **no migra las citas viejas**: quedan con la cadena que tenían, y
 * conviven dos vocabularios en la misma agenda.
 *
 * Eso convierte esto en una operación con ventana: se hace **antes** de que
 * existan citas reales, una vez, mirando el resultado. Un botón en el panel
 * invitaría a tocarlo un martes cualquiera, que es justo cuando hace daño.
 *
 * ## Los seis, y por qué no son los cinco de EA
 *
 * La migración `043` de EA siembra `Booked, Confirmed, Rescheduled, Cancelled,
 * Draft` — **sin "Completada" ni "No asistió"**, que son exactamente los dos que
 * el motor de comisiones necesita para saber qué se liquida. Sin ellos no hay
 * forma de distinguir una cita atendida de una que la clienta no honró, y la
 * quincena se calcularía sobre las dos.
 *
 * `Draft` no entra: es una reserva a medio hacer del flujo público de EA, y el
 * panel ya la pinta punteada sin necesidad de que esté en la lista.
 *
 * ## La guarda
 *
 * Antes de escribir se mira qué estados están **en uso** en las citas que ya
 * existen. Si alguno desaparecería de la lista, el job **no escribe** y los
 * lista: esas citas quedarían con una cadena que el desplegable ya no ofrece, y
 * nadie podría volver a ponerles ese estado desde la interfaz de EA.
 *
 * Es la diferencia entre correr esto en una agenda vacía —donde es gratis— y
 * correrlo con seis meses de historia, donde no lo es.
 */

/** Los seis que el estudio usa, en el orden en que se muestran. */
export const STATUS_OPTIONS: readonly string[] = [
  "Reservada",
  "Confirmada",
  "Reprogramada",
  "Completada",
  "No asistió",
  "Cancelada",
];

/** El nombre del ajuste en EA. Lo leen `Calendar.php` y `Booking.php`. */
export const STATUS_OPTIONS_SETTING = "appointment_status_options";

export type StatusPlan =
  /** La lista ya es la que queremos. No se escribe nada. */
  | { action: "ya-esta"; options: readonly string[] }
  /** Se puede escribir. `losing` siempre vacío. */
  | { action: "escribir"; from: readonly string[] | null; to: readonly string[] }
  /**
   * Hay citas usando estados que la lista nueva no tiene. **No se escribe.**
   * `losing` son esas cadenas, tal como están en las filas.
   */
  | { action: "peligro"; losing: readonly string[]; inUse: readonly string[] };

/**
 * Lee el valor crudo del ajuste. `null` si no existe o si no es una lista.
 *
 * EA lo guarda como JSON array de cadenas. Un valor que no parsea no es un
 * error acá: significa que EA lo trata como lista vacía, y entonces escribir la
 * lista buena es exactamente lo correcto.
 */
export function parseStatusOptions(raw: string | null): string[] | null {
  if (raw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  if (!parsed.every((value) => typeof value === "string")) return null;

  return parsed;
}

/**
 * Qué hacer, dada la lista actual y los estados que las citas ya usan.
 *
 * Función pura: toda la decisión está acá y el CLI solo la ejecuta. La
 * comparación de "ya está" es **por contenido y orden** — reordenar la lista no
 * rompe nada en EA, pero tampoco hace falta escribirla, y una escritura que no
 * cambia nada igual deja rastro en el log de EA.
 */
export function planStatusOptions(input: {
  current: readonly string[] | null;
  /** Estados que aparecen en citas existentes. Sin normalizar, como vienen. */
  inUse: readonly string[];
  target?: readonly string[];
}): StatusPlan {
  const target = input.target ?? STATUS_OPTIONS;
  const inUse = [...new Set(input.inUse.filter((value) => value.trim() !== ""))].sort();

  // La comparación de pérdida es laxa a propósito: `"no asistió"`, `"No
  // Asistió"` y `"NO ASISTIO"` son el mismo estado escrito distinto, y marcar
  // una de ellas como "se pierde" sería una falsa alarma que enseña a ignorar
  // la alarma.
  const targetKeys = new Set(target.map(statusKey));
  const losing = inUse.filter((value) => !targetKeys.has(statusKey(value)));

  if (losing.length > 0) return { action: "peligro", losing, inUse };

  if (
    input.current !== null &&
    input.current.length === target.length &&
    input.current.every((value, index) => value === target[index])
  ) {
    return { action: "ya-esta", options: target };
  }

  return { action: "escribir", from: input.current, to: target };
}

/**
 * La llave con la que dos estados se consideran el mismo.
 *
 * Es la misma normalización de `components/ui/status.ts` —sin tildes, sin
 * mayúsculas, sin separadores— duplicada acá en cuatro líneas a propósito: este
 * módulo se empaqueta con esbuild para correr como script suelto, y arrastrar
 * un import de `components/` metería React en el bundle de un CLI.
 */
function statusKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** El valor que se le manda a EA. */
export function serializeStatusOptions(options: readonly string[]): string {
  // Con espacio después de la coma, que es como lo escribe la migración `043` de
  // EA. No cambia nada funcional —`json_decode` no mira el espaciado— pero deja
  // el valor indistinguible de uno escrito por EA, y eso importa el día que
  // alguien compare dos instalaciones a ojo.
  return `[${options.map((option) => JSON.stringify(option)).join(", ")}]`;
}
