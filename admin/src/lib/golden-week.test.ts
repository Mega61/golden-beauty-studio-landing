import { describe, expect, it } from "vitest";

import {
  computeCommissions,
  totalsByProvider,
  type CommissionInput,
  type CommissionRuleInput,
} from "./commission";
import { buildDayClosePayments } from "./ingest-payload";
import { computeTicketTotals, type TicketItemInput, type TicketTotals } from "./ticket";

import type { Cop, PaymentMethod } from "@/db/types";

/**
 * # El golden test — una semana de fixture, conciliada una sola vez
 *
 * El plan lo pide con nombre propio: "un golden test sobre una semana fija de
 * citas de fixture que afirma los totales exactos de ingreso, propinas y
 * comisión por profesional. Convierte el paso *conciliar una semana real línea
 * por línea* en algo repetible."
 *
 * Los números esperados de este archivo **se calcularon a mano**, renglón por
 * renglón, no copiando lo que el código devolvió. Es la única forma de que el
 * test signifique algo: un esperado copiado de la salida solo afirma que el
 * código sigue haciendo lo que hace, incluso si lo que hace está mal.
 *
 * Si un cambio futuro hace fallar este archivo, la pregunta correcta **no** es
 * "¿cómo actualizo el esperado?". Es: qué cambió de significado, y por qué. Un
 * número de acá que se mueve es una semana de plata que se movió.
 *
 * ## La semana
 *
 * Lunes 24 a sábado 29 de agosto de 2026, dos técnicas, once renglones
 * repartidos en diez cuentas. Está armada para que cada trampa del motor caiga
 * al menos una vez:
 *
 * - una cita **agendada como press-on y cerrada como forrado + adicionales**,
 *   con descuento y motivo — la base es lo realizado;
 * - un **combo trabajado por dos técnicas**, que reparte 60/40;
 * - un **renglón manual en cero** (retoque de garantía), que no paga comisión y
 *   **queda marcado**;
 * - una **inasistencia**, que no produce cuenta ni comisión;
 * - una regla **de monto fijo** que le gana a la de porcentaje por
 *   especificidad;
 * - y un prorrateo de descuento cuyo peso de residuo no cae redondo.
 *
 * ⚠ **Las cuatro reglas de comisión son de fixture.** Las tasas reales todavía
 * no existen (§ Decisiones pendientes). Están elegidas para que los caminos del
 * motor se separen, no para parecerse a lo que el estudio paga.
 */

// ── Servicios de EA, con su categoría de `pricing.ts` ────────────────────────

const SOFIA = 2;
const DANIELA = 3;

const ACRYLIC_SCULPTED = { id: 1, category: "montajes", price: 115_000 };
const SEMI_PERMANENT_HANDS = { id: 2, category: "sencillos", price: 50_000 };
const ACRYLIC_OVERLAY = { id: 3, category: "forrados", price: 85_000 };
const POLYGEL_REFILL = { id: 4, category: "retoques", price: 90_000 };
const COMBO_SEMI_HANDS_FEET = { id: 5, category: "combos", price: 95_000 };
const TRADITIONAL_HANDS = { id: 6, category: "sencillos", price: 30_000 };
const BUILDER_GEL_DUAL = { id: 7, category: "montajes", price: 105_000 };
const DIPPING = { id: 20, category: "forrados", price: 80_000 };
const POLYGEL_SCULPTED = { id: 9, category: "montajes", price: 120_000 };
const FEET_CLEANUP_ONLY = { id: 10, category: "sencillos", price: 25_000 };
/** Lo que se agendó en la cita del martes. No paga ni un peso: no se hizo. */
const PRESS_ON = { id: 11, category: "montajes", price: 100_000 };

const DESIGN_PER_NAIL = 10_000;
const SYSTEM_REMOVAL = 20_000;

// ── La semana ───────────────────────────────────────────────────────────────

type Assignment = { eaProviderId: number; shareBp: number };

