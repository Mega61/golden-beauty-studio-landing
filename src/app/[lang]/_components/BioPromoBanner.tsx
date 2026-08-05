"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { BioLink } from "./BioLink";
import { CAREERS_PANEL_EVENT, CAREERS_PANEL_HASH } from "@/lib/careers-panel";
import type { BioHiring, BioPromo } from "@/data/bio.types";

// Auto-advance cadence (ms) for the bio promo carousel. Matches the landing
// strip so the brand's promo rotation feels consistent across surfaces.
const ROTATE_MS = 6000;

// Fixed band height so the absolutely-stacked slides can cross-fade without the
// layout jumping. Mirrors the single-band `minHeight` the bio used before.
const BAND_HEIGHT = 210;

// Horizontal travel that counts as a swipe rather than a tap. 40px is short
// enough for a thumb flick on a 390px screen and long enough that it never
// steals a deliberate tap on the band.
const SWIPE_PX = 40;

type Slide =
  | { kind: "promo"; promo: BioPromo }
  | { kind: "hiring"; hiring: BioHiring };

function slideTag(slide: Slide): string {
  return slide.kind === "promo" ? slide.promo.tag : slide.hiring.tag;
}

// Shared chrome for both slide kinds: the eyebrow with its pulse dot at the
// top, headline and CTA pinned to the bottom.
function SlideBody({
  tag,
  title,
  cta,
  children,
}: {
  tag: string;
  title: string;
  cta: string;
  children?: React.ReactNode;
}) {
  return (
    <>
      {children}

      {/* top — eyebrow + pulse */}
      <span className="relative flex items-center" style={{ gap: 10 }}>
        <span
          aria-hidden
          className="gbs-pulse inline-block shrink-0 rounded-full"
          style={{ width: 8, height: 8, background: "var(--color-gold-bright)" }}
        />
        <span
          className="font-sans uppercase"
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: "0.3em",
            color: "var(--color-gold-bright)",
          }}
        >
          {tag}
        </span>
      </span>

      {/* bottom — headline + CTA */}
      <span className="relative block">
        <span
          className="block font-display italic"
          style={{ fontSize: 23, lineHeight: 1.1, color: "var(--color-ivory)" }}
        >
          {title}
        </span>
        <span
          className="mt-3 flex items-center justify-between"
          style={{ gap: 12 }}
        >
          <span
            className="font-sans uppercase"
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.24em",
              color: "var(--color-gold-soft)",
            }}
          >
            {cta}
          </span>
          <span
            aria-hidden
            className="shrink-0 font-display italic leading-none"
            style={{ fontSize: 24, color: "var(--color-gold-bright)" }}
          >
            →
          </span>
        </span>
      </span>
    </>
  );
}

const LAYER_CLASS =
  "absolute inset-0 flex flex-col justify-between overflow-hidden no-underline";

function layerStyle(active: boolean, reduced: boolean): React.CSSProperties {
  return {
    padding: 20,
    background: "var(--color-carbon)",
    border: "1px solid rgba(231, 170, 81, 0.22)",
    opacity: active ? 1 : 0,
    transitionProperty: "opacity",
    transitionTimingFunction: "ease",
    transitionDuration: reduced ? "0ms" : "500ms",
    pointerEvents: active ? "auto" : "none",
  };
}

// One promo slide — the photographic band the bio has always used.
function PromoSlide({
  promo,
  active,
  reduced,
}: {
  promo: BioPromo;
  active: boolean;
  reduced: boolean;
}) {
  return (
    <BioLink
      href={promo.href}
      linkKey="promo"
      label={promo.tag}
      kind="promo"
      external={/^https?:\/\//i.test(promo.href)}
      className={LAYER_CLASS}
      style={layerStyle(active, reduced)}
    >
      <SlideBody tag={promo.tag} title={promo.title} cta={promo.cta}>
        {promo.image && (
          <Image
            src={promo.image}
            alt=""
            fill
            sizes="400px"
            className="object-cover"
            style={{ filter: "brightness(0.6) contrast(1.05) saturate(0.95)" }}
          />
        )}
        <span
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(20,15,12,0.4) 0%, rgba(20,15,12,0.18) 42%, rgba(20,15,12,0.85) 100%)",
          }}
        />
        <span
          aria-hidden
          className="bg-marble absolute inset-0"
          style={{ mixBlendMode: "soft-light", opacity: 0.22 }}
        />
      </SlideBody>
    </BioLink>
  );
}

/**
 * The hiring slide. Same footprint and same chrome as a promo, but with no
 * photograph — that absence is the whole point: a job ad dressed as an offer
 * would read as one more thing to buy, and the visitor scrolling past is being
 * asked for something entirely different.
 *
 * It links to the form already on this page rather than to
 * `/trabaja-con-nosotros`. Sending a bio visitor to another route to fill in a
 * form that's 200px below them is the exact hop the inline disclosure was
 * built to remove.
 */
