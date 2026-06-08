import "server-only";
import { PROMOS_DATA as ES } from "./promos.es";
import { PROMOS_DATA as EN } from "./promos.en";
import type { Locale } from "@/app/[lang]/dictionaries";
import type { PromoScenario, PromosBySlug } from "./promos.types";

const BY_LANG: Record<Locale, PromosBySlug> = { es: ES, en: EN };

export function getPromos(lang: Locale): PromosBySlug {
  return BY_LANG[lang];
}

// Tokens that mean "no promo" wherever they appear in the env list.
const OFF_TOKENS = ["vacio", "none", "off"];

/**
 * Resolves every active scenario for the given locale. Today: driven by
 * `NEXT_PUBLIC_ACTIVE_PROMO`, which now accepts a comma-separated list of
 * scenario slugs (e.g. `apertura,primera-visita`). Order is preserved — it sets
 * the carousel order in the strip and the Highlights section — and duplicates
 * are dropped. Empty string, `vacio`, `none`, or `off` each evaluate to no
 * promo; an empty list returns `[]`.
 *
 * Declared `async` so the future Strapi swap (which needs `fetch`) is a
 * one-file change — the call sites already await the result.
 */
export async function getActiveScenarios(
  lang: Locale,
): Promise<PromoScenario[]> {
  const raw = process.env.NEXT_PUBLIC_ACTIVE_PROMO ?? "";
  const slugs = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && !OFF_TOKENS.includes(s));

  const seen = new Set<string>();
  const scenarios: PromoScenario[] = [];
  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    const scenario = BY_LANG[lang][slug];
    if (!scenario || !scenario.active) continue;
    if (!scenario.strip && scenario.items.length === 0) continue;
    scenarios.push(scenario);
  }
  return scenarios;
}

/**
 * Back-compat single-scenario resolver: the first active scenario, or `null`.
 * Both the landing and the bio now consume the full list via
 * `getActiveScenarios`; this wrapper is kept for any single-promo caller.
 */
export async function getActiveScenario(
  lang: Locale,
): Promise<PromoScenario | null> {
  return (await getActiveScenarios(lang))[0] ?? null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * STRAPI SWAP
 * When the CMS is online, replace `getActiveScenarios` with the implementation
 * below (`getActiveScenario` stays as the first-of-list wrapper). The signature
 * `(lang) => Promise<PromoScenario[]>` does not change, so neither `page.tsx`
 * nor the components need any edits — multiple in-window scenarios just flow
 * through to the carousels.
 *
 * Required env: STRAPI_URL (e.g. https://cms.goldenbeautystudio.com)
 *
 * export async function getActiveScenarios(
 *   lang: Locale,
 * ): Promise<PromoScenario[]> {
 *   const url =
 *     `${process.env.STRAPI_URL}/api/promo-scenarios` +
 *     `?locale=${lang}` +
 *     `&populate[strip]=*` +
 *     `&populate[items][populate]=image` +
 *     `&filters[active][$eq]=true` +
 *     `&sort=order:asc`;
 *   const res = await fetch(url, { next: { revalidate: 60 } });
 *   if (!res.ok) return [];
 *   const { data } = await res.json();
 *   const now = new Date().toISOString();
 *   return (data ?? [])
 *     .map((d: any) => normalizeStrapi(d.attributes ?? d))
 *     .filter(
 *       (s: PromoScenario) =>
 *         (!s.starts_at || s.starts_at <= now) &&
 *         (!s.ends_at || now <= s.ends_at) &&
 *         (s.strip || s.items.length > 0),
 *     );
 * }
 *
 * function normalizeStrapi(attrs: any): PromoScenario {
 *   return {
 *     slug: attrs.slug,
 *     label: attrs.label,
 *     active: attrs.active,
 *     starts_at: attrs.starts_at,
 *     ends_at: attrs.ends_at,
 *     strip: attrs.strip ?? null,
 *     items: (attrs.items ?? []).map((it: any) => ({
 *       id: it.id ?? String(it._id ?? ""),
 *       eyebrow: it.eyebrow,
 *       title: it.title,
 *       body: it.body,
 *       cta_label: it.cta_label,
 *       cta_href: it.cta_href,
 *       ribbon: it.ribbon,
 *       accent: it.accent,
 *       badge_day: it.badge_day,
 *       badge_month: it.badge_month,
 *       featured: Boolean(it.featured),
 *       starts_at: it.starts_at,
 *       ends_at: it.ends_at,
 *       image_url: it.image?.data?.attributes?.url
 *         ? `${process.env.STRAPI_URL}${it.image.data.attributes.url}`
 *         : undefined,
 *     })),
 *   };
 * }
 * ──────────────────────────────────────────────────────────────────────────── */
