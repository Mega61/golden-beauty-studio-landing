import { describe, expect, it } from "vitest";

import type {
  AppointmentFinance,
  AppointmentFinanceItem,
  BasisPoints,
  CommissionEntry,
  CommissionRule,
} from "@/db/types";
import type { CommissionRuleInput } from "@/lib/commission";
import { parseEaLocalDate, type EaLocalDate } from "@/lib/ea";

import {
  CommissionRunError,
  fortnightBlockers,
  fortnightBounds,
  fortnightDays,
  fortnightOf,
  planFortnight,
  shiftFortnight,
  summarizePlan,
  sumEntries,
  toCommissionAccount,
  toCommissionRule,
  type CommissionAccount,
  type CommissionAccountItem,
  type FortnightAssessment,
  type PlannedEntry,
} from "./commission-run";

/**
 * Capa 1 de D1: la quincena, planeada.
 *
 * Todo lo que decide un monto en este paquete es `planFortnight()` y las cuatro
 * funciones puras que la rodean, así que acá está el 100 % de las ramas de esa
 * mitad. La otra mitad —escribir, y negarse a reescribir lo pagado— es una
 * invariante de MySQL y se prueba contra un MySQL de verdad en
 * `commission-run.integration.test.ts`.
 *
 * El caso de referencia de este archivo (`describe("la quincena de referencia")`)
 * tiene **los montos calculados a mano antes de correr nada**, renglón por
 * renglón, y está abajo en el comentario que lo precede. Es la única forma de
 * que un test de plata pruebe algo: si los esperados salen de correr el código,
 * lo único que se fija es que el código siga haciendo lo que hace.
 */

// ── Fixtures ────────────────────────────────────────────────────────────────

const LINA = 3;
const SARA = 7;

/** El combo publicado como un solo servicio de EA. 60 % manos, 40 % pies. */
const COMBO_SERVICE = 42;
const COMBO_HANDS_BP: BasisPoints = 6000;
const COMBOS = new Map<number, BasisPoints>([[COMBO_SERVICE, COMBO_HANDS_BP]]);

const QUINCENA = fortnightOf("2026-09-08");

/** La regla que rige hoy: 40 % plano, sobre todo, sin fecha de fin. */
const CUARENTA: CommissionRuleInput = {
  id: 1,
  eaProviderId: null,
  categoryId: null,
  eaServiceId: null,
  appliesTo: "ambos",
  kind: "percent",
  percentBp: 4000,
  fixedAmount: null,
  validFrom: "2026-01-01",
  validTo: null,
};

let nextItemId = 1000;

function renglon(
  over: Partial<CommissionAccountItem> & { unitPriceSnapshot: number },
): CommissionAccountItem {
  const qty = over.qty ?? 1;
  return {
    itemId: over.itemId ?? (nextItemId += 1),
    kind: over.kind ?? "servicio",
    eaServiceId: over.eaServiceId ?? 5,
    pricingId: over.pricingId ?? "acrylic-sculpted",
    qty,
    unitPriceSnapshot: over.unitPriceSnapshot,
    lineTotal: over.lineTotal ?? qty * over.unitPriceSnapshot,
    note: over.note ?? null,
  };
}

let nextFinanceId = 500;

function cuenta(over: Partial<CommissionAccount> = {}): CommissionAccount {
  const items = over.items ?? [renglon({ unitPriceSnapshot: 100_000 })];
  const discount = over.discount ?? 0;
  const financeId = over.financeId ?? (nextFinanceId += 1);
  return {
    financeId,
    eaAppointmentId: over.eaAppointmentId ?? financeId + 10_000,
    // `in` y no `??`: la mitad de estos campos son nullable y un `null`
    // explícito en el override es justamente el caso que hay que poder armar.
    serviceDate:
      "serviceDate" in over
        ? (over.serviceDate as EaLocalDate | null)
        : parseEaLocalDate("2026-09-08"),
    closed: over.closed ?? true,
    eaProviderId: "eaProviderId" in over ? (over.eaProviderId as number | null) : LINA,
    secondaryEaProviderId: over.secondaryEaProviderId ?? null,
    performedServiceId:
      "performedServiceId" in over ? (over.performedServiceId as number | null) : 5,
    discount,
    amountCharged:
      over.amountCharged !== undefined
        ? over.amountCharged
        : items.reduce((sum, item) => sum + item.lineTotal, 0) - discount,
    tip: over.tip ?? 0,
    items,
  };
}

