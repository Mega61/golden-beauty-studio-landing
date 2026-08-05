import Link from "next/link";
import type { Locale } from "../dictionaries";
import type { JobRole } from "@/data/careers.types";

/**
 * Copy for the two places the studio *announces* it's hiring — this band and
 * the /bio banner slide.
 *
 * It lives under its own `vacantes` dictionary key rather than inside
 * `trabaja`, for two reasons. An announcement has to work as an interruption on
 * a page about something else, so it gets a shorter, blunter voice than the
 * careers page's own headline copy. And `trabaja` is handed whole to the client
 * form component — folding this in would ship announcement copy to every
 * visitor's browser to render nothing.
 */
export type VacantesDict = {
  eyebrow: string;
  title: string;
  body: string;
  /** Accessible name for the open-cargos chip list. */
  rolesLabel: string;
  cta: string;
  /** The /bio slide runs tighter than this band, so it gets its own pair. */
  bioTitle: string;
  bioCta: string;
};

/**
 * "Estamos contratando" — the hiring announcement inside the landing's promo
 * section (`#promos`).
 *
 * Deliberately NOT a promo card and NOT a carousel slide. A promo rotates, so
 * roughly half the visitors never see any given one; hiring is an always-on
 * fact, and a vacancy that only shows up every other 7 seconds is a vacancy
 * nobody applies to. It also speaks to a different audience than everything
 * else on the page, which is why it breaks register: carbon surface under the
 * cream promo cards, the same recipe `ACCENT_CARD.ink` and the careers page
 * already use, so it reads as a different *voice* without inventing a style.
 *
 * Server component. It's handed to `Highlights` (a client component) as a
 * ReactNode slot rather than imported by it, so none of this markup — nor the
 * cargo list — ends up in the client bundle.
 */

/** Cargo the owner keeps in the CMS as a catch-all. Real on the form's dropdown
 *  ("¿ninguno encaja? Otro"), meaningless as an advertised opening. */
const CATCH_ALL_SLUG = "otro";

/** Chips past this point stop reading as a list and start reading as noise. */
const MAX_CHIPS = 5;

export default function VacantesBand({
  dict,
  lang,
  roles,
}: {
  dict: VacantesDict;
  lang: Locale;
  roles: JobRole[];
}) {
  const chips = roles
    .filter((r) => r.slug !== CATCH_ALL_SLUG)
    .slice(0, MAX_CHIPS);

  // The band's accessible name comes from its own headline. That headline is a
  // <p>, not an <h3>, on purpose: with no promo running the section renders no
  // <h2> above it, and a lone <h3> would be a heading-level skip. The landmark
  // is named either way, which is what actually helps someone navigating by
  // landmark or heading.
  const titleId = "vacantes-band-title";

  return (
    <aside
      id="vacantes"
      aria-labelledby={titleId}
      className="relative mx-5 overflow-hidden md:mx-0"
      style={{
        background: "var(--color-carbon)",
        border: "1px solid rgba(231, 170, 81, 0.22)",
      }}
    >
      {/* Same faint marble wash as the careers page and the /bio card. */}
      <div
        aria-hidden
        className="bg-marble pointer-events-none absolute inset-0"
        style={{ opacity: 0.06 }}
      />

      <div className="relative grid grid-cols-1 gap-6 p-6 md:grid-cols-[1.5fr_auto] md:items-center md:gap-12 md:p-9">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className="gbs-pulse inline-block h-[7px] w-[7px] shrink-0"
              style={{ background: "var(--color-gold-bright)" }}
            />
            <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold-bright">
              {dict.eyebrow}
            </span>
          </div>

          <p
            id={titleId}
            className="m-0 mt-3.5 font-display text-[26px] font-normal leading-[1.08] text-cream md:text-[34px]"
            style={{ letterSpacing: "-0.01em", textWrap: "balance" }}
          >
            {dict.title}
          </p>

          <p
            className="m-0 mt-3 max-w-[54ch] font-sans text-[13px] leading-[1.65] md:text-[14px]"
            style={{ color: "rgba(243,236,223,0.72)", textWrap: "pretty" }}
          >
            {dict.body}
          </p>

          {chips.length > 0 && (
            <ul
              aria-label={dict.rolesLabel}
              className="m-0 mt-5 flex list-none flex-wrap gap-2 p-0"
            >
              {chips.map((role) => (
                <li
                  key={role.slug}
                  className="font-sans text-[11px] leading-none"
                  style={{
                    padding: "8px 12px",
                    border: "1px solid rgba(243,236,223,0.18)",
                    color: "rgba(243,236,223,0.78)",
                  }}
                >
                  {role.label}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Gold-bordered ghost, never the gold gradient fill: on the landing the
            gradient belongs to booking, and a hiring notice must not out-shout
            the thing that pays for the studio. Full-width on a phone so the tap
            target spans the band; auto-width beside the copy from md up. */}
        <Link
          href={`/${lang}/trabaja-con-nosotros`}
          className="inline-flex w-full cursor-pointer items-center justify-center gap-3 border border-gold px-6 py-3.5 font-sans text-[12px] font-semibold uppercase tracking-[0.24em] text-gold-soft no-underline md:w-auto md:px-8 md:py-4 md:text-[13px]"
        >
          {dict.cta}
          <span aria-hidden className="font-display text-[15px] italic leading-none">
            →
          </span>
        </Link>
      </div>
    </aside>
  );
}
