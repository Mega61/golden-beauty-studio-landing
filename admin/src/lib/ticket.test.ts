import { describe, expect, it } from "vitest";

import {
  TicketError,
  assertTicketInvariant,
  computeTicketTotals,
  priceVariance,
  ticketFromEnteredTotal,
  validateTicketClose,
  type TicketItemInput,
  type TicketTotals,
} from "./ticket";

/**
 * Precios reales de `src/data/pricing.ts`, no inventados: si un día el
 * prorrateo se rompe justo con las cifras del catálogo, este archivo tiene que
 * verlo.
 */
const ACRYLIC_SCULPTED = 115_000;
const DESIGN_PER_NAIL = 10_000;
const SYSTEM_REMOVAL = 20_000;

const servicio = (unitPriceSnapshot: number, qty = 1): TicketItemInput => ({
  kind: "servicio",
  eaServiceId: 6,
  pricingId: "acrylic-sculpted",
  qty,
  unitPriceSnapshot,
});

const adicional = (unitPriceSnapshot: number, qty = 1): TicketItemInput => ({
  kind: "adicional",
  eaServiceId: null,
  pricingId: "design-per-nail",
  qty,
  unitPriceSnapshot,
});

describe("computeTicketTotals — la invariante central", () => {
  it("Σ line_total − discount === amount_charged, sin descuento", () => {
    const totals = computeTicketTotals([servicio(ACRYLIC_SCULPTED), adicional(DESIGN_PER_NAIL, 3)]);

    expect(totals.subtotal).toBe(145_000);
    expect(totals.discount).toBe(0);
    expect(totals.amountCharged).toBe(145_000);
    expect(totals.lines.map((l) => l.lineTotal)).toEqual([115_000, 30_000]);
    expect(totals.lines.map((l) => l.netTotal)).toEqual([115_000, 30_000]);
  });

  it("y con descuento", () => {
    const totals = computeTicketTotals(
      [servicio(ACRYLIC_SCULPTED), adicional(DESIGN_PER_NAIL, 3)],
      15_000,
    );

    expect(totals.amountCharged).toBe(130_000);
    expect(totals.lines.reduce((sum, l) => sum + l.discountShare, 0)).toBe(15_000);
    expect(totals.lines.reduce((sum, l) => sum + l.netTotal, 0)).toBe(130_000);
  });

  it("se sostiene sobre cientos de combinaciones de renglones y descuentos", () => {
    // El modo de falla real no es "el ejemplo del manual da mal": es una
    // combinación rara donde el prorrateo pierde un peso. Se busca a propósito.
    for (const precios of [
      [115_000],
      [115_000, 10_000],
      [7, 11, 13],
      [1, 1, 1],
      [100_000, 10_000, 10_000, 10_000],
      [33_333, 33_333, 33_334],
    ]) {
      const items = precios.map((p) => servicio(p));
      const subtotal = precios.reduce((a, b) => a + b, 0);

      for (let discount = 0; discount <= subtotal; discount += Math.max(1, Math.floor(subtotal / 37))) {
        const totals = computeTicketTotals(items, discount, 5_000);

        expect(totals.amountCharged).toBe(subtotal - discount);
        expect(totals.lines.reduce((s, l) => s + l.discountShare, 0)).toBe(discount);
        expect(totals.lines.reduce((s, l) => s + l.netTotal, 0)).toBe(totals.amountCharged);
        // La propina jamás toca ninguna de las tres cifras de arriba.
        expect(totals.tip).toBe(5_000);
        expect(totals.amountPaid).toBe(totals.amountCharged + 5_000);
      }
    }
  });

  it("un descuento del subtotal completo deja el cobro en cero", () => {
    const totals = computeTicketTotals([servicio(50_000)], 50_000);

    expect(totals.amountCharged).toBe(0);
    expect(totals.lines[0].netTotal).toBe(0);
  });
});

describe("computeTicketTotals — la propina vive afuera", () => {
  it("no entra al subtotal, ni al cobro, ni a la base de comisión", () => {
    const sinPropina = computeTicketTotals([servicio(100_000)], 0, 0);
    const conPropina = computeTicketTotals([servicio(100_000)], 0, 50_000);

    expect(conPropina.subtotal).toBe(sinPropina.subtotal);
    expect(conPropina.amountCharged).toBe(sinPropina.amountCharged);
    expect(conPropina.lines[0].netTotal).toBe(sinPropina.lines[0].netTotal);

    // Lo único que cambia es lo que la clienta entrega de la mano.
    expect(conPropina.amountPaid).toBe(150_000);
  });

  it("no participa del prorrateo del descuento", () => {
    const totals = computeTicketTotals([servicio(60_000), servicio(40_000)], 10_000, 20_000);

    expect(totals.lines.map((l) => l.discountShare)).toEqual([6_000, 4_000]);
  });

  it("rechaza una propina negativa", () => {
    expect(() => computeTicketTotals([servicio(1_000)], 0, -1)).toThrow(/propina/);
  });
});