function plan(
  accounts: readonly CommissionAccount[],
  over: { rules?: readonly CommissionRuleInput[]; combos?: Map<number, BasisPoints> } = {},
) {
  return planFortnight({
    period: QUINCENA,
    accounts,
    rules: over.rules ?? [CUARENTA],
    combos: over.combos ?? COMBOS,
  });
}

function amountOf(entries: readonly PlannedEntry[], itemId: number, eaProviderId: number) {
  const found = entries.find(
    (entry) => entry.itemId === itemId && entry.eaProviderId === eaProviderId,
  );
  return found?.amount;
}

// ── El periodo ──────────────────────────────────────────────────────────────

describe("fortnightOf", () => {
  it("corta el mes en 1–15 y 16–fin", () => {
    expect(fortnightOf("2026-09-01")).toEqual({
      periodStart: "2026-09-01",
      periodEnd: "2026-09-15",
    });
    expect(fortnightOf("2026-09-15")).toEqual({
      periodStart: "2026-09-01",
      periodEnd: "2026-09-15",
    });
    expect(fortnightOf("2026-09-16")).toEqual({
      periodStart: "2026-09-16",
      periodEnd: "2026-09-30",
    });
    expect(fortnightOf("2026-09-30")).toEqual({
      periodStart: "2026-09-16",
      periodEnd: "2026-09-30",
    });
  });

  it("cierra febrero donde termina febrero", () => {
    // 2028 es bisiesto. Un corte fijo en 30 dejaría el 29 sin quincena y su
    // comisión sin liquidar, y nadie lo notaría hasta cuatro años después.
    expect(fortnightOf("2028-02-20").periodEnd).toBe("2028-02-29");
    expect(fortnightOf("2026-02-20").periodEnd).toBe("2026-02-28");
  });
});

describe("shiftFortnight", () => {
  it("va a la quincena anterior y a la siguiente cruzando el mes", () => {
    const primera = fortnightOf("2026-09-03");
    expect(shiftFortnight(primera, -1)).toEqual({
      periodStart: "2026-08-16",
      periodEnd: "2026-08-31",
    });
    expect(shiftFortnight(primera, 1)).toEqual({
      periodStart: "2026-09-16",
      periodEnd: "2026-09-30",
    });
  });

  it("no se desalinea al saltar meses de distinto largo", () => {
    // Restar quince días sí se desalinea: la segunda quincena de febrero tiene
    // trece. Saltando un día por fuera del corte, no.
    let period = fortnightOf("2026-01-05");
    const visitados: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      period = shiftFortnight(period, 1);
      visitados.push(`${period.periodStart}→${period.periodEnd}`);
    }
    expect(visitados).toEqual([
      "2026-01-16→2026-01-31",
      "2026-02-01→2026-02-15",
      "2026-02-16→2026-02-28",
      "2026-03-01→2026-03-15",
      "2026-03-16→2026-03-31",
      "2026-04-01→2026-04-15",
    ]);
  });
});

describe("fortnightBounds", () => {
  it("ancla los extremos a la medianoche de Bogotá, no del proceso", () => {
    const [from, to] = fortnightBounds(fortnightOf("2026-09-03"));
    // Bogotá es UTC−5 todo el año: la medianoche del 1 son las 05:00 UTC.
    expect(from.toISOString()).toBe("2026-09-01T05:00:00.000Z");
    // Borde superior exclusivo: la medianoche del 16, que ya es de la quincena
    // siguiente. Con `new Date("2026-09-16")` el rango se habría comido las
    // cinco últimas horas del 15.
    expect(to.toISOString()).toBe("2026-09-16T05:00:00.000Z");
  });

  it("cruza el fin de mes sin inventar un día 31", () => {
    const [, to] = fortnightBounds(fortnightOf("2026-02-20"));
    expect(to.toISOString()).toBe("2026-03-01T05:00:00.000Z");
  });
});