type FixtureLine = TicketItemInput & {
  /** Categoría de `pricing.ts` del servicio **realizado**. */
  category: string | null;
};

type FixtureAppointment = {
  eaAppointmentId: number;
  date: string;
  eaProviderId: number;
  /** Quién trabajó cada renglón. Casi siempre la técnica de la cita, al 100 %. */
  assignments: Assignment[];
  bookedServiceId: number;
  performedServiceId: number;
  lines: FixtureLine[];
  discount: Cop;
  tip: Cop;
  method: PaymentMethod;
};

const soloElla = (eaProviderId: number): Assignment[] => [{ eaProviderId, shareBp: 10_000 }];

const servicio = (service: { id: number; category: string; price: number }): FixtureLine => ({
  kind: "servicio",
  eaServiceId: service.id,
  category: service.category,
  qty: 1,
  unitPriceSnapshot: service.price,
});

const extra = (pricingId: string, unitPriceSnapshot: Cop, qty = 1): FixtureLine => ({
  kind: "adicional",
  eaServiceId: null,
  category: "extras",
  pricingId,
  qty,
  unitPriceSnapshot,
});

const WEEK: FixtureAppointment[] = [
  // ── lunes 24 ──────────────────────────────────────────────────────────────
  {
    eaAppointmentId: 101,
    date: "2026-08-24",
    eaProviderId: SOFIA,
    assignments: soloElla(SOFIA),
    bookedServiceId: ACRYLIC_SCULPTED.id,
    performedServiceId: ACRYLIC_SCULPTED.id,
    lines: [servicio(ACRYLIC_SCULPTED), extra("design-per-nail", DESIGN_PER_NAIL, 3)],
    discount: 0,
    tip: 10_000,
    method: "efectivo",
  },
  {
    eaAppointmentId: 102,
    date: "2026-08-24",
    eaProviderId: DANIELA,
    assignments: soloElla(DANIELA),
    bookedServiceId: SEMI_PERMANENT_HANDS.id,
    performedServiceId: SEMI_PERMANENT_HANDS.id,
    lines: [servicio(SEMI_PERMANENT_HANDS)],
    discount: 0,
    tip: 0,
    method: "transferencia",
  },

  // ── martes 25: se reservó press-on y terminó en forrado ───────────────────
  {
    eaAppointmentId: 103,
    date: "2026-08-25",
    eaProviderId: SOFIA,
    assignments: soloElla(SOFIA),
    bookedServiceId: PRESS_ON.id,
    performedServiceId: ACRYLIC_OVERLAY.id,
    lines: [
      servicio(ACRYLIC_OVERLAY),
      extra("design-per-nail", DESIGN_PER_NAIL, 3),
      extra("system-removal", SYSTEM_REMOVAL),
    ],
    discount: 5_000,
    tip: 10_000,
    method: "efectivo",
  },
  {
    eaAppointmentId: 104,
    date: "2026-08-25",
    eaProviderId: DANIELA,
    assignments: soloElla(DANIELA),
    bookedServiceId: POLYGEL_REFILL.id,
    performedServiceId: POLYGEL_REFILL.id,
    lines: [servicio(POLYGEL_REFILL)],
    discount: 0,
    tip: 5_000,
    method: "efectivo",
  },

  // ── miércoles 26: combo a cuatro manos ───────────────────────────────────
  {
    eaAppointmentId: 105,
    date: "2026-08-26",
    eaProviderId: SOFIA,
    assignments: [
      { eaProviderId: SOFIA, shareBp: 6_000 },
      { eaProviderId: DANIELA, shareBp: 4_000 },
    ],
    bookedServiceId: COMBO_SEMI_HANDS_FEET.id,
    performedServiceId: COMBO_SEMI_HANDS_FEET.id,
    lines: [servicio(COMBO_SEMI_HANDS_FEET)],
    discount: 0,
    tip: 0,
    method: "efectivo",
  },
  {
    eaAppointmentId: 106,
    date: "2026-08-26",
    eaProviderId: DANIELA,
    assignments: soloElla(DANIELA),
    bookedServiceId: TRADITIONAL_HANDS.id,
    performedServiceId: TRADITIONAL_HANDS.id,
    lines: [
      servicio(TRADITIONAL_HANDS),
      // El retoque de garantía: queda contado en la cuenta y en la ficha de la
      // clienta, sin cobrar y sin pagar comisión.
      {
        kind: "manual",
        category: null,
        qty: 1,
        unitPriceSnapshot: 0,
        note: "se le repuso una uña sin cobro",
      },
    ],
    discount: 0,
    tip: 0,
    method: "efectivo",
  },

  // ── jueves 27: cortesía. (La inasistencia de Daniela no produce cuenta.) ──
  {
    eaAppointmentId: 107,
    date: "2026-08-27",
    eaProviderId: SOFIA,
    assignments: soloElla(SOFIA),
    bookedServiceId: BUILDER_GEL_DUAL.id,
    performedServiceId: BUILDER_GEL_DUAL.id,
    lines: [servicio(BUILDER_GEL_DUAL)],
    discount: 10_000,
    tip: 0,
    method: "transferencia",
  },

  // ── viernes 28: la regla de monto fijo ───────────────────────────────────
  {
    eaAppointmentId: 109,
    date: "2026-08-28",
    eaProviderId: DANIELA,
    assignments: soloElla(DANIELA),
    bookedServiceId: DIPPING.id,
    performedServiceId: DIPPING.id,
    lines: [servicio(DIPPING), extra("design-per-nail", DESIGN_PER_NAIL)],
    discount: 0,
    tip: 20_000,
    method: "efectivo",
  },

  // ── sábado 29 ────────────────────────────────────────────────────────────
  {
    eaAppointmentId: 110,
    date: "2026-08-29",
    eaProviderId: SOFIA,
    assignments: soloElla(SOFIA),
    bookedServiceId: POLYGEL_SCULPTED.id,
    performedServiceId: POLYGEL_SCULPTED.id,
    lines: [servicio(POLYGEL_SCULPTED)],
    discount: 0,
    tip: 15_000,
    method: "transferencia",
  },
  {
    eaAppointmentId: 111,
    date: "2026-08-29",
    eaProviderId: DANIELA,
    assignments: soloElla(DANIELA),
    bookedServiceId: FEET_CLEANUP_ONLY.id,
    performedServiceId: FEET_CLEANUP_ONLY.id,
    lines: [servicio(FEET_CLEANUP_ONLY)],
    discount: 0,
    tip: 0,
    method: "efectivo",
  },
];

