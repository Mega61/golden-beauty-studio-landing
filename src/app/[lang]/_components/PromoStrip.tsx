"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type {
  PromoScenario,
  PromoStrip as PromoStripData,
  PromoStripAccent,
} from "@/data/promos.types";

type PromoStripDict = {
  dismissAria: string;
};

type Props = {
  scenarios: PromoScenario[];
  dict: PromoStripDict;
};

// Auto-advance cadence for the strip carousel (ms). Offset from the Highlights
// section so the two carousels don't flip in lockstep.
const ROTATE_MS = 6000;

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

// One stacked layer per strip. Only the active layer is visible (opacity 1);
// the rest cross-fade out, carrying their own accent background with them.
function Slide({
  strip,
  active,
  dict,
  onDismiss,
  controls,
}: {
  strip: PromoStripData;
  active: boolean;
  dict: PromoStripDict;
  onDismiss: () => void;
  controls: React.ReactNode;
}) {
  const { tag, message, cta, href, until, accent } = strip;
  const styles = ACCENT_STYLES[accent] ?? ACCENT_STYLES.gold;
  const external = /^https?:\/\//i.test(href);

  return (
    <div
      aria-hidden={!active}
      className={`absolute inset-0 transition-opacity duration-500 ${styles.text}`}
      style={{
        ...styles.container,
        opacity: active ? 1 : 0,
        pointerEvents: active ? "auto" : "none",
      }}
    >
      <div className="mx-auto flex h-full max-w-[1440px] items-center gap-3 px-4 md:gap-4 md:px-8">
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
          {...(external
            ? { target: "_blank" as const, rel: "noopener noreferrer" }
            : {})}
          className={`shrink-0 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] underline underline-offset-[5px] md:text-[12px] ${styles.ctaText}`}
        >
          {cta}
        </Link>

        {/* Carousel dots — only present when more than one promo is live */}
        {controls}

        {/* Dismiss */}
        <button
          type="button"
          aria-label={dict.dismissAria}
          onClick={onDismiss}
          className={`shrink-0 cursor-pointer p-1 font-sans text-base leading-none ${styles.text}`}
        >
          ×
        </button>
      </div>
    </div>
  );
}

export default function PromoStrip({ scenarios, dict }: Props) {
  // Dismiss is session-only on purpose — every page load gives the strip
  // another chance to land. Move to localStorage if persistence is wanted.
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);

  // Each active scenario contributes its single strip (if any). Order follows
  // NEXT_PUBLIC_ACTIVE_PROMO, so it doubles as the carousel order.
  const strips = scenarios
    .map((s) => s.strip)
    .filter((s): s is PromoStripData => Boolean(s));
  const count = strips.length;

  // Auto-advance. Depending on `active` restarts the timer on every change, so
  // a manual dot click also resets the countdown.
  useEffect(() => {
    if (count <= 1) return;
    const id = setInterval(
      () => setActive((i) => (i + 1) % count),
      ROTATE_MS,
    );
    return () => clearInterval(id);
  }, [count, active]);

  if (count === 0 || dismissed) return null;
  const current = Math.min(active, count - 1);

  const dots =
    count > 1 ? (
      <div className="flex shrink-0 items-center gap-2">
        {strips.map((s, i) => (
          <button
            key={s.tag + i}
            type="button"
            aria-label={s.tag}
            aria-current={i === current}
            onClick={() => setActive(i)}
            className="h-[6px] w-[6px] cursor-pointer rounded-full transition-opacity"
            style={{
              background: "currentColor",
              opacity: i === current ? 1 : 0.4,
            }}
          />
        ))}
      </div>
    ) : null;

  return (
    <div
      role="region"
      aria-label={strips[current].tag}
      aria-live="polite"
      className="relative w-full overflow-hidden h-[38px] md:h-10"
    >
      {strips.map((strip, i) => (
        <Slide
          key={strip.tag + i}
          strip={strip}
          active={i === current}
          dict={dict}
          onDismiss={() => setDismissed(true)}
          controls={dots}
        />
      ))}
    </div>
  );
}