describe("fortnightDays", () => {
  it("enumera los días del periodo, extremos incluidos", () => {
    const days = fortnightDays(fortnightOf("2026-09-20"));
    expect(days).toHaveLength(15);
    expect(days[0]).toBe("2026-09-16");
    expect(days[14]).toBe("2026-09-30");
  });

  it("da trece días en la segunda quincena de febrero", () => {
    expect(fortnightDays(fortnightOf("2026-02-20"))).toHaveLength(13);
  });
});

// ── Los bordes de la base ───────────────────────────────────────────────────

describe("toCommissionAccount", () => {
  const row: AppointmentFinance = {
    id: 91,
    ea_appointment_id: 4001,
    ea_provider_id: LINA,
    secondary_ea_provider_id: null,
    appointment_start_at: new Date("2026-09-08T14:00:00Z"),
    booked_service_id: 5,
    performed_service_id: 9,
    service_price_snapshot: 180_000,
    snapshot_source: "webhook",
    discount: 0,
    amount_charged: 180_000,
    tip: 20_000,
    payment_method: "efectivo",
    paid_at: new Date("2026-09-08T20:00:00Z"),
    service_notes: null,
    variance_reason_code: null,
    variance_reason: null,
    closed_by: "usr_1",
    closed_at: new Date("2026-09-08T20:00:00Z"),
    day_close_id: null,
    pushed_to_ingest_at: null,
    created_at: new Date("2026-09-08T10:00:00Z"),
    updated_at: new Date("2026-09-08T20:00:00Z"),
  };

  const item: AppointmentFinanceItem = {
    id: 700,
    appointment_finance_id: 91,
    kind: "servicio",
    ea_service_id: 9,
    pricing_id: "acrylic-sculpted",
    qty: 1,
    unit_price_snapshot: 180_000,
    line_total: 180_000,
    note: null,
    created_at: new Date("2026-09-08T20:00:00Z"),
  };

  it("fecha la cita en el calendario de Bogotá, no en UTC", () => {
    // 2026-09-09T02:00:00Z son las 9 p. m. del 8 en Bogotá. Fechada en UTC, esa
    // cita saltaría al día siguiente — y una del día 15 a las 8 p. m. saltaría
    // a la quincena siguiente.
    const account = toCommissionAccount(
      { ...row, appointment_start_at: new Date("2026-09-09T02:00:00Z") },
      [item],
    );
    expect(account.serviceDate).toBe("2026-09-08");
  });

  it("deja la fecha en null cuando la fila no la tiene", () => {
    const account = toCommissionAccount({ ...row, appointment_start_at: null }, []);
    expect(account.serviceDate).toBeNull();
    expect(account.items).toEqual([]);
  });

  it("copia los renglones con su total guardado", () => {
    const account = toCommissionAccount(row, [item]);
    expect(account.closed).toBe(true);
    expect(account.tip).toBe(20_000);
    expect(account.items).toEqual([
      {
        itemId: 700,
        kind: "servicio",
        eaServiceId: 9,
        pricingId: "acrylic-sculpted",
        qty: 1,
        unitPriceSnapshot: 180_000,
        lineTotal: 180_000,
        note: null,
      },
    ]);
  });

  it("marca como no cerrada la cuenta sin closed_at", () => {
    expect(toCommissionAccount({ ...row, closed_at: null }, [item]).closed).toBe(false);
  });
});

