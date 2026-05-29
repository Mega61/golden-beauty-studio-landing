import { business, siteConfig } from "@/config/site";
import { pricing } from "@/data/pricing";
import { resolveDescription } from "@/lib/seo";
import type { Dictionary, Locale } from "@/app/[lang]/dictionaries";

const abs = (path: string) => new URL(path, siteConfig.siteUrl).toString();

type Categories = Record<
  string,
  { label: string; items: Record<string, { name: string }> }
>;

function buildOfferCatalog(lang: Locale, dict: Dictionary) {
  const cats = dict.servicios.categories as unknown as Categories;
  return {
    "@type": "OfferCatalog",
    name: lang === "es" ? "Servicios de uñas" : "Nail services",
    itemListElement: pricing.map((cat) => {
      const c = cats[cat.id];
      return {
        "@type": "OfferCatalog",
        name: c?.label ?? cat.id,
        itemListElement: cat.items.map((it) => ({
          "@type": "Offer",
          priceCurrency: "COP",
          price: it.priceCOP,
          itemOffered: {
            "@type": "Service",
            name: c?.items?.[it.id]?.name ?? it.id,
            serviceType: c?.label ?? cat.id,
          },
        })),
      };
    }),
  };
}

// Builds the JSON-LD `@graph` for a language: a `BeautySalon` (LocalBusiness)
// node with address/geo/hours/offers, plus a `WebSite` node. Env-derived
// fields (`telephone`, `sameAs`, `hasMap`) are attached only when present so
// empty config never emits hollow or fabricated markup.
export function buildJsonLd(lang: Locale, dict: Dictionary) {
  const businessId = `${siteConfig.siteUrl}/#business`;

  const mapsUrl = siteConfig.mapsPlaceId
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
        `${business.streetAddress}, ${business.addressLocality}`,
      )}&query_place_id=${siteConfig.mapsPlaceId}`
    : null;

  const localBusiness: Record<string, unknown> = {
    "@type": "BeautySalon",
    "@id": businessId,
    name: business.name,
    legalName: business.legalName,
    url: abs(`/${lang}`),
    image: abs(`/${lang}/opengraph-image`),
    description: resolveDescription(dict, lang),
    keywords: dict.meta.keywords,
    priceRange: business.priceRange,
    currenciesAccepted: "COP",
    areaServed: business.addressLocality,
    address: {
      "@type": "PostalAddress",
      streetAddress: business.streetAddress,
      addressLocality: business.addressLocality,
      addressRegion: business.addressRegion,
      addressCountry: business.addressCountry,
    },
    geo: {
      "@type": "GeoCoordinates",
      latitude: business.latitude,
      longitude: business.longitude,
    },
    openingHoursSpecification: business.openingHours.map((block) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: block.days,
      opens: block.opens,
      closes: block.closes,
    })),
    hasOfferCatalog: buildOfferCatalog(lang, dict),
  };

  if (business.telephone) localBusiness.telephone = business.telephone;
  if (business.sameAs.length) localBusiness.sameAs = business.sameAs;
  if (mapsUrl) localBusiness.hasMap = mapsUrl;

  const website = {
    "@type": "WebSite",
    "@id": `${siteConfig.siteUrl}/#website`,
    url: siteConfig.siteUrl,
    name: business.name,
    inLanguage: lang === "es" ? "es-CO" : "en-US",
    publisher: { "@id": businessId },
  };

  return {
    "@context": "https://schema.org",
    "@graph": [localBusiness, website],
  };
}
