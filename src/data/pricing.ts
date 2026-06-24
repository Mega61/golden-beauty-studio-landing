// Bundled fallback for service prices and durations + SEO helpers.
//
// When STRAPI_URL is set, the live price list (names, descriptions, prices,
// durations — fully owner-editable) is read from the CMS via `getPricing()`
// below; this bundled array + the dictionary names are the fallback used when
// the CMS is unset/unreachable/empty, so the section never goes blank. The
// SEO/JSON-LD helpers (`getStartingPriceCOP`, lib/schema.ts) intentionally keep
// using this bundled data so metadata stays synchronous.

import { type PricingLocale } from "./pricing-format";

export type PriceItem = {
  id: string;
  priceCOP: number;
  fromPrice?: boolean;
  durationMin: number | null;
};

export type PriceCategory = {
  id: string;
  items: PriceItem[];
};

export const pricing: readonly PriceCategory[] = [
  {
    id: "montajes",
    items: [
      { id: "polygel-sculpted", priceCOP: 120000, durationMin: 150 },
      { id: "acrylic-sculpted", priceCOP: 115000, durationMin: 150 },
      { id: "polygel-dual", priceCOP: 110000, durationMin: 150 },
      { id: "builder-gel-dual", priceCOP: 105000, durationMin: 150 },
      { id: "press-on", priceCOP: 100000, durationMin: 105 },
    ],
  },
  {
    id: "retoques",
    items: [
      { id: "polygel-refill", priceCOP: 90000, durationMin: 120 },
      { id: "builder-gel-refill", priceCOP: 85000, durationMin: 120 },
      { id: "acrylic-refill", priceCOP: 80000, durationMin: 120 },
    ],
  },
  {
    id: "forrados",
    items: [
      { id: "polygel-overlay", priceCOP: 95000, durationMin: 90 },
      { id: "builder-gel-overlay", priceCOP: 90000, durationMin: 90 },
      { id: "acrylic-overlay", priceCOP: 85000, durationMin: 90 },
      { id: "dipping", priceCOP: 80000, durationMin: 90 },
      { id: "rubber-base-leveling", priceCOP: 70000, durationMin: 90 },
    ],
  },
  {
    id: "sencillos",
    items: [
      { id: "semi-permanent-feet", priceCOP: 55000, durationMin: 75 },
      { id: "semi-permanent-no-color", priceCOP: 40000, durationMin: 45 },
      { id: "semi-permanent-hands", priceCOP: 50000, durationMin: 60 },
      { id: "traditional-feet", priceCOP: 35000, durationMin: 60 },
      { id: "traditional-hands", priceCOP: 30000, durationMin: 60 },
      { id: "feet-cleanup-only", priceCOP: 25000, durationMin: 45 },
      { id: "hands-cleanup-only", priceCOP: 20000, durationMin: 30 },
    ],
  },
  {
    id: "combos",
    items: [
      { id: "polygel-overlay-hands-semi-feet", priceCOP: 135000, durationMin: 150 },
      { id: "builder-gel-overlay-hands-semi-feet", priceCOP: 130000, durationMin: 150 },
      { id: "acrylic-overlay-hands-semi-feet", priceCOP: 125000, durationMin: 150 },
      { id: "semi-permanent-hands-feet", priceCOP: 95000, durationMin: 120 },
      { id: "semi-permanent-hands-traditional-feet", priceCOP: 77000, durationMin: 120 },
    ],
  },
  {
    id: "extras",
    items: [
      { id: "system-removal", priceCOP: 20000, durationMin: 30 },
      { id: "single-dual-system-nail", priceCOP: 11000, durationMin: 10 },
      { id: "single-press-on-nail", priceCOP: 10000, durationMin: 5 },
      { id: "design-per-nail", priceCOP: 10000, durationMin: null },
      { id: "in-depth-foot-cleaning", priceCOP: 15000, durationMin: 10 },
    ],
  },
] as const;

