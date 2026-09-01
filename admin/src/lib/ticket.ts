/**
 * La cuenta de servicio: renglones, descuento, propina y total.
 *
 * Una cita no tiene *un* precio. Tiene una cuenta: el servicio que realmente se
 * hizo (que no siempre es el que se agendó), los adicionales que entraron, y de
 * vez en cuando un renglón manual para lo que no está en el catálogo. La
 * técnica es la única persona que sabe qué pasó en esa silla, así que es ella
 * quien la cierra, y de acá salen la comisión y los reportes de la dueña.
 *
 * Una sola invariante gobierna el archivo entero:
 *
 * > **`Σ line_total − discount === amount_charged`**
 *
 * No es una aserción defensiva: es la definición de qué significa una cuenta.
 * Si se rompe, el cierre de caja no cuadra, la liquidación paga mal y Actual
 * Budget recibe una cifra que no corresponde a ninguna plata que haya entrado.
 * Por eso `computeTicketTotals()` la verifica sobre su propio resultado antes
 * de devolverlo — el costo es una suma y el beneficio es que un bug futuro en
 * el prorrateo reviente acá, en una función pura y testeada, y no tres capas
 * más abajo en un reporte mensual.
 *
 * Dos cosas que viven **fuera** de esa invariante a propósito:
 *
 * - **La propina.** No es ingreso del estudio, no entra a la base de comisión y
 *   no participa del descuento. Viaja al lado del total, nunca dentro.
 * - **El descuento prorrateado.** Se reparte entre los renglones para que la
 *   comisión se calcule sobre lo efectivamente cobrado en cada uno (§ Comisiones:
 *   "quien da el descuento también se baja su comisión"). El prorrateo suma
 *   exacto al descuento total, con el mismo reparto de residuo que los combos.
 */

import { allocateByWeights } from "./combo-allocation";

import type { Cop, FinanceItemKind, VarianceReasonCode } from "@/db/types";

/** Una cuenta mal armada. Es data inválida, no un error de red ni de base. */
export class TicketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TicketError";
  }
}

/**
 * Un renglón tal como lo arma la pantalla de "Cerrar servicio", antes de que
 * este módulo le calcule nada.
 *
 * Espeja `appointment_finance_item` sin las columnas que pone la base (`id`,
 * `appointment_finance_id`, `created_at`) ni `line_total`, que es justamente lo
 * que se calcula acá.
 */
export type TicketItemInput = {
  kind: FinanceItemKind;
  eaServiceId?: number | null;
  /** Id de `src/data/pricing.ts`. Los adicionales salen de la categoría `extras`. */
  pricingId?: string | null;
  /** Cuántas veces entra el renglón. Tres uñas con diseño son `qty: 3`. */
  qty: number;
  /** Precio de lista congelado. Ver `lib/price-snapshot.ts`. */
  unitPriceSnapshot: Cop;
  /** Obligatoria para `kind: "manual"`. */
  note?: string | null;
};

/** El renglón ya valorado, con su parte del descuento. */
export type TicketLine = TicketItemInput & {
  /** `qty × unitPriceSnapshot`. Entero de pesos: el redondeo es por renglón. */
  lineTotal: Cop;
  /** La parte del descuento del ticket que le tocó a este renglón. */
  discountShare: Cop;
  /**
   * `lineTotal − discountShare`. **Es la base de comisión del renglón**, y por
   * eso este campo existe: nadie aguas abajo debería tener que volver a
   * prorratear el descuento, porque prorratearlo dos veces con dos algoritmos
   * es cómo se llega a dos liquidaciones distintas del mismo periodo.
   */
  netTotal: Cop;
};

export type TicketTotals = {
  lines: TicketLine[];
  /** `Σ line_total`, antes del descuento. */
  subtotal: Cop;
  discount: Cop;
  /** `subtotal − discount`. Lo que entra a la caja del estudio. */
  amountCharged: Cop;
  /** Aparte del ingreso y de la base de comisión, siempre. */
  tip: Cop;
  /** Lo que la clienta entrega de la mano: `amountCharged + tip`. */
  amountPaid: Cop;
};

