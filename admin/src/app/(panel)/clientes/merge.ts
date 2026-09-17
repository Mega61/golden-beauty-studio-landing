/**
 * Fusionar las filas de EA que resultaron ser la misma clienta.
 *
 * `identity.ts` ya las junta **al leer**: la ficha muestra una sola persona
 * aunque EA tenga tres filas con el mismo teléfono. Eso resuelve la pantalla y
 * no resuelve la agenda — al agendar hay que elegir una de las tres, la clienta
 * que llama aparece tres veces en el buscador de EA, y su historia queda
 * repartida. Fusionar de verdad es mover las citas a una sola fila y borrar las
 * otras.
 *
 * Es la operación más destructiva del panel, así que el orden no es negociable:
 *
 * ```text
 *   1. mover las citas de las perdedoras a la superviviente
 *   2. verificar que se movieron
 *   3. recién ahí borrar las perdedoras
 * ```
 *
 * Si (1) falla a la mitad, no se borra nada: quedan citas repartidas, que es el
 * estado que ya había. Si (3) falla, queda una fila de clienta sin citas, que la
 * fusión al leer sigue mostrando como una sola persona. **Ningún orden posible
 * de fallas pierde una cita**, y ésa es la única propiedad que importa acá.
 */

import type { Customer } from "@/lib/ea";

import { displayName } from "./identity";

export type MergePlan = {
  /** La fila que sobrevive. */
  survivor: Customer;
  /** Las que se borran, después de moverles las citas. */
  losers: Customer[];
  /**
   * Campos que la superviviente **no** tenía y alguna perdedora sí. Se le
   * copian antes de borrar: si la fila vieja tiene el correo y la nueva no,
   * fusionar sin esto perdería el correo para siempre.
   */
  enrich: Partial<Pick<Customer, "email" | "phone" | "notes" | "firstName" | "lastName">>;
};

export type MergeBlocker = "una-sola" | "sin-filas";

/**
 * Quién sobrevive, quién se borra, y qué hay que copiarle antes.
 *
 * ## Sobrevive el id más bajo
 *
 * Es el más viejo, y por lo tanto el más probable de estar referenciado en algo
 * que este panel no ve — un evento de Google creado hace meses, un enlace que
 * alguien guardó. Elegir "el más completo" sonaría mejor y sería inestable:
 * dos corridas podrían elegir distinto según qué campo se llenó primero.
 *
 * ## Y no se pierde nada del resto
 *
 * Lo que las perdedoras tengan y la superviviente no, se copia. El criterio es
 * "el primer valor no vacío, en orden de id" — no el más largo ni el más nuevo:
 * cualquier regla más lista es una regla que hay que explicar, y acá lo que
 * importa es que **ningún dato desaparezca**, no cuál gana.
 *
 * El teléfono entra en la lista por un caso real: una fila vieja sin teléfono
 * (creada por el flujo público antes de pedirlo) puede tener el id más bajo y
 * ser la superviviente.
 */
export function planMerge(customers: readonly Customer[]): MergePlan | { blocker: MergeBlocker } {
  if (customers.length === 0) return { blocker: "sin-filas" };
  if (customers.length === 1) return { blocker: "una-sola" };

  const sorted = [...customers].sort((a, b) => a.id - b.id);
  const [survivor, ...losers] = sorted;

  const enrich: MergePlan["enrich"] = {};

  for (const field of ["email", "phone", "notes", "firstName", "lastName"] as const) {
    if (nonEmpty(survivor[field])) continue;
    const donor = losers.find((loser) => nonEmpty(loser[field]));
    if (donor) enrich[field] = donor[field];
  }

  return { survivor, losers, enrich };
}

function nonEmpty(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/** Cómo se describe la fusión antes de hacerla. Es lo que se confirma. */
export function describeMerge(plan: MergePlan): string {
  const name = displayName(plan.survivor) || `#${plan.survivor.id}`;
  const ids = plan.losers.map((loser) => `#${loser.id}`).join(", ");
  const campos = Object.keys(plan.enrich);

  const base =
    `Se queda ${name} (#${plan.survivor.id}) y se borran ${ids}. ` +
    `Sus citas se mueven antes de borrar nada.`;

  return campos.length === 0 ? base : `${base} Se le copian: ${campos.join(", ")}.`;
}
