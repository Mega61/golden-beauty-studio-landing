/**
 * La variación de precio de una cuenta: cuánto se cobró **por debajo** del
 * precio de lista.
 *
 * ## Esto pertenece a `lib/ticket.ts` (B1), no acá
 *
 * La definición ya existe y es de B1. Vive **adentro** de
 * `validateTicketClose()`, que no la exporta:
 *
 * ```ts
 * const listTotal = totals.lines.reduce(
 *   (sum, line) => (line.lineTotal > 0 ? sum + line.lineTotal : sum), 0);
 * const belowList = listTotal - totals.amountCharged;
 * ```
 *
 * Es la compuerta que impide cerrar una cuenta que cobró menos que la lista sin
 * dar motivo, y `gbs-money-auditor` la corrigió una vez (H5) precisamente
 * porque mirar solo el campo `discount` dejaba dos formas de bajar el total sin
 * que nadie se enterara: escribir un total menor a mano, y agregar un renglón
 * negativo.
 *
 * El reporte "variación de precio por técnica, desglosada por motivo" necesita
 * ese mismo número para cada cuenta ya cerrada. **Lo pedí exportado de B1 y no
 * lo está**, así que está acá — y acá está *mal*: dos definiciones de
 * "variación" en dos archivos es exactamente lo que se separa en silencio a los
 * tres meses. Lo que corresponde es exportar `priceVariance()` desde
 * `lib/ticket.ts` y que este archivo desaparezca.
 *
 * ## Mientras eso pase, hay un ancla
 *
 * `variance.test.ts` no prueba esta función contra números escritos a mano: la
 * prueba **contra `validateTicketClose()` de B1**, afirmando que devuelve un
 * valor positivo exactamente cuando B1 exige un motivo. Si alguien cambia la
 * compuerta de B1, este test se pone rojo — que es lo único que hace tolerable
 * tener la definición duplicada mientras dure.
 */

import { computeTicketTotals, type TicketItemInput } from "@/lib/ticket";
import type { Cop } from "@/db/types";

/** Lo mínimo que hace falta de un renglón para valorarlo. */
export type VarianceLine = {
  kind: TicketItemInput["kind"];
  qty: number;
  unitPrice: Cop;
  note?: string | null;
};

/**
 * `precio de lista − cobrado`, en pesos.
 *
 * Positivo = se cobró menos que la lista, que es "la plata que se escapó".
 * Cero o negativo = no hubo variación a la baja; se devuelve **0** y no un
 * número negativo, porque el reporte suma variaciones y un cobro por encima de
 * la lista (una corrección al alza, un renglón manual) compensaría una cortesía
 * real y las dos desaparecerían de la vista.
 *
 * El precio de lista es la suma de los renglones **positivos**: el trabajo que
 * se hizo, a la tarifa del catálogo. Un renglón negativo no es trabajo, es una
 * rebaja escrita como renglón, y queda del lado de la variación. Es
 * literalmente el criterio de B1.
 */
export function priceVariance(
  items: readonly VarianceLine[],
  amountCharged: Cop,
): Cop {
  // **Una cuenta sin renglones se reporta como sin variación, no revienta.**
  //
  // `computeTicketTotals()` lanza ante una lista vacía, y hace bien: "una
  // cuenta sin renglones no es una cuenta de cero, es una cuenta que no se
  // cerró", y la compuerta del cierre diario necesita esa distinción. Pero acá
  // el llamador es un reporte sobre filas que **ya** están en la base, y una
  // fila así solo aparece si alguien la escribió por SQL. Lanzar en medio de la
  // agregación tumbaría la pantalla entera —los nueve reportes— por una fila
  // rota. Se devuelve 0 y la anomalía se ve donde corresponde: en Diagnóstico.
  if (items.length === 0) return 0;

  // Se pasa por `computeTicketTotals` de B1 en vez de multiplicar acá: es lo
  // que valida el signo del renglón (`qty ≥ 1` siempre) y lo que garantiza que
  // "renglón positivo" signifique lo mismo en los dos lados.
  const totals = computeTicketTotals(
    items.map((item) => ({
      kind: item.kind,
      qty: item.qty,
      unitPriceSnapshot: item.unitPrice,
      note: item.note ?? null,
    })),
    0,
    0,
  );

  const listTotal = totals.lines.reduce(
    (sum, line) => (line.lineTotal > 0 ? sum + line.lineTotal : sum),
    0,
  );

  return Math.max(0, listTotal - amountCharged);
}
