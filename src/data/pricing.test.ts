import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPriceCOP,
  getPricing,
  getStartingPriceCOP,
  pricing,
  type PricingCopy,
} from "./pricing";

describe("getPriceCOP", () => {
  it("finds an item in any category", () => {
    expect(getPriceCOP("acrylic-sculpted")).toBe(115000);
    expect(getPriceCOP("semi-permanent-hands-feet")).toBe(95000);
    expect(getPriceCOP("system-removal")).toBe(20000);
  });

  it("returns null for an unknown id rather than throwing or coercing", () => {
    expect(getPriceCOP("does-not-exist")).toBeNull();
  });

  it("is case-sensitive — ids are literal keys, not fuzzy matches", () => {
    expect(getPriceCOP("Acrylic-Sculpted")).toBeNull();
  });
});

describe("getStartingPriceCOP", () => {
  /**
   * `extras` holds per-nail add-ons and removals that nobody can book on their
   * own — `single-press-on-nail` is $10.000. If the exclusion ever breaks, the
   * meta description advertises "desde $10.000" for a service that does not
   * exist as a booking. That is the regression this test exists to catch.
   */
  it("excludes the extras category", () => {
    const cheapestExtra = Math.min(
      ...(pricing.find((c) => c.id === "extras")?.items ?? []).map(
        (i) => i.priceCOP,
      ),
    );
    expect(getStartingPriceCOP()).toBeGreaterThan(cheapestExtra);
  });

  it("returns the cheapest standalone bookable service", () => {
    const expected = Math.min(
      ...pricing
        .filter((c) => c.id !== "extras")
        .flatMap((c) => c.items.map((i) => i.priceCOP)),
    );
    expect(getStartingPriceCOP()).toBe(expected);
  });
});

describe("pricing data integrity", () => {
  it("has no duplicate item ids across categories", () => {
    const ids = pricing.flatMap((c) => c.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prices every item with a positive amount", () => {
    for (const cat of pricing) {
      for (const item of cat.items) {
        expect(item.priceCOP, `${cat.id}/${item.id}`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * Every combo is a hands service plus a feet service sold cheaper and faster
   * than the two bought separately — see docs/ADMIN-PANEL.md, where this is the
   * evidence for modelling a combo as one Easy!Appointments service rather than
   * two linked appointments. If a repricing ever makes a combo cost more than
   * its parts, the admin panel's combo builder would be publishing a worse deal
   * than the à-la-carte menu.
   */
  it("prices every combo below the sum of a plausible pair", () => {
    const combos = pricing.find((c) => c.id === "combos")?.items ?? [];
    expect(combos.length).toBeGreaterThan(0);
    const cheapestFeet = Math.min(
      getPriceCOP("semi-permanent-feet") ?? Infinity,
      getPriceCOP("traditional-feet") ?? Infinity,
    );
    for (const combo of combos) {
      expect(combo.priceCOP, combo.id).toBeGreaterThan(cheapestFeet);
    }
  });
});

describe("getPricing", () => {
  const copy: PricingCopy = {
    montajes: {
      label: "Montajes",
      sub: "Uña esculpida",
      items: {
        "acrylic-sculpted": { name: "Acrílico esculpido", desc: "Desc" },
      },
    },
  };

  const originalStrapiUrl = process.env.STRAPI_URL;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalStrapiUrl === undefined) delete process.env.STRAPI_URL;
    else process.env.STRAPI_URL = originalStrapiUrl;
  });

  it("uses the bundled fallback when STRAPI_URL is unset", async () => {
    delete process.env.STRAPI_URL;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await getPricing("es", copy);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.map((c) => c.id)).toEqual(pricing.map((c) => c.id));
  });

  it("names fallback items from the dictionary copy", async () => {
    delete process.env.STRAPI_URL;
    const result = await getPricing("es", copy);
    const montajes = result.find((c) => c.id === "montajes");
    expect(montajes?.label).toBe("Montajes");
    expect(
      montajes?.items.find((i) => i.id === "acrylic-sculpted")?.name,
    ).toBe("Acrílico esculpido");
  });

  it("falls back to the item id when the dictionary has no name for it", async () => {
    delete process.env.STRAPI_URL;
    const result = await getPricing("es", copy);
    const retoques = result.find((c) => c.id === "retoques");
    expect(retoques?.items[0]?.name).toBe(retoques?.items[0]?.id);
  });

  it("reads the CMS when STRAPI_URL is set", async () => {
    process.env.STRAPI_URL = "https://cms.example.test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 1,
              slug: "cms-cat",
              label_es: "Categoría CMS",
              label_en: "CMS category",
              sub_es: "Sub",
              items: [
                {
                  id: 10,
                  slug: "cms-item",
                  name_es: "Servicio CMS",
                  name_en: "CMS service",
                  priceCOP: 111000,
                  durationMin: 90,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const result = await getPricing("es", copy);
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("Categoría CMS");
    expect(result[0]?.items[0]).toMatchObject({
      id: "cms-item",
      name: "Servicio CMS",
      priceCOP: 111000,
      durationMin: 90,
      fromPrice: false,
    });
  });

  it("picks names in the requested language", async () => {
    process.env.STRAPI_URL = "https://cms.example.test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 1,
              slug: "c",
              label_es: "ES",
              label_en: "EN",
              items: [
                {
                  id: 1,
                  slug: "i",
                  name_es: "Nombre",
                  name_en: "Name",
                  priceCOP: 1000,
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await getPricing("en", copy);
    expect(result[0]?.label).toBe("EN");
    expect(result[0]?.items[0]?.name).toBe("Name");
  });

  /**
   * A CMS entry translated in Spanish but not yet in English must not render an
   * empty row on `/en`. The item is skipped; a category left with no items is
   * dropped; a response with no usable categories falls back entirely.
   */
  it("skips items with no name in the requested language", async () => {
    process.env.STRAPI_URL = "https://cms.example.test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 1,
              slug: "c",
              label_en: "EN",
              items: [{ id: 1, slug: "i", name_es: "Solo español", priceCOP: 1 }],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await getPricing("en", copy);
    expect(result.map((c) => c.id)).toEqual(pricing.map((c) => c.id));
  });

  it.each([
    ["a non-ok response", () => new Response("nope", { status: 500 })],
    ["an empty data array", () => new Response(JSON.stringify({ data: [] }))],
    ["a body with no data key", () => new Response(JSON.stringify({}))],
  ])("falls back on %s", async (_label, makeResponse) => {
    process.env.STRAPI_URL = "https://cms.example.test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(makeResponse());
    const result = await getPricing("es", copy);
    expect(result.map((c) => c.id)).toEqual(pricing.map((c) => c.id));
  });

  it("falls back when the CMS is unreachable", async () => {
    process.env.STRAPI_URL = "https://cms.example.test";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await getPricing("es", copy);
    expect(result.map((c) => c.id)).toEqual(pricing.map((c) => c.id));
  });

  it("falls back when the CMS returns unparseable JSON", async () => {
    process.env.STRAPI_URL = "https://cms.example.test";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>502</html>", { status: 200 }),
    );
    const result = await getPricing("es", copy);
    expect(result.map((c) => c.id)).toEqual(pricing.map((c) => c.id));
  });
});
