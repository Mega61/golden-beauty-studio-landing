import { describe, expect, it } from "vitest";

import type { BasisPoints } from "@/db/types";
import type { CommissionRuleInput } from "@/lib/commission";
import { parseEaLocalDate } from "@/lib/ea";
import { commissionBasesOf } from "@/lib/ticket";
import {
  fortnightOf,
  planFortnight,
  type CommissionAccount,
} from "@/jobs/commission-run";

import type { CatalogService, TicketCatalog } from "./catalog";
import {
  addService,
  draftFromFinance,
  draftToItems,
  emptyDraft,
  isDirty,
  mergeIntoCombo,
  priceDraft,
  promoDateOf,
  removeService,
  type TicketDraft,
  type TicketPricing,
} from "./draft";
import { parseDraft } from "./draft-store";

/**
 * Las promos y el segundo servicio **al cerrar la cuenta** (pedidos 4, 5, 7 y 8
 * de la dueña, 2026-10-16).
 *
 * Las reglas, en palabras de la dueña:
 *
 * - Miércoles de pies y sábado de press-on se cobran a precio de promo cuando
 *   la técnica cierra la cuenta, y se recalculan si cambia lo que se hizo.
 * - Primera visita: 10 % en los servicios, nunca en los adicionales.
 * - No se acumulan: gana el descuento mayor (empate → la del día).
 * - Un combo en día de promo paga lo menor entre el combo y sus mitades con la
 *   promo puesta; nunca las dos rebajas juntas. El 10 % va sobre el combo.
 * - La comisión del 40 % va sobre lo cobrado con promo: un descuento normal.
 * - Un par que no es combo (rubber + pies) se cobra como dos servicios, cada
 *   uno a su lista; si el par sí es un combo, se ofrece cobrarlo como el combo.
 *
 * Los precios salen de `src/data/pricing.ts` y `src/data/promo-rules.ts`:
 * semipermanente pies 55.000 (promo 40.000), pies tradicional 35.000 (promo
 * 25.000), press-on 100.000 (promo 80.000), rubber 70.000.
 */

const RUBBER = 1;
const SEMI_PIES = 2;
const PIES_TRAD = 3;
const PRESS_ON = 4;
const SEMI_MANOS = 5;
const COMBO_SEMI = 6;
const DISENO = 10;

function service(over: Partial<CatalogService> & { eaServiceId: number }): CatalogService {
  return {
    name: `Servicio ${over.eaServiceId}`,
    listPrice: 10_000,
    durationMin: 60,
    categoryId: 1,
    categoryName: "Montajes",
    pricingId: null,
    isExtra: false,
    ...over,
  };
}

const CATALOGO: TicketCatalog = {
  services: [
    service({ eaServiceId: RUBBER, name: "Rubber nivelación", listPrice: 70_000, pricingId: "rubber-base-leveling" }),
    service({ eaServiceId: SEMI_PIES, name: "Semipermanente pies", listPrice: 55_000, pricingId: "semi-permanent-feet", categoryName: "Sencillos" }),
    service({ eaServiceId: PIES_TRAD, name: "Pies tradicional", listPrice: 35_000, pricingId: "traditional-feet", categoryName: "Sencillos" }),
    service({ eaServiceId: PRESS_ON, name: "Press-on", listPrice: 100_000, pricingId: "press-on" }),
    service({ eaServiceId: SEMI_MANOS, name: "Semipermanente manos", listPrice: 60_000, pricingId: "semi-permanent-hands", categoryName: "Sencillos" }),
    service({
      eaServiceId: COMBO_SEMI,
      name: "Semipermanente manos + pies",
      listPrice: 100_000,
      pricingId: "semi-permanent-hands-feet",
      categoryName: "Combos",
    }),
    service({
      eaServiceId: DISENO,
      name: "Diseño por uña",
      listPrice: 10_000,
      categoryName: "Extras",
      pricingId: "design-per-nail",
      isExtra: true,
    }),
  ],
};

const MIERCOLES = parseEaLocalDate("2026-10-14");
const JUEVES = parseEaLocalDate("2026-10-15");
const SABADO = parseEaLocalDate("2026-10-17");

/** Cita agendada sin precio congelado: cada renglón va a la lista de hoy. */
function el(date: typeof MIERCOLES, bookedServiceId: number | null = null): TicketPricing {
  return { bookedServiceId, bookedSnapshot: null, promoDate: date };
}

function borrador(performedServiceId: number, over: Partial<TicketDraft> = {}): TicketDraft {
  return { ...emptyDraft(77, performedServiceId, 1_000), ...over };
}

// ── La promo del día ────────────────────────────────────────────────────────

