import { describe, expect, it } from "vitest";

import { dayPromoOn, parseQuote, promoHints, visitPricing, type DayPromo } from "./booking-promo";

const WED = "2026-10-14";
const SAT = "2026-10-17";
const FRI = "2026-10-16";

const feet: DayPromo[] = [{ slug: "miercoles-pies", label: "Miércoles de pies", weekday: 3, promoCOP: 25000 }];
const press: DayPromo[] = [{ slug: "sabado-press", label: "Sábado de Press", weekday: 6, promoCOP: 80000 }];

describe("dayPromoOn", () => {
  it("aplica solo el día de la semana de la promo", () => {
    expect(dayPromoOn([{ priceCOP: 40000, dayPromos: feet }], WED)).toEqual({ slug: "miercoles-pies", discount: 15000 });
    expect(dayPromoOn([{ priceCOP: 40000, dayPromos: feet }], FRI)).toBeNull();
    expect(dayPromoOn([{ priceCOP: 100000, dayPromos: press }], SAT)).toEqual({ slug: "sabado-press", discount: 20000 });
  });

  it("en un par, solo baja la mitad que tiene promo", () => {
    expect(dayPromoOn([{ priceCOP: 95000 }, { priceCOP: 40000, dayPromos: feet }], WED)).toEqual({
      slug: "miercoles-pies",
      discount: 15000,
    });
  });

  it("un precio de promo que no ahorra no cuenta", () => {
    expect(dayPromoOn([{ priceCOP: 20000, dayPromos: feet }], WED)).toBeNull();
  });

  it("sin promos (un combo) no hay nada", () => {
    expect(dayPromoOn([{ priceCOP: 120000, dayPromos: [] }], WED)).toBeNull();
  });
});

describe("promoHints", () => {
  it("una por día, la más barata, de lunes a domingo", () => {
    const hints = promoHints(100000, [
      ...press,
      { slug: "x", label: "X", weekday: 6, promoCOP: 70000 },
      { slug: "y", label: "Y", weekday: 0, promoCOP: 90000 },
      ...feet,
    ]);
    expect(hints.map((h) => [h.weekday, h.promoCOP])).toEqual([
      [3, 25000],
      [6, 70000],
      [0, 90000],
    ]);
  });

  it("descarta lo que no queda por debajo del precio", () => {
    expect(promoHints(25000, feet)).toEqual([]);
    expect(promoHints(40000, undefined)).toEqual([]);
  });
});

describe("parseQuote", () => {
  it("acepta la respuesta del panel", () => {
    expect(
      parseQuote({
        subtotal: 95000,
        promo: { slug: "primera-visita", label: "10% primera visita", discount: 9500 },
        total: 85500,
        firstVisit: true,
      }),
    ).toEqual({ subtotal: 95000, promo: { slug: "primera-visita", discount: 9500 }, total: 85500, firstVisit: true });
  });

  it("firstVisit desconocido es null", () => {
    expect(parseQuote({ subtotal: 1, promo: null, total: 1 })?.firstVisit).toBeNull();
  });

  it.each([
    null,
    "x",
    { subtotal: "1", total: 1 },
    { subtotal: 100, total: 200, promo: null },
    { subtotal: 100, total: 90, promo: { slug: "x", discount: -1 } },
    { subtotal: 100, total: 90, promo: "x" },
  ])("descarta %j", (body) => expect(parseQuote(body)).toBeNull());
});

describe("visitPricing", () => {
  it("sin cotización: precio de lista menos la promo del día", () => {
    expect(visitPricing(40000, { slug: "miercoles-pies", discount: 15000 }, null)).toEqual({
      promo: { slug: "miercoles-pies", discount: 15000 },
      total: 25000,
      firstVisit: null,
    });
    expect(visitPricing(40000, null, null)).toEqual({ promo: null, total: 40000, firstVisit: null });
  });

  it("con cotización, manda la cotización", () => {
    expect(
      visitPricing(
        95000,
        null,
        { subtotal: 95000, promo: { slug: "primera-visita", discount: 9500 }, total: 85500, firstVisit: true },
      ),
    ).toEqual({ promo: { slug: "primera-visita", discount: 9500 }, total: 85500, firstVisit: true });
  });
});
