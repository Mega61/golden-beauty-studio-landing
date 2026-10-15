import { formatPrice, type PricingLocale } from "./pricing-format";
import { getPriceCOP } from "./pricing";
import type { PromoPriceRow } from "./promos.types";

// Promo prices — one number per offer, shared by `promos.es.ts` and
// `promos.en.ts` so the two languages can never quote different amounts.
//
// `regularId` points at the service in `src/data/pricing.ts` whose normal price
// is shown struck through next to the promo. It's read from there, never typed
// here, so a price bump in the catalog moves the "before" price too. A test in
// `promos.test.ts` fails if a promo price is not actually below the regular one
// — a strikethrough that saves nothing is false advertising.
export const PROMO_PRICES = {
  "sabado-press": [{ key: "press-on", regularId: "press-on", promoCOP: 80000 }],
  "miercoles-pies": [
    { key: "traditional-feet", regularId: "traditional-feet", promoCOP: 25000 },
    { key: "semi-permanent-feet", regularId: "semi-permanent-feet", promoCOP: 40000 },
  ],
} as const;

const CURRENCY_SUFFIX: Record<PricingLocale, string> = { es: "", en: " COP" };

function fmt(amountCOP: number, lang: PricingLocale): string {
  return formatPrice(amountCOP, lang, "", CURRENCY_SUFFIX[lang]);
}

/**
 * The rendered price rows for one promo, with labels supplied per language.
 * A row whose regular price can't be found simply drops its strikethrough
 * instead of inventing one.
 */
export function promoPriceRows(
  slug: keyof typeof PROMO_PRICES,
  lang: PricingLocale,
  labels: Record<string, string>,
): PromoPriceRow[] {
  return PROMO_PRICES[slug].map((row) => {
    const regular = getPriceCOP(row.regularId);
    return {
      label: labels[row.key] ?? row.key,
      price: fmt(row.promoCOP, lang),
      ...(regular !== null && regular > row.promoCOP ? { was: fmt(regular, lang) } : {}),
    };
  });
}

/** Just the promo amount, formatted — for strip messages and titles. */
export function promoPrice(
  slug: keyof typeof PROMO_PRICES,
  key: string,
  lang: PricingLocale,
): string {
  const row = PROMO_PRICES[slug].find((r) => r.key === key);
  if (!row) throw new Error(`promo-prices: no price "${key}" in "${slug}"`);
  return fmt(row.promoCOP, lang);
}
