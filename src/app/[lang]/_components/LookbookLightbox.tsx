"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Locale } from "../dictionaries";
import type { LookbookItem } from "@/data/lookbook-manifest";
import { CATEGORY_LABELS, lookbookAlt } from "@/data/lookbook-categories";

export type LookbookLightboxDict = {
  close: string;
  next: string;
  previous: string;
  counter: string;
};

export type LookbookLightboxProps = {
  lang: Locale;
  items: readonly LookbookItem[];
  startIndex: number;
  dict: LookbookLightboxDict;
  onClose: () => void;
};

const SWIPE_THRESHOLD_PX = 60;
const SWIPE_VELOCITY = 0.4; // px / ms
const SWIPE_AXIS_BIAS = 1.2;
const AXIS_LOCK_PX = 8;
const SNAP_MS = 220;
const EDGE_RESISTANCE = 0.3;

type SwipeAxis = "none" | "horizontal" | "vertical";

const SIZES_HINT = "(min-width: 1200px) 1100px, 92vw";

export default function LookbookLightbox({
  lang,
  items,
  startIndex,
  dict,
  onClose,
}: LookbookLightboxProps) {
  const [index, setIndex] = useState(() =>
    Math.min(Math.max(0, startIndex), Math.max(0, items.length - 1)),
  );
  const [dragX, setDragX] = useState(0);
  const [animating, setAnimating] = useState(false);

  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(
    null,
  );
  const axisRef = useRef<SwipeAxis>("none");
  const slidingRef = useRef(false);
  const snapTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = prev;
      if (snapTimeoutRef.current !== null) {
        window.clearTimeout(snapTimeoutRef.current);
      }
    };
  }, []);

  const canPrev = index > 0;
  const canNext = index < items.length - 1;

  // Animated slide — used only when a real swipe gesture commits.
  function commitSlide(direction: 1 | -1) {
    if (slidingRef.current) return;
    if (direction === 1 && !canNext) return;
    if (direction === -1 && !canPrev) return;
    const stage = stageRef.current;
    if (!stage) return;
    const sw = stage.clientWidth;
    slidingRef.current = true;
    setAnimating(true);
    setDragX(direction === 1 ? -sw : sw);
    if (snapTimeoutRef.current !== null) {
      window.clearTimeout(snapTimeoutRef.current);
    }
    snapTimeoutRef.current = window.setTimeout(() => {
      setIndex((i) =>
        Math.max(0, Math.min(items.length - 1, i + direction)),
      );
      setAnimating(false);
      setDragX(0);
      slidingRef.current = false;
    }, SNAP_MS);
  }

  // Instant commit — used by buttons and keyboard so desktop nav doesn't
  // run the swipe slide. The neighbor image is already in the DOM so it
  // appears immediately when the slot shifts.
  function commitInstant(direction: 1 | -1) {
    if (slidingRef.current) return;
    if (direction === 1 && !canNext) return;
    if (direction === -1 && !canPrev) return;
    if (snapTimeoutRef.current !== null) {
      window.clearTimeout(snapTimeoutRef.current);
      snapTimeoutRef.current = null;
    }
    setAnimating(false);
    setDragX(0);
    setIndex((i) =>
      Math.max(0, Math.min(items.length - 1, i + direction)),
    );
  }

  function springBack() {
    setAnimating(true);
    setDragX(0);
    if (snapTimeoutRef.current !== null) {
      window.clearTimeout(snapTimeoutRef.current);
    }
    snapTimeoutRef.current = window.setTimeout(() => {
      setAnimating(false);
    }, SNAP_MS);
  }

  function goPrev() {
    commitInstant(-1);
  }
  function goNext() {
    commitInstant(1);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        commitInstant(-1);
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        commitInstant(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, onClose, canPrev, canNext]);

  if (items.length === 0) return null;

  const current = items[index];
  const prevItem = canPrev ? items[index - 1] : null;
  const nextItem = canNext ? items[index + 1] : null;
  const categoryLabel =
    CATEGORY_LABELS[current.category]?.[lang] ?? current.category;
  const counterText = dict.counter
    .replace("{current}", String(index + 1))
    .replace("{total}", String(items.length));

  function onBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  function onTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    if (slidingRef.current) return;
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
    axisRef.current = "none";
    setAnimating(false);
  }

  function onTouchMove(e: React.TouchEvent<HTMLDivElement>) {
    const start = touchStartRef.current;
    if (!start) return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;

    if (axisRef.current === "none") {
      if (Math.abs(dx) > AXIS_LOCK_PX || Math.abs(dy) > AXIS_LOCK_PX) {
        axisRef.current =
          Math.abs(dx) > Math.abs(dy) ? "horizontal" : "vertical";
      } else {
        return;
      }
    }
    if (axisRef.current !== "horizontal") return;

    let effDx = dx;
    if ((dx > 0 && !canPrev) || (dx < 0 && !canNext)) {
      effDx = dx * EDGE_RESISTANCE;
    }
    setDragX(effDx);
  }

  function onTouchEnd(e: React.TouchEvent<HTMLDivElement>) {
    const start = touchStartRef.current;
    const wasHorizontal = axisRef.current === "horizontal";
    touchStartRef.current = null;
    axisRef.current = "none";
    if (!start || !wasHorizontal) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const dt = Math.max(1, Date.now() - start.t);
    const vx = Math.abs(dx) / dt;

    const horizontalIntent = Math.abs(dx) > Math.abs(dy) * SWIPE_AXIS_BIAS;
    const passed =
      horizontalIntent &&
      (Math.abs(dx) > SWIPE_THRESHOLD_PX || vx > SWIPE_VELOCITY);

    if (passed && dx < 0 && canNext) {
      commitSlide(1);
    } else if (passed && dx > 0 && canPrev) {
      commitSlide(-1);
    } else {
      springBack();
    }
  }

  const overlay = (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lookbook-lightbox-caption"
      className="lookbook-lightbox fixed inset-0 z-[100] flex flex-col bg-ink/95 backdrop-blur-md"
      style={{ height: "100dvh", touchAction: "pan-y" }}
      onClick={onBackdropClick}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      {/* Top chrome: counter + close */}
      <div
        className="flex items-center justify-between px-4 md:px-6"
        style={{
          paddingTop: "max(0.75rem, env(safe-area-inset-top))",
          paddingBottom: "0.5rem",
        }}
      >
        <span
          className="font-sans text-[11px] uppercase tracking-[0.22em] text-gold-soft md:text-[12px]"
          aria-live="polite"
        >
          {counterText}
        </span>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label={dict.close}
          className="flex h-11 w-11 cursor-pointer items-center justify-center text-gold-soft transition-colors hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M4 4l12 12M16 4L4 16"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Stage: holds the 3-slide carousel; clipped by overflow-hidden */}
      <div
        ref={stageRef}
        className="relative flex flex-1 items-center justify-center overflow-hidden"
      >
        {/* Desktop prev arrow (md+) */}
        <button
          type="button"
          onClick={goPrev}
          disabled={!canPrev}
          aria-label={dict.previous}
          className="absolute left-2 top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center text-gold-soft transition-colors hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:opacity-30 md:flex"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 22 22"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M14 4L7 11l7 7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        {/* Carousel track — flex row of three slots; slot 1 is the current
            image, slots 0/2 hold prev/next so they're always painted and
            cached. The transform anchors slot 1 at center; swipe drag
            offsets it, then commitSlide snaps to ±slotWidth before
            committing the index (and reseating the slot contents). */}
        <div
          className="lookbook-lightbox-track flex h-full w-full"
          data-animating={animating ? "true" : "false"}
          style={{
            transform: `translate3d(calc(-100% + ${dragX}px), 0, 0)`,
            transition: animating
              ? `transform ${SNAP_MS}ms cubic-bezier(0.22, 0.61, 0.36, 1)`
              : "none",
            willChange: "transform",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <CarouselSlot item={prevItem} lang={lang} />
          <CarouselSlot item={current} lang={lang} priority />
          <CarouselSlot item={nextItem} lang={lang} />
        </div>

        {/* Desktop next arrow (md+) */}
        <button
          type="button"
          onClick={goNext}
          disabled={!canNext}
          aria-label={dict.next}
          className="absolute right-2 top-1/2 z-10 hidden h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center text-gold-soft transition-colors hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:opacity-30 md:flex"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 22 22"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M8 4l7 7-7 7"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {/* Bottom chrome: caption + mobile toolbar */}
      <div
        className="flex flex-col gap-2 px-4 md:gap-3 md:px-6"
        style={{
          paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
          paddingTop: "0.5rem",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <figcaption
          id="lookbook-lightbox-caption"
          className="flex flex-col items-center gap-0.5 text-center sm:flex-row sm:justify-center sm:gap-3"
          style={{ maxWidth: "min(92vw, 720px)", margin: "0 auto" }}
        >
          <span className="font-display text-[16px] italic text-ivory md:text-[20px]">
            {current.caption}
          </span>
          <span className="font-sans text-[10px] uppercase tracking-[0.22em] text-gold-soft opacity-80 md:text-[11px]">
            {categoryLabel}
          </span>
        </figcaption>

        {/* Mobile toolbar: prev / spacer / next */}
        <div className="flex items-center justify-between md:hidden">
          <button
            type="button"
            onClick={goPrev}
            disabled={!canPrev}
            aria-label={dict.previous}
            className="flex h-11 w-11 cursor-pointer items-center justify-center text-gold-soft transition-colors hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M14 4L7 11l7 7"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={goNext}
            disabled={!canNext}
            aria-label={dict.next}
            className="flex h-11 w-11 cursor-pointer items-center justify-center text-gold-soft transition-colors hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:opacity-30"
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M8 4l7 7-7 7"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <style>{`
        @media (prefers-reduced-motion: no-preference) {
          .lookbook-lightbox {
            animation: lb-lightbox-in 200ms ease-out;
          }
        }
        @keyframes lb-lightbox-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .lookbook-lightbox-track[data-animating="true"] {
            transition: none !important;
          }
        }
      `}</style>
    </div>
  );

  return createPortal(overlay, document.body);
}

function CarouselSlot({
  item,
  lang,
  priority = false,
}: {
  item: LookbookItem | null;
  lang: Locale;
  priority?: boolean;
}) {
  return (
    <div
      className="flex h-full items-center justify-center"
      style={{ flex: "0 0 100%" }}
    >
      {item ? (
        <div
          className="relative"
          style={{
            width: "min(92vw, 1100px)",
            height: "min(78dvh, 100%)",
          }}
        >
          <Image
            src={item.src}
            alt={lookbookAlt(item, lang)}
            fill
            sizes={SIZES_HINT}
            priority={priority}
            loading={priority ? undefined : "eager"}
            className="select-none pointer-events-none"
            draggable={false}
            style={{ objectFit: "contain" }}
          />
        </div>
      ) : null}
    </div>
  );
}
