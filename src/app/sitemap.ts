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
  const lastModified = new Date();
  const languages: Record<string, string> = Object.fromEntries(
    locales.map((l) => [l, `${siteConfig.siteUrl}/${l}${path}`]),
  );
  languages["x-default"] = `${siteConfig.siteUrl}/es${path}`;
  return locales.map((lang) => ({
    url: `${siteConfig.siteUrl}/${lang}${path}`,
    lastModified,
    changeFrequency,
    priority: lang === "es" ? priorityEs : priorityEs - 0.2,
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