describe("priceDraft — promo del día al cerrar", () => {
  it("miércoles de pies: el semipermanente de pies se cobra a 40.000, sin pedir motivo", () => {
    const r = priceDraft(borrador(SEMI_PIES), CATALOGO, el(MIERCOLES));
    expect(r.errors).toEqual([]);
    expect(r.promo).toMatchObject({ kind: "dia", slug: "miercoles-pies", discount: 15_000 });
    expect(r.totals).toMatchObject({ subtotal: 55_000, discount: 15_000, amountCharged: 40_000 });
    expect(r.varianceReasonCode).toBe("promo");
  });

  it("los adicionales no bajan: solo el servicio de la promo", () => {
    const r = priceDraft(borrador(SEMI_PIES, { extras: { [String(DISENO)]: 2 } }), CATALOGO, el(MIERCOLES));
    expect(r.totals).toMatchObject({ subtotal: 75_000, discount: 15_000, amountCharged: 60_000 });
  });

  it("el jueves no hay promo: se cobra la lista", () => {
    const r = priceDraft(borrador(SEMI_PIES), CATALOGO, el(JUEVES));
    expect(r.availablePromo).toBeNull();
    expect(r.totals).toMatchObject({ discount: 0, amountCharged: 55_000 });
    expect(r.varianceReasonCode).toBeNull();
  });

  it("sábado de press-on", () => {
    const r = priceDraft(borrador(PRESS_ON), CATALOGO, el(SABADO));
    expect(r.promo?.slug).toBe("sabado-press");
    expect(r.totals?.amountCharged).toBe(80_000);
  });

  it("se recalcula cuando la técnica cambia lo que se hizo", () => {
    // Se agendó semipermanente de pies un miércoles; terminó en pies tradicional.
    const r = priceDraft(
      borrador(SEMI_PIES, { performedServiceId: PIES_TRAD }),
      CATALOGO,
      el(MIERCOLES, SEMI_PIES),
    );
    expect(r.promo?.discount).toBe(10_000);
    expect(r.totals?.amountCharged).toBe(25_000);

    // Y si cambió a algo sin promo, la promo desaparece sola.
    const sin = priceDraft(borrador(SEMI_PIES, { performedServiceId: RUBBER }), CATALOGO, el(MIERCOLES));
    expect(sin.availablePromo).toBeNull();
    expect(sin.totals?.amountCharged).toBe(70_000);
  });

  it("rebaja el precio congelado del agendado, no la lista de hoy", () => {
    const pricing: TicketPricing = { bookedServiceId: SEMI_PIES, bookedSnapshot: 50_000, promoDate: MIERCOLES };
    const r = priceDraft(borrador(SEMI_PIES), CATALOGO, pricing);
    expect(r.promo?.discount).toBe(10_000);
    expect(r.totals?.amountCharged).toBe(40_000);
  });

  it("quitada, no descuenta, pero la hoja la sigue ofreciendo", () => {
    const r = priceDraft(borrador(SEMI_PIES, { applyPromo: false }), CATALOGO, el(MIERCOLES));
    expect(r.errors).toEqual([]);
    expect(r.promo).toBeNull();
    expect(r.availablePromo?.discount).toBe(15_000);
    expect(r.totals?.amountCharged).toBe(55_000);
  });

  it("sin el día de la cita no hay promo: no se descuenta sobre un día que no se sabe", () => {
    const r = priceDraft(borrador(SEMI_PIES), CATALOGO, { bookedServiceId: null, bookedSnapshot: null });
    expect(r.availablePromo).toBeNull();
    expect(r.totals?.amountCharged).toBe(55_000);
  });

  it("promoDateOf saca el día de una hora de pared, y nada de un texto roto", () => {
    expect(promoDateOf("2026-10-14 10:30:00")).toBe("2026-10-14");
    expect(promoDateOf("")).toBeNull();
    expect(promoDateOf(null)).toBeNull();
    expect(promoDateOf("ayer")).toBeNull();
  });
});

// ── Primera visita ──────────────────────────────────────────────────────────

