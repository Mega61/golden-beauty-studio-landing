"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Logo from "./Logo";
import type { Locale } from "../dictionaries";

const noopSubscribe = () => () => {};
const useIsClient = () =>
  useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

type Item = { key: string; href: string; label: string };

type Props = {
  lang: Locale;
  otherLang: Locale;
  items: Item[];
  cta: string;
  ctaShort: string;
  bookingUrl: string | null;
};

export default function MobileMenu({
  lang,
  otherLang,
  items,
  cta,
  ctaShort,
  bookingUrl,
}: Props) {
  const [open, setOpen] = useState(false);
  const mounted = useIsClient();

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const close = () => setOpen(false);

  const drawer = (
      <div
        id="gbs-mobile-drawer"
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        className={`fixed inset-0 z-[60] lg:hidden ${
          open ? "pointer-events-auto" : "pointer-events-none"
        }`}
      >
        <button
          type="button"
          tabIndex={open ? 0 : -1}
          aria-label="Close menu"
          onClick={close}
          className={`absolute inset-0 transition-opacity duration-300 ${
            open ? "opacity-100" : "opacity-0"
          }`}
          style={{ background: "rgba(20, 15, 12, 0.55)" }}
        />

        <aside
          className={`absolute inset-y-0 right-0 flex w-[min(86vw,360px)] flex-col transition-transform duration-300 ease-out ${
            open ? "translate-x-0" : "translate-x-full"
          }`}
          style={{
            backgroundColor: "#f8f4ee",
            boxShadow: "-20px 0 60px -20px rgba(20, 15, 12, 0.35)",
          }}
        >
          <div
            className="flex items-center justify-between px-6 pb-4 pt-12"
            style={{ borderBottom: "1px solid var(--hair)" }}
          >
            <Logo variant="text" size={11} />
            <button
              type="button"
              onClick={close}
              aria-label="Close menu"
              className="-mr-1 flex h-9 w-9 items-center justify-center text-ink"
            >
              <span className="font-display text-[26px] leading-none">×</span>
            </button>
          </div>

          <nav className="flex flex-col px-6 py-4">
            {/* Plain <a> for hash anchors — next/link short-circuits repeat
                clicks when the URL is already at the same pathname+hash. */}
            {items.map((i) => (
              <a
                key={i.key}
                href={i.href}
                onClick={close}
                className="py-3 font-display text-[26px] italic text-ink no-underline"
                style={{ borderBottom: "1px solid var(--hair)" }}
              >
                {i.label}
              </a>
            ))}
          </nav>

          <div className="mt-auto flex flex-col gap-3 px-6 pb-10">
            <Link
              href={`/${otherLang}`}
              onClick={close}
              className="font-sans text-[11px] font-semibold uppercase tracking-[0.28em] text-ink-mute no-underline"
            >
              <span className="text-ink">{lang.toUpperCase()}</span>
              <span className="mx-1.5 text-ink-mute/60">/</span>
              <span>{otherLang.toUpperCase()}</span>
            </Link>
            {bookingUrl && (
              <Link
                href={bookingUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={close}
                className="bg-gold-grad inline-flex items-center justify-between gap-3 px-5 py-4 font-sans text-[12px] font-semibold uppercase tracking-[0.24em] text-white no-underline"
              >
                <span>{cta}</span>
                <span className="font-serif">→</span>
              </Link>
            )}
          </div>
        </aside>
      </div>
  );

  return (
    <>
      <div className="flex items-center gap-3 lg:hidden">
        {bookingUrl && (
          <Link
            href={bookingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-gold-grad-dark px-3.5 py-2 font-sans text-[10px] font-semibold uppercase tracking-[0.22em] text-white no-underline"
          >
            {ctaShort}
          </Link>
        )}
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          aria-expanded={open}
          aria-controls="gbs-mobile-drawer"
          className="-mr-1 flex h-8 w-8 flex-col items-center justify-center gap-[5px]"
        >
          <span className="block h-px w-5 bg-ink" />
          <span className="block h-px w-5 bg-ink" />
          <span className="block h-px w-5 bg-ink" />
        </button>
      </div>
      {mounted && createPortal(drawer, document.body)}
    </>
  );
}