describe("toCommissionRule", () => {
  it("pasa la fila a la forma que el motor resuelve", () => {
    const row: CommissionRule = {
      id: 4,
      ea_provider_id: null,
      category_id: null,
      ea_service_id: null,
      applies_to: "ambos",
      kind: "percent",
      percent_bp: 4000,
      fixed_amount: null,
      valid_from: "2026-01-01",
      valid_to: null,
      created_by: null,
      created_at: new Date("2026-09-01T00:00:00Z"),
      updated_at: new Date("2026-09-01T00:00:00Z"),
    };
    expect(toCommissionRule(row)).toEqual({
      id: 4,
      eaProviderId: null,
      categoryId: null,
      eaServiceId: null,
      appliesTo: "ambos",
      kind: "percent",
      // En puntos básicos, entero. 40 y 0.4 son los dos errores que esta
      // columna existe para hacer imposibles.
      percentBp: 4000,
      fixedAmount: null,
      validFrom: "2026-01-01",
      validTo: null,
    });
  });
});

// ── La quincena de referencia ───────────────────────────────────────────────

/**
 * Cinco cuentas reales de una quincena, con la aritmética hecha a mano.
 *
 * ```text
 * A · 2026-09-02 · Lina
 *     forrado          1 × 180.000 = 180.000  → 40 % = 72.000
 *     diseño por uña   3 ×   8.000 =  24.000  → 40 % =  9.600
 *     propina 20.000 (fuera de la base)         subtotal 81.600
 *
 * B · 2026-09-05 · Lina · descuento 10.000 prorrateado
 *     montaje          1 × 200.000 = 200.000 − 9.302 = 190.698 → 76.279,2 → 76.279
 *     adicional        1 ×  15.000 =  15.000 −   698 =  14.302 →  5.720,8 →  5.721
 *     cobrado 205.000                            subtotal 82.000 = 40 % de 205.000
 *
 * C · 2026-09-08 · Lina (manos) + Sara (pies) · combo 60/40
 *     combo            1 × 250.000 → manos 150.000 → 60.000 · pies 100.000 → 40.000
 *     adicional        1 ×  10.000 → completo a Lina        →  4.000
 *
 * D · 2026-09-10 · Sara · retoque de garantía
 *     renglón manual   1 ×       0 → sin balde de applies_to → 0, MARCADO
 *
 * E · 2026-09-12 · Lina · cuenta sin cerrar → saltada
 *
 * Lina  = 81.600 + 82.000 + 64.000 = 227.600   (40 % de 569.000 de base)
 * Sara  =                   40.000 +      0 =  40.000   (40 % de 100.000)
 * ```
 */