describe("computeTicketTotals — prorrateo del descuento", () => {
  it("reparte en proporción al renglón", () => {
    const totals = computeTicketTotals([servicio(80_000), adicional(20_000)], 10_000);

    expect(totals.lines.map((l) => l.discountShare)).toEqual([8_000, 2_000]);
    expect(totals.lines.map((l) => l.netTotal)).toEqual([72_000, 18_000]);
  });

  it("el peso de residuo cae de forma determinista y no se pierde", () => {
    // 1 peso de descuento sobre tres renglones iguales: no hay forma de
    // repartirlo en tercios. Cae completo en uno, y siempre en el mismo.
    const totals = computeTicketTotals([servicio(10_000), servicio(10_000), servicio(10_000)], 1);

    expect(totals.lines.map((l) => l.discountShare)).toEqual([1, 0, 0]);
    expect(totals.lines.reduce((s, l) => s + l.discountShare, 0)).toBe(1);
  });

  it("un renglón que resta no recibe descuento", () => {
    // Corrección: se devolvió un adicional. El descuento del ticket se prorratea
    // solo entre lo que suma — descontar sobre un crédito lo volvería más
    // negativo sin que nadie lo haya pedido.
    const items: TicketItemInput[] = [
      servicio(100_000),
      { kind: "manual", qty: 1, unitPriceSnapshot: -10_000, note: "uña repuesta sin cobro" },
    ];

    const totals = computeTicketTotals(items, 9_000);

    expect(totals.subtotal).toBe(90_000);
    expect(totals.amountCharged).toBe(81_000);
    expect(totals.lines.map((l) => l.discountShare)).toEqual([9_000, 0]);
    expect(totals.lines.map((l) => l.netTotal)).toEqual([91_000, -10_000]);
  });

  it("un renglón en cero no recibe descuento y sigue contando como renglón", () => {
    // El retoque de garantía: queda en la cuenta, en la ficha de la clienta y
    // en ocupación, sin cobrar.
    const items: TicketItemInput[] = [
      servicio(100_000),
      { kind: "manual", qty: 1, unitPriceSnapshot: 0, note: "retoque de garantía" },
    ];

    const totals = computeTicketTotals(items, 10_000);

    expect(totals.lines).toHaveLength(2);
    expect(totals.lines[1].discountShare).toBe(0);
    expect(totals.lines[1].netTotal).toBe(0);
  });
});

describe("computeTicketTotals — lo que no se acepta", () => {
  it("una cuenta sin renglones no es una cuenta de cero", () => {
    expect(() => computeTicketTotals([])).toThrow(/al menos un renglón/);
  });

  it("un descuento mayor que el subtotal", () => {
    expect(() => computeTicketTotals([servicio(50_000)], 50_001)).toThrow(/mayor que el subtotal/);
  });

  it("un descuento negativo", () => {
    expect(() => computeTicketTotals([servicio(50_000)], -1)).toThrow(/no puede ser negativo/);
  });

  it("un renglón manual sin nota", () => {
    expect(() =>
      computeTicketTotals([{ kind: "manual", qty: 1, unitPriceSnapshot: 5_000 }]),
    ).toThrow(/exige una nota/);

    expect(() =>
      computeTicketTotals([{ kind: "manual", qty: 1, unitPriceSnapshot: 5_000, note: "   " }]),
    ).toThrow(/exige una nota/);

    expect(() =>
      computeTicketTotals([{ kind: "manual", qty: 1, unitPriceSnapshot: 5_000, note: null }]),
    ).toThrow(/exige una nota/);
  });

  it("un renglón manual CON nota sí pasa", () => {
    const totals = computeTicketTotals([
      { kind: "manual", qty: 1, unitPriceSnapshot: 5_000, note: "esmaltado de un pie" },
    ]);

    expect(totals.amountCharged).toBe(5_000);
  });

  it("una cantidad en cero o negativa", () => {
    // El signo vive en el precio unitario, no en la cantidad: con los dos con
    // signo, qty −2 × precio −1000 daría +2000 y una devolución se leería como
    // cobro.
    expect(() => computeTicketTotals([servicio(1_000, 0)])).toThrow(/al menos 1/);
    expect(() => computeTicketTotals([servicio(1_000, -2)])).toThrow(/al menos 1/);
  });

  it("centavos en cualquier campo", () => {
    expect(() => computeTicketTotals([servicio(1_000.5)])).toThrow(/entero de pesos/);
    expect(() => computeTicketTotals([servicio(1_000, 1.5)])).toThrow(/entero de pesos/);
    expect(() => computeTicketTotals([servicio(1_000)], 0.5)).toThrow(/entero de pesos/);
    expect(() => computeTicketTotals([servicio(1_000)], 0, 0.5)).toThrow(/entero de pesos/);
  });

  it("un renglón cuyo total se sale del entero seguro", () => {
    expect(() =>
      computeTicketTotals([servicio(Number.MAX_SAFE_INTEGER, 2)]),
    ).toThrow(/el total/);
  });

  it("un subtotal que se sale del entero seguro", () => {
    const enorme = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 10;
    expect(() => computeTicketTotals([servicio(enorme), servicio(enorme)])).toThrow(/subtotal/);
  });
});

