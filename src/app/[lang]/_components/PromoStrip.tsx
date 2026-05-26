"use client";

import { useState } from "react";
import Link from "next/link";
import type { PromoScenario, PromoStripAccent } from "@/data/promos.types";

type PromoStripDict = {
  dismissAria: string;
};

type Props = {
  scenario: PromoScenario | null;
  dict: PromoStripDict;
};

// Inline-style maps for the 3 accents. Tailwind utility classes would also
// work for the simple ones, but the gold gradient and ivory bottom-border
// land cleaner as one object per accent.
const ACCENT_STYLES: Record<
  PromoStripAccent,
  { container: React.CSSProperties; text: string; tagText: string; ctaText: string }
> = {
  gold: {
    container: {
      background:
        "linear-gradient(90deg, var(--color-gold-dark) 0%, var(--color-gold) 50%, var(--color-gold-bright) 100%)",
    },
    text: "text-white",
    tagText: "text-white/85",
    ctaText: "text-white",
  },
  ink: {
    container: { background: "var(--color-carbon)" },
    text: "text-gold-soft",
    tagText: "text-gold-soft/80",
    ctaText: "text-gold-bright",
  },
  ivory: {
    container: {
      background: "var(--color-cream)",
      borderBottom: "1px solid var(--hair)",
    },
    text: "text-ink",
    tagText: "text-ink-soft",
    ctaText: "text-gold-dark",
  },
};

export default function PromoStrip({ scenario, dict }: Props) {
  // Dismiss is session-only on purpose — every page load gives the strip
  // another chance to land. Move to localStorage if persistence is wanted.
  const [dismissed, setDismissed] = useState(false);

  if (!scenario || !scenario.strip || dismissed) return null;
  const { tag, message, cta, href, until, accent } = scenario.strip;
  const styles = ACCENT_STYLES[accent] ?? ACCENT_STYLES.gold;

  return (
    <div
      role="region"
      aria-label={tag}
      className={`relative w-full ${styles.text}`}
      style={styles.container}
    >
      <div className="mx-auto flex h-[38px] max-w-[1440px] items-center gap-3 px-4 md:h-10 md:gap-4 md:px-8">
        {/* Tag pill — hidden on mobile */}
        <span
          className={`hidden shrink-0 border px-2.5 py-1 font-sans text-[10px] font-semibold uppercase tracking-[0.28em] md:inline-flex ${styles.tagText}`}
          style={{ borderColor: "currentColor", opacity: 0.7 }}
        >
          {tag}
        </span>

        {/* Pulse dot + message */}
        <div className="flex min-w-0 flex-1 items-center justify-center gap-3 md:gap-4">
          <span
            aria-hidden
            className="gbs-pulse inline-block h-[7px] w-[7px] shrink-0"
            style={{ background: "var(--color-gold-bright)" }}
          />
          <span
            className={`font-display truncate text-[13px] italic md:text-[15px] ${styles.text}`}
          >
            {message}
          </span>
        </div>

        {/* Until label — hidden on mobile, omitted entirely when no deadline */}
        {until && (
          <span
            className={`hidden shrink-0 font-sans text-[10px] font-semibold uppercase tracking-[0.28em] md:inline-flex ${styles.ctaText}`}
          >
            {until}
          </span>
        )}

        {/* CTA — external URLs (http(s)://) open in a new tab so the strip's
            promo doesn't kick the user out of the landing. Hash anchors stay
            in-tab as usual. */}
        <Link
          href={href}
          {...(/^https?:\/\//i.test(href)
            ? { target: "_blank" as const, rel: "noopener noreferrer" }
            : {})}
          className={`shrink-0 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] underline underline-offset-[5px] md:text-[12px] ${styles.ctaText}`}
        >
          {cta}
        </Link>

        {/* Dismiss */}
        <button
          type="button"
          aria-label={dict.dismissAria}
          onClick={() => setDismissed(true)}
          className={`shrink-0 cursor-pointer p-1 font-sans text-base leading-none ${styles.text}`}
        >
          ×
        </button>
      </div>
    </div>
  );
}
