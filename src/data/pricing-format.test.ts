import { describe, expect, it } from "vitest";
import { formatDuration, formatPrice } from "./pricing-format";

describe("formatPrice", () => {
  it("groups thousands the Colombian way in Spanish", () => {
    expect(formatPrice(120000, "es", "desde", "", false)).toBe("$120.000");
  });

  it("groups thousands the US way in English", () => {
    expect(formatPrice(120000, "en", "from", "", false)).toBe("$120,000");
  });

  // The two locales carry different currency affordances: `/es` reads as pesos
  // without saying so, `/en` needs the COP suffix or a dollar sign reads as USD.
  it("appends the currency suffix when one is supplied", () => {
    expect(formatPrice(120000, "en", "from", " COP", false)).toBe(
      "$120,000 COP",
    );
  });

  it("prefixes the from-label only when isFrom is set", () => {
    expect(formatPrice(180000, "es", "desde", "", true)).toBe("desde $180.000");
    expect(formatPrice(180000, "es", "desde", "", false)).toBe("$180.000");
  });

  it("treats an omitted isFrom as not-a-from-price", () => {
    expect(formatPrice(50000, "es", "desde", "")).toBe("$50.000");
  });

  it("never renders decimals", () => {
    expect(formatPrice(99999.6, "es", "desde", "", false)).toBe("$100.000");
  });
});

describe("formatDuration", () => {
  it("renders hours and minutes together", () => {
    expect(formatDuration(150)).toBe("2h 30min");
  });

  it("drops the minutes on a whole hour", () => {
    expect(formatDuration(120)).toBe("2h");
  });

  it("renders sub-hour durations as minutes only", () => {
    expect(formatDuration(45)).toBe("45min");
  });

  // `durationMin: null` is a real value in pricing.ts — `design-per-nail` has no
  // meaningful duration. It must render as an em-dash, never "0min" or "null".
  it("renders an em-dash for a null duration", () => {
    expect(formatDuration(null)).toBe("—");
  });

  it("distinguishes zero from null", () => {
    expect(formatDuration(0)).toBe("0min");
  });
});