describe("assertTicketInvariant", () => {
  const sano = computeTicketTotals([servicio(100_000), adicional(20_000)], 12_000);

  it("acepta un resultado sano", () => {
    expect(() => assertTicketInvariant(sano)).not.toThrow();
  });

  it("caza un amount_charged manipulado", () => {
    // El caso real que esto protege: una fila leída de la base cuyos renglones
    // no cuadran con su encabezado. Se ve en Diagnóstico en vez de propagarse a
    // la liquidación.
    const roto: TicketTotals = { ...sano, amountCharged: sano.amountCharged + 1 };
    expect(() => assertTicketInvariant(roto)).toThrow(/Invariante rota/);
  });

  it("caza un prorrateo que no suma al descuento", () => {
    const roto: TicketTotals = {
      ...sano,
      lines: sano.lines.map((l, i) => (i === 0 ? { ...l, discountShare: l.discountShare + 1 } : l)),
    };

    expect(() => assertTicketInvariant(roto)).toThrow(/prorrateo del descuento suma/);
  });

  it("caza renglones netos que no suman al cobro", () => {
    const roto: TicketTotals = {
      ...sano,
      lines: sano.lines.map((l, i) => (i === 0 ? { ...l, netTotal: l.netTotal + 1 } : l)),
    };

    expect(() => assertTicketInvariant(roto)).toThrow(/renglones netos suman/);
  });
});

describe("ticketFromEnteredTotal — la técnica edita el total", () => {
  it("un total menor se guarda como descuento, con su motivo", () => {
    // El motivo dejó de ser opcional en este camino: bajar el total escribiendo
    // menos es exactamente la variación que § Independencia con rastro exige
    // justificar, y antes era el único camino que se la saltaba (H5).
    const totals = ticketFromEnteredTotal(
      [servicio(115_000), adicional(DESIGN_PER_NAIL, 3)],
      130_000,
      0,
      { varianceReasonCode: "cortesia" },
    );

    expect(totals.subtotal).toBe(145_000);
    expect(totals.discount).toBe(15_000);
    expect(totals.amountCharged).toBe(130_000);
    expect(totals.lines.reduce((s, l) => s + l.discountShare, 0)).toBe(15_000);
  });

  it("el total calculado tal cual no genera descuento", () => {
    const totals = ticketFromEnteredTotal([servicio(115_000)], 115_000, 10_000);

    expect(totals.discount).toBe(0);
    expect(totals.tip).toBe(10_000);
  });

  it("un total mayor que el subtotal no se acepta", () => {
    // Cobrar de más es un renglón que falta, no un descuento negativo. Dejarlo
    // pasar guardaría plata cobrada sin ningún renglón que la explique.
    expect(() => ticketFromEnteredTotal([servicio(100_000)], 120_000)).toThrow(/supera el subtotal/);
  });

  it("rechaza centavos en el total ingresado", () => {
    expect(() => ticketFromEnteredTotal([servicio(100_000)], 99_999.5)).toThrow(/entero de pesos/);
  });
});

