import { describe, expect, it } from "vitest";

import type { GiftCardQuote } from "@/lib/gift-cards";
import { assertPaymentsCoverCharge } from "@/lib/ticket";

import type { CatalogService, TicketCatalog } from "./catalog";
import {
  amountAfterGiftCard,
  draftFromFinance,
  draftToPayments,
  emptyDraft,
  isDirty,
  priceDraft,
  tipMethodFor,
  tipNeedsMethod,
  type TicketDraft,
  type TicketPricing,
} from "./draft";
import { parseDraft } from "./draft-store";

/**
 * La tarjeta regalo **en la cuenta**: una promocional es un descuento que
 * compite con la promo (gana el mayor, nunca se suman), una pagada es un pago
 * `bono` que cubre lo que alcance. La misma función en la hoja y en el
 * servidor, como todo lo demás del borrador.
 *
 * Miércoles 2026-10-14: semipermanente pies 55.000 → promo 40.000 (−15.000).
 */

const SEMI_PIES = 2;
const DISENO = 10;

function service(over: Partial<CatalogService> & { eaServiceId: number }): CatalogService {
  return {
    name: `Servicio ${over.eaServiceId}`,
    listPrice: 10_000,
    durationMin: 60,
    categoryId: 1,
    categoryName: "Sencillos",
    pricingId: null,
    isExtra: false,
    ...over,
  };
}

const CATALOGO: TicketCatalog = {
  services: [
    service({ eaServiceId: SEMI_PIES, name: "Semipermanente pies", listPrice: 55_000, pricingId: "semi-permanent-feet" }),
    service({ eaServiceId: DISENO, name: "Diseño", listPrice: 10_000, isExtra: true, pricingId: "design-per-nail" }),
  ],
};

const CODE = "TR-AB12-CD34";

function card(over: Partial<GiftCardQuote> = {}): GiftCardQuote {
  return {
    code: CODE,
    amountCop: 20_000,
    funded: false,
    minTicketCop: null,
    tierName: null,
    recipientName: null,
    validTo: null,
    ...over,
  };
}

function pricing(giftCard: GiftCardQuote | null, promoDate: string | null = "2026-10-14"): TicketPricing {
  return {
    bookedServiceId: SEMI_PIES,
    bookedSnapshot: 55_000,
    promoDate: promoDate as TicketPricing["promoDate"],
    giftCard,
  };
}

function draft(over: Partial<TicketDraft> = {}): TicketDraft {
  return { ...emptyDraft(7001, SEMI_PIES, 1_000), giftCardCode: CODE, ...over };
}

