import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary, hasLocale, type Locale } from "../dictionaries";
import { siteConfig } from "@/config/site";
import { getActiveScenarios } from "@/data/promos";
import { getJobRoles } from "@/data/careers";
import { getBio, scenariosToBioPromos } from "@/data/bio";
import Bio from "../_components/Bio";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang);
  const title = "Golden Beauty Studio — Links";
  const description = dict.footer.tagline.replace(/\n/g, " ");
  return {
    title,
    description,
    alternates: {
      canonical: `/${lang}/bio`,
      languages: { es: "/es/bio", en: "/en/bio", "x-default": "/es/bio" },
    },
    openGraph: { title, description, url: `/${lang}/bio` },
  };
}

export default async function BioPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const typedLang: Locale = lang;

  const bio = await getBio(typedLang);
  const scenarios = await getActiveScenarios(typedLang);
  const promos = scenariosToBioPromos(scenarios, typedLang);
  const dict = await getDictionary(typedLang);
  const careersOn = siteConfig.sections.trabaja;
  const roles = careersOn ? await getJobRoles(typedLang) : [];

  return (
    <Bio
      bio={bio}
      promos={promos}
      lang={typedLang}
      trabaja={careersOn ? dict.trabaja : null}
      roles={roles}
    />
  );
}
