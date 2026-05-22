"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import Placeholder from "./Placeholder";
import LookbookLightbox, {
  type LookbookLightboxDict,
} from "./LookbookLightbox";
import type { Locale } from "../dictionaries";
import type {
  LookbookCategory,
  LookbookItem,
} from "@/data/lookbook-manifest";
import { CATEGORY_LABELS } from "@/data/lookbook-categories";

type FilterValue = "all" | LookbookCategory;

// Asymmetric 12-slot mosaic specs (preserved from the v1 design).
const desktopSpec = [
  { c: 2, r: 5 },
  { c: 1, r: 3 },
  { c: 1, r: 3 },
  { c: 2, r: 4 },
  { c: 1, r: 4 },
  { c: 1, r: 3 },
  { c: 2, r: 3 },
  { c: 1, r: 4 },
  { c: 1, r: 4 },
  { c: 1, r: 3 },
  { c: 1, r: 3 },
  { c: 2, r: 4 },
];

const mobileSpec = [
  { c: 2, r: 4 },
  { c: 1, r: 3 },
  { c: 1, r: 3 },
  { c: 1, r: 4 },
  { c: 1, r: 4 },
  { c: 2, r: 3 },
  { c: 1, r: 3 },
  { c: 1, r: 3 },
  { c: 2, r: 4 },
  { c: 1, r: 3 },
  { c: 1, r: 3 },
  { c: 2, r: 3 },
];

// Brand-seal placeholder tones used to dress empty slots in the "all" mosaic
// when the manifest has fewer than 12 photos. Cycles through tones for variety.
const PLACEHOLDER_TONES = ["gold", "cream", "ink"] as const;
type PlaceholderTone = (typeof PLACEHOLDER_TONES)[number];

export type LookbookGridProps = {
  lang: Locale;
  items: readonly LookbookItem[];
  categories: readonly LookbookCategory[];
  allLabel: string;
  lightboxDict: LookbookLightboxDict;
};

