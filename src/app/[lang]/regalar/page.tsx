import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDictionary, hasLocale, type Locale } from "../dictionaries";
import { siteConfig } from "@/config/site";
import { adminOrigin, giftCardsUrl } from "@/app/api/reservas/guards";
import { FALLBACK_GIFT_TIERS } from "@/data/gift-tiers";
import { formatCOP } from "@/lib/booking";
import { parseTiers, paymentLines, type GiftTier } from "@/lib/gift";
import Nav from "../_components/Nav";
import Footer from "../_components/Footer";
import GiftCardVisual from "./GiftCardVisual";
import RegalarFlow from "./RegalarFlow";

/**
 * `/[lang]/regalar` — tarjetas regalo.
 *
 * One slug for both locales, like `/reservar`: the Spanish URL is the one that
 * goes on Instagram and in WhatsApp replies.
 *
 * Unlike `/reservar` this one is indexable and in the sitemap: "tarjeta regalo
 * uñas Sabaneta" is a real December search, and this page answers it on its
 * own (what it costs, how it works, the terms).
 *
 * There is no payment gateway. The order creates the card in Stampee as
 * `pending_payment`; the buyer transfers, the owner confirms in the panel, and
 * the card becomes usable. The page says so up front, and again on success.
 *
 * Off with `NEXT_PUBLIC_SECTION_REGALAR=false` (404, and gone from nav, footer
 * and sitemap).
 */
const PATH = "regalar";

/**
 * Static, refreshed every minute: this is where ad traffic lands, so it
 * shouldn't wait on the panel per visit. `?ref=` is read in the browser for
 * the same reason — reading it here would make every request dynamic.
 */
