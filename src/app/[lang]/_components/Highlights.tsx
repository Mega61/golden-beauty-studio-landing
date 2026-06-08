"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { EyebrowLabel } from "./atoms";
import PromoTermsCTA from "./PromoTermsCTA";
import type { PromoItem, PromoScenario } from "@/data/promos.types";

// Auto-advance cadence for the section carousel (ms). Offset from the strip so
// the two carousels don't flip in lockstep.
const ROTATE_MS = 7000;

type HighlightsDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  support: string;
  footerQuote: string;
  footerLink: string;
  termsEyebrow: string;
  termsClose: string;
  termsCloseAria: string;
};

type Props = {
  scenarios: PromoScenario[];
  dict: HighlightsDict;
};

// Accent → background + text + cta colour. Cards never use border-radius and
// never use box-shadow; depth lives in 1px hairlines and accent contrast.
const ACCENT_CARD: Record<
  PromoItem["accent"],
  { background: string; text: string; subtext: string; ctaText: string; eyebrowText: string; rule: string }
> = {
  gold: {
    background: "var(--color-cream)",
    text: "text-ink",
    subtext: "text-ink-soft",
    ctaText: "text-gold",
    eyebrowText: "text-gold",
    rule: "var(--hair)",
  },
  mocha: {
    background: "var(--color-ivory)",
    text: "text-ink",
    subtext: "text-ink-soft",
    ctaText: "text-gold-dark",
    eyebrowText: "text-gold",
    rule: "var(--hair)",
  },
  ink: {
    background: "var(--color-carbon)",
    text: "text-cream",
    subtext: "text-gold-soft/70",
    ctaText: "text-gold-bright",
    eyebrowText: "text-gold-bright",
    rule: "rgba(231, 170, 81, 0.22)",
  },
};

function gridTemplateFor(count: number): string {
  if (count <= 1) return "1fr";
  if (count === 2) return "1.6fr 1fr";
  return "1.6fr 1fr 1fr";
}

function DateBadge({ day, month, onDark }: { day: string; month: string; onDark?: boolean }) {
  return (
    <div
      className="flex h-16 w-16 flex-col items-center justify-center"
      style={{
        background: onDark ? "rgba(20, 16, 14, 0.78)" : "var(--color-ivory)",
        border: "1px solid var(--color-gold)",
        backdropFilter: onDark ? "blur(6px)" : undefined,
      }}
    >
      <span
        className="font-display text-[28px] italic leading-none text-gold"
        style={{ marginBottom: 2 }}
      >
        {day}
      </span>
      <span
        className={`font-sans text-[9px] font-semibold uppercase tracking-[0.28em] ${onDark ? "text-gold-soft" : "text-ink"}`}
      >
        {month}
      </span>
    </div>
  );
}

function Ribbon({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-sans text-[10px] font-semibold uppercase tracking-[0.28em] text-gold-soft"
      style={{
        background: "rgba(20, 16, 14, 0.78)",
        backdropFilter: "blur(6px)",
        padding: "8px 14px",
      }}
    >
      {children}
    </div>
  );
}

function CardCTA({
  href,
  label,
  ctaText,
  ruleColor,
}: {
  href: string;
  label: string;
  ctaText: string;
  ruleColor: string;
}) {
  const external = /^https?:\/\//i.test(href);
  return (
    <div className="mt-6 pt-4" style={{ borderTop: `1px solid ${ruleColor}` }}>
      <Link
        href={href}
        {...(external
          ? { target: "_blank" as const, rel: "noopener noreferrer" }
          : {})}
        className={`inline-flex items-center gap-2 font-sans text-[11px] font-semibold uppercase tracking-[0.28em] ${ctaText}`}
      >
        {label}
        <span className="font-display text-[15px] italic leading-none">→</span>
      </Link>
    </div>
  );
}

