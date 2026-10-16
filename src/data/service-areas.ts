import { pricing } from "./pricing";

/**
 * Hands or feet, per price-list id — what lets the booking flow ask "¿también
 * pies?" for *any* hands service, not only the ones that have a combo.
 *
 * A pair without a combo is booked as two appointments back to back with the
 * same professional, priced and timed as the plain sum of the two services
 * (combos stay what they are: their own service, cheaper than the sum).
 *
 * Feet is the short, explicit list; everything else bookable on its own is
 * hands. `extras` and `combos` are neither: an add-on isn't a visit, and a
 * combo already is the pair.
 */
export const FEET_SERVICE_IDS = [
  "semi-permanent-feet",
  "traditional-feet",
  "feet-cleanup-only",
] as const;

const NOT_A_HALF = new Set(["extras", "combos"]);

export type ServiceArea = "hands" | "feet";

export function serviceAreas(): Record<string, ServiceArea> {
  const feet = new Set<string>(FEET_SERVICE_IDS);
  const out: Record<string, ServiceArea> = {};
  for (const category of pricing) {
    if (NOT_A_HALF.has(category.id)) continue;
    for (const item of category.items) out[item.id] = feet.has(item.id) ? "feet" : "hands";
  }
  return out;
}

/**
 * What a feet service can be paired with: **any** hands service. Any work on
 * the nails can go with work on the feet — a sculpted set plus a pedicure is
 * as normal a visit as a semi plus a pedicure, whichever was picked first.
 */
export function handsForFeet(): string[] {
  const areas = serviceAreas();
  return Object.keys(areas).filter((id) => areas[id] === "hands");
}