describe("tarjeta promocional contra la promo: gana el mayor", () => {
  it("la tarjeta descuenta más que el miércoles de pies: va la tarjeta, sola", () => {
    const result = priceDraft(draft(), CATALOGO, pricing(card({ amountCop: 20_000 })));
    expect(result.totals?.discount).toBe(20_000);
    expect(result.totals?.amountCharged).toBe(35_000);
    expect(result.promo).toBeNull();
    expect(result.giftCard).toEqual({ code: CODE, discount: 20_000 });
    expect(result.varianceReasonCode).toBe("promo");
    expect(result.errors).toEqual([]);
  });

  it("la promo descuenta más: va la promo y la tarjeta queda para otra visita", () => {
    const result = priceDraft(draft(), CATALOGO, pricing(card({ amountCop: 10_000 })));
    expect(result.totals?.discount).toBe(15_000);
    expect(result.promo?.slug).toBe("miercoles-pies");
    expect(result.giftCard).toBeNull();
    expect(result.giftCardNote).toMatch(/queda para otra visita/);
  });

  it("empate: gana la promo (la tarjeta no se gasta)", () => {
    const result = priceDraft(draft(), CATALOGO, pricing(card({ amountCop: 15_000 })));
    expect(result.promo?.slug).toBe("miercoles-pies");
    expect(result.giftCard).toBeNull();
  });

  it("sin promo prendida, la tarjeta va sola", () => {
    const result = priceDraft(draft({ applyPromo: false }), CATALOGO, pricing(card({ amountCop: 5_000 })));
    expect(result.totals?.discount).toBe(5_000);
    expect(result.giftCard?.discount).toBe(5_000);
  });

  it("nunca deja la cuenta en negativo: descuenta como mucho el subtotal", () => {
    const result = priceDraft(draft({ applyPromo: false }), CATALOGO, pricing(card({ amountCop: 200_000 }), null));
    expect(result.totals?.amountCharged).toBe(0);
    expect(result.giftCard?.discount).toBe(55_000);
  });

  it("por debajo del ticket mínimo no aplica, y se dice por qué", () => {
    const result = priceDraft(
      draft({ applyPromo: false }),
      CATALOGO,
      pricing(card({ amountCop: 20_000, minTicketCop: 60_000 })),
    );
    expect(result.giftCard).toBeNull();
    expect(result.totals?.discount).toBe(0);
    expect(result.giftCardNote).toMatch(/al menos/);

    // Con un adicional pasa el mínimo.
    const conDiseno = priceDraft(
      draft({ applyPromo: false, extras: { [String(DISENO)]: 1 } }),
      CATALOGO,
      pricing(card({ amountCop: 20_000, minTicketCop: 60_000 })),
    );
    expect(conDiseno.giftCard?.discount).toBe(20_000);
  });

  it("un total escrito a mano manda: la tarjeta no se suma por debajo", () => {
    const result = priceDraft(
      draft({ totalOverride: 50_000, varianceReasonCode: "otro", varianceReason: "x" }),
      CATALOGO,
      pricing(card({ amountCop: 20_000 })),
    );
    expect(result.totals?.amountCharged).toBe(50_000);
    expect(result.giftCard).toBeNull();
    expect(result.varianceReasonCode).toBe("otro");
    expect(result.giftCardNote).toMatch(/total escrito a mano/);
  });

  it("una lectura de otro código no se aplica", () => {
    const result = priceDraft(draft({ giftCardCode: "TR-ZZZZ-ZZZZ" }), CATALOGO, pricing(card()));
    expect(result.giftCard).toBeNull();
  });

  it("la cortesía gana sobre la tarjeta", () => {
    const result = priceDraft(draft({ houseCourtesy: true }), CATALOGO, pricing(card()));
    expect(result.giftCard).toBeNull();
    expect(result.varianceReasonCode).toBe("cortesia");
  });
});

describe("tarjeta pagada: es un pago, no un descuento", () => {
  const pagada = card({ funded: true, amountCop: 100_000 });

  it("no toca el total ni la promo", () => {
    const result = priceDraft(draft(), CATALOGO, pricing(pagada));
    expect(result.totals?.amountCharged).toBe(40_000);
    expect(result.promo?.slug).toBe("miercoles-pies");
    expect(result.giftCard).toBeNull();
    expect(result.giftCardNote).toBeNull();
  });

  it("cubre toda la cuenta si alcanza: un solo pago bono y nada más", () => {
    const payments = draftToPayments(draft({ payments: [{ method: "efectivo", amount: 0 }] }), 40_000, pagada);
    expect(payments).toEqual([{ method: "bono", amount: 40_000 }]);
    expect(() => assertPaymentsCoverCharge(payments, 40_000)).not.toThrow();
  });

  it("si no alcanza, el resto va con el método de la hoja", () => {
    const chica = card({ funded: true, amountCop: 30_000 });
    expect(amountAfterGiftCard(draft(), 40_000, chica)).toBe(10_000);
    const payments = draftToPayments(draft({ payments: [{ method: "transferencia", amount: 0 }] }), 40_000, chica);
    expect(payments).toEqual([
      { method: "bono", amount: 30_000 },
      { method: "transferencia", amount: 10_000 },
    ]);
    expect(() => assertPaymentsCoverCharge(payments, 40_000)).not.toThrow();
  });

  it("con dos métodos para el resto, los montos escritos se respetan", () => {
    const chica = card({ funded: true, amountCop: 20_000 });
    const payments = draftToPayments(
      draft({
        payments: [
          { method: "efectivo", amount: 10_000 },
          { method: "transferencia", amount: 10_000 },
        ],
      }),
      40_000,
      chica,
    );
    expect(payments).toEqual([
      { method: "bono", amount: 20_000 },
      { method: "efectivo", amount: 10_000 },
      { method: "transferencia", amount: 10_000 },
    ]);
  });

  it("tarjeta que paga todo + propina: el método de la hoja es el de la propina", () => {
    const pagos = draftToPayments(draft({ tip: 5_000, payments: [{ method: "efectivo", amount: 0 }] }), 40_000, pagada);
    expect(pagos).toEqual([{ method: "bono", amount: 40_000 }]);
    expect(tipMethodFor(draft({ tip: 5_000, payments: [{ method: "efectivo", amount: 0 }] }), pagos)).toBe("efectivo");
    expect(tipNeedsMethod(draft({ tip: 5_000 }), pagos)).toBe(true);
    expect(tipNeedsMethod(draft({ tip: 0 }), pagos)).toBe(false);
    // Con otro pago la propina va en él.
    const mixto = [{ method: "bono" as const, amount: 30_000 }, { method: "efectivo" as const, amount: 10_000 }];
    expect(tipMethodFor(draft({ tip: 5_000, payments: [{ method: "efectivo", amount: 0 }] }), mixto)).toBeNull();
    expect(tipNeedsMethod(draft({ tip: 5_000 }), mixto)).toBe(false);
  });

  it("al reabrir, el método de la propina vuelve como el elegido", () => {
    const reabierto = draftFromFinance(7001, SEMI_PIES, {
      performedServiceId: SEMI_PIES,
      discount: 15_000,
      tip: 5_000,
      amountCharged: 40_000,
      payments: [{ method: "bono", amount: 40_000 }],
      serviceNotes: "",
      varianceReasonCode: "promo",
      varianceReason: "miercoles-pies",
      giftCardCode: CODE,
      tipMethod: "transferencia",
      items: [{ kind: "servicio", eaServiceId: SEMI_PIES, qty: 1, unitPrice: 55_000, note: null }],
    });
    expect(reabierto.payments).toEqual([{ method: "transferencia", amount: 0 }]);
  });

  it("sin la lectura de la tarjeta, no hay pago bono", () => {
    expect(draftToPayments(draft({ payments: [{ method: "efectivo", amount: 0 }] }), 40_000, null)).toEqual([
      { method: "efectivo", amount: 40_000 },
    ]);
  });
});

