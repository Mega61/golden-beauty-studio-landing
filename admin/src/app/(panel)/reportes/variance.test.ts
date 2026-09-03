import { describe, expect, it } from "vitest";

import { TicketError, validateTicketClose, type TicketItemInput } from "@/lib/ticket";

import { priceVariance, type VarianceLine } from "./variance";

/**
 * **El test que ancla la definición duplicada.**
 *
 * `priceVariance()` es un espejo de la compuerta que vive adentro de
 * `validateTicketClose()` de B1, que no la exporta (ver la cabecera de
 * `variance.ts`). Mientras la duplicación exista, lo único que la hace
 * tolerable es que este archivo **no pruebe números escritos a mano**: prueba
 * que `priceVariance() > 0` exactamente cuando B1 exige un motivo.
 *
 * Si alguien cambia la compuerta de B1, el bloque "ancla" de abajo se pone rojo
 * y la divergencia se ve antes de que un reporte publique una variación que la
 * cuenta no reconoce.
 */

const asTicket = (lines: readonly VarianceLine[]): TicketItemInput[] =>
  lines.map((line) => ({
    kind: line.kind,
    qty: line.qty,
    unitPriceSnapshot: line.unitPrice,
    note: line.note ?? null,
  }));

/** ¿B1 exige motivo para esta cuenta? Se pregunta a B1, no se replica. */
function b1DemandsReason(lines: readonly VarianceLine[], amountCharged: number): boolean {
  const items = asTicket(lines);
  const subtotal = items.reduce(
    (total, item) => total + item.qty * item.unitPriceSnapshot,
    0,
  );

  try {
    validateTicketClose({
      items,
      discount: subtotal - amountCharged,
      tip: 0,
      varianceReasonCode: null,
    });
    return false;
  } catch (error) {
    if (error instanceof TicketError) return true;
    throw error;
  }
}

const SERVICIO: VarianceLine = { kind: "servicio", qty: 1, unitPrice: 115_000 };

describe("priceVariance", () => {
  it("cobrar la lista completa no es variación", () => {
    expect(priceVariance([SERVICIO], 115_000)).toBe(0);
  });

  it("cobrar menos que la lista es la diferencia", () => {
    expect(priceVariance([SERVICIO], 100_000)).toBe(15_000);
  });

  it("suma los renglones positivos, no solo el servicio", () => {
    const lines: VarianceLine[] = [
      SERVICIO,
      { kind: "adicional", qty: 3, unitPrice: 8_000 },
    ];
    expect(priceVariance(lines, 115_000 + 24_000)).toBe(0);
    expect(priceVariance(lines, 120_000)).toBe(19_000);
  });

  it("un renglón negativo es variación, no precio de lista", () => {
    // Es el criterio de B1 textual: "un renglón negativo no es trabajo, es una
    // rebaja escrita como renglón". Sin esto, agregar un renglón de −30.000 y
    // cobrar 30.000 menos daría variación cero.
    const lines: VarianceLine[] = [
      SERVICIO,
      { kind: "manual", qty: 1, unitPrice: -30_000, note: "cortesía" },
    ];
    expect(priceVariance(lines, 85_000)).toBe(30_000);
  });

  it("cobrar **más** que la lista devuelve 0, no un negativo", () => {
    // El reporte suma variaciones: un cobro por encima de la lista compensaría
    // una cortesía real y las dos desaparecerían de la vista.
    expect(priceVariance([SERVICIO], 130_000)).toBe(0);
  });

  it("una cuenta sin renglones se reporta en cero en vez de tumbar la pantalla", () => {
    // B1 lanza ante una lista vacía y hace bien: una cuenta sin renglones no se
    // cerró. Pero acá el llamador es un reporte sobre filas que ya están en la
    // base, y una fila así solo aparece si alguien la escribió por SQL. Lanzar
    // acá tumbaría los nueve reportes por una fila rota.
    expect(priceVariance([], 0)).toBe(0);
    expect(priceVariance([], 50_000)).toBe(0);
  });

  it("un renglón manual en cero no genera variación", () => {
    // Es el retoque de garantía: queda contado en ocupación y en la ficha de la
    // clienta, y no cobra. Que no aparezca como plata escapada es el punto.
    expect(
      priceVariance([{ kind: "manual", qty: 1, unitPrice: 0, note: "garantía" }], 0),
    ).toBe(0);
  });

  it("hereda las validaciones de B1 en vez de tener las suyas", () => {
    // Pasa por `computeTicketTotals`, así que el signo en la cantidad se
    // rechaza acá igual que al cerrar la cuenta.
    expect(() => priceVariance([{ kind: "servicio", qty: -2, unitPrice: 1_000 }], 0)).toThrow(
      TicketError,
    );
    expect(() => priceVariance([{ kind: "manual", qty: 1, unitPrice: 100 }], 0)).toThrow(
      TicketError,
    );
  });
});

describe("ancla contra la compuerta de B1", () => {
  const CASES: { name: string; lines: VarianceLine[]; charged: number }[] = [
    { name: "lista exacta", lines: [SERVICIO], charged: 115_000 },
    { name: "un peso menos", lines: [SERVICIO], charged: 114_999 },
    { name: "una cortesía grande", lines: [SERVICIO], charged: 80_000 },
    { name: "gratis", lines: [SERVICIO], charged: 0 },
    {
      name: "con adicionales, cobrando todo",
      lines: [SERVICIO, { kind: "adicional", qty: 3, unitPrice: 8_000 }],
      charged: 139_000,
    },
    {
      name: "con adicionales, cobrando de menos",
      lines: [SERVICIO, { kind: "adicional", qty: 3, unitPrice: 8_000 }],
      charged: 130_000,
    },
    {
      name: "rebaja escrita como renglón negativo",
      lines: [SERVICIO, { kind: "manual", qty: 1, unitPrice: -15_000, note: "rebaja" }],
      charged: 100_000,
    },
    {
      name: "renglón manual en cero, cuenta gratis coherente",
      lines: [{ kind: "manual", qty: 1, unitPrice: 0, note: "garantía" }],
      charged: 0,
    },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name}: variación > 0 ⟺ B1 pide motivo`, () => {
      const variance = priceVariance(testCase.lines, testCase.charged);
      expect(variance > 0, `variación ${variance}`).toBe(
        b1DemandsReason(testCase.lines, testCase.charged),
      );
    });
  }

  it("y el monto coincide con lo que dice el mensaje de error de B1", () => {
    // El mensaje de B1 lleva la cifra: "Se cobró X menos que el precio de
    // lista". Comparar contra ella es lo más cerca que se puede estar de leer
    // la definición de B1 sin que B1 la exporte.
    const lines = [SERVICIO, { kind: "adicional" as const, qty: 2, unitPrice: 8_000 }];
    const charged = 100_000;

    let message = "";
    try {
      validateTicketClose({
        items: asTicket(lines),
        discount: 131_000 - charged,
        varianceReasonCode: null,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain(String(priceVariance(lines, charged)));
  });
});
