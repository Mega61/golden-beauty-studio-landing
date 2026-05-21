import type { MetadataRoute } from "next";
import { siteConfig } from "@/config/site";
import { locales } from "./[lang]/dictionaries";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const languages = Object.fromEntries(
    locales.map((l) => [l, `${siteConfig.siteUrl}/${l}`]),
  );
  return locales.map((lang) => ({
    url: `${siteConfig.siteUrl}/${lang}`,
    lastModified,
    changeFrequency: "monthly",
    priority: lang === "es" ? 1 : 0.8,
    alternates: { languages },
  }));
}
