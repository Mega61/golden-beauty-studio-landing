/**
 * Reparto exacto de una cifra de plata entre partes.
 *
 * Dos usos, un solo algoritmo:
 *
 * 1. **El combo.** Un combo es *un* servicio de EA con precio propio, fijado a
 *    mano y menor que la suma de sus partes. Para que los reportes puedan
 *    seguir atribuyendo ingreso a los servicios de manos y de pies subyacentes
 *    hay que partir ese precio, y la fila `combo` dice en qué proporción
 *    (`allocation_hands_bp`).
 * 2. **El prorrateo del descuento del ticket** entre los renglones, que
 *    `lib/ticket.ts` importa de acá. El plan los describe como el mismo
 *    problema ("el peso de residuo se asigna de forma determinista, igual que
 *    en el reparto de combos") y por eso es el mismo código: dos
 *    implementaciones del mismo reparto son dos oportunidades de que una sume
 *    distinto que la otra.
 *
 * La regla que gobierna todo el archivo:
 *
 * > **Las partes suman exacto al total. Siempre. Sin excepción.**
 *
 * Colombia no tiene centavos, así que cada parte es un entero de pesos y el
 * reparto casi nunca cae redondo. Los pesos de residuo no se pueden perder (el
 * ingreso atribuido daría menos que el ingreso cobrado) ni duplicar (daría
 * más), y con dos llamadas iguales tienen que caer en el mismo lado, o dos
 * corridas del mismo reporte darían números distintos.
 *
 * El método es el de **mayores residuos** (Hamilton): a cada parte le toca el
 * piso de su cuota exacta, y los pesos que sobran se reparten de a uno entre
 * las partes de mayor residuo fraccionario, desempatando por índice. Toda la
 * aritmética es entera — nada de `0.1 + 0.2` decidiendo a quién le toca un
 * peso.
 */

import type { BasisPoints, Cop } from "@/db/types";

/** 100 % expresado en puntos básicos. Ver la convención 2 de `db/types.ts`. */
export const FULL_BASIS_POINTS = 10_000;

/** Datos que no permiten un reparto exacto. Es un error de programación. */
export class AllocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationError";
  }
}

function assertSafeInteger(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new AllocationError(`${what} tiene que ser un entero seguro, y llegó ${value}`);
  }
}

/**
 * Reparte `amount` entre partes con los pesos dados.
 *
 * Los pesos son enteros no negativos en cualquier unidad — puntos básicos para
 * el combo, pesos de renglón para el descuento. No hace falta que sumen nada en
 * particular; lo que importa es la proporción.
 *
 * `amount` puede ser negativo: una corrección posterior al cierre entra como
 * renglón nuevo, y ese renglón puede restar. El reparto sigue sumando exacto —
 * el piso es hacia −∞ y el residuo sigue cayendo en `[0, n)`.
 *
 * Con todos los pesos en cero el reparto es indefinido y **lanza** en vez de
 * devolver ceros: repartir 100.000 pesos entre partes sin peso no es un caso de
 * borde con respuesta razonable, es un llamado mal armado, y devolver ceros
 * haría desaparecer plata en silencio. La única excepción es `amount = 0`, que
 * reparte ceros porque no hay nada que perder.
 */