/**
 * Las reglas de fixture. **Ninguna de estas tasas es la del estudio.**
 *
 * | # | A quién | Sobre qué | Cuánto |
 * | --- | --- | --- | --- |
 * | 1 | todas | servicio principal | 10 % |
 * | 2 | todas | adicionales | 5 % |
 * | 3 | Sofía, categoría `montajes` | servicio principal | 15 % |
 * | 4 | Daniela, servicio `dipping` | ambos | $8.000 fijos |
 */
const RULES: CommissionRuleInput[] = [
  {
    id: 1,
    eaProviderId: null,
    categoryId: null,
    eaServiceId: null,
    appliesTo: "principal",
    kind: "percent",
    percentBp: 1_000,
    fixedAmount: null,
    validFrom: "2026-01-01",
    validTo: null,
  },
  {
    id: 2,
    eaProviderId: null,
    categoryId: null,
    eaServiceId: null,
    appliesTo: "adicionales",
    kind: "percent",
    percentBp: 500,
    fixedAmount: null,
    validFrom: "2026-01-01",
    validTo: null,
  },
  {
    id: 3,
    eaProviderId: SOFIA,
    categoryId: "montajes",
    eaServiceId: null,
    appliesTo: "principal",
    kind: "percent",
    percentBp: 1_500,
    fixedAmount: null,
    validFrom: "2026-01-01",
    validTo: null,
  },
  {
    id: 4,
    eaProviderId: DANIELA,
    categoryId: null,
    eaServiceId: DIPPING.id,
    appliesTo: "ambos",
    kind: "fixed",
    percentBp: null,
    fixedAmount: 8_000,
    validFrom: "2026-01-01",
    validTo: null,
  },
];

