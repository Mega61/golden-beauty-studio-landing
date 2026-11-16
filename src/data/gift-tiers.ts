import type { GiftTier } from "@/lib/gift";

/**
 * The gift-card tiers `/regalar` shows when the panel can't be reached.
 *
 * The real ones live in Stampee (`gift_card_tiers`) and reach the page through
 * the panel; the owner edits them there, not here. This list only keeps the
 * page from going blank on a Vercel preview or a panel hiccup, and it is the
 * only place outside Stampee where a gift-card amount is written down. With these,
 * the form can't create an order (the ids are not Stampee's), so it offers to
 * order on WhatsApp instead.
 *
 * Mirrors the seed in the contract: Detalle (semi on hands), Consentida (semi
 * hands + feet, or press-on), Golden (a full set plus extras).
 */
export const FALLBACK_GIFT_TIERS: readonly GiftTier[] = [
  {
    id: "fallback-detalle",
    name: "Detalle",
    amountCop: 50000,
    description: "Semipermanente en manos",
    validityDays: 365,
  },
  {
    id: "fallback-consentida",
    name: "Consentida",
    amountCop: 100000,
    description: "Semipermanente en manos y pies, o press-on",
    validityDays: 365,
  },
  {
    id: "fallback-golden",
    name: "Golden",
    amountCop: 150000,
    description: "Montaje con diseño y extras",
    validityDays: 365,
  },
];

export function isFallbackTier(id: string): boolean {
  return id.startsWith("fallback-");
}
