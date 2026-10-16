import { describe, expect, it } from "vitest";

import { pricing } from "./pricing";
import { FEET_SERVICE_IDS, handsForFeet, serviceAreas } from "./service-areas";

const allIds = new Set(pricing.flatMap((c) => c.items.map((i) => i.id)));

describe("service areas", () => {
  it("every feet id exists in the price list", () => {
    for (const id of FEET_SERVICE_IDS) expect(allIds.has(id)).toBe(true);
  });

  it("classifies hands and feet, and leaves combos and extras out", () => {
    const areas = serviceAreas();
    expect(areas["semi-permanent-feet"]).toBe("feet");
    expect(areas["acrylic-sculpted"]).toBe("hands");
    expect(areas["semi-permanent-hands"]).toBe("hands");
    expect(areas["system-removal"]).toBeUndefined();
    expect(areas["semi-permanent-hands-feet"]).toBeUndefined();
  });

  it("a feet service pairs with the simple hands services only", () => {
    const hands = handsForFeet();
    expect(hands).toContain("semi-permanent-hands");
    expect(hands).not.toContain("semi-permanent-feet");
    expect(hands).not.toContain("acrylic-sculpted");
  });
});
