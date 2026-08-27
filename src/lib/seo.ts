import { getPriceCOP, getStartingPriceCOP } from "@/data/pricing";
import { formatPrice } from "@/data/pricing-format";
import type { Dictionary, Locale } from "@/app/[lang]/dictionaries";

// Resolves the SEO meta description, interpolating the `{priceFrom}` token with
// the studio's starting price formatted for the locale (e.g. "$30.000" /
// "$30,000 COP"). Keeping the number out of the translation strings means the
// price stays single-sourced in `pricing.ts` and never drifts.
export function resolveDescription(dict: Dictionary, lang: Locale): string {
  const currencySuffix = dict.servicios.labels.currencySuffix ?? "";
  const priceFrom = formatPrice(
    getStartingPriceCOP(),
    lang,
    "",
    currencySuffix,
    false,
  );
  return dict.meta.description.replace("{priceFrom}", priceFrom);
}

/**
 * Interpolates `{price:<pricing-id>}` tokens in body copy with the real,
 * locale-formatted price from `pricing.ts` — same reasoning as `{priceFrom}`
 * above: FAQ prose quotes a live number instead of a hardcoded one that would
 * drift the next time someone edits the price list.
 *
 * An unknown id is left as-is rather than rendered as "$NaN", so a typo shows up
 * as visible literal text in review instead of shipping a wrong price.
 */
export function resolvePriceTokens(
  text: string,
  lang: Locale,
  currencySuffix: string,
): string {
  return text.replace(/\{price:([a-z0-9-]+)\}/gi, (whole, id: string) => {
    const cop = getPriceCOP(id);
    if (cop === null) return whole;
    return formatPrice(cop, lang, "", currencySuffix, false);
  });
}
