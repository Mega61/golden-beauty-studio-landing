import Image from "next/image";
import Logo from "./Logo";
import { BioLink, BioView } from "./BioLink";
import BioPromoBanner from "./BioPromoBanner";
import SocialIcon from "./SocialIcon";
import type { BioData, BioPromo } from "@/data/bio.types";

type Props = {
  bio: BioData;
  promos: BioPromo[];
};

/**
 * Standalone link-in-bio page — the editorial Linktree replacement the
 * Instagram bio points at. Mobile-first (390 px target, centered on wider
 * viewports), built entirely from design-system tokens: no border-radius beyond
 * the social-chip circles, and the only box-shadow is the pulse-dot halo. The
 * single gold gradient fill on the page is the primary CTA.
 *
 * Server component; the tracked anchors (`BioLink`) and the `bio_view` beacon
 * (`BioView`) are the only client pieces. Every clickable funnels through GA4.
 */

export default function Bio({ bio, promos }: Props) {
  const primary = bio.links.find((l) => l.primary) ?? null;
  const rows = bio.links.filter((l) => !l.primary);

  const hasPromo = promos.length > 0;
  const ctaMt = hasPromo ? 14 : 26;
  const rowsMt = primary ? 12 : hasPromo ? 14 : 26;

  return (
    <main
      className="relative w-full overflow-hidden"
      style={{
        minHeight: "100dvh",
        backgroundColor: "var(--color-ivory)",
      }}
    >
      <BioView />

      {/* Brand gold-marble surface, dialed back to a faint wash so it reads as
          texture, not subject — content stays legible above it. */}
      <div
        aria-hidden
        className="bg-marble pointer-events-none absolute inset-0"
        style={{ opacity: 0.32 }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(248,244,238,0.55) 0%, rgba(248,244,238,0.78) 100%)",
        }}
      />
      <div
        className="relative mx-auto flex w-full max-w-[400px] flex-col items-center"
        style={{
          paddingTop: "max(36px, env(safe-area-inset-top))",
          paddingLeft: "max(22px, env(safe-area-inset-left))",
          paddingRight: "max(22px, env(safe-area-inset-right))",
          paddingBottom: "max(32px, env(safe-area-inset-bottom))",
        }}
      >
        <h1 className="sr-only">Golden Beauty Studio — {bio.handle}</h1>

        {/* Brand lockup — leads the page now that the avatar is gone */}
        <Logo variant="text" size={18} />

        {/* Location eyebrow — gold caps flanked by hairlines */}
        <div className="flex items-center" style={{ marginTop: 16, gap: 12 }}>
          <span
            aria-hidden
            className="block h-px"
            style={{ width: 18, background: "var(--color-gold)" }}
          />
          <span
            className="font-sans uppercase"
            style={{
              fontSize: 10,
              letterSpacing: "0.32em",
              color: "var(--color-gold)",
            }}
          >
            {bio.location}
          </span>
          <span
            aria-hidden
            className="block h-px"
            style={{ width: 18, background: "var(--color-gold)" }}
          />
        </div>

        {/* Tagline — Cormorant italic */}
        <p
          className="font-display text-center italic"
          style={{
            marginTop: 14,
            fontSize: 17,
            lineHeight: 1.4,
            maxWidth: 280,
            color: "var(--color-ink-soft)",
          }}
        >
          {bio.tagline}
        </p>

        {/* Pinned promo band — a photographic hero (omitted when no scenario is
            active). With 2+ active promos it becomes a rotating carousel,
            mirroring the landing strip + Highlights. */}
        <BioPromoBanner promos={promos} />

        {/* Primary CTA — the only gold gradient fill on the page */}
        {primary && (
          <BioLink
            href={primary.href}
            linkKey={primary.key}
            label={primary.label}
            kind="cta"
            external={primary.external}
            className="bg-gold-grad flex w-full items-center justify-between no-underline"
            style={{ marginTop: ctaMt, gap: 14, padding: "20px 22px" }}
          >
            <span className="min-w-0">
              <span
                className="block font-sans uppercase text-white"
                style={{
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: "0.24em",
                }}
              >
                {primary.label}
              </span>
              <span
                className="block font-sans"
                style={{
                  marginTop: 5,
                  fontSize: 11,
                  color: "rgba(255, 255, 255, 0.82)",
                }}
              >
                {primary.sub}
              </span>
            </span>
            <span
              aria-hidden
              className="shrink-0 font-display italic leading-none text-white"
              style={{ fontSize: 26 }}
            >
              →
            </span>
          </BioLink>
        )}

        {/* Link rows — hairline cards, in priority order */}
        <div
          className="flex w-full flex-col"
          style={{ marginTop: rowsMt, gap: 12 }}
        >
          {rows.map((link) => (
            <BioLink
              key={link.key}
              href={link.href}
              linkKey={link.key}
              label={link.label}
              kind="row"
              external={link.external}
              className="relative flex w-full items-stretch overflow-hidden no-underline"
              style={{
                minHeight: 68,
                background: "var(--color-paper)",
                border: "1px solid var(--hair)",
              }}
            >
              {/* Thumbnail — flush left, spans the full height of the row */}
              {link.image && (
                <span
                  className="relative shrink-0 self-stretch"
                  style={{
                    width: 72,
                    borderRight: "1px solid var(--hair)",
                  }}
                >
                  <Image
                    src={link.image}
                    alt=""
                    fill
                    sizes="72px"
                    className="object-cover"
                    style={{ filter: "saturate(0.94) contrast(1.02)" }}
                  />
                </span>
              )}
              <span
                className="flex min-w-0 flex-1 flex-col justify-center"
                style={{ padding: "12px 16px" }}
              >
                <span
                  className="block font-display"
                  style={{
                    fontSize: 19,
                    lineHeight: 1.12,
                    color: "var(--color-ink)",
                  }}
                >
                  {link.label}
                </span>
                <span
                  className="block font-sans uppercase"
                  style={{
                    marginTop: 6,
                    fontSize: 10,
                    fontWeight: 500,
                    letterSpacing: "0.18em",
                    color: "var(--color-ink-mute)",
                  }}
                >
                  {link.sub}
                </span>
              </span>
              <span
                aria-hidden
                className="flex shrink-0 items-center font-display italic leading-none"
                style={{
                  paddingRight: 18,
                  fontSize: 22,
                  color: "var(--color-gold)",
                }}
              >
                →
              </span>
            </BioLink>
          ))}
        </div>

        {/* Socials + wordmark */}
        <div
          className="flex w-full flex-col items-center"
          style={{ marginTop: 30, gap: 16 }}
        >
          <span
            aria-hidden
            className="block h-px"
            style={{ width: 40, background: "var(--hair)" }}
          />
          {bio.socials.length > 0 && (
            <div className="flex items-center" style={{ gap: 14 }}>
              {bio.socials.map((s) => (
                <BioLink
                  key={s.key}
                  href={s.href}
                  linkKey={s.key}
                  label={s.label}
                  kind="social"
                  external
                  ariaLabel={s.label}
                  className="flex items-center justify-center rounded-full no-underline"
                  style={{
                    width: 44,
                    height: 44,
                    border: "1px solid var(--hair)",
                    color: "var(--color-gold)",
                  }}
                >
                  <SocialIcon name={s.key} size={18} />
                </BioLink>
              ))}
            </div>
          )}
          <span
            className="font-sans uppercase"
            style={{
              fontSize: 9.5,
              letterSpacing: "0.3em",
              color: "var(--color-ink-mute)",
            }}
          >
            Golden Beauty Studio
          </span>
        </div>
      </div>
    </main>
  );
}