describe("la quincena de referencia", () => {
  const A = cuenta({
    financeId: 601,
    eaAppointmentId: 5001,
    serviceDate: parseEaLocalDate("2026-09-02"),
    eaProviderId: LINA,
    tip: 20_000,
    items: [
      renglon({ itemId: 1, unitPriceSnapshot: 180_000 }),
      renglon({
        itemId: 2,
        kind: "adicional",
        eaServiceId: 31,
        pricingId: "design-per-nail",
        qty: 3,
        unitPriceSnapshot: 8_000,
      }),
    ],
  });

  const B = cuenta({
    financeId: 602,
    eaAppointmentId: 5002,
    serviceDate: parseEaLocalDate("2026-09-05"),
    eaProviderId: LINA,
    discount: 10_000,
    items: [
      renglon({ itemId: 3, unitPriceSnapshot: 200_000 }),
      renglon({
        itemId: 4,
        kind: "adicional",
        eaServiceId: 31,
        unitPriceSnapshot: 15_000,
      }),
    ],
  });

  const C = cuenta({
    financeId: 603,
    eaAppointmentId: 5003,
    serviceDate: parseEaLocalDate("2026-09-08"),
    eaProviderId: LINA,
    secondaryEaProviderId: SARA,
    performedServiceId: COMBO_SERVICE,
    items: [
      renglon({ itemId: 5, eaServiceId: COMBO_SERVICE, unitPriceSnapshot: 250_000 }),
      renglon({
        itemId: 6,
        kind: "adicional",
        eaServiceId: 31,
        unitPriceSnapshot: 10_000,
      }),
    ],
  });

  const D = cuenta({
    financeId: 604,
    eaAppointmentId: 5004,
    serviceDate: parseEaLocalDate("2026-09-10"),
    eaProviderId: SARA,
    items: [
      renglon({
        itemId: 7,
        kind: "manual",
        eaServiceId: null,
        pricingId: null,
        unitPriceSnapshot: 0,
        note: "retoque de garantía",
      }),
    ],
  });

  const E = cuenta({
    financeId: 605,
    eaAppointmentId: 5005,
    serviceDate: parseEaLocalDate("2026-09-12"),
    closed: false,
    amountCharged: null,
  });

  const resultado = plan([A, B, C, D, E]);

  it("paga cada renglón al 40 % de lo cobrado en ese renglón", () => {
    expect(amountOf(resultado.entries, 1, LINA)).toBe(72_000);
    expect(amountOf(resultado.entries, 2, LINA)).toBe(9_600);
    expect(amountOf(resultado.entries, 3, LINA)).toBe(76_279);
    expect(amountOf(resultado.entries, 4, LINA)).toBe(5_721);
  });

  it("reparte el combo a cuatro manos por la proporción de la fila combo", () => {
    expect(amountOf(resultado.entries, 5, LINA)).toBe(60_000);
    expect(amountOf(resultado.entries, 5, SARA)).toBe(40_000);
    // El adicional de esa misma cuenta va completo a la principal: no hay dato
    // que diga quién lo hizo, y repartirlo con la proporción del combo sería
    // inventarlo.
    expect(amountOf(resultado.entries, 6, LINA)).toBe(4_000);
    expect(amountOf(resultado.entries, 6, SARA)).toBeUndefined();
  });

  it("deja el renglón manual en cero y marcado", () => {
    const manual = resultado.entries.find((entry) => entry.itemId === 7);
    expect(manual).toMatchObject({ amount: 0, ruleId: null, flag: "renglon-manual" });
  });

  it("salta la cuenta sin cerrar y lo dice", () => {
    expect(resultado.skipped).toEqual([
      {
        financeId: 605,
        eaAppointmentId: 5005,
        reason: "sin-cerrar",
        message: "La cuenta de esta cita todavía no se cerró.",
      },
    ]);
    expect(resultado.entries.some((entry) => entry.financeId === 605)).toBe(false);
  });

  it("suma por técnica lo que hay que pagarle el 15", () => {
    expect(resultado.totals).toEqual([
      { eaProviderId: LINA, base: 569_000, amount: 227_600, flagged: 0, appointments: 3 },
      { eaProviderId: SARA, base: 100_000, amount: 40_000, flagged: 1, appointments: 2 },
    ]);
  });

  it("no le paga comisión sobre la propina", () => {
    // La propina de A son 20.000 y ya es 100 % de la técnica. Con 40 % encima,
    // el total de Lina subiría 8.000 pesos por cita.
    const sinPropina = plan([{ ...A, tip: 0, amountCharged: 204_000 }]);
    const conPropina = plan([A]);
    expect(conPropina.totals[0].amount).toBe(sinPropina.totals[0].amount);
    expect(conPropina.totals[0].amount).toBe(81_600);
  });

  it("la comisión de cada cuenta es el 40 % exacto de lo que entró a la caja", () => {
    // La suma de los renglones redondeados uno por uno tiene que dar lo mismo
    // que el 40 % del total cobrado. Es la propiedad que hace que la
    // liquidación cuadre con la caja sin un peso de diferencia.
    for (const account of [A, B, C]) {
      const amount = plan([account]).totals.reduce((sum, total) => sum + total.amount, 0);
      expect(amount).toBe((account.amountCharged ?? 0) * 0.4);
    }
  });
});

// ── Vigencia: nada se recalcula en retrospectiva ────────────────────────────

