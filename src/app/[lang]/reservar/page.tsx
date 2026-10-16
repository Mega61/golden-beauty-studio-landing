import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary, hasLocale, type Locale } from "../dictionaries";
import { siteConfig } from "@/config/site";
import Nav from "../_components/Nav";
import Footer from "../_components/Footer";
import ReservaFlow, { type Catalog, type ServiceCopy } from "./ReservaFlow";
import { adminOrigin, bookingUrl } from "@/app/api/reservas/guards";
import { getReviews } from "@/data/reviews";

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

/**
 * The catalog, rendered with the page instead of fetched after it.
 *
 * Services and technicians change a few times a year; making a phone on 4G
 * wait for a second round trip — and stare at a skeleton — before it can pick
 * anything was the slowest part of the flow. Cached for a minute in Next's data
 * cache, so a burst of ad traffic costs the panel one request a minute, not one
 * per visitor. Availability is never cached here: that stays a live call.
 *
 * Bounded at 2.5 s and allowed to fail: the client fetches it itself when this
 * comes back null, which is exactly how the page worked before.
 */
async function loadCatalog(): Promise<Catalog | null> {
  const origin = adminOrigin();
  if (!origin) return null;
  try {
    const res = await fetch(bookingUrl(origin, "catalogo"), {
      headers: { Accept: "application/json" },
      next: { revalidate: 60, tags: ["booking-catalog"] },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Catalog;
    return { ...body, combos: body.combos ?? [] };
  } catch {
    return null;
  }
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

  const [dict, catalog, reviews] = await Promise.all([
    getDictionary(typedLang),
    loadCatalog(),
    getReviews(typedLang).catch(() => null),
  ]);
  const t = dict.reservar;

  return (
    <>
      <Nav
        lang={typedLang}
        dict={dict.nav}
        sections={siteConfig.sections}
        onLanding={false}
        switchPath={`/${PATH}`}
        showCta={false}
      />

      {/* No page heading: the studio header inside the flow is the heading —
          photo, name, rating — the way a booking app presents a business.
          The deeper background is what the booking card sits on. */}
      <main className="bg-ivory-deep/50">
        <h1 className="sr-only">{t.title}</h1>
        <ReservaFlow
          dict={t}
          lang={typedLang}
          today={todayInStudio()}
          initialSlug={initialSlug}
          initialCatalog={catalog}
          rating={
            reviews?.rating && reviews.count
              ? { value: reviews.rating, count: reviews.count }
              : null
          }
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