// ── El motor, corrido sobre la semana ───────────────────────────────────────

type ClosedTicket = FixtureAppointment & { totals: TicketTotals };

function closeWeek(): ClosedTicket[] {
  return WEEK.map((appointment) => ({
    ...appointment,
    totals: computeTicketTotals(appointment.lines, appointment.discount, appointment.tip),
  }));
}

/**
 * Cada renglón cerrado, con la técnica que lo trabajó y su categoría.
 *
 * Ojo con lo que **no** viaja: `bookedServiceId`. El motor de comisiones nunca
 * lo ve, y eso es lo que garantiza que no pueda comisionar sobre lo agendado.
 */
function commissionInputs(week: readonly ClosedTicket[]): CommissionInput[] {
  const inputs: CommissionInput[] = [];

  for (const appointment of week) {
    for (const [index, line] of appointment.totals.lines.entries()) {
      inputs.push({
        line: {
          itemId: appointment.eaAppointmentId * 100 + index,
          kind: line.kind,
          eaServiceId: line.eaServiceId ?? null,
          categoryId: appointment.lines[index].category,
          baseAmount: line.netTotal,
          serviceDate: appointment.date,
        },
        assignments: appointment.assignments,
      });
    }
  }

  return inputs;
}

describe("golden week — 24 al 29 de agosto de 2026", () => {
  const week = closeWeek();
  const results = computeCommissions(commissionInputs(week), RULES);
  const byProvider = totalsByProvider(results);

  const revenueOf = (eaProviderId: number): Cop =>
    week
      .filter((a) => a.eaProviderId === eaProviderId)
      .reduce((sum, a) => sum + a.totals.amountCharged, 0);

  const tipsOf = (eaProviderId: number): Cop =>
    week.filter((a) => a.eaProviderId === eaProviderId).reduce((sum, a) => sum + a.totals.tip, 0);

  it("ingreso de la semana", () => {
    // 145.000 + 50.000 + 130.000 + 90.000 + 95.000 + 30.000 + 95.000 + 90.000
    // + 120.000 + 25.000
    expect(week.reduce((sum, a) => sum + a.totals.amountCharged, 0)).toBe(870_000);
  });

  it("ingreso por profesional (atribuido a la técnica de la cita)", () => {
    // Sofía: 145.000 + 130.000 + 95.000 + 95.000 + 120.000
    expect(revenueOf(SOFIA)).toBe(585_000);
    // Daniela: 50.000 + 90.000 + 30.000 + 90.000 + 25.000
    expect(revenueOf(DANIELA)).toBe(285_000);
  });

  it("propinas por profesional, aparte del ingreso siempre", () => {
    expect(tipsOf(SOFIA)).toBe(35_000); // 10.000 + 10.000 + 15.000
    expect(tipsOf(DANIELA)).toBe(25_000); // 5.000 + 20.000
    expect(tipsOf(SOFIA) + tipsOf(DANIELA)).toBe(60_000);
  });

  it("comisión por profesional", () => {
    // Sofía, renglón por renglón:
    //   101 montaje 115.000 × 15 % (regla 3) ....................... 17.250
    //   101 diseños  30.000 ×  5 % (regla 2) .......................  1.500
    //   103 forrado  81.852 × 10 % (regla 1, no es montaje) ........  8.185
    //   103 diseños  28.889 ×  5 % ................................   1.444
    //   103 retiro   19.259 ×  5 % ................................     963
    //   105 combo    57.000 × 10 % (su 60 % del combo) .............  5.700
    //   107 montaje  95.000 × 15 % (con la cortesía ya descontada) . 14.250
    //   110 montaje 120.000 × 15 % ................................ 18.000
    //                                                              --------
    //                                                                67.292
    //
    // Daniela:
    //   102 sencillo 50.000 × 10 % ................................   5.000
    //   104 retoque  90.000 × 10 % ................................   9.000
    //   105 combo    38.000 × 10 % (su 40 %) ......................   3.800
    //   106 sencillo 30.000 × 10 % ................................   3.000
    //   106 manual        0  — sin regla posible, MARCADO .........       0
    //   109 dipping  80.000 → fijo de la regla 4 ..................   8.000
    //   109 diseño   10.000 ×  5 % (la regla 4 pide su servicio) ..     500
    //   111 sencillo 25.000 × 10 % ................................   2.500
    //                                                              --------
    //                                                                31.800
    expect(byProvider).toEqual([
      { eaProviderId: SOFIA, base: 547_000, amount: 67_292, flaggedCount: 0 },
      { eaProviderId: DANIELA, base: 323_000, amount: 31_800, flaggedCount: 1 },
    ]);
  });

  it("la suma de las bases de comisión ES el ingreso de la semana", () => {
    // No es una coincidencia aritmética: es la invariante del ticket vista
    // desde arriba. Cada peso cobrado está en exactamente un renglón de
    // exactamente una técnica, y el reparto del combo no pierde ni duplica
    // ninguno. Si esta línea falla, algo se está contando dos veces.
    expect(byProvider.reduce((sum, p) => sum + p.base, 0)).toBe(870_000);
  });

  it("el renglón manual queda MARCADO, no escondido en un cero", () => {
    const marcados = results.filter((r) => r.flagged);

    expect(marcados).toHaveLength(1);
    expect(marcados[0]).toMatchObject({
      eaProviderId: DANIELA,
      ruleId: null,
      amount: 0,
      flag: "renglon-manual",
    });
  });

  it("la cita agendada como press-on paga por el forrado, no por el press-on", () => {
    // Press-on son $100.000 y un montaje, así que con la regla 3 habría pagado
    // 15 % de 100.000 = 15.000. Sobre lo realizado paga 10 % de 81.852.
    const forrado = results.find((r) => r.itemId === 103 * 100);

    expect(forrado).toMatchObject({ ruleId: 1, baseAmount: 81_852, amount: 8_185 });
  });

  it("el reparto del combo suma exacto al precio del combo", () => {
    const combo = results.filter((r) => r.itemId === 105 * 100);

    expect(combo.map((r) => r.baseAmount)).toEqual([57_000, 38_000]);
    expect(combo.reduce((sum, r) => sum + r.baseAmount, 0)).toBe(COMBO_SEMI_HANDS_FEET.price);
  });

  it("el push del cierre de cada día es idempotente por construcción", () => {
    // Un `imported_id` por cita, sin repetidos en toda la semana: correr el
    // push dos veces no puede agregar nada en Actual.
    const pagos = buildDayClosePayments(
      week.map((a) => ({
        eaAppointmentId: a.eaAppointmentId,
        amountCharged: a.totals.amountCharged,
        tip: a.totals.tip,
        paymentMethod: a.method,
        paidOn: a.date,
        eaProviderId: a.eaProviderId,
        performedServiceId: a.performedServiceId,
      })),
    );

    expect(new Set(pagos.map((p) => p.source_tx_id)).size).toBe(pagos.length);
    expect(pagos.reduce((sum, p) => sum + p.amount, 0)).toBe(870_000);
    expect(pagos.reduce((sum, p) => sum + p.tip, 0)).toBe(60_000);
  });

  it("la invariante del ticket se sostiene en las diez cuentas", () => {
    for (const appointment of week) {
      const subtotal = appointment.totals.lines.reduce((sum, l) => sum + l.lineTotal, 0);

      expect(subtotal - appointment.totals.discount).toBe(appointment.totals.amountCharged);
      expect(appointment.totals.lines.reduce((sum, l) => sum + l.netTotal, 0)).toBe(
        appointment.totals.amountCharged,
      );
    }
  });
});