describe("la vigencia de la regla", () => {
  const TREINTA: CommissionRuleInput = {
    ...CUARENTA,
    id: 1,
    percentBp: 3000,
    validFrom: "2026-01-01",
    // `valid_to` es **inclusivo**: el día 5 todavía paga 30 %.
    validTo: "2026-09-05",
  };
  const CUARENTA_DESDE_6: CommissionRuleInput = {
    ...CUARENTA,
    id: 2,
    percentBp: 4000,
    validFrom: "2026-09-06",
    validTo: null,
  };

  it("aplica a cada cita la tasa vigente el día de la cita, no la de hoy", () => {
    const antes = cuenta({
      serviceDate: parseEaLocalDate("2026-09-05"),
      items: [renglon({ itemId: 11, unitPriceSnapshot: 100_000 })],
    });
    const despues = cuenta({
      serviceDate: parseEaLocalDate("2026-09-06"),
      items: [renglon({ itemId: 12, unitPriceSnapshot: 100_000 })],
    });

    const resultado = plan([antes, despues], { rules: [TREINTA, CUARENTA_DESDE_6] });

    expect(amountOf(resultado.entries, 11, LINA)).toBe(30_000);
    expect(amountOf(resultado.entries, 12, LINA)).toBe(40_000);
    // Y la tasa queda congelada en la entrada, para que la liquidación se pueda
    // explicar meses después.
    expect(resultado.entries.map((entry) => entry.rateBp)).toEqual([3000, 4000]);
    expect(resultado.entries.map((entry) => entry.ruleId)).toEqual([1, 2]);
  });
});

// ── Lo que se salta, y por qué ──────────────────────────────────────────────

describe("las cuentas que no se pueden liquidar", () => {
  function razon(account: CommissionAccount) {
    const resultado = plan([account]);
    expect(resultado.entries).toEqual([]);
    return resultado.skipped[0];
  }

  it("sin fecha de cita", () => {
    expect(razon(cuenta({ serviceDate: null }))).toMatchObject({ reason: "sin-fecha" });
  });

  it("con fecha de otra quincena", () => {
    // Defensa contra un llamador que traiga filas de otro rango: escribirlas
    // con este `period_start` las metería en una liquidación ajena y su propia
    // quincena las volvería a contar.
    expect(
      razon(cuenta({ serviceDate: parseEaLocalDate("2026-08-31") })),
    ).toMatchObject({ reason: "sin-fecha" });
    expect(
      razon(cuenta({ serviceDate: parseEaLocalDate("2026-09-16") })),
    ).toMatchObject({ reason: "sin-fecha" });
  });

  it("sin técnica asignada", () => {
    expect(razon(cuenta({ eaProviderId: null }))).toMatchObject({
      reason: "sin-tecnica",
    });
  });

  it("cerrada y sin un solo renglón", () => {
    expect(razon(cuenta({ items: [], amountCharged: 0 }))).toMatchObject({
      reason: "sin-renglones",
    });
  });

  it("con un renglón cuyo total guardado no es cantidad × precio", () => {
    const roto = razon(
      cuenta({
        items: [renglon({ itemId: 21, qty: 2, unitPriceSnapshot: 50_000, lineTotal: 90_000 })],
        amountCharged: 90_000,
      }),
    );
    expect(roto.reason).toBe("total-no-cuadra");
    expect(roto.message).toContain("90000");
    expect(roto.message).toContain("100000");
  });

  it("con un cobrado que no es la suma de sus renglones menos el descuento", () => {
    const roto = razon(
      cuenta({
        items: [renglon({ itemId: 22, unitPriceSnapshot: 100_000 })],
        amountCharged: 120_000,
      }),
    );
    expect(roto.reason).toBe("total-no-cuadra");
    expect(roto.message).toContain("120000");
  });

  it("con una cuenta que lib/ticket.ts rechaza", () => {
    // Un renglón manual sin nota. Dentro de tres meses nadie puede decir qué se
    // cobró, así que `lib/ticket.ts` no lo acepta y acá tampoco se comisiona.
    const ilegible = razon(
      cuenta({
        items: [
          renglon({ itemId: 23, kind: "manual", unitPriceSnapshot: 30_000, note: "  " }),
        ],
      }),
    );
    expect(ilegible.reason).toBe("cuenta-ilegible");
    expect(ilegible.message).toContain("nota");
  });

  it("con dos técnicas y ningún combo que diga cómo repartir", () => {
    const sinReparto = razon(
      cuenta({
        secondaryEaProviderId: SARA,
        performedServiceId: 5,
        items: [renglon({ itemId: 24, unitPriceSnapshot: 250_000 })],
      }),
    );
    expect(sinReparto.reason).toBe("reparto-desconocido");
  });

  it("con dos técnicas y un servicio realizado desconocido", () => {
    expect(
      razon(
        cuenta({
          secondaryEaProviderId: SARA,
          performedServiceId: null,
          items: [renglon({ itemId: 25, unitPriceSnapshot: 250_000 })],
        }),
      ).reason,
    ).toBe("reparto-desconocido");
  });

  it("pero no cuando la técnica secundaria es la misma que la principal", () => {
    // Una fila así es un dato redundante, no un combo a cuatro manos. Partirlo
    // 60/40 entre la misma persona daría dos entradas para el mismo renglón —
    // que la UNIQUE de `commission_entry` rechazaría, con razón.
    const resultado = plan([
      cuenta({
        secondaryEaProviderId: LINA,
        items: [renglon({ itemId: 26, unitPriceSnapshot: 100_000 })],
      }),
    ]);
    expect(resultado.skipped).toEqual([]);
    expect(resultado.entries).toHaveLength(1);
    expect(amountOf(resultado.entries, 26, LINA)).toBe(40_000);
  });
});