describe("priceDraft — 10 % primera visita", () => {
  it("el 10 % va sobre los servicios, no sobre los adicionales", () => {
    const r = priceDraft(
      borrador(RUBBER, { firstVisit: true, extras: { [String(DISENO)]: 2 } }),
      CATALOGO,
      el(JUEVES),
    );
    expect(r.promo).toMatchObject({ kind: "primera_visita", discount: 7_000 });
    expect(r.totals).toMatchObject({ subtotal: 90_000, amountCharged: 83_000 });
    expect(r.varianceReasonCode).toBe("promo");
  });

  it("no se acumula con la del día: gana la mayor", () => {
    // Miércoles, semipermanente de pies, primera visita: 15.000 contra 5.500.
    const r = priceDraft(borrador(SEMI_PIES, { firstVisit: true }), CATALOGO, el(MIERCOLES));
    expect(r.promo).toMatchObject({ slug: "miercoles-pies", discount: 15_000 });
    expect(r.totals?.amountCharged).toBe(40_000);
  });

  it("gana el 10 % cuando es mayor (dos servicios, uno solo con promo del día)", () => {
    // Rubber + pies tradicional un miércoles: el día rebaja 10.000; el 10 %
    // de 105.000 son 10.500.
    const r = priceDraft(
      borrador(RUBBER, { firstVisit: true, additionalServices: [PIES_TRAD] }),
      CATALOGO,
      el(MIERCOLES),
    );
    expect(r.promo).toMatchObject({ slug: "primera-visita", discount: 10_500 });
    expect(r.totals?.amountCharged).toBe(94_500);
  });

  it("un combo en miércoles cobra sus mitades con la promo si sale menos, sin sumarle el 10 %", () => {
    // Combo $100.000 vs semi manos $50.000 + semi pies en promo $40.000 = $90.000.
    const miercoles = priceDraft(borrador(COMBO_SEMI), CATALOGO, el(MIERCOLES));
    expect(miercoles.promo).toMatchObject({ slug: "miercoles-pies", discount: 10_000 });
    expect(miercoles.totals?.amountCharged).toBe(90_000);

    // Primera visita el mismo día: 10 % = $10.000, empate → la del día, una sola.
    const nueva = priceDraft(borrador(COMBO_SEMI, { firstVisit: true }), CATALOGO, el(MIERCOLES));
    expect(nueva.promo).toMatchObject({ slug: "miercoles-pies", discount: 10_000 });
    expect(nueva.totals?.amountCharged).toBe(90_000);

    // Otro día, el 10 % sobre el combo.
    const jueves = priceDraft(borrador(COMBO_SEMI, { firstVisit: true }), CATALOGO, el(JUEVES));
    expect(jueves.promo).toMatchObject({ slug: "primera-visita", discount: 10_000 });
  });

  it("sin la casilla no hay 10 %", () => {
    const r = priceDraft(borrador(RUBBER), CATALOGO, el(JUEVES));
    expect(r.availablePromo).toBeNull();
  });
});

// ── Total escrito y cortesía ────────────────────────────────────────────────

describe("priceDraft — la promo junto al total escrito y a la cortesía", () => {
  it("tocar el total y dejar el de la promo sigue siendo la promo, sin motivo", () => {
    const r = priceDraft(borrador(SEMI_PIES, { totalOverride: 40_000 }), CATALOGO, el(MIERCOLES));
    expect(r.errors).toEqual([]);
    expect(r.promo?.slug).toBe("miercoles-pies");
    expect(r.varianceReasonCode).toBe("promo");
  });

  it("cobrar menos que la promo es una rebaja de la técnica y pide su motivo", () => {
    const sinMotivo = priceDraft(borrador(SEMI_PIES, { totalOverride: 35_000 }), CATALOGO, el(MIERCOLES));
    expect(sinMotivo.promo).toBeNull();
    expect(sinMotivo.errors.join(" ")).toMatch(/no hay motivo/);

    const conMotivo = priceDraft(
      borrador(SEMI_PIES, { totalOverride: 35_000, varianceReasonCode: "otro" }),
      CATALOGO,
      el(MIERCOLES),
    );
    expect(conMotivo.errors).toEqual([]);
    expect(conMotivo.varianceReasonCode).toBe("otro");
    expect(conMotivo.totals).toMatchObject({ discount: 20_000, amountCharged: 35_000 });
  });

  it("cobrar la lista completa con la promo puesta no pide motivo", () => {
    const r = priceDraft(borrador(SEMI_PIES, { totalOverride: 55_000 }), CATALOGO, el(MIERCOLES));
    expect(r.errors).toEqual([]);
    expect(r.totals?.discount).toBe(0);
    expect(r.varianceReasonCode).toBeNull();
  });

  it("un borrador que trae `promo` como motivo propio no se salta la compuerta", () => {
    const r = priceDraft(
      borrador(SEMI_PIES, { totalOverride: 30_000, varianceReasonCode: "promo" }),
      CATALOGO,
      el(MIERCOLES),
    );
    expect(r.errors.join(" ")).toMatch(/no hay motivo/);
  });

  it("la cortesía gana: ni promo ni 10 %, cobro cero sobre la lista", () => {
    const r = priceDraft(
      borrador(SEMI_PIES, { houseCourtesy: true, firstVisit: true }),
      CATALOGO,
      el(MIERCOLES),
    );
    expect(r.promo).toBeNull();
    expect(r.availablePromo).toBeNull();
    expect(r.totals).toMatchObject({ subtotal: 55_000, discount: 55_000, amountCharged: 0 });
    // La comisión de la cortesía sigue siendo sobre la lista entera.
    expect(commissionBasesOf(r.totals!, true)).toEqual([55_000]);
  });
});