describe("validateTicketClose — sin motivo no se guarda", () => {
  it("un descuento sin código de motivo no pasa", () => {
    expect(() =>
      validateTicketClose({ items: [servicio(100_000)], discount: 10_000 }),
    ).toThrow(/no hay motivo/);
  });

  it("con código de motivo sí", () => {
    const totals = validateTicketClose({
      items: [servicio(100_000)],
      discount: 10_000,
      varianceReasonCode: "cortesia",
      varianceReason: "clienta de la casa",
    });

    expect(totals.amountCharged).toBe(90_000);
  });

  it("el texto libre es opcional: el código ya clasifica", () => {
    expect(() =>
      validateTicketClose({
        items: [servicio(100_000)],
        discount: 10_000,
        varianceReasonCode: "cambio_servicio",
      }),
    ).not.toThrow();
  });

  it("sin descuento no se pide nada", () => {
    const totals = validateTicketClose({ items: [servicio(100_000)] });

    expect(totals.discount).toBe(0);
    expect(totals.tip).toBe(0);
  });

  it("un código en null cuenta como no haber puesto motivo", () => {
    expect(() =>
      validateTicketClose({
        items: [servicio(100_000)],
        discount: 1,
        varianceReasonCode: null,
      }),
    ).toThrow(TicketError);
  });
});

describe("el caso que el plan pone como prueba de fuego", () => {
  it("agendado press-on, realizado forrado de acrílico + 3 diseños, con motivo", () => {
    // La cita se reservó como press-on ($100.000) y la clienta terminó pidiendo
    // un forrado de acrílico ($85.000) con diseño en tres uñas ($10.000 c/u).
    // La cuenta habla de lo REALIZADO; lo agendado vive en el encabezado y no
    // toca ni un peso de acá.
    const totals = validateTicketClose({
      items: [
        {
          kind: "servicio",
          eaServiceId: 12,
          pricingId: "acrylic-overlay",
          qty: 1,
          unitPriceSnapshot: 85_000,
        },
        {
          kind: "adicional",
          pricingId: "design-per-nail",
          qty: 3,
          unitPriceSnapshot: DESIGN_PER_NAIL,
        },
        {
          kind: "adicional",
          pricingId: "system-removal",
          qty: 1,
          unitPriceSnapshot: SYSTEM_REMOVAL,
        },
      ],
      discount: 5_000,
      tip: 10_000,
      varianceReasonCode: "cambio_servicio",
      varianceReason: "se reservó press-on y pidió forrado",
    });

    expect(totals.subtotal).toBe(135_000);
    expect(totals.amountCharged).toBe(130_000);
    expect(totals.amountPaid).toBe(140_000);

    // El descuento se reparte en proporción, y suma exacto.
    expect(totals.lines.map((l) => l.discountShare)).toEqual([3_148, 1_111, 741]);
    expect(totals.lines.reduce((s, l) => s + l.discountShare, 0)).toBe(5_000);
    expect(totals.lines.reduce((s, l) => s + l.netTotal, 0)).toBe(130_000);
  });
});

// ── La variación de precio ──────────────────────────────────────────────────

/**
 * Un renglón como lo describe el reporte de variación: `kind`, cantidad,
 * precio unitario y —si es manual— la nota.
 */
const linea = (
  kind: TicketItemInput["kind"],
  qty: number,
  unitPrice: number,
  note?: string,
): TicketItemInput => ({ kind, qty, unitPriceSnapshot: unitPrice, note: note ?? null });

const SERVICIO = linea("servicio", 1, ACRYLIC_SCULPTED);