export const revalidate = 60;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ lang: string }>;
}): Promise<Metadata> {
  const { lang } = await params;
  if (!hasLocale(lang) || !siteConfig.sections.regalar) return {};
  const dict = await getDictionary(lang);
  const { title, description } = dict.regalar.meta;
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

/**
 * The tiers on sale, rendered with the page. Same approach as the booking
 * catalog: cached a minute in Next's data cache, bounded at 2.5 s, and
 * allowed to fail — the client retries, and the bundled tiers fill in.
 */
async function loadTiers(): Promise<GiftTier[] | null> {
  const origin = adminOrigin();
  if (!origin) return null;
  try {
    const res = await fetch(giftCardsUrl(origin, "tiers"), {
      headers: { Accept: "application/json" },
      next: { revalidate: 60, tags: ["gift-tiers"] },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const tiers = parseTiers(await res.json());
    return tiers.length ? tiers : null;
  } catch {
    return null;
  }
}

export default async function RegalarPage({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!hasLocale(lang)) notFound();
  if (!siteConfig.sections.regalar) notFound();
  const typedLang: Locale = lang;

  const [dict, tiers] = await Promise.all([getDictionary(typedLang), loadTiers()]);
  const t = dict.regalar;

  // The hero's card shows the middle tier: the one that reads as "a real
  // gift" without being the most expensive thing on the page.
  const shown = tiers ?? FALLBACK_GIFT_TIERS;
  const heroTier = shown[Math.min(1, shown.length - 1)];

  return (
    <>
      <Nav
        lang={typedLang}
        dict={dict.nav}
        sections={siteConfig.sections}
        onLanding={false}
        switchPath={`/${PATH}`}
      />

      <main>
        {/* ── Hero ─────────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden bg-carbon text-cream">
          <div aria-hidden className="bg-marble pointer-events-none absolute inset-0" style={{ opacity: 0.07 }} />
          <div
            aria-hidden
            className="pointer-events-none absolute -right-40 top-1/2 h-[720px] w-[720px] -translate-y-1/2 rounded-full"
            style={{ background: "radial-gradient(circle, rgba(231,170,81,0.2) 0%, rgba(231,170,81,0) 62%)" }}
          />

          <div className="relative mx-auto grid max-w-[1280px] items-center gap-12 px-5 pb-16 pt-12 md:grid-cols-[1.05fr_0.95fr] md:gap-16 md:px-14 md:pb-24 md:pt-20">
            <div>
              <div className="mb-5 flex items-center gap-3">
                <span aria-hidden className="block h-px w-7 bg-gold-bright" />
                <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold-bright">
                  {t.hero.eyebrow}
                </span>
              </div>
              <h1
                className="m-0 font-display text-[46px] font-normal leading-[1.02] md:text-[72px]"
                style={{ letterSpacing: "-0.02em", textWrap: "balance" }}
              >
                {t.hero.title1}
                <br />
                <em className="text-gold-grad-light not-italic">
                  <span className="italic">{t.hero.title2_em}</span>
                </em>
              </h1>
              <p
                className="m-0 mt-6 max-w-[52ch] font-sans text-[15px] leading-[1.75] md:text-[16px]"
                style={{ color: "rgba(243,236,223,0.78)", textWrap: "pretty" }}
              >
                {t.hero.body}
              </p>

              <a
                href="#tarjetas"
                className="bg-gold-grad mt-8 inline-flex items-center gap-3 px-7 py-4 font-sans text-[12px] font-semibold uppercase tracking-[0.24em] text-white no-underline md:text-[13px]"
              >
                {t.hero.cta}
                <span className="font-serif text-base leading-none">↓</span>
              </a>

              <ul className="m-0 mt-8 flex list-none flex-wrap gap-x-5 gap-y-2 p-0 font-sans text-[12px] text-cream/65">
                {t.hero.facts.map((fact) => (
                  <li key={fact} className="flex items-center gap-2">
                    <span aria-hidden className="text-gold-bright">✦</span>
                    {fact}
                  </li>
                ))}
              </ul>
            </div>

            {/* Two cards, fanned: one reads as a picture, two read as a gift. */}
            <div className="relative mx-auto w-full max-w-[520px] pb-6 pt-4 md:pb-0">
              <div aria-hidden className="absolute inset-x-[6%] top-0 rotate-[7deg] opacity-80 md:inset-x-[4%]">
                <GiftCardVisual tone="champagne" label={t.card.label} amount="" />
              </div>
              <div className="relative -rotate-[4deg] transition-transform duration-700 hover:-rotate-[2deg]">
                <GiftCardVisual
                  tone="carbon"
                  label={t.card.label}
                  tierName={heroTier.name}
                  amount={formatCOP(heroTier.amountCop, typedLang)}
                  toLabel={t.card.to}
                  toName={t.card.you}
                />
              </div>
            </div>
          </div>

          {/* ── Cómo funciona ──────────────────────────────────────────── */}
          <div className="relative border-t" style={{ borderColor: "rgba(243,236,223,0.1)" }}>
            <div className="mx-auto max-w-[1280px] px-5 py-12 md:px-14 md:py-16">
              <h2 className="m-0 mb-8 font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold-bright md:mb-10">
                {t.steps.eyebrow}
              </h2>
              <ol className="m-0 grid list-none gap-8 p-0 md:grid-cols-3 md:gap-12">
                {t.steps.items.map((step, i) => (
                  <li key={step.title} className="flex gap-5">
                    <span
                      aria-hidden
                      className="text-gold-grad-light font-display text-[44px] italic leading-none md:text-[54px]"
                    >
                      {i + 1}
                    </span>
                    <div className="pt-1">
                      <h3 className="m-0 font-display text-[23px] font-normal leading-tight text-cream md:text-[26px]">
                        {step.title}
                      </h3>
                      <p className="m-0 mt-2 font-sans text-[14px] leading-[1.65]" style={{ color: "rgba(243,236,223,0.7)" }}>
                        {step.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* ── Tiers + form + success ───────────────────────────────────── */}
        <RegalarFlow
          dict={t}
          lang={typedLang}
          initialTiers={tiers}
          whatsappNumber={process.env.NEXT_PUBLIC_WHATSAPP_NUMBER?.trim() || null}
          paymentInfo={paymentLines(process.env.NEXT_PUBLIC_GIFT_PAYMENT_INFO)}
          turnstileSiteKey={siteConfig.turnstileSiteKey}
        />

        {/* ── Terms ────────────────────────────────────────────────────── */}
        <section className="bg-ivory px-5 pb-16 md:px-14 md:pb-24">
          <div className="mx-auto max-w-[1040px] rounded-[28px] border border-gold/30 bg-paper/60 px-6 py-9 md:px-12 md:py-12">
            <div className="md:grid md:grid-cols-[0.8fr_1.2fr] md:gap-12">
              <div>
                <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.32em] text-gold">{t.terms.eyebrow}</span>
                <h2 className="m-0 mt-3 font-display text-[32px] font-normal leading-tight text-ink md:text-[40px]">{t.terms.title}</h2>
              </div>
              <ul className="m-0 mt-6 list-none p-0 md:mt-0">
                {t.terms.items.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3 border-t border-ink/10 py-3.5 font-sans text-[14px] leading-[1.55] text-ink-soft first:border-t-0 first:pt-0 md:text-[15px]"
                  >
                    <span aria-hidden className="mt-[3px] font-display text-[15px] italic leading-none text-gold">
                      —
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── FAQ ──────────────────────────────────────────────────────── */}
        <section className="border-t border-hair bg-ivory px-5 py-16 md:px-14 md:py-24">
          <div className="mx-auto max-w-[1180px]">
            <span className="font-sans text-[11px] font-semibold uppercase tracking-[0.32em] text-gold">{t.faq.eyebrow}</span>
            <h2
              className="m-0 mt-3.5 font-display text-[38px] font-normal leading-[1.02] text-ink md:text-[56px]"
              style={{ letterSpacing: "-0.02em" }}
            >
              {t.faq.title1}{" "}
              <em className="text-gold-grad not-italic">
                <span className="italic">{t.faq.title2_em}</span>
              </em>
            </h2>
            <div className="mt-10 grid grid-cols-1 gap-x-16 gap-y-9 md:mt-14 md:grid-cols-2 md:gap-y-12">
              {t.faq.items.map((item) => (
                <article key={item.q} className="flex flex-col gap-2.5">
                  <h3 className="m-0 font-display text-[21px] font-normal leading-[1.25] text-ink md:text-[24px]">{item.q}</h3>
                  <p className="m-0 font-sans text-[14px] leading-[1.7] text-ink-soft md:text-[15px]">{item.a}</p>
                </article>
              ))}
            </div>

            <Link
              href={`/${typedLang}`}
              className="mt-14 inline-block font-sans text-[10px] font-semibold uppercase tracking-[0.24em] text-ink-mute no-underline hover:text-gold"
            >
              ← {t.meta.back}
            </Link>
          </div>
        </section>
      </main>

      <Footer dict={dict.footer} lang={typedLang} />
    </>
  );
}