// Picks the link version or the terms-dialog version based on whether the item
// carries a `terms[]` array. Items with terms get a button that opens a modal;
// everything else stays a plain link as before.
function ItemCTA({
  item,
  ctaText,
  ruleColor,
  dict,
}: {
  item: PromoItem;
  ctaText: string;
  ruleColor: string;
  dict: HighlightsDict;
}) {
  if (item.terms && item.terms.length > 0) {
    return (
      <PromoTermsCTA
        label={item.cta_label}
        ctaText={ctaText}
        ruleColor={ruleColor}
        title={item.title}
        terms={item.terms}
        dict={{
          termsEyebrow: dict.termsEyebrow,
          termsClose: dict.termsClose,
          termsCloseAria: dict.termsCloseAria,
        }}
      />
    );
  }
  return (
    <CardCTA
      href={item.cta_href}
      label={item.cta_label}
      ctaText={ctaText}
      ruleColor={ruleColor}
    />
  );
}

function FeaturedCard({ item, dict }: { item: PromoItem; dict: HighlightsDict }) {
  const palette = ACCENT_CARD[item.accent] ?? ACCENT_CARD.gold;
  const isInk = item.accent === "ink";
  const hasImage = Boolean(item.image_url);
  return (
    <article
      className={`flex h-full flex-col ${palette.text}`}
      style={{
        background: palette.background,
        border: "1px solid var(--hair)",
      }}
    >
      {/* Native 16/9 — matches the source framing exactly, no crop at any
          breakpoint. The photo is always read as the landscape editorial it
          is, even on narrow screens. */}
      <div className="relative w-full aspect-[16/9]">
        {hasImage ? (
          <Image
            src={item.image_url!}
            alt={item.title}
            fill
            sizes="(min-width: 768px) 60vw, 100vw"
            className="object-cover"
            priority
          />
        ) : (
          // Placeholder: marble texture + carbon wash. Sized identically to
          // the real image, so swapping in a real `image_url` won't shift the
          // surrounding layout.
          <div
            aria-hidden
            className="bg-marble absolute inset-0"
            style={{ filter: "saturate(0.85) contrast(1.05)" }}
          />
        )}
        {/* Subtle bottom wash so the ribbon stays readable without dulling
            the product. Heavier wash kept for the placeholder mármol case. */}
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background: hasImage
              ? "linear-gradient(180deg, rgba(20,15,12,0) 55%, rgba(20,15,12,0.42) 100%)"
              : "linear-gradient(180deg, rgba(20,15,12,0) 30%, rgba(20,15,12,0.55) 100%)",
          }}
        />

        {item.badge_day && item.badge_month && (
          <div className="absolute left-4 top-4 md:left-5 md:top-5">
            <DateBadge day={item.badge_day} month={item.badge_month} />
          </div>
        )}

        {item.ribbon && (
          <div className="absolute bottom-4 left-4 md:bottom-5 md:left-5">
            <Ribbon>{item.ribbon}</Ribbon>
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-5 md:p-9">
        <EyebrowLabel className={palette.eyebrowText}>{item.eyebrow}</EyebrowLabel>
        <h3
          className="m-0 mb-4 mt-3 font-display font-normal leading-[1.05] text-[28px] md:text-[40px]"
          style={{ letterSpacing: "-0.01em" }}
        >
          {item.title}
        </h3>
        <p className={`m-0 font-sans text-[14px] leading-[1.6] md:text-[15px] ${palette.subtext}`}>
          {item.body}
        </p>
        <div className="mt-auto">
          <ItemCTA
            item={item}
            ctaText={palette.ctaText}
            ruleColor={isInk ? "rgba(231,170,81,0.28)" : "var(--hair)"}
            dict={dict}
          />
        </div>
      </div>
    </article>
  );
}