// ── Otro servicio ───────────────────────────────────────────────────────────

describe("servicios agregados", () => {
  it("rubber + pies: dos renglones `servicio`, cada uno a su lista", () => {
    const d = addService(borrador(RUBBER), SEMI_PIES);
    const { items, flags } = draftToItems(d, CATALOGO, el(JUEVES));
    expect(flags).toEqual([]);
    expect(items).toEqual([
      expect.objectContaining({ kind: "servicio", eaServiceId: RUBBER, unitPriceSnapshot: 70_000 }),
      expect.objectContaining({ kind: "servicio", eaServiceId: SEMI_PIES, unitPriceSnapshot: 55_000 }),
    ]);
    expect(priceDraft(d, CATALOGO, el(JUEVES)).totals?.amountCharged).toBe(125_000);
  });

  it("un miércoles, la promo de pies le toca al renglón agregado", () => {
    const r = priceDraft(addService(borrador(RUBBER), SEMI_PIES), CATALOGO, el(MIERCOLES));
    expect(r.promo?.perLine).toEqual([{ key: "1", discount: 15_000 }]);
    expect(r.totals?.amountCharged).toBe(110_000);
  });

  it("el agregado va a la lista de hoy, nunca al congelado del agendado", () => {
    // El congelado es del servicio que se reservó (rubber a 65.000). Si la
    // técnica agrega rubber otra vez —dos personas, una cuenta—, el segundo no
    // hereda ese precio.
    const pricing: TicketPricing = { bookedServiceId: RUBBER, bookedSnapshot: 65_000, promoDate: JUEVES };
    const { items } = draftToItems(addService(borrador(RUBBER), RUBBER), CATALOGO, pricing);
    expect(items.map((i) => i.unitPriceSnapshot)).toEqual([65_000, 70_000]);
  });

  it("un id que ya no está o que es un adicional no se cobra: se marca", () => {
    const d = { ...borrador(RUBBER), additionalServices: [999, DISENO] };
    const { items, flags } = draftToItems(d, CATALOGO, el(JUEVES));
    expect(items).toHaveLength(1);
    expect(flags.map((f) => f.label)).toEqual(["Servicio #999", "Servicio #10"]);
  });

  it("quitar y cobrar como combo", () => {
    const d = addService(borrador(SEMI_MANOS), SEMI_PIES);
    expect(removeService(d, 0).additionalServices).toEqual([]);

    const combo = mergeIntoCombo(d, 0, COMBO_SEMI);
    expect(combo.performedServiceId).toBe(COMBO_SEMI);
    expect(combo.additionalServices).toEqual([]);
    expect(priceDraft(combo, CATALOGO, el(JUEVES)).totals?.amountCharged).toBe(100_000);
  });

  it("agregar un servicio cuenta como un cambio", () => {
    const base = borrador(RUBBER);
    expect(isDirty(addService(base, SEMI_PIES), base)).toBe(true);
    expect(isDirty({ ...base, applyPromo: false }, base)).toBe(true);
    expect(isDirty({ ...base, firstVisit: true }, base)).toBe(true);
  });
});

// ── Reabrir la cuenta ───────────────────────────────────────────────────────