function HiringSlide({
  hiring,
  active,
  reduced,
}: {
  hiring: BioHiring;
  active: boolean;
  reduced: boolean;
}) {
  return (
    <BioLink
      href={CAREERS_PANEL_HASH}
      linkKey="trabaja"
      label={hiring.tag}
      kind="careers"
      onClick={() => {
        window.dispatchEvent(new CustomEvent(CAREERS_PANEL_EVENT));
      }}
      className={LAYER_CLASS}
      style={layerStyle(active, reduced)}
    >
      <SlideBody tag={hiring.tag} title={hiring.title} cta={hiring.cta}>
        {/* Marble at full strength instead of the soft-light veil the promos
            use over a photo — it's the only texture on this slide. */}
        <span
          aria-hidden
          className="bg-marble absolute inset-0"
          style={{ opacity: 0.1 }}
        />
        <span
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(20,15,12,0.15) 0%, rgba(20,15,12,0.6) 100%)",
          }}
        />
      </SlideBody>
    </BioLink>
  );
}

export default function BioPromoBanner({
  promos,
  hiring,
}: {
  promos: BioPromo[];
  /** Null when the hiring announcement is switched off. */
  hiring?: BioHiring | null;
}) {
  // Hiring goes last so a live promo still owns the first paint — the visitor
  // who came to book sees the offer, not the job ad.
  const slides: Slide[] = [
    ...promos.map((promo): Slide => ({ kind: "promo", promo })),
    ...(hiring ? [{ kind: "hiring" as const, hiring }] : []),
  ];
  const count = slides.length;

  const [active, setActive] = useState(0);
  const [reduced, setReduced] = useState(false);
  // Auto-rotation stops for good once the visitor drives the carousel by hand.
  // Something that keeps moving under a thumb that just moved it reads as the
  // interface arguing back.
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Auto-advance; depending on `active` restarts the timer so a manual tap
  // also resets the countdown.
  useEffect(() => {
    if (count <= 1 || paused || reduced) return;
    const id = setInterval(() => setActive((i) => (i + 1) % count), ROTATE_MS);
    return () => clearInterval(id);
  }, [count, active, paused, reduced]);

  const go = useCallback(
    (delta: number) => {
      setPaused(true);
      setActive((i) => (i + delta + count) % count);
    },
    [count],
  );

  /* ── swipe ──────────────────────────────────────────────────────────────
     The dots are a 6px target in the corner of a card the thumb is already
     resting on; on a phone-first page the gesture is the real control and the
     dots are the affordance that tells you it exists. `touch-action: pan-y`
     keeps vertical scrolling with the browser and claims only the horizontal
     axis. */
  const startX = useRef(0);
  const startY = useRef(0);
  const dragging = useRef(false);
  const moved = useRef(false);

  const onPointerDown = (e: React.PointerEvent) => {
    if (count <= 1) return;
    startX.current = e.clientX;
    startY.current = e.clientY;
    dragging.current = true;
    moved.current = false;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - startX.current;
    const dy = e.clientY - startY.current;
    if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) moved.current = true;
  };

  const onPointerEnd = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    const dx = e.clientX - startX.current;
    if (moved.current && Math.abs(dx) >= SWIPE_PX) go(dx < 0 ? 1 : -1);
  };

  // A swipe that ends on the band would otherwise also fire the anchor's click.
  // `moved` is cleared on the next pointerdown, not here, because click lands
  // after pointerup.
  const onClickCapture = (e: React.MouseEvent) => {
    if (!moved.current) return;
    e.preventDefault();
    e.stopPropagation();
  };

  if (count === 0) return null;
  const current = Math.min(active, count - 1);

  return (
    <div
      role="region"
      aria-label={slideTag(slides[current])}
      aria-live="polite"
      className="relative w-full"
      style={{ marginTop: 26, height: BAND_HEIGHT, touchAction: "pan-y" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={onClickCapture}
    >
      {slides.map((slide, i) =>
        slide.kind === "promo" ? (
          <PromoSlide
            key={`promo-${slide.promo.tag}-${i}`}
            promo={slide.promo}
            active={i === current}
            reduced={reduced}
          />
        ) : (
          <HiringSlide
            key="hiring"
            hiring={slide.hiring}
            active={i === current}
            reduced={reduced}
          />
        ),
      )}

      {/* Dots — siblings of the anchors (never nested inside them), pinned
          top-right opposite the eyebrow. Only present for 2+ slides. The dot
          stays 6px; the button around it is padded out to a 24px target. */}
      {count > 1 && (
        <div
          className="absolute z-10 flex items-center"
          style={{ top: 9, right: 9 }}
        >
          {slides.map((slide, i) => (
            <button
              key={`dot-${slideTag(slide)}-${i}`}
              type="button"
              aria-label={slideTag(slide)}
              aria-current={i === current}
              onClick={() => {
                setPaused(true);
                setActive(i);
              }}
              className="flex cursor-pointer items-center justify-center"
              style={{ padding: 9 }}
            >
              <span
                aria-hidden
                className="block h-[6px] w-[6px] rounded-full transition-opacity"
                style={{
                  background: "var(--color-gold-bright)",
                  opacity: i === current ? 1 : 0.4,
                }}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
