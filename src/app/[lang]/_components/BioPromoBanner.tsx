"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { BioLink } from "./BioLink";
import type { BioPromo } from "@/data/bio.types";

// Auto-advance cadence (ms) for the bio promo carousel. Matches the landing
// strip so the brand's promo rotation feels consistent across surfaces.
const ROTATE_MS = 6000;

// Fixed band height so the absolutely-stacked slides can cross-fade without the
// layout jumping. Mirrors the single-band `minHeight` the bio used before.
const BAND_HEIGHT = 210;

// One promo slide — the exact photographic band the bio used for a single
// promo, now one cross-fading layer. The whole band is the tracked anchor.
function Slide({ promo, active }: { promo: BioPromo; active: boolean }) {
  return (
    <BioLink
      href={promo.href}
      linkKey="promo"
      label={promo.tag}
      kind="promo"
      external={/^https?:\/\//i.test(promo.href)}
      className="absolute inset-0 flex flex-col justify-between overflow-hidden no-underline transition-opacity duration-500"
      style={{
        padding: 20,
        background: "var(--color-carbon)",
        border: "1px solid rgba(231, 170, 81, 0.22)",
        opacity: active ? 1 : 0,
        pointerEvents: active ? "auto" : "none",
      }}
    >
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
          {promo.tag}
        </span>
      </span>

      {/* bottom — headline + CTA */}
      <span className="relative block">
        <span
          className="block font-display italic"
          style={{ fontSize: 23, lineHeight: 1.1, color: "var(--color-ivory)" }}
        >
          {promo.title}
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
            {promo.cta}
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
    </BioLink>
  );
}

export default function BioPromoBanner({ promos }: { promos: BioPromo[] }) {
  const [active, setActive] = useState(0);
  const count = promos.length;

  // Auto-advance; depending on `active` restarts the timer so a manual dot tap
  // also resets the countdown.
  useEffect(() => {
    if (count <= 1) return;
    const id = setInterval(() => setActive((i) => (i + 1) % count), ROTATE_MS);
    return () => clearInterval(id);
  }, [count, active]);

  if (count === 0) return null;
  const current = Math.min(active, count - 1);

  return (
    <div
      role="region"
      aria-label={promos[current].tag}
      aria-live="polite"
      className="relative w-full"
      style={{ marginTop: 26, height: BAND_HEIGHT }}
    >
      {promos.map((promo, i) => (
        <Slide key={promo.tag + i} promo={promo} active={i === current} />
      ))}

      {/* Dots — siblings of the anchors (never nested inside them), pinned
          top-right opposite the eyebrow. Only present for 2+ promos. */}
      {count > 1 && (
        <div
          className="absolute z-10 flex items-center"
          style={{ top: 18, right: 18, gap: 7 }}
        >
          {promos.map((promo, i) => (
            <button
              key={promo.tag + i}
              type="button"
              aria-label={promo.tag}
              aria-current={i === current}
              onClick={() => setActive(i)}
              className="h-[6px] w-[6px] cursor-pointer rounded-full transition-opacity"
              style={{
                background: "var(--color-gold-bright)",
                opacity: i === current ? 1 : 0.4,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