function assertPesos(value: number, what: string): void {
  if (!Number.isSafeInteger(value)) {
    // Colombia no tiene centavos. Un `0.5` acá es un bug de conversión aguas
    // arriba, y aceptarlo dejaría el cierre del día descuadrado por un
    // redondeo que nadie pidió.
    throw new TicketError(`${what} tiene que ser un entero de pesos, y llegó ${value}`);
  }
}

/**
 * Valida un renglón y le calcula el total.
 *
 * **El signo vive en el precio unitario, no en la cantidad.** `qty` es siempre
 * ≥ 1; una corrección que resta entra como un renglón nuevo con
 * `unitPriceSnapshot` negativo. La razón es que con ambos campos con signo,
 * `qty: -2 × precio: -1000` da `+2000` — una devolución que se lee como cobro —
 * y ninguna validación local puede distinguir eso de un cobro legítimo. Con el
 * signo en un solo lado el caso no existe.
 *
 * Un renglón de precio cero sí es válido y es la salida del retoque de
 * garantía: queda contado en ocupación y en la ficha de la clienta sin cobrar.
 */
function priceLine(item: TicketItemInput, index: number): TicketLine {
  const where = `El renglón ${index}`;

  assertPesos(item.qty, `${where}: la cantidad`);
  assertPesos(item.unitPriceSnapshot, `${where}: el precio unitario`);

  if (item.qty < 1) {
    throw new TicketError(
      `${where}: la cantidad tiene que ser al menos 1, y llegó ${item.qty}. ` +
        "Una corrección que resta va con precio unitario negativo, no con cantidad negativa.",
    );
  }

  if (item.kind === "manual" && (item.note ?? "").trim() === "") {
    // Un renglón manual está fuera del catálogo: sin la nota, dentro de tres
    // meses nadie puede decir qué se cobró. Es el único campo obligatorio que
    // el flujo de la técnica impone, y se impone acá y no en la UI para que
    // valga también para el reproceso y para la corrección por API.
    throw new TicketError(`${where}: un renglón manual exige una nota que diga qué se cobró`);
  }

  const lineTotal = item.qty * item.unitPriceSnapshot;
  assertPesos(lineTotal, `${where}: el total`);

  return { ...item, lineTotal, discountShare: 0, netTotal: lineTotal };
}

/**
 * La cuenta completa.
 *
 * El descuento se reparte entre los renglones **de total positivo**. Un renglón
 * que resta (una corrección) no puede además recibir descuento: no hay nada que
 * descontar sobre un crédito, y darle una parte negativa del descuento lo
 * volvería más negativo sin que nadie lo haya pedido.
 */
export function computeTicketTotals(
  items: readonly TicketItemInput[],
  discount: Cop = 0,
  tip: Cop = 0,
): TicketTotals {
  if (items.length === 0) {
    // Una cuenta sin renglones no es una cuenta de cero: es una cuenta que no
    // se cerró. La compuerta del cierre diario cuenta con poder distinguirlas.
    throw new TicketError("Una cuenta tiene que tener al menos un renglón");
  }

  assertPesos(discount, "El descuento");
  assertPesos(tip, "La propina");

  if (discount < 0) {
    throw new TicketError(`El descuento no puede ser negativo: ${discount}`);
  }

  if (tip < 0) {
    throw new TicketError(`La propina no puede ser negativa: ${tip}`);
  }

  const lines = items.map(priceLine);
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  assertPesos(subtotal, "El subtotal");

  if (discount > subtotal) {
    // Un descuento mayor que el subtotal daría un total negativo, y eso no es
    // un descuento: es una devolución, que en la v1 no existe (§ Fuera de
    // alcance). Que reviente es más honesto que guardar un cobro negativo que
    // luego el cierre de caja tiene que interpretar.
    throw new TicketError(
      `El descuento (${discount}) es mayor que el subtotal (${subtotal})`,
    );
  }

  if (discount > 0) {
    const weights = lines.map((line) => Math.max(line.lineTotal, 0));
    const shares = allocateByWeights(discount, weights);

    for (const [index, line] of lines.entries()) {
      line.discountShare = shares[index];
      line.netTotal = line.lineTotal - shares[index];
    }
  }

  const amountCharged = subtotal - discount;
  const totals: TicketTotals = {
    lines,
    subtotal,
    discount,
    amountCharged,
    tip,
    amountPaid: amountCharged + tip,
  };

  assertTicketInvariant(totals);

  return totals;
}