function CompactCard({ item, dict }: { item: PromoItem; dict: HighlightsDict }) {
  const palette = ACCENT_CARD[item.accent] ?? ACCENT_CARD.gold;
  const isInk = item.accent === "ink";
  return (
    <article
      className={`flex h-full flex-col ${palette.text}`}
      style={{
        background: palette.background,
        border: "1px solid var(--hair)",
      }}
    >
      <div className="flex flex-1 flex-col p-5 md:p-7">
        <div className="mb-3 flex items-start justify-between gap-3">
          <EyebrowLabel className={palette.eyebrowText}>{item.eyebrow}</EyebrowLabel>
          {item.badge_day && item.badge_month && (
            <span className="shrink-0 font-display text-[15px] italic text-gold leading-none">
              {item.badge_day} · {item.badge_month}
            </span>
          )}
        </div>
        <h3
          className="m-0 mb-3 font-display font-normal leading-[1.1] text-[22px] md:text-[26px]"
          style={{ letterSpacing: "-0.01em" }}
        >
          {item.title}
        </h3>
        <p className={`m-0 font-sans text-[13px] leading-[1.6] md:text-[14px] ${palette.subtext}`}>
          {item.body}
        </p>
        {item.ribbon && (
          <p
            className={`mt-3 font-sans text-[10px] font-semibold uppercase tracking-[0.28em] ${palette.eyebrowText}`}
          >
            {item.ribbon}
          </p>
        )}
        <div className="mt-auto">
          <ItemCTA
            item={item}
            ctaText={palette.ctaText}
            ruleColor={isInk ? "rgba(231,170,81,0.28)" : "var(--hair)"}
            dict={dict}
          />
        </div>
      </div>
    </article>
  );
}

// One scenario's card block: featured first (if none flagged, the first item
// is promoted so the block never collapses into a row of small cards), then
// the rest as compacts. This is the exact grid the section used to render for
// a single scenario — now it's one carousel slide.
function ScenarioGrid({
  scenario,
  dict,
}: {
  scenario: PromoScenario;
  dict: HighlightsDict;
}) {
  const featured =
    scenario.items.find((it) => it.featured) ?? scenario.items[0];
  const rest = scenario.items.filter((it) => it.id !== featured.id);
  const all = [featured, ...rest];

  return (
    <div
      className="grid grid-cols-1 gap-5 px-5 md:gap-6 md:grid-cols-[var(--gbs-grid-cols)] md:px-0"
      style={
        {
          ["--gbs-grid-cols" as string]: gridTemplateFor(all.length),
        } as React.CSSProperties
      }
    >
      {all.map((item, idx) =>
        idx === 0 ? (
          <FeaturedCard key={item.id} item={item} dict={dict} />
        ) : (
          <CompactCard key={item.id} item={item} dict={dict} />
        ),
      )}
    </div>
  );
}