describe("draftFromFinance — reabrir una cuenta con promo o con dos servicios", () => {
  function guardada(d: TicketDraft, pricing: TicketPricing, reason: string) {
    const r = priceDraft(d, CATALOGO, pricing);
    const totals = r.totals!;
    return {
      performedServiceId: d.performedServiceId,
      discount: totals.discount,
      tip: 0,
      amountCharged: totals.amountCharged,
      payments: [],
      serviceNotes: "",
      varianceReasonCode: r.varianceReasonCode,
      varianceReason: reason,
      items: totals.lines.map((line) => ({
        kind: line.kind,
        eaServiceId: line.eaServiceId ?? null,
        qty: line.qty,
        unitPrice: line.unitPriceSnapshot,
        note: line.note ?? null,
      })),
    };
  }

  it("vuelve con la promo puesta, sin total escrito, y cobra lo mismo", () => {
    const d = addService(borrador(RUBBER), SEMI_PIES);
    const fila = guardada(d, el(MIERCOLES), "miercoles-pies");
    const reabierta = draftFromFinance(77, RUBBER, fila);

    expect(reabierta).toMatchObject({
      performedServiceId: RUBBER,
      additionalServices: [SEMI_PIES],
      applyPromo: true,
      firstVisit: false,
      totalOverride: null,
      varianceReasonCode: null,
    });
    expect(priceDraft(reabierta, CATALOGO, el(MIERCOLES)).totals?.amountCharged).toBe(fila.amountCharged);
  });

  it("una primera visita sin confirmar vuelve con la casilla puesta", () => {
    const d = borrador(RUBBER, { firstVisit: true });
    const fila = guardada(d, el(JUEVES), "primera-visita · sin confirmar en el historial");
    const reabierta = draftFromFinance(77, RUBBER, fila);
    expect(reabierta.firstVisit).toBe(true);
    expect(priceDraft(reabierta, CATALOGO, el(JUEVES)).totals?.amountCharged).toBe(63_000);
  });

  it("una cuenta cerrada sin promo no la gana sola al reabrirla", () => {
    // Cerrada antes de las promos, un miércoles, a lista. Reabrirla y guardar
    // sin tocar nada no puede cambiar lo que ya se cobró.
    const vieja = guardada(borrador(SEMI_PIES, { applyPromo: false }), el(MIERCOLES), "");
    const reabierta = draftFromFinance(77, SEMI_PIES, vieja);
    expect(reabierta.applyPromo).toBe(false);
    expect(priceDraft(reabierta, CATALOGO, el(MIERCOLES)).totals?.amountCharged).toBe(55_000);
  });
});

// ── El borrador guardado en el celular ──────────────────────────────────────

describe("parseDraft — los campos nuevos", () => {
  it("un borrador de antes no trae promo: no se aplica al reenviarlo", () => {
    const { additionalServices: _a, applyPromo: _p, firstVisit: _f, ...viejo } = borrador(SEMI_PIES);
    void _a;
    void _p;
    void _f;
    const parsed = parseDraft(viejo);
    expect(parsed).toMatchObject({ additionalServices: [], applyPromo: false, firstVisit: false });
  });

  it("lee los servicios agregados y descarta lo que no es un id", () => {
    const parsed = parseDraft({
      ...borrador(RUBBER),
      additionalServices: [SEMI_PIES, -1, "3", 1.5, PIES_TRAD],
      applyPromo: true,
      firstVisit: "true",
    });
    expect(parsed).toMatchObject({
      additionalServices: [SEMI_PIES, PIES_TRAD],
      applyPromo: true,
      firstVisit: false,
    });
  });
});

// ── La comisión ─────────────────────────────────────────────────────────────

describe("la comisión de una cuenta con promo y dos servicios", () => {
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

  it("el 40 % va sobre lo cobrado con promo, y el segundo servicio comisiona como el principal", () => {
    const r = priceDraft(addService(borrador(RUBBER), SEMI_PIES), CATALOGO, el(MIERCOLES));
    const totals = r.totals!;

    // Un descuento normal: la base es lo cobrado, repartido entre renglones.
    const bases = commissionBasesOf(totals, false);
    expect(bases.reduce((a, b) => a + b, 0)).toBe(110_000);

    const account: CommissionAccount = {
      financeId: 1,
      eaAppointmentId: 77,
      serviceDate: MIERCOLES,
      closed: true,
      eaProviderId: 3,
      secondaryEaProviderId: null,
      performedServiceId: RUBBER,
      discount: totals.discount,
      amountCharged: totals.amountCharged,
      tip: 0,
      houseCourtesy: false,
      items: totals.lines.map((line, index) => ({
        itemId: index + 1,
        kind: line.kind,
        eaServiceId: line.eaServiceId ?? null,
        pricingId: line.pricingId ?? null,
        qty: line.qty,
        unitPriceSnapshot: line.unitPriceSnapshot,
        lineTotal: line.lineTotal,
        note: line.note ?? null,
      })),
    };

    const plan = planFortnight({
      period: fortnightOf("2026-10-14"),
      accounts: [account],
      rules: [CUARENTA],
      combos: new Map<number, BasisPoints>(),
    });

    expect(plan.skipped).toEqual([]);
    expect(plan.entries).toHaveLength(2);
    expect(plan.entries.every((entry) => entry.flag === null && entry.rateBp === 4000)).toBe(true);
    expect(plan.totals).toEqual([
      expect.objectContaining({ eaProviderId: 3, base: 110_000, amount: 44_000 }),
    ]);
  });
});