/**
 * Verifica la invariante central sobre un resultado ya armado.
 *
 * Se corre siempre, sobre la salida de `computeTicketTotals()`, y está
 * exportada para que la pueda correr también quien lea una cuenta de la base —
 * una fila `appointment_finance` con sus `appointment_finance_item` tiene que
 * cumplir lo mismo, y una que no lo cumpla es una fila corrupta que hay que ver
 * en Diagnóstico y no propagar a la liquidación.
 */
export function assertTicketInvariant(totals: TicketTotals): void {
  const subtotal = totals.lines.reduce((sum, line) => sum + line.lineTotal, 0);

  if (subtotal - totals.discount !== totals.amountCharged) {
    throw new TicketError(
      `Invariante rota: Σ line_total (${subtotal}) − descuento (${totals.discount}) ` +
        `≠ amount_charged (${totals.amountCharged})`,
    );
  }

  const shared = totals.lines.reduce((sum, line) => sum + line.discountShare, 0);

  if (shared !== totals.discount) {
    throw new TicketError(
      `El prorrateo del descuento suma ${shared} y el descuento es ${totals.discount}`,
    );
  }

  const net = totals.lines.reduce((sum, line) => sum + line.netTotal, 0);

  if (net !== totals.amountCharged) {
    throw new TicketError(
      `Los renglones netos suman ${net} y el cobro es ${totals.amountCharged}`,
    );
  }
}

/**
 * La cuenta cuando la técnica **edita el total** en vez de aceptar el calculado.
 *
 * En la pantalla el total viene calculado y tocarlo lo hace editable. Lo que
 * esa edición significa en el modelo es un descuento: `subtotal − escrito`. No
 * hay una segunda forma de bajar el total que no rompa la invariante, y por eso
 * la conversión vive acá y no en el componente.
 *
 * Escribir **más** que el subtotal no se acepta. No es un descuento negativo:
 * es un renglón que falta — un adicional que no se marcó, o un renglón manual.
 * Guardarlo como total suelto dejaría plata cobrada sin ningún renglón que la
 * explique, que es exactamente lo que la cuenta con renglones vino a eliminar.
 */
export function ticketFromEnteredTotal(
  items: readonly TicketItemInput[],
  enteredAmount: Cop,
  tip: Cop = 0,
): TicketTotals {
  assertPesos(enteredAmount, "El total ingresado");

  const priced = computeTicketTotals(items, 0, tip);

  if (enteredAmount > priced.subtotal) {
    throw new TicketError(
      `El total ingresado (${enteredAmount}) supera el subtotal (${priced.subtotal}). ` +
        "Cobrar de más va como un renglón, no como un total suelto.",
    );
  }

  return computeTicketTotals(items, priced.subtotal - enteredAmount, tip);
}

/** Lo que la técnica manda al tocar "Guardar". */
export type TicketCloseInput = {
  items: readonly TicketItemInput[];
  discount?: Cop;
  tip?: Cop;
  varianceReasonCode?: VarianceReasonCode | null;
  varianceReason?: string | null;
};

/**
 * La cuenta más la regla de negocio que la acompaña: **si el total difiere del
 * calculado, se pide un motivo.**
 *
 * Vive acá y no en la pantalla porque la cuenta también se cierra por otros
 * caminos —la corrección de recepción, el reproceso— y una regla que solo
 * existe en el formulario es una regla que no rige. Sin motivo no se guarda; es
 * un campo, no una auditoría.
 *
 * El texto libre es opcional: el código de la lista corta ya clasifica, y
 * exigir además una frase escrita entre dos clientas produce "asdf", no
 * información.
 */
export function validateTicketClose(input: TicketCloseInput): TicketTotals {
  const totals = computeTicketTotals(input.items, input.discount ?? 0, input.tip ?? 0);

  if (totals.discount > 0 && !input.varianceReasonCode) {
    throw new TicketError(
      `Se cobró ${totals.discount} menos que el precio de lista y no hay motivo. ` +
        "Un descuento sin motivo no se guarda.",
    );
  }

  return totals;
}
