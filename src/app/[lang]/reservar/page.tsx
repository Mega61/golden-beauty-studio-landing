import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary, hasLocale, type Locale } from "../dictionaries";
import { siteConfig } from "@/config/site";
import { EyebrowLabel, GoldRule } from "../_components/atoms";
import Nav from "../_components/Nav";
import Footer from "../_components/Footer";
import ReservaFlow from "./ReservaFlow";

/**
 * `/[lang]/reservar` — the booking flow.
 *
 * One slug for both locales, like `/bio` and `/trabaja-con-nosotros`: the studio
 * is in Sabaneta, so the Spanish URL is the one clients and Google will see, and
 * a single path avoids a second set of redirects and hreflang pairs.
 *
 * A page rather than a modal on the landing, because a URL is the point: it can
 * be dropped into the `/bio` link tree, a WhatsApp reply or an ad and take
 * someone straight to booking instead of to the homepage, hoping she scrolls.
 *
 * `noindex` is deliberate. This is a transactional screen, not a page anyone
 * should land on from a search — the pages that should rank are the price list
 * and the FAQ, which answer the question that brings people here. Leaving it
 * indexable would put a bare form in front of someone who wanted to know what
 * acrylics cost.
 */
const PATH = "reservar";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang)) return {};
  const dict = await getDictionary(lang);
  const { title, description } = dict.reservar.meta;

  return {
    title,
    description,
    robots: { index: false, follow: true },
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

/**
 * Hoy en el calendario del estudio, no en el del visitante.
 *
 * `en-CA` da `YYYY-MM-DD`, que es la forma que espera EA. Se resuelve acá y no
 * en el cliente porque el servidor es el único que sabe con certeza en qué día
 * está Sabaneta: alguien mirando desde Madrid a la 1 a. m. sigue queriendo
 * reservar el día de allá.
 */
function todayInStudio(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" });
}

export default async function ReservarPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const typedLang: Locale = lang;

  const dict = await getDictionary(typedLang);
  const t = dict.reservar;

  return (
    <>
      <Nav
        lang={typedLang}
        dict={dict.nav}
        sections={siteConfig.sections}
        onLanding={false}
        switchPath={`/${PATH}`}
      />

      <main className="bg-ivory pt-12 md:pt-16">
        <header className="mx-auto max-w-[760px] px-5 pb-4 text-center">
          <EyebrowLabel className="text-gold-dark">{t.eyebrow}</EyebrowLabel>
          <h1 className="mt-3 font-display text-4xl text-ink md:text-5xl">{t.title}</h1>
          <GoldRule className="my-5" width={90} />
          <p className="font-sans text-sm text-ink-soft">{t.intro}</p>
        </header>

        <ReservaFlow
          dict={t}
          lang={typedLang}
          today={todayInStudio()}
          whatsappHref={siteConfig.whatsappUrl}
        />
      </main>

      <Footer dict={dict.footer} />
    </>
  );
}
