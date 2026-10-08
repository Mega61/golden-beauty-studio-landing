import { afterEach, describe, expect, it } from "vitest";
import { getActiveScenario, getActiveScenarios } from "./promos";
import { PROMOS_DATA as ES } from "./promos.es";
import { PROMOS_DATA as EN } from "./promos.en";
import { PROMO_PRICES, promoPriceRows } from "./promo-prices";
import { getPriceCOP } from "./pricing";

const original = process.env.NEXT_PUBLIC_ACTIVE_PROMO;

function setPromo(value: string | undefined) {
  if (value === undefined) delete process.env.NEXT_PUBLIC_ACTIVE_PROMO;
  else process.env.NEXT_PUBLIC_ACTIVE_PROMO = value;
}

afterEach(() => setPromo(original));

describe("getActiveScenarios", () => {
  it("returns nothing when the env var is unset", async () => {
    setPromo(undefined);
    expect(await getActiveScenarios("es")).toEqual([]);
  });

  it("returns nothing for an empty string", async () => {
    setPromo("");
    expect(await getActiveScenarios("es")).toEqual([]);
  });

  it.each(["vacio", "none", "off"])(
    "treats %s as no promo at all",
    async (token) => {
      setPromo(token);
      expect(await getActiveScenarios("es")).toEqual([]);
    },
  );

  it("drops an off-token that appears alongside a real slug", async () => {
    setPromo("apertura,none");
    const result = await getActiveScenarios("es");
    expect(result.map((s) => s.slug)).toEqual(["apertura"]);
  });

  it("resolves a single slug", async () => {
    setPromo("apertura");
    const result = await getActiveScenarios("es");
    expect(result).toHaveLength(1);
    expect(result[0]?.slug).toBe("apertura");
  });

  /**
   * Order is not incidental — it is the carousel order in the top strip and in
   * Highlights, and the first slug is the one the /bio teaser features.
   */
  it("preserves the order the env var lists", async () => {
    setPromo("primera-visita,apertura");
    const result = await getActiveScenarios("es");
    expect(result.map((s) => s.slug)).toEqual(["primera-visita", "apertura"]);
  });

  it("drops duplicates but keeps the first occurrence's position", async () => {
    setPromo("apertura,primera-visita,apertura");
    const result = await getActiveScenarios("es");
    expect(result.map((s) => s.slug)).toEqual(["apertura", "primera-visita"]);
  });

  it("tolerates whitespace and mixed case around slugs", async () => {
    setPromo("  APERTURA , Primera-Visita  ");
    const result = await getActiveScenarios("es");
    expect(result.map((s) => s.slug)).toEqual(["apertura", "primera-visita"]);
  });

  it("ignores a slug that has no scenario", async () => {
    setPromo("apertura,promo-que-no-existe");
    const result = await getActiveScenarios("es");
    expect(result.map((s) => s.slug)).toEqual(["apertura"]);
  });

  it("serves the English scenarios for the en locale", async () => {
    setPromo("apertura");
    const [es] = await getActiveScenarios("es");
    const [en] = await getActiveScenarios("en");
    expect(es?.slug).toBe(en?.slug);
    expect(en?.strip?.message).not.toBe(es?.strip?.message);
  });

  it("never returns a scenario with neither a strip nor items", async () => {
    setPromo("apertura,primera-visita");
    for (const scenario of await getActiveScenarios("es")) {
      expect(Boolean(scenario.strip) || scenario.items.length > 0).toBe(true);
    }
  });
});

describe("getActiveScenario", () => {
  it("returns the first scenario in env order", async () => {
    setPromo("primera-visita,apertura");
    expect((await getActiveScenario("es"))?.slug).toBe("primera-visita");
  });

  it("returns null when no promo is active", async () => {
    setPromo("off");
    expect(await getActiveScenario("es")).toBeNull();
  });
});

describe("the current lineup", () => {
  const LINEUP = "sabado-press,miercoles-pies,primera-visita";

  it("resolves all three, in env order, in both languages", async () => {
    setPromo(LINEUP);
    for (const lang of ["es", "en"] as const) {
      const result = await getActiveScenarios(lang);
      expect(result.map((s) => s.slug)).toEqual(LINEUP.split(","));
    }
  });

  it("shows the same flyer in both languages", async () => {
    setPromo(LINEUP);
    const es = await getActiveScenarios("es");
    const en = await getActiveScenarios("en");
    expect(en.map((s) => s.items[0]?.image_url)).toEqual(es.map((s) => s.items[0]?.image_url));
  });
});

describe("portrait flyers", () => {
  // A flyer carries its prices as pixels. Without a real alt, a screen reader
  // hears the title and none of the numbers.
  it("always carry an alt that is more than the title", () => {
    for (const data of [ES, EN]) {
      for (const scenario of Object.values(data)) {
        for (const item of scenario.items) {
          if (item.image_orientation !== "portrait") continue;
          expect(item.image_url, `${scenario.slug}/${item.id}`).toBeTruthy();
          expect(item.image_alt, `${scenario.slug}/${item.id}`).toBeTruthy();
          expect(item.image_alt).not.toBe(item.title);
        }
      }
    }
  });
});

describe("promo prices", () => {
  // A strikethrough that saves nothing is false advertising.
  it("are below the regular price they are shown against", () => {
    for (const [slug, rows] of Object.entries(PROMO_PRICES)) {
      for (const row of rows) {
        const regular = getPriceCOP(row.regularId);
        expect(regular, `${slug}/${row.key}: ${row.regularId} not in pricing.ts`).not.toBeNull();
        expect(row.promoCOP, `${slug}/${row.key}`).toBeLessThan(regular!);
      }
    }
  });

  it("render the same amounts in both languages, each in its own format", () => {
    const es = promoPriceRows("sabado-press", "es", { "press-on": "Press On" });
    const en = promoPriceRows("sabado-press", "en", { "press-on": "Press On" });
    expect(es).toEqual([{ label: "Press On", price: "$80.000", was: "$100.000" }]);
    expect(en).toEqual([{ label: "Press On", price: "$80,000 COP", was: "$100,000 COP" }]);
  });
});
