import { afterEach, describe, expect, it } from "vitest";
import { getActiveScenario, getActiveScenarios } from "./promos";

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
