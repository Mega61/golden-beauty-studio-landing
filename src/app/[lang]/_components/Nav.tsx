import Link from "next/link";
import Logo from "./Logo";
import MobileMenu from "./MobileMenu";
import { PrimaryCTA } from "./atoms";
import type { Locale } from "../dictionaries";
import { siteConfig, type SectionKey } from "@/config/site";

type NavItemKey = "trabajo" | "servicios" | "tecnicas" | "estudio" | "contacto";

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
  contacto: "contacto",
};

export default function Nav({
  lang,
  dict,
  sections,
}: {
  lang: Locale;
  dict: NavDict;
  sections: typeof siteConfig.sections;
}) {
  const otherLang: Locale = lang === "es" ? "en" : "es";
  const allAnchors: Array<{ key: NavItemKey; href: string }> = [
    { key: "trabajo", href: "#trabajo" },
    { key: "servicios", href: "#servicios" },
    { key: "tecnicas", href: "#tecnicas" },
    { key: "estudio", href: "#estudio" },
    { key: "contacto", href: "#contacto" },
  ];
  const anchors = allAnchors.filter(
    (a) => sections[NAV_SECTION_MAP[a.key]],
  );
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
          {anchors.map((a) => (
            <a
              key={a.key}
              href={a.href}
              className="font-sans text-[11px] font-medium uppercase tracking-[0.28em] text-ink no-underline hover:text-gold"
            >
              {dict.items[a.key]}
            </a>
          ))}
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
          <PrimaryCTA href={bookingUrl}>{dict.cta}</PrimaryCTA>
        </div>

        <MobileMenu
          lang={lang}
          otherLang={otherLang}
          items={anchors.map((a) => ({
            key: a.key,
            href: a.href,
            label: dict.items[a.key],
          }))}
          cta={dict.cta}
          ctaShort={dict.ctaShort}
          bookingUrl={bookingUrl}
        />
      </div>
    </header>
  );
}
