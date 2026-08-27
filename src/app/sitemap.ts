import type { MetadataRoute } from "next";
import { siteConfig } from "@/config/site";
import { locales } from "./[lang]/dictionaries";

/**
 * Landing + careers page, one entry per locale with hreflang alternates. `/bio`
 * is deliberately absent: it's a link tree for Instagram traffic, not a page
 * worth ranking.
 */
function entry(
  path: string,
  changeFrequency: "monthly" | "yearly",
  priorityEs: number,
): MetadataRoute.Sitemap {
  const languages: Record<string, string> = Object.fromEntries(
    locales.map((l) => [l, `${siteConfig.siteUrl}/${l}${path}`]),
  );
  languages["x-default"] = `${siteConfig.siteUrl}/es${path}`;
  return locales.map((lang) => ({
    url: `${siteConfig.siteUrl}/${lang}${path}`,
    // `lastModified` is deliberately omitted. We have no per-page change
    // tracking, so the only value we could emit is the build timestamp — which
    // moves on every deploy whether or not the page changed. Google discounts
    // lastmod it finds unreliable, so an absent value (it falls back to its own
    // crawl-based freshness signal) beats one that always lies.
    changeFrequency,
    // Round: 0.6 - 0.2 is 0.39999999999999997 in IEEE-754 floats.
    priority:
      lang === "es"
        ? priorityEs
        : Math.round((priorityEs - 0.2) * 100) / 100,
    alternates: { languages },
  }));
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    ...entry("", "monthly", 1),
    // Only listed while hiring is switched on — the route 404s otherwise.
    ...(siteConfig.sections.trabaja
      ? entry("/trabaja-con-nosotros", "monthly", 0.6)
      : []),
  ];
}
