import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary, hasLocale, type Locale } from "../dictionaries";
import { getActiveScenario } from "@/data/promos";
import { getBio, scenarioToBioPromo } from "@/data/bio";
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
  const scenario = await getActiveScenario(typedLang);
  const promo = scenarioToBioPromo(scenario, typedLang);

  return <Bio bio={bio} promo={promo} />;
}
