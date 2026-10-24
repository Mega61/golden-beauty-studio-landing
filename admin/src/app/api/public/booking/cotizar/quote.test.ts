import { describe, expect, it } from "vitest";

import { parseEaLocalDate } from "@/lib/ea/datetime";
import { buildQuoteLines, createLookupGate, quoteVisit, type QuoteService } from "./quote";

const WED = parseEaLocalDate("2026-10-14");
const SAT = parseEaLocalDate("2026-10-17");
const FRI = parseEaLocalDate("2026-10-16");

const svc = (id: number, price: number | null, extra: Partial<QuoteService> = {}): QuoteService => ({
  id,
  price,
  isPrivate: false,
  duration: 60,
  ...extra,
});

const SERVICES = [
  svc(1, 40000), // pies tradicional
  svc(2, 95000), // semipermanente manos
  svc(3, 120000), // combo semi manos + pies
  svc(4, 100000), // press on
  svc(9, 5000, { isPrivate: true }), // adicional privado
  svc(10, 30000, { duration: null }),
];
const SLUGS = new Map([
  [1, "traditional-feet"],
  [2, "semi-permanent-hands"],
  [3, "semi-permanent-hands-feet"],
  [4, "press-on"],
]);

const lines = (serviceId: number, thenServiceId: number | null = null) =>
  buildQuoteLines({ serviceId, thenServiceId }, SERVICES, SLUGS)!;

describe("buildQuoteLines", () => {
  it("un servicio, con el precio de EA y su id de vitrina", () => {
    expect(lines(1)).toEqual([{ key: "1", pricingId: "traditional-feet", listPrice: 40000, kind: "servicio" }]);
  });

  it("un par sin combo son dos renglones de servicio", () => {
    expect(lines(2, 1).map((l) => l.pricingId)).toEqual(["semi-permanent-hands", "traditional-feet"]);
  });

  it("no cotiza lo que no se puede reservar", () => {
    expect(buildQuoteLines({ serviceId: 99, thenServiceId: null }, SERVICES, SLUGS)).toBeNull();
    expect(buildQuoteLines({ serviceId: 9, thenServiceId: null }, SERVICES, SLUGS)).toBeNull();
    expect(buildQuoteLines({ serviceId: 10, thenServiceId: null }, SERVICES, SLUGS)).toBeNull();
    expect(buildQuoteLines({ serviceId: 2, thenServiceId: 9 }, SERVICES, SLUGS)).toBeNull();
  });

  it("sin vínculo en service_map no hay id de vitrina; sin precio, cero", () => {
    expect(buildQuoteLines({ serviceId: 5, thenServiceId: null }, [svc(5, null)], new Map())).toEqual([
      { key: "5", pricingId: null, listPrice: 0, kind: "servicio" },
    ]);
  });
});

describe("quoteVisit", () => {
  it("miércoles de pies: precio de promo, sin teléfono", () => {
    expect(quoteVisit(lines(1), WED, null)).toEqual({
      subtotal: 40000,
      promo: { slug: "miercoles-pies", label: "Miércoles de pies", discount: 15000 },
      total: 25000,
      firstVisit: null,
    });
  });

  it("otro día no hay promo del día", () => {
    expect(quoteVisit(lines(1), FRI, false)).toMatchObject({ promo: null, total: 40000 });
  });

  it("primera visita sin promo del día: 10% sobre los servicios", () => {
    expect(quoteVisit(lines(2), FRI, true)).toMatchObject({
      promo: { slug: "primera-visita", discount: 9500 },
      total: 85500,
      firstVisit: true,
    });
  });

  it("no se acumulan: gana el mayor (miércoles de pies le gana al 10%)", () => {
    expect(quoteVisit(lines(1), WED, true)).toMatchObject({ promo: { slug: "miercoles-pies" }, total: 25000 });
  });

  it("no se acumulan: gana el mayor (el 10% del par le gana al miércoles)", () => {
    // 10% de 135.000 = 13.500 < 15.000 → miércoles. Con unas manos más caras el
    // 10% pasa adelante.
    expect(quoteVisit(lines(2, 1), WED, true)).toMatchObject({ promo: { slug: "miercoles-pies" }, total: 120000 });
    const pricey = buildQuoteLines({ serviceId: 7, thenServiceId: 1 }, [...SERVICES, svc(7, 200000)], SLUGS)!;
    expect(quoteVisit(pricey, WED, true)).toMatchObject({ promo: { slug: "primera-visita", discount: 24000 } });
  });

  it("un combo en miércoles paga sus mitades con la promo si sale menos, sin sumarle el 10%", () => {
    // Combo $120.000 vs semi manos $50.000 + semi pies en promo $40.000 = $90.000.
    expect(quoteVisit(lines(3), WED, false)).toMatchObject({ promo: { slug: "miercoles-pies", discount: 30000 }, total: 90000 });
    expect(quoteVisit(lines(3), WED, true)).toMatchObject({ promo: { slug: "miercoles-pies", discount: 30000 }, total: 90000 });
    // Otro día, el 10% sobre el precio del combo.
    expect(quoteVisit(lines(3), FRI, true)).toMatchObject({ promo: { slug: "primera-visita", discount: 12000 } });
  });

  it("'no se sabe' no promete el 10%", () => {
    expect(quoteVisit(lines(4), FRI, null)).toMatchObject({ promo: null, firstVisit: null });
    expect(quoteVisit(lines(4), SAT, null)).toMatchObject({ promo: { slug: "sabado-press" }, total: 80000 });
  });
});

describe("createLookupGate", () => {
  it("recuerda por teléfono hasta que vence", () => {
    let t = 0;
    const gate = createLookupGate({ maxLookups: 1, windowMs: 1000, memoMs: 500, now: () => t });
    expect(gate.remembered("+573001234567")).toBeUndefined();
    gate.remember("+573001234567", true);
    expect(gate.remembered("+573001234567")).toBe(true);
    t = 500;
    expect(gate.remembered("+573001234567")).toBeUndefined();
  });

  it("corta las consultas nuevas pasado el cupo, y lo devuelve con la ventana", () => {
    let t = 0;
    const gate = createLookupGate({ maxLookups: 2, windowMs: 1000, memoMs: 500, now: () => t });
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(true);
    expect(gate.take()).toBe(false);
    t = 1000;
    expect(gate.take()).toBe(true);
  });

  it("no crece sin techo: se van primero los más viejos", () => {
    const gate = createLookupGate({ maxLookups: 1, windowMs: 1, memoMs: 10_000, maxEntries: 2, now: () => 0 });
    gate.remember("a", true);
    gate.remember("b", false);
    gate.remember("c", true);
    expect(gate.remembered("a")).toBeUndefined();
    expect(gate.remembered("b")).toBe(false);
    expect(gate.remembered("c")).toBe(true);
  });
});
