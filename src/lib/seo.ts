import { getStartingPriceCOP } from "@/data/pricing";
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