// ── Sin regla, cero marcado ─────────────────────────────────────────────────

describe("cuando no hay regla aplicable", () => {
  it("liquida cero y lo marca, en vez de un cero silencioso", () => {
    const resultado = plan([cuenta({ items: [renglon({ itemId: 31, unitPriceSnapshot: 100_000 })] })], {
      rules: [],
    });
    expect(resultado.entries[0]).toMatchObject({
      amount: 0,
      ruleId: null,
      rateBp: null,
      flag: "sin-regla",
    });
    expect(resultado.totals[0].flagged).toBe(1);
  });
});

// ── Las categorías, que hoy no existen ──────────────────────────────────────

describe("las reglas por categoría", () => {
  const POR_CATEGORIA: CommissionRuleInput = {
    ...CUARENTA,
    id: 9,
    categoryId: "montajes",
    percentBp: 1500,
  };

  it("no se liquidan a ciegas: sin resolvedor de categoría, lanza", () => {
    // Sin resolvedor, `categoryId` sería `null`, la regla de montajes no
    // coincidiría nunca y el renglón caería en la global al 40 % donde debía
    // pagar 15 %. Un error de 25 puntos que ninguna pantalla mostraría.
    expect(() =>
      planFortnight({
        period: QUINCENA,
        accounts: [cuenta()],
        rules: [CUARENTA, POR_CATEGORIA],
      }),
    ).toThrow(CommissionRunError);
  });

  it("con resolvedor, la categoría gana sobre la global", () => {
    const resultado = planFortnight({
      period: QUINCENA,
      accounts: [cuenta({ items: [renglon({ itemId: 41, unitPriceSnapshot: 200_000 })] })],
      rules: [CUARENTA, POR_CATEGORIA],
      categoryOf: () => "montajes",
    });
    expect(amountOf(resultado.entries, 41, LINA)).toBe(30_000);
    expect(resultado.entries[0].rateBp).toBe(1500);
  });

  it("y sin reglas por categoría no hace falta resolvedor", () => {
    expect(
      planFortnight({
        period: QUINCENA,
        accounts: [cuenta({ items: [renglon({ itemId: 42, unitPriceSnapshot: 100_000 })] })],
        rules: [CUARENTA],
      }).entries,
    ).toHaveLength(1);
  });
});

