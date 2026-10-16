import { describe, expect, it } from "vitest";

import { parseEaLocalDate } from "@/lib/ea/datetime";
import { bestPromo, dayPromosFor, weekdayOf, type PromoLineInput } from "./promos";

const WED = parseEaLocalDate("2026-10-14");
const SAT = parseEaLocalDate("2026-10-17");
const FRI = parseEaLocalDate("2026-10-16");

const line = (pricingId: string | null, listPrice: number, kind: PromoLineInput["kind"] = "servicio"): PromoLineInput => ({
  key: `${pricingId}-${kind}`,
  pricingId,
  listPrice,
  kind,
});

describe("weekdayOf", () => {
  it("lee el día calendario", () => {
    expect(weekdayOf(WED)).toBe(3);
    expect(weekdayOf(SAT)).toBe(6);
    expect(weekdayOf(FRI)).toBe(5);
  });
});

describe("bestPromo", () => {
  it("aplica Sábado de Press solo un sábado", () => {
    expect(bestPromo({ lines: [line("press-on", 100000)], date: SAT, isFirstVisit: false })).toMatchObject({
      slug: "sabado-press",
      discount: 20000,
    });
    expect(bestPromo({ lines: [line("press-on", 100000)], date: FRI, isFirstVisit: false })).toBeNull();
  });

  it("Miércoles de pies rebaja cada servicio de pies", () => {
    const quote = bestPromo({
      lines: [line("semi-permanent-feet", 55000), line("in-depth-foot-cleaning", 15000, "adicional")],
      date: WED,
      isFirstVisit: false,
    });
    expect(quote).toMatchObject({ slug: "miercoles-pies", discount: 15000 });
    expect(quote?.perLine).toEqual([{ key: "semi-permanent-feet-servicio", discount: 15000 }]);
  });

  it("un combo no recibe la promo del día", () => {
    expect(bestPromo({ lines: [line("semi-permanent-hands-feet", 95000)], date: WED, isFirstVisit: false })).toBeNull();
  });

  it("primera visita: 10% de los servicios, no de los adicionales, redondeado a la centena", () => {
    const quote = bestPromo({
      lines: [line("rubber-base-leveling", 70000), line("design-per-nail", 30000, "adicional")],
      date: FRI,
      isFirstVisit: true,
    });
    expect(quote).toMatchObject({ kind: "primera_visita", discount: 7000 });
    expect(bestPromo({ lines: [line("traditional-hands", 33333)], date: FRI, isFirstVisit: true })?.discount).toBe(3300);
  });

  it("no se acumulan: gana el descuento mayor", () => {
    // Miércoles, semi pies: promo $15.000 vs 10% = $5.500 → gana la del día.
    expect(bestPromo({ lines: [line("semi-permanent-feet", 55000)], date: WED, isFirstVisit: true })).toMatchObject({
      slug: "miercoles-pies",
      discount: 15000,
    });
    // Miércoles, polygel + tradicional pies: promo $10.000 vs 10% de 155.000 → gana el 10%.
    expect(
      bestPromo({ lines: [line("polygel-sculpted", 120000), line("traditional-feet", 35000)], date: WED, isFirstVisit: true }),
    ).toMatchObject({ kind: "primera_visita", discount: 15500 });
  });

  it("en un empate gana la promo del día", () => {
    // Lista 88.900: promo = 88.900 − 80.000 = 8.900; 10% = 8.890 → 8.900. Empate.
    const quote = bestPromo({ lines: [line("press-on", 88900)], date: SAT, isFirstVisit: true });
    expect(quote?.kind).toBe("dia");
  });

  it("una lista ya por debajo de la promo no genera descuento", () => {
    expect(bestPromo({ lines: [line("press-on", 75000)], date: SAT, isFirstVisit: false })).toBeNull();
  });
});

describe("dayPromosFor", () => {
  it("lista las promos de un servicio para pintarlas antes de elegir fecha", () => {
    expect(dayPromosFor("traditional-feet")).toEqual([
      { slug: "miercoles-pies", label: "Miércoles de pies", weekday: 3, promoCOP: 25000 },
    ]);
    expect(dayPromosFor("polygel-refill")).toEqual([]);
    expect(dayPromosFor(null)).toEqual([]);
  });
});