export function allocateByWeights(amount: Cop, weights: readonly number[]): Cop[] {
  assertSafeInteger(amount, "El monto a repartir");

  if (weights.length === 0) {
    throw new AllocationError("No hay partes entre las cuales repartir");
  }

  let totalWeight = 0;

  for (const [index, weight] of weights.entries()) {
    assertSafeInteger(weight, `El peso de la parte ${index}`);

    if (weight < 0) {
      throw new AllocationError(`El peso de la parte ${index} es negativo: ${weight}`);
    }

    totalWeight += weight;
  }

  if (amount === 0) {
    return weights.map(() => 0);
  }

  if (totalWeight === 0) {
    throw new AllocationError(
      `No se puede repartir ${amount} entre partes cuyos pesos suman cero`,
    );
  }

  // **El reparto es simétrico respecto del signo: repartir −a es repartir a
  // con el signo cambiado.**
  //
  // Antes no lo era. El residuo se asignaba "mayor residuo, desempate por
  // índice ascendente" en los dos sentidos, así que un combo de precio impar
  // repartido 50/50 daba `{47501, 47500}` al cobrar y `{−47500, −47501}` al
  // corregir: el total cancelaba, pero **quedaba +1 peso pegado a manos y −1 a
  // pies, para siempre y sin marca**. Con `allocateByWeights` compartido por el
  // prorrateo del ticket, el reparto del combo y la comisión entre dos
  // técnicas, el mismo peso fantasma aparecía en tres reportes distintos.
  //
  // Se resuelve repartiendo siempre el valor absoluto y devolviéndole el signo
  // al final, que es también lo que elimina el `-0` que `Math.floor(-0/W)`
  // producía y que se colaba hasta `commission_entry` — `roundPesos()` ya lo
  // atajaba, pero la salida de esta función no pasa por ahí.
  //
  // Encontrado por `gbs-money-auditor` (H1 y H1b).
  const sign = amount < 0 ? -1 : 1;
  const magnitude = Math.abs(amount);

  // Cuota exacta de cada parte = magnitude * weight / totalWeight, en
  // aritmética entera: `floor` da el entero, y `numerador − floor * totalWeight`
  // da el residuo sin tocar un solo float. Con el monto ya en positivo, el
  // residuo cae en `[0, n)` por construcción.
  const shares: Cop[] = [];
  const remainders: number[] = [];
  let assigned = 0;

  for (const weight of weights) {
    const numerator = magnitude * weight;
    assertSafeInteger(numerator, "El producto monto × peso");

    const share = Math.floor(numerator / totalWeight);

    shares.push(share);
    remainders.push(numerator - share * totalWeight);
    assigned += share;
  }

  // Cuántos pesos quedaron sin repartir. Por construcción está en `[0, n)`.
  const leftover = magnitude - assigned;

  // Se reparten de a uno entre las partes de mayor residuo. El desempate por
  // índice ascendente es lo que hace el resultado reproducible: sin él, dos
  // partes con el mismo residuo dependerían del orden en que el motor de JS
  // decidiera ordenarlas.
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => (b.remainder - a.remainder) || (a.index - b.index));

  for (let i = 0; i < leftover; i += 1) {
    shares[order[i].index] += 1;
  }

  // El signo se devuelve al final. `sign * 0` es `0` cuando `sign` es 1 y `-0`
  // cuando es −1, así que las partes en cero se dejan explícitamente en `+0`:
  // un `-0` en una fila de `commission_entry` o en un reporte es un valor que
  // se imprime distinto y compara igual, que es la peor combinación posible.
  return shares.map((share) => (share === 0 ? 0 : sign * share));
}

/** Las dos mitades de un combo, ya en pesos enteros. */
export type ComboAllocation = {
  hands: Cop;
  feet: Cop;
};

/**
 * Parte el precio de un combo entre manos y pies.
 *
 * `allocationHandsBp` viene de la fila `combo` y es criterio de la dueña, no
 * una fórmula: el precio del combo ya es menor que la suma de las partes, así
 * que ninguna proporción "natural" se puede deducir de los precios de lista.
 *
 * `hands + feet === price`, exacto, para cualquier precio y cualquier
 * proporción. Es la invariante que este módulo existe para sostener.
 */
export function allocateCombo(price: Cop, allocationHandsBp: BasisPoints): ComboAllocation {
  assertSafeInteger(allocationHandsBp, "La proporción de manos");

  if (allocationHandsBp < 0 || allocationHandsBp > FULL_BASIS_POINTS) {
    throw new AllocationError(
      `La proporción de manos está fuera de 0–${FULL_BASIS_POINTS} bp: ${allocationHandsBp}`,
    );
  }

  // Con precio cero `allocateByWeights` devuelve ceros sin mirar los pesos, así
  // que una proporción de 0 bp (todo pies) tampoco necesita caso especial acá.
  const [hands, feet] = allocateByWeights(price, [
    allocationHandsBp,
    FULL_BASIS_POINTS - allocationHandsBp,
  ]);

  return { hands, feet };
}