export default function Highlights({ scenarios, dict }: Props) {
  // Only scenarios that actually have cards become slides.
  const slides = scenarios.filter((s) => s.items.length > 0);
  const count = slides.length;
  const multi = count > 1;

  const [active, setActive] = useState(0);
  const slideRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Measured height of the active slide. The carousel wrapper is locked to it
  // and transitions, so the footer glides instead of jumping between slides of
  // different heights (a 1-card promo is much taller than a 2-card row).
  const [height, setHeight] = useState<number | undefined>(undefined);
  // Until the first measurement the active slide stays in normal flow, so the
  // section sizes correctly during SSR / before hydration (no layout shift).
  const [stacked, setStacked] = useState(false);

  const current = count > 0 ? Math.min(active, count - 1) : 0;

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

  // Lock the wrapper to the active slide's height, then switch every slide to
  // absolute stacking so they can cross-fade over the same footprint.
  useEffect(() => {
    if (!multi) return;
    const el = slideRefs.current[current];
    if (!el) return;
    setHeight(el.offsetHeight);
    setStacked(true);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [current, count, multi]);

  if (count === 0) return null;
  const scenario = slides[current];

  return (
    <section
      id="promos"
      className="relative bg-paper px-0 pb-14 pt-16 md:px-20 md:pb-[100px] md:pt-[120px]"
    >
      <div className="relative mx-auto max-w-[1240px]">
        {/* Header — the scenario label tracks the active carousel slide. */}
        <div className="mb-10 grid grid-cols-1 gap-6 px-5 md:mb-16 md:grid-cols-[1.4fr_1fr] md:items-end md:gap-12 md:px-0">
          <div>
            <EyebrowLabel className="text-gold">
              — {dict.eyebrow} · {scenario.label}
            </EyebrowLabel>
            <h2
              className="mb-0 mt-3.5 font-display text-[36px] font-normal leading-[1.02] text-ink md:text-[64px]"
              style={{ letterSpacing: "-0.02em" }}
            >
              {dict.title1}
              <br />
              <em className="text-gold-grad italic">{dict.title2_em}</em>
            </h2>
          </div>
          <p className="m-0 max-w-[460px] font-display text-[18px] italic leading-[1.45] text-ink-soft md:text-[22px]">
            {dict.support}
          </p>
        </div>

        {/* Carousel — slides cross-fade over a height-animated footprint. A lone
            promo skips all of this and renders as a plain grid. */}
        {multi ? (
          <div
            className="relative overflow-hidden"
            style={{
              height: height,
              transition: "height 500ms cubic-bezier(0.4, 0, 0.2, 1)",
            }}
          >
            {slides.map((s, i) => {
              const isCurrent = i === current;
              return (
                <div
                  key={s.slug}
                  ref={(el) => {
                    slideRefs.current[i] = el;
                  }}
                  aria-hidden={!isCurrent}
                  className="transition-opacity duration-500 ease-in-out"
                  style={{
                    position: stacked || !isCurrent ? "absolute" : "relative",
                    top: 0,
                    left: 0,
                    right: 0,
                    opacity: isCurrent ? 1 : 0,
                    pointerEvents: isCurrent ? "auto" : "none",
                  }}
                >
                  <ScenarioGrid scenario={s} dict={dict} />
                </div>
              );
            })}
          </div>
        ) : (
          <ScenarioGrid scenario={scenario} dict={dict} />
        )}

        {/* Dots — only when more than one promo is live. Each is labeled with
            its scenario so the control is meaningful to screen readers. */}
        {count > 1 && (
          <div
            role="tablist"
            aria-label={dict.eyebrow}
            className="mt-8 flex items-center justify-center gap-3 px-5 md:mt-10 md:px-0"
          >
            {slides.map((s, i) => (
              <button
                key={s.slug}
                type="button"
                role="tab"
                aria-selected={i === current}
                aria-label={s.label}
                onClick={() => setActive(i)}
                className="flex cursor-pointer items-center gap-2 font-sans text-[10px] font-semibold uppercase tracking-[0.28em] transition-colors"
                style={{ color: i === current ? "var(--color-gold)" : "var(--color-ink-soft)" }}
              >
                <span
                  className="inline-block h-[6px] w-[6px] rounded-full transition-opacity"
                  style={{ background: "currentColor", opacity: i === current ? 1 : 0.45 }}
                />
                {s.label}
              </button>
            ))}
          </div>
        )}

        {/* Footer */}
        <div
          className="mt-12 flex flex-col gap-3 px-5 pt-7 md:mt-16 md:flex-row md:items-center md:justify-between md:gap-6 md:px-0 md:pt-8"
          style={{ borderTop: "1px solid var(--hair)" }}
        >
          <p className="m-0 font-display text-[15px] italic text-ink-soft md:text-[17px]">
            {dict.footerQuote}
          </p>
          <a
            href="#contacto"
            className="font-sans text-[11px] font-semibold uppercase tracking-[0.28em] text-gold underline underline-offset-[5px]"
          >
            {dict.footerLink}
          </a>
        </div>
      </div>
    </section>
  );
}
