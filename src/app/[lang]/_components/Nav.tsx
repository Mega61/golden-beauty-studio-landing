import Link from "next/link";
import Logo from "./Logo";
import MobileMenu from "./MobileMenu";
import { PrimaryCTA } from "./atoms";
import type { Locale } from "../dictionaries";
import { siteConfig, type SectionKey } from "@/config/site";

type NavItemKey =
  | "trabajo"
  | "servicios"
  | "tecnicas"
  | "estudio"
  | "reviews"
  | "contacto"
  | "trabaja";

type NavDict = {
  items: Record<NavItemKey, string>;
  cta: string;
  ctaShort: string;
};

// Maps a nav anchor to the section toggle that controls its target.
const NAV_SECTION_MAP: Record<NavItemKey, SectionKey> = {
  trabajo: "lookbook",
  servicios: "servicios",
  tecnicas: "tecnicas",
  estudio: "estudio",
  reviews: "reviews",
  contacto: "contacto",
  trabaja: "trabaja",
};

/** Careers lives on its own route, not a section of the landing. */
const CAREERS_PATH = "trabaja-con-nosotros";

export default function Nav({
  lang,
  dict,
  sections,
  onLanding = true,
}: {
  lang: Locale;
  dict: NavDict;
  sections: typeof siteConfig.sections;
  /**
   * False when the nav is rendered on a standalone page (e.g. the careers page).
   * The section links then point back at the landing (`/es#servicios`) instead of
   * being bare in-page hashes that would resolve to nothing.
   */
  onLanding?: boolean;
}) {
  const otherLang: Locale = lang === "es" ? "en" : "es";
  // `route: true` items navigate to another page; the rest are in-page anchors.
  const allAnchors: Array<{ key: NavItemKey; hash: string; route?: boolean }> = [
    { key: "trabajo", hash: "#trabajo" },
    { key: "servicios", hash: "#servicios" },
    { key: "tecnicas", hash: "#tecnicas" },
    { key: "estudio", hash: "#estudio" },
    { key: "reviews", hash: "#reviews" },
    { key: "contacto", hash: "#contacto" },
    { key: "trabaja", hash: `/${lang}/${CAREERS_PATH}`, route: true },
  ];
  const anchors = allAnchors
    .filter((a) => sections[NAV_SECTION_MAP[a.key]])
    .map((a) => ({
      ...a,
      href: a.route ? a.hash : onLanding ? a.hash : `/${lang}${a.hash}`,
    }));
  const { bookingUrl } = siteConfig;

  return (
    <header
      className="sticky top-0 z-50 border-b border-hair backdrop-blur-2xl"
      style={{ background: "rgba(248, 244, 238, 0.86)" }}
    >
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-5 pb-3.5 pt-3.5 md:px-14 md:py-5">
        <Link href={`/${lang}`} aria-label="Golden Beauty Studio">
          <Logo variant="text" size={12} />
        </Link>

        <nav className="hidden gap-7 lg:flex lg:gap-9">
          {anchors.map((a) => {
            const className =
              "font-sans text-[11px] font-medium uppercase tracking-[0.28em] text-ink no-underline hover:text-gold";
            // Routes use <Link> for client-side navigation; hash anchors stay
            // plain <a> because next/link short-circuits repeat same-hash clicks.
            return a.route ? (
              <Link key={a.key} href={a.href} className={className}>
                {dict.items[a.key]}
              </Link>
            ) : (
              <a key={a.key} href={a.href} className={className}>
                {dict.items[a.key]}
              </a>
            );
          })}
        </nav>

        <div className="hidden items-center gap-4 lg:flex">
          <Link
            href={`/${otherLang}`}
            className="font-sans text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-mute no-underline hover:text-gold"
            aria-label={`Switch to ${otherLang.toUpperCase()}`}
          >
            {lang.toUpperCase()} <span className="text-ink-mute/60">/</span>{" "}
            <span className="text-ink-mute/60">{otherLang.toUpperCase()}</span>
          </Link>
          <PrimaryCTA href={bookingUrl} trackLocation="nav">
            {dict.cta}
          </PrimaryCTA>
        </div>

        <MobileMenu
          lang={lang}
          otherLang={otherLang}
          items={anchors.map((a) => ({
            key: a.key,
            href: a.href,
            label: dict.items[a.key],
            route: a.route,
          }))}
          cta={dict.cta}
          ctaShort={dict.ctaShort}
          bookingUrl={bookingUrl}
        />
      </div>
    </header>
  );
}