// Lowest price of a standalone, bookable service — used for the "from $…"
// hint in the SEO meta description. Excludes the `extras` category (per-nail
// add-ons / removals are not standalone bookings, so they'd be misleading).
export function getStartingPriceCOP(): number {
  return Math.min(
    ...pricing
      .filter((cat) => cat.id !== "extras")
      .flatMap((cat) => cat.items.map((it) => it.priceCOP)),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CMS-driven price list
// ─────────────────────────────────────────────────────────────────────────────

// A fully-resolved (single-locale) price list, ready to render — names and
// descriptions already picked for the requested language. This is what the
// Servicios component consumes, whether it came from Strapi or the fallback.
export type ResolvedPriceItem = {
  id: string;
  name: string;
  desc: string;
  priceCOP: number;
  durationMin: number | null;
  fromPrice: boolean;
};
export type ResolvedPriceCategory = {
  id: string;
  label: string;
  sub: string;
  items: ResolvedPriceItem[];
};

// The shape of `dict.servicios.categories` — used to supply names/descriptions
// for the bundled fallback (and category chrome) when the CMS is unavailable.
export type PricingCopy = Record<
  string,
  {
    label: string;
    sub: string;
    items: Record<string, { name: string; desc: string }>;
  }
>;

type StrapiPriceItem = {
  id: number;
  documentId?: string;
  slug?: string;
  name_es?: string;
  name_en?: string;
  desc_es?: string;
  desc_en?: string;
  priceCOP?: number;
  durationMin?: number | null;
  fromPrice?: boolean;
  order?: number;
};
type StrapiPriceCategory = {
  id: number;
  documentId?: string;
  slug?: string;
  label_es?: string;
  label_en?: string;
  sub_es?: string;
  sub_en?: string;
  order?: number;
  items?: StrapiPriceItem[];
};

// Merge the bundled numbers with the dictionary names into the resolved shape.
function buildFallback(
  lang: PricingLocale,
  copy: PricingCopy,
): ResolvedPriceCategory[] {
  return pricing.map((cat) => {
    const c = copy[cat.id];
    return {
      id: cat.id,
      label: c?.label ?? cat.id,
      sub: c?.sub ?? "",
      items: cat.items.map((it) => ({
        id: it.id,
        name: c?.items?.[it.id]?.name ?? it.id,
        desc: c?.items?.[it.id]?.desc ?? "",
        priceCOP: it.priceCOP,
        durationMin: it.durationMin,
        fromPrice: it.fromPrice ?? false,
      })),
    };
  });
}

/**
 * Resolves the price list for a language. Reads the Strapi `price-category`
 * collection (with its `price-item`s) when `STRAPI_URL` is set; on any error,
 * empty result, or when the CMS is not configured, falls back to the bundled
 * numbers + dictionary names so the section never goes blank.
 *
 * Bilingual names/descriptions live on the entries as `*_es` / `*_en` sibling
 * fields (matching the lookbook-category convention) — no Strapi i18n locales,
 * so the owner edits one entry per service with both languages side by side.
 * Strapi v5 returns a flat response shape.
 */
export async function getPricing(
  lang: PricingLocale,
  fallbackCopy: PricingCopy,
): Promise<readonly ResolvedPriceCategory[]> {
  const fallback = buildFallback(lang, fallbackCopy);
  const base = process.env.STRAPI_URL;
  if (!base) return fallback;
  try {
    const url =
      `${base}/api/price-categories` +
      `?populate[items][sort][0]=order:asc` +
      `&sort[0]=order:asc` +
      `&pagination[pageSize]=100`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return fallback;
    const json = (await res.json()) as { data?: StrapiPriceCategory[] };
    const es = lang === "es";
    const categories: ResolvedPriceCategory[] = [];
    for (const cat of json.data ?? []) {
      const items: ResolvedPriceItem[] = [];
      for (const it of cat.items ?? []) {
        const name = (es ? it.name_es : it.name_en) ?? "";
        if (!name) continue;
        items.push({
          id: it.slug ?? it.documentId ?? String(it.id),
          name,
          desc: (es ? it.desc_es : it.desc_en) ?? "",
          priceCOP: it.priceCOP ?? 0,
          durationMin: it.durationMin ?? null,
          fromPrice: it.fromPrice ?? false,
        });
      }
      if (items.length === 0) continue;
      categories.push({
        id: cat.slug ?? cat.documentId ?? String(cat.id),
        label: (es ? cat.label_es : cat.label_en) ?? cat.slug ?? "",
        sub: (es ? cat.sub_es : cat.sub_en) ?? "",
        items,
      });
    }
    return categories.length > 0 ? categories : fallback;
  } catch {
    return fallback;
  }
}
