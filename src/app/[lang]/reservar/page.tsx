import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary, hasLocale, type Locale } from "../dictionaries";
import { siteConfig } from "@/config/site";
import { EyebrowLabel } from "../_components/atoms";
import Nav from "../_components/Nav";
import Footer from "../_components/Footer";
import ReservaFlow, { type ServiceCopy } from "./ReservaFlow";

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

/**
 * Name, description and category of each service in the visitor's language,
 * keyed by the price-list id.
 *
 * EA only knows the Spanish names, so without this an English visitor books
 * "Esculpidas en polygel". The panel sends each service's price-list id
 * (`slug`), and the flow looks it up here; a service with no entry falls back
 * to EA's name, so a new service is bookable before anyone translates it.
 */
function serviceCopy(categories: Record<string, {
  label: string;
  items: Record<string, { name: string; desc: string }>;
}>): Record<string, ServiceCopy> {
  const out: Record<string, ServiceCopy> = {};
  for (const [catId, cat] of Object.entries(categories)) {
    for (const [id, item] of Object.entries(cat.items)) {
      out[id] = { name: item.name, desc: item.desc, category: cat.label, categoryId: catId };
    }
  }
  return out;
}

export default async function ReservarPage({
  params,
  searchParams,
}: {
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  const typedLang: Locale = lang;

  // Reading the query is also what makes this page render per request. It has
  // to: `todayInStudio()` at build time would freeze "today" on the deploy date.
  const query = await searchParams;
  const initialSlug = typeof query.servicio === "string" ? query.servicio : null;

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

      <main className="bg-ivory pt-8 md:pt-14">
        <header className="mx-auto max-w-[1120px] px-5 pb-2 md:px-8">
          <EyebrowLabel className="text-gold-dark">{t.eyebrow}</EyebrowLabel>
          <h1 className="mt-2 font-display text-[40px] leading-none text-ink md:text-6xl">
            {t.title}
          </h1>
          <p className="mt-3 font-sans text-sm text-ink-soft">{t.intro}</p>
        </header>

        <ReservaFlow
          dict={t}
          lang={typedLang}
          today={todayInStudio()}
          initialSlug={initialSlug}
          copy={serviceCopy(dict.servicios.categories)}
          whatsappNumber={process.env.NEXT_PUBLIC_WHATSAPP_NUMBER?.trim() || null}
          mapsUrl={
            // Same shape as the footer's link: the documented Maps URL, pinned
            // to the business listing when the Place ID is set.
            `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
              "Golden Beauty Studio, Calle 69 Sur #43a - 41, Sabaneta",
            )}${siteConfig.mapsPlaceId ? `&query_place_id=${siteConfig.mapsPlaceId}` : ""}`
          }
        />
      </main>

      <Footer dict={dict.footer} lang={typedLang} />
    </>
  );
}
