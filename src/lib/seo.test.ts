import { describe, expect, it } from "vitest";
import type { Dictionary, Locale } from "@/app/[lang]/dictionaries";
import { resolveDescription, resolvePriceTokens } from "./seo";
import { getPriceCOP, getStartingPriceCOP } from "@/data/pricing";

describe("resolvePriceTokens", () => {
  it("replaces a known id with the locale-formatted price", () => {
    const price = getPriceCOP("acrylic-sculpted");
    expect(price).not.toBeNull();
    expect(
      resolvePriceTokens("Cuestan {price:acrylic-sculpted}.", "es", ""),
    ).toBe(`Cuestan $${(price as number).toLocaleString("es-CO")}.`);
  });

  /**
   * The load-bearing safety property, stated in AGENTS.md: an id that is not in
   * pricing.ts is left on screen as literal text so the mistake is caught in
   * review — rather than rendering "$NaN" or, far worse, silently publishing a
   * price the studio does not charge.
   */
  it("leaves an unknown id untouched instead of inventing a price", () => {
    const out = resolvePriceTokens("Cuestan {price:no-existe}.", "es", "");
    expect(out).toBe("Cuestan {price:no-existe}.");
    expect(out).not.toContain("NaN");
    expect(out).not.toContain("$");
  });

  it("resolves every token in a passage, not just the first", () => {
    const out = resolvePriceTokens(
      "{price:traditional-hands} y {price:traditional-feet}",
      "es",
      "",
    );
    expect(out).toBe("$30.000 y $35.000");
  });

  it("resolves known ids even when an unknown one sits beside them", () => {
    const out = resolvePriceTokens(
      "{price:traditional-hands} y {price:inventado}",
      "es",
      "",
    );
    expect(out).toBe("$30.000 y {price:inventado}");
  });

  it("applies the currency suffix and the English number format", () => {
    expect(
      resolvePriceTokens("From {price:traditional-hands}", "en", " COP"),
    ).toBe("From $30,000 COP");
  });

  it("never prefixes a from-label, even for a fromPrice item", () => {
    // Tokens appear mid-sentence in FAQ prose, where "desde" is either already
    // written by the author or not wanted at all.
    const out = resolvePriceTokens("{price:acrylic-sculpted}", "es", "");
    expect(out.startsWith("$")).toBe(true);
  });

  it("leaves text with no tokens completely alone", () => {
    const text = "Una frase sin precios, con llaves { } sueltas.";
    expect(resolvePriceTokens(text, "es", "")).toBe(text);
  });
});

describe("resolveDescription", () => {
  const dict = {
    meta: { description: "Uñas en Sabaneta desde {priceFrom}." },
    servicios: { labels: { currencySuffix: " COP" } },
  } as unknown as Dictionary;

  it("interpolates the starting price for the locale", () => {
    const expected = getStartingPriceCOP().toLocaleString("en-US");
    expect(resolveDescription(dict, "en" as Locale)).toBe(
      `Uñas en Sabaneta desde $${expected} COP.`,
    );
  });

  it("tolerates a dictionary with no currency suffix", () => {
    const bare = {
      meta: { description: "Desde {priceFrom}." },
      servicios: { labels: {} },
    } as unknown as Dictionary;
    expect(resolveDescription(bare, "es" as Locale)).toBe("Desde $20.000.");
  });
});
