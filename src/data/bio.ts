import "server-only";
import { BIO_COPY as ES } from "./bio.es";
import { BIO_COPY as EN } from "./bio.en";
import { siteConfig, business } from "@/config/site";
import type { Locale } from "@/app/[lang]/dictionaries";
import type { BioCopy, BioData, BioLink, BioPromo, BioSocial } from "./bio.types";
import type { PromoScenario } from "./promos.types";

const BY_LANG: Record<Locale, BioCopy> = { es: ES, en: EN };

// Studio listing on Google Maps. Mirrors the deep-link Contacto builds: prefers
// the Business Profile Place ID, falls back to an address search.
function mapsHref(): string {
  const q = encodeURIComponent(
    `${business.name}, ${business.streetAddress}, ${business.addressLocality}`,
  );
  return siteConfig.mapsPlaceId
    ? `https://www.google.com/maps/search/?api=1&query=${q}&query_place_id=${siteConfig.mapsPlaceId}`
    : `https://www.google.com/maps/search/?api=1&query=${q}`;
}

/**
 * Resolves the full bio payload for a locale: localized copy (mock today,
 * Strapi later) merged with the real destinations, which already live in
 * `siteConfig` (env). A link whose destination is unset is dropped, so nothing
 * pointing at a dead `#` ever renders. `agendar` is the single `primary` row →
 * it takes the gold CTA slot.
 *
 * `async` so the future Strapi swap (which needs `fetch`) is a one-file change —
 * the call site in `bio/page.tsx` already awaits the result.
 */
export async function getBio(lang: Locale): Promise<BioData> {
  const copy = BY_LANG[lang];
  const { bookingUrl, whatsappUrl, instagramUrl, tiktokUrl } = siteConfig;

  // Destinations reuse the site-wide env (the same values the landing uses);
  // `servicios` and `maps` have no env var, so they get a computed default.
  // `external` is derived from the final href, so an absolute URL opens in a
  // new tab while a relative path stays in-tab.
  const allLinks: BioLink[] = [
    {
      key: "agendar",
      ...copy.links.agendar,
      href: bookingUrl ?? "",
      primary: true,
    },
    {
      key: "whatsapp",
      ...copy.links.whatsapp,
      href: whatsappUrl ?? "",
      image: "/lookbook-wm/semipermanente/rosa-oro.jpg",
    },
    {
      key: "servicios",
      ...copy.links.servicios,
      href: `/${lang}#servicios`,
      image: "/lookbook-wm/polygel/golden.jpg",
    },
    {
      key: "instagram",
      ...copy.links.instagram,
      href: instagramUrl ?? "",
      image: "/lookbook-wm/semipermanente/dorado-espejo.jpg",
    },
    {
      key: "maps",
      ...copy.links.maps,
      href: mapsHref(),
      image: "/lookbook-wm/semipermanente/blooming-espejo.jpg",
    },
  ];
  const links: BioLink[] = allLinks
    .filter((l) => l.href !== "")
    .map((l) => ({ ...l, external: /^https?:\/\//i.test(l.href) }));

  const socialSources: Array<{ key: string; short: string; href: string | null }> = [
    { key: "ig", short: "IG", href: instagramUrl },
    { key: "wa", short: "WA", href: whatsappUrl },
    { key: "tt", short: "TT", href: tiktokUrl },
  ];
  const socials: BioSocial[] = socialSources
    .filter((s): s is { key: string; short: string; href: string } =>
      Boolean(s.href),
    )
    .map((s) => ({
      ...s,
      label: copy.socials[s.key as keyof BioCopy["socials"]],
    }));

  return {
    handle: copy.handle,
    tagline: copy.tagline,
    location: copy.location,
    avatar: "/hero.jpg",
    links,
    socials,
  };
}

/**
 * Maps the active promo scenario (the same one the landing strip reads) onto
 * the pinned-promo band. `null` scenario → `null` band → the band is omitted
 * and the CTA rises to take its place.
 *
 * tag   ← scenario.label  (period descriptor)
 * title ← featured item's headline, falling back to the strip message
 * href  ← always the landing's promo section (`/es#promos`)
 *
 * The banner deliberately ignores each scenario's own CTA (which usually points
 * at booking or `#contacto`): on the bio — a directory page — it acts as a
 * teaser that opens the full promo block on the landing, not a direct booking.
 * `#promos` is the id of the Highlights section the landing strip also targets.
 */
export function scenarioToBioPromo(
  scenario: PromoScenario | null,
  lang: Locale,
): BioPromo | null {
  if (!scenario) return null;
  const featured = scenario.items.find((i) => i.featured) ?? scenario.items[0];
  const title = featured?.title ?? scenario.strip?.message;
  if (!title) return null;
  const href = `/${lang}#promos`;
  return {
    tag: scenario.label,
    title,
    href,
    image: featured?.image_url,
    cta: BY_LANG[lang].promoCta,
  };
}

/**
 * Maps every active scenario (same list the landing carousel reads) onto a
 * pinned-promo band. When 2+ promos are running the bio renders them as a
 * rotating carousel, mirroring the landing strip + Highlights. Order follows
 * `getActiveScenarios` (i.e. `NEXT_PUBLIC_ACTIVE_PROMO`). Scenarios that yield
 * no band (no featured title nor strip message) are dropped.
 */
export function scenariosToBioPromos(
  scenarios: PromoScenario[],
  lang: Locale,
): BioPromo[] {
  return scenarios
    .map((s) => scenarioToBioPromo(s, lang))
    .filter((p): p is BioPromo => p !== null);
}

/* ────────────────────────────────────────────────────────────────────────────
 * STRAPI SWAP
 * When the CMS is online, replace the body of `getBio` with a fetch of the
 * `link-bio` Single Type. The signature `(lang) => Promise<BioData>` does not
 * change, so neither `bio/page.tsx` nor the `Bio` component need any edits.
 *
 *   export async function getBio(lang: Locale): Promise<BioData> {
 *     const res = await fetch(
 *       `${process.env.STRAPI_URL}/api/link-bio?locale=${lang}` +
 *         `&populate[avatar]=*&populate[links]=*&populate[socials]=*`,
 *       { next: { revalidate: 60 } },
 *     );
 *     const { data } = await res.json();
 *     return normalizeStrapi(data.attributes); // flatten data/attributes + resolve media
 *   }
 * ──────────────────────────────────────────────────────────────────────────── */