describe("el borrador guarda solo el código", () => {
  it("se reabre una cuenta con tarjeta pagada: el código vuelve y el bono no es un método de la hoja", () => {
    const reabierto = draftFromFinance(7001, SEMI_PIES, {
      performedServiceId: SEMI_PIES,
      discount: 15_000,
      tip: 0,
      amountCharged: 40_000,
      payments: [{ method: "bono", amount: 40_000 }],
      serviceNotes: "",
      varianceReasonCode: "promo",
      varianceReason: "miercoles-pies",
      giftCardCode: CODE,
      items: [{ kind: "servicio", eaServiceId: SEMI_PIES, qty: 1, unitPrice: 55_000, note: null }],
    });
    expect(reabierto.giftCardCode).toBe(CODE);
    expect(reabierto.payments).toEqual([]);
    expect(reabierto.applyPromo).toBe(true);
  });

  it("se reabre una cuenta con tarjeta promocional: código desde el motivo, sin primera visita", () => {
    const reabierto = draftFromFinance(7001, SEMI_PIES, {
      performedServiceId: SEMI_PIES,
      discount: 20_000,
      tip: 0,
      amountCharged: 35_000,
      payments: [{ method: "efectivo", amount: 35_000 }],
      serviceNotes: "",
      varianceReasonCode: "promo",
      varianceReason: `bono ${CODE}`,
      items: [{ kind: "servicio", eaServiceId: SEMI_PIES, qty: 1, unitPrice: 55_000, note: null }],
    });
    expect(reabierto.giftCardCode).toBe(CODE);
    expect(reabierto.firstVisit).toBe(false);
    expect(reabierto.totalOverride).toBeNull();
    // Y valorado con la misma tarjeta, cobra lo mismo que al cerrarla.
    const precio = priceDraft(reabierto, CATALOGO, pricing(card({ amountCop: 20_000 })));
    expect(precio.totals?.amountCharged).toBe(35_000);
  });

  it("cambiar la tarjeta ensucia el borrador; el código sobrevive al localStorage", () => {
    const base = draft({ giftCardCode: null });
    expect(isDirty(draft(), base)).toBe(true);
    expect(parseDraft(JSON.parse(JSON.stringify(draft())))?.giftCardCode).toBe(CODE);
    expect(parseDraft(JSON.parse(JSON.stringify({ ...draft(), giftCardCode: "tr ab12 cd34" })))?.giftCardCode).toBe(CODE);
    expect(parseDraft(JSON.parse(JSON.stringify({ ...draft(), giftCardCode: "basura" })))?.giftCardCode).toBeNull();
  });
});
