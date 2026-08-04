import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary, hasLocale, type Locale } from "../dictionaries";
import { siteConfig } from "@/config/site";
import { getJobRoles } from "@/data/careers";
import Nav from "../_components/Nav";
import Trabaja from "../_components/Trabaja";
import Footer from "../_components/Footer";

/**
 * `/[lang]/trabaja-con-nosotros` — the careers page.
 *
 * One slug for both locales (like `/bio`): the studio hires locally in Sabaneta,
 * so the Spanish URL is the one applicants and Google will see, and keeping a
 * single path avoids a second set of redirects and hreflang pairs.
 *
 * Hidden entirely (404) when NEXT_PUBLIC_SECTION_TRABAJA is off, so switching
 * hiring off doesn't leave a live form quietly collecting applications.
 */
const PATH = "trabaja-con-nosotros";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang) || !siteConfig.sections.trabaja) return {};
  const dict = await getDictionary(lang);
  const { title, description } = dict.trabaja.meta;
  return {
    title,
    description,
    alternates: {
      canonical: `/${lang}/${PATH}`,
      languages: {
        es: `/es/${PATH}`,
        en: `/en/${PATH}`,
        "x-default": `/es/${PATH}`,
      },
    },
    openGraph: { title, description, url: `/${lang}/${PATH}` },
  };
}

export default async function TrabajaPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  if (!siteConfig.sections.trabaja) notFound();
  const typedLang: Locale = lang;

  const dict = await getDictionary(typedLang);
  const roles = await getJobRoles(typedLang);

  return (
    <>
      <Nav
        lang={typedLang}
        dict={dict.nav}
        sections={siteConfig.sections}
        onLanding={false}
      />
      <Trabaja dict={dict.trabaja} lang={typedLang} roles={roles} />
      <Footer dict={dict.footer} />
    </>
  );
}
