import "server-only";
import { PROMOS_DATA as ES } from "./promos.es";
import { PROMOS_DATA as EN } from "./promos.en";
import type { Locale } from "@/app/[lang]/dictionaries";
import type { PromoScenario, PromosBySlug } from "./promos.types";

const BY_LANG: Record<Locale, PromosBySlug> = { es: ES, en: EN };

export function getPromos(lang: Locale): PromosBySlug {
  return BY_LANG[lang];
}

/**
 * Resolves the active scenario for the given locale, or `null` if no promo is
 * running. Today: driven by `NEXT_PUBLIC_ACTIVE_PROMO` (a scenario slug). Empty
 * string, `vacio`, `none`, or `off` all evaluate to no-promo.
 *
 * Declared `async` so the future Strapi swap (which needs `fetch`) is a
 * one-file change — the call site in `page.tsx` already awaits the result.
 */
export async function getActiveScenario(
  lang: Locale,
): Promise<PromoScenario | null> {
  const slug = process.env.NEXT_PUBLIC_ACTIVE_PROMO?.trim().toLowerCase();
  if (!slug || ["vacio", "none", "off"].includes(slug)) return null;
  const scenario = BY_LANG[lang][slug];
  if (!scenario || !scenario.active) return null;
  if (!scenario.strip && scenario.items.length === 0) return null;
  return scenario;
}

/* ────────────────────────────────────────────────────────────────────────────
 * STRAPI SWAP
 * When the CMS is online, replace `getActiveScenario` with the implementation
 * below. The signature `(lang) => Promise<PromoScenario | null>` does not
 * change, so neither `page.tsx` nor the components need any edits.
 *
 * Required env: STRAPI_URL (e.g. https://cms.goldenbeautystudio.com)
 *
 * export async function getActiveScenario(
 *   lang: Locale,
 * ): Promise<PromoScenario | null> {
 *   const url =
 *     `${process.env.STRAPI_URL}/api/promo-scenarios` +
 *     `?locale=${lang}` +
 *     `&populate[strip]=*` +
 *     `&populate[items][populate]=image` +
 *     `&filters[active][$eq]=true`;
 *   const res = await fetch(url, { next: { revalidate: 60 } });
 *   if (!res.ok) return null;
 *   const { data } = await res.json();
 *   const now = new Date().toISOString();
 *   const scenarios: PromoScenario[] = (data ?? []).map((d: any) =>
 *     normalizeStrapi(d.attributes ?? d),
 *   );
 *   return (
 *     scenarios.find(
 *       (s) =>
 *         (!s.starts_at || s.starts_at <= now) &&
 *         (!s.ends_at || now <= s.ends_at),
 *     ) ?? null
 *   );
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
