import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SHOWCASE_PRICING_SOURCE } from "@/data/showcase-pricing";

import { LANDING_PRICING_RELATIVE_PATH, loadPricingCatalog } from "./pricing-source";

describe("loadPricingCatalog", () => {
  it("una PRICING_SOURCE_PATH que no existe es un error, no la copia horneada", async () => {
    const result = await loadPricingCatalog({
      PRICING_SOURCE_PATH: "/no/existe/pricing.ts",
    } as unknown as NodeJS.ProcessEnv);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("PRICING_SOURCE_PATH");
  });

  it("la copia horneada es el texto de la vitrina, byte a byte", () => {
    // `build-combo-map.mjs --check` lo vigila en CI; esto lo dice también acá,
    // donde se nota antes.
    const repo = readFileSync(path.resolve(process.cwd(), LANDING_PRICING_RELATIVE_PATH), "utf8");
    expect(SHOWCASE_PRICING_SOURCE).toBe(repo);
  });
});