export default function LookbookGrid({
  lang,
  items,
  categories,
  allLabel,
  lightboxDict,
}: LookbookGridProps) {
  const [filter, setFilter] = useState<FilterValue>("all");
  // Carries the filter snapshot so re-filtering implicitly closes the lightbox
  // without needing an effect.
  const [openState, setOpenState] = useState<{
    filter: FilterValue;
    index: number;
  } | null>(null);

  // Count items per category to drive the disabled state on filter buttons.
  const countsByCategory = useMemo(() => {
    const counts = new Map<LookbookCategory, number>();
    for (const it of items) {
      counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const filteredItems = useMemo(() => {
    if (filter === "all") return items;
    return items.filter((it) => it.category === filter);
  }, [filter, items]);

  const openIndex =
    openState && openState.filter === filter ? openState.index : null;

  const openAt = (item: LookbookItem) => {
    const idx = filteredItems.findIndex((it) => it.src === item.src);
    if (idx >= 0) setOpenState({ filter, index: idx });
  };
  const closeLightbox = () => setOpenState(null);

  return (
    <>
      {/* Filter buttons */}
      <div className="mt-6 flex flex-wrap gap-4 md:mt-8">
        <FilterButton
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label={allLabel}
        />
        {categories.map((cat) => {
          const hasItems = (countsByCategory.get(cat) ?? 0) > 0;
          return (
            <FilterButton
              key={cat}
              active={filter === cat}
              onClick={() => setFilter(cat)}
              label={CATEGORY_LABELS[cat][lang]}
              disabled={!hasItems}
            />
          );
        })}
      </div>

      {/* Grid — asymmetric mosaic for "all", uniform for filtered */}
      <div
        key={filter}
        className="lookbook-grid-fade mt-9 md:mt-18"
        style={{ animation: "lb-fade-in 220ms ease-out" }}
      >
        {filter === "all" ? (
          <MosaicGrid items={filteredItems} onOpen={openAt} />
        ) : (
          <UniformGrid items={filteredItems} onOpen={openAt} />
        )}
      </div>

      {openIndex !== null && (
        <LookbookLightbox
          lang={lang}
          items={filteredItems}
          startIndex={openIndex}
          dict={lightboxDict}
          onClose={closeLightbox}
        />
      )}

      <style>{`
        @keyframes lb-fade-in {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @media (min-width: 768px) {
          .lookbook-tile-asym {
            grid-column: span var(--c-desktop) !important;
            grid-row: span var(--r-desktop) !important;
          }
          .lookbook-mosaic-grid {
            --row: 64px;
            --gap: 14px;
          }
        }
      `}</style>
    </>
  );
}

function FilterButton({
  active,
  onClick,
  label,
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-disabled={disabled || undefined}
      className={`px-4 py-2 font-sans text-[11px] font-medium uppercase tracking-[0.22em] transition-colors ${
        active
          ? "cursor-pointer bg-ink text-gold-soft"
          : disabled
            ? "cursor-not-allowed border border-hair bg-transparent text-ink opacity-40"
            : "cursor-pointer border border-hair bg-transparent text-ink hover:border-gold hover:text-gold"
      }`}
    >
      {label}
    </button>
  );
}

function MosaicGrid({
  items,
  onOpen,
}: {
  items: readonly LookbookItem[];
  onOpen: (item: LookbookItem) => void;
}) {
  // Fill 12 slots; empty slots get a placeholder seal.
  const slots = Array.from({ length: 12 }, (_, i) => items[i] ?? null);

  return (
    <div
      className="lookbook-mosaic-grid grid grid-cols-2 md:grid-cols-4"
      style={
        {
          gridAutoRows: "var(--row, 56px)",
          gap: "var(--gap, 8px)",
        } as React.CSSProperties
      }
    >
      {slots.map((item, idx) => {
        const sM = mobileSpec[idx];
        const sD = desktopSpec[idx];
        const tileStyle = {
          "--c-mobile": sM.c,
          "--r-mobile": sM.r,
          "--c-desktop": sD.c,
          "--r-desktop": sD.r,
          gridColumn: `span ${sM.c}`,
          gridRow: `span ${sM.r}`,
        } as React.CSSProperties;
        if (!item) {
          return (
            <figure
              key={idx}
              className="lookbook-tile-asym relative m-0 overflow-hidden bg-cream"
              style={tileStyle}
            >
              <Placeholder
                label="Próximamente"
                tone={
                  PLACEHOLDER_TONES[
                    idx % PLACEHOLDER_TONES.length
                  ] as PlaceholderTone
                }
              />
            </figure>
          );
        }
        return (
          <LookbookTileButton
            key={idx}
            item={item}
            sizes="(min-width: 768px) 25vw, 50vw"
            className="lookbook-tile-asym"
            style={tileStyle}
            onOpen={onOpen}
          />
        );
      })}
    </div>
  );
}

function UniformGrid({
  items,
  onOpen,
}: {
  items: readonly LookbookItem[];
  onOpen: (item: LookbookItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center font-display text-[18px] italic text-ink-mute">
        Próximamente
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4 md:gap-3.5">
      {items.map((item) => (
        <LookbookTileButton
          key={item.src}
          item={item}
          sizes="(min-width: 768px) 25vw, 50vw"
          style={{ aspectRatio: "4 / 5" }}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function LookbookTileButton({
  item,
  sizes,
  className,
  style,
  onOpen,
}: {
  item: LookbookItem;
  sizes: string;
  className?: string;
  style?: React.CSSProperties;
  onOpen: (item: LookbookItem) => void;
}) {
  const categoryLabel = CATEGORY_LABELS[item.category]?.es ?? item.category;
  const base =
    "lookbook-tile group relative m-0 cursor-zoom-in overflow-hidden border-0 bg-cream p-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-ivory";
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={className ? `${base} ${className}` : base}
      style={style}
      aria-label={`${item.caption} — ${categoryLabel}`}
    >
      <Image
        src={item.src}
        alt={item.caption}
        fill
        sizes={sizes}
        className="object-cover transition-[filter,transform] duration-300 group-hover:scale-[1.02]"
        style={{ filter: "saturate(0.92) contrast(1.02)" }}
      />
      <TileCaption item={item} />
    </button>
  );
}

function TileCaption({ item }: { item: LookbookItem }) {
  const categoryLabel = CATEGORY_LABELS[item.category]?.es ?? item.category;
  return (
    <figcaption
      className="absolute inset-x-0 bottom-0 flex items-baseline justify-between gap-2 px-3 py-2.5 text-gold-soft md:px-4 md:py-3.5"
      style={{
        background:
          "linear-gradient(0deg, rgba(20,15,12,0.78), rgba(20,15,12,0))",
      }}
    >
      <span className="font-display text-[13px] italic text-ivory md:text-[15px]">
        {item.caption}
      </span>
      <span className="text-right font-sans text-[9px] uppercase tracking-[0.18em] opacity-80">
        {categoryLabel}
      </span>
    </figcaption>
  );
}