// ── Sumas ───────────────────────────────────────────────────────────────────

describe("summarizePlan", () => {
  it("no cuenta dos veces la cita que tiene dos renglones", () => {
    const entries: PlannedEntry[] = [
      {
        itemId: 1,
        eaProviderId: LINA,
        ruleId: 1,
        baseAmount: 100_000,
        rateBp: 4000,
        amount: 40_000,
        flag: null,
        financeId: 1,
        eaAppointmentId: 900,
        serviceDate: parseEaLocalDate("2026-09-02"),
      },
      {
        itemId: 2,
        eaProviderId: LINA,
        ruleId: 1,
        baseAmount: 10_000,
        rateBp: 4000,
        amount: 4_000,
        flag: "regla-ambigua",
        financeId: 1,
        eaAppointmentId: 900,
        serviceDate: parseEaLocalDate("2026-09-02"),
      },
    ];
    expect(summarizePlan(entries)).toEqual([
      { eaProviderId: LINA, base: 110_000, amount: 44_000, flagged: 1, appointments: 1 },
    ]);
  });

  it("sin entradas no inventa técnicas", () => {
    expect(summarizePlan([])).toEqual([]);
  });
});

describe("sumEntries", () => {
  function entry(amount: number): CommissionEntry {
    return {
      id: 1,
      appointment_finance_item_id: 1,
      ea_provider_id: LINA,
      commission_rule_id: 1,
      base_amount: amount * 2,
      rate_bp: 4000,
      amount,
      period_start: "2026-09-01",
      period_end: "2026-09-15",
      status: "pending",
      commission_run_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  it("suma lo escrito, incluida una corrección que resta", () => {
    expect(sumEntries([entry(40_000), entry(9_600), entry(-4_000)])).toBe(45_600);
  });

  it("una quincena sin entradas vale cero, no null", () => {
    expect(sumEntries([])).toBe(0);
  });
});

// ── La compuerta ────────────────────────────────────────────────────────────

describe("fortnightBlockers", () => {
  function assessment(over: Partial<FortnightAssessment> = {}): FortnightAssessment {
    return {
      period: QUINCENA,
      missingDayCloses: [],
      flaggedEntries: 0,
      open: false,
      ...over,
    };
  }

  it("con la quincena cerrada, todo cerrado y nada marcado, no bloquea nada", () => {
    expect(fortnightBlockers(assessment())).toEqual([]);
  });

  it("bloquea mientras la quincena está en curso", () => {
    expect(fortnightBlockers(assessment({ open: true }))).toEqual([
      { kind: "en-curso", until: "2026-09-15" },
    ]);
  });

  it("devuelve los días sin cierre de caja, no una frase", () => {
    // El bloqueo viaja como dato: la frase la arma la pantalla, que es la que
    // sabe escribir "viernes 4 de septiembre". El motor corre también en un
    // cron y no tiene por qué conocer ese formato.
    const días = [parseEaLocalDate("2026-09-04"), parseEaLocalDate("2026-09-07")];
    expect(fortnightBlockers(assessment({ missingDayCloses: días }))).toEqual([
      { kind: "sin-cierre", days: días },
    ]);
  });

  it("bloquea por los renglones sin regla, con su cuenta", () => {
    expect(fortnightBlockers(assessment({ flaggedEntries: 4 }))).toEqual([
      { kind: "sin-regla", count: 4 },
    ]);
  });

  it("acumula los tres motivos en vez de mostrar solo el primero", () => {
    expect(
      fortnightBlockers(
        assessment({
          open: true,
          missingDayCloses: [parseEaLocalDate("2026-09-04")],
          flaggedEntries: 2,
        }),
      ).map((blocker) => blocker.kind),
    ).toEqual(["en-curso", "sin-cierre", "sin-regla"]);
  });
});