describe("priceVariance", () => {
  it("cobrar la lista completa no es variación", () => {
    expect(priceVariance([SERVICIO], 115_000)).toBe(0);
  });

  it("cobrar menos que la lista es la diferencia", () => {
    expect(priceVariance([SERVICIO], 100_000)).toBe(15_000);
  });

  it("suma los renglones positivos, no solo el servicio", () => {
    const lines = [SERVICIO, linea("adicional", 3, 8_000)];
    expect(priceVariance(lines, 115_000 + 24_000)).toBe(0);
    expect(priceVariance(lines, 120_000)).toBe(19_000);
  });

  it("un renglón negativo es variación, no precio de lista", () => {
    // "Un renglón negativo no es trabajo, es una rebaja escrita como renglón".
    // Sin esto, agregar un renglón de −30.000 y cobrar 30.000 menos daría
    // variación cero.
    const lines = [SERVICIO, linea("manual", 1, -30_000, "cortesía")];
    expect(priceVariance(lines, 85_000)).toBe(30_000);
  });

  it("cobrar **más** que la lista devuelve 0, no un negativo", () => {
    // El reporte suma variaciones: un cobro por encima de la lista compensaría
    // una cortesía real y las dos desaparecerían de la vista.
    expect(priceVariance([SERVICIO], 130_000)).toBe(0);
  });

  it("una cuenta sin renglones se reporta en cero en vez de tumbar la pantalla", () => {
    // `computeTicketTotals` lanza ante una lista vacía y hace bien: una cuenta
    // sin renglones no se cerró. Pero el llamador del reporte lee filas que ya
    // están en la base, y una fila así solo aparece si alguien la escribió por
    // SQL. Lanzar ahí tumbaría los nueve reportes por una fila rota.
    expect(priceVariance([], 0)).toBe(0);
    expect(priceVariance([], 50_000)).toBe(0);
  });

  it("un renglón manual en cero no genera variación", () => {
    // Es el retoque de garantía: queda contado en ocupación y en la ficha de la
    // clienta, y no cobra. Que no aparezca como plata escapada es el punto.
    expect(priceVariance([linea("manual", 1, 0, "garantía")], 0)).toBe(0);
  });

  it("hereda las validaciones del cálculo en vez de tener las suyas", () => {
    // Pasa por `computeTicketTotals`, así que el signo en la cantidad se
    // rechaza acá igual que al cerrar la cuenta, y un renglón manual sin nota
    // también.
    expect(() => priceVariance([linea("servicio", -2, 1_000)], 0)).toThrow(TicketError);
    expect(() => priceVariance([linea("manual", 1, 100)], 0)).toThrow(TicketError);
  });
});

/**
 * **El test que anclaba la definición duplicada, ahora sobre una sola.**
 *
 * `priceVariance()` fue un espejo de la compuerta que vive adentro de
 * `validateTicketClose()`, en `(panel)/reportes/variance.ts`. Lo único que
 * hacía tolerable esa copia era que su test **no probaba números escritos a
 * mano**: probaba que `priceVariance() > 0` exactamente cuando la compuerta
 * exige un motivo.
 *
 * La copia ya no existe —la compuerta llama a esta función— así que este bloque
 * pasó de detectar una divergencia a fijar la relación: si alguien cambia la
 * compuerta para que pida motivo por otra razón (el campo `discount`, un
 * umbral), esto se pone rojo, y el reporte de variación no publica una cifra
 * que la cuenta no reconoce.
 */
describe("ancla: variación > 0 ⟺ la compuerta pide motivo", () => {
  /** ¿La compuerta exige motivo para esta cuenta? Se le pregunta, no se replica. */
  function demandsReason(items: readonly TicketItemInput[], amountCharged: number): boolean {
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

  const CASES: { name: string; lines: TicketItemInput[]; charged: number }[] = [
    { name: "lista exacta", lines: [SERVICIO], charged: 115_000 },
    { name: "un peso menos", lines: [SERVICIO], charged: 114_999 },
    { name: "una cortesía grande", lines: [SERVICIO], charged: 80_000 },
    { name: "gratis", lines: [SERVICIO], charged: 0 },
    {
      name: "con adicionales, cobrando todo",
      lines: [SERVICIO, linea("adicional", 3, 8_000)],
      charged: 139_000,
    },
    {
      name: "con adicionales, cobrando de menos",
      lines: [SERVICIO, linea("adicional", 3, 8_000)],
      charged: 130_000,
    },
    {
      name: "rebaja escrita como renglón negativo",
      lines: [SERVICIO, linea("manual", 1, -15_000, "rebaja")],
      charged: 100_000,
    },
    {
      name: "renglón manual en cero, cuenta gratis coherente",
      lines: [linea("manual", 1, 0, "garantía")],
      charged: 0,
    },
  ];

  for (const testCase of CASES) {
    it(`${testCase.name}: variación > 0 ⟺ pide motivo`, () => {
      const variance = priceVariance(testCase.lines, testCase.charged);
      expect(variance > 0, `variación ${variance}`).toBe(
        demandsReason(testCase.lines, testCase.charged),
      );
    });
  }

  it("y el monto coincide con el que dice el mensaje de error de la compuerta", () => {
    // El mensaje lleva la cifra: "Se cobró X menos que el precio de lista".
    const lines = [SERVICIO, linea("adicional", 2, 8_000)];
    const charged = 100_000;

    let message = "";
    try {
      validateTicketClose({
        items: lines,
        discount: 131_000 - charged,
        varianceReasonCode: null,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }

    expect(message).toContain(String(priceVariance(lines, charged)));
  });
});
