"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PostulacionForm, { type TrabajaDict } from "./PostulacionForm";
import { trackApplyOpen } from "@/lib/analytics";
import {
  CAREERS_PANEL_EVENT,
  CAREERS_PANEL_ID,
} from "@/lib/careers-panel";
import type { Locale } from "../dictionaries";
import type { JobRole } from "@/data/careers.types";

/**
 * "Trabaja con nosotras" on the /bio page.
 *
 * Shaped as a disclosure row rather than a link to the careers page: traffic here
 * arrives from the Instagram bio on a phone, and every extra hop (load another
 * page, find the form) loses applicants. Collapsed, it reads as one more hairline
 * row in the link tree, so it never competes with the gold booking CTA; expanded,
 * the whole form is right there.
 *
 * The form component is shared with /trabaja-con-nosotros — same cargos, same
 * validation, same endpoint — just rendered in the light tone and single-column.
 */
export default function TrabajaBio({
  dict,
  lang,
  roles,
}: {
  dict: TrabajaDict;
  lang: Locale;
  roles: JobRole[];
}) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Mirrors `open` so the openers below can check it without being re-created
  // on every toggle, and so `apply_open` fires exactly once per expansion no
  // matter which of the three entry points did it.
  const openRef = useRef(false);

  // Bring the newly revealed form into view — on a 390 px screen the panel opens
  // mostly below the fold, and a form you have to hunt for is a form you skip.
  //
  // Anchors on the whole disclosure (`block: "start"`), not on the panel: with
  // the panel expanded the pair is taller than a phone viewport, and aligning
  // anything else drops the visitor into the middle of a form with the label
  // that explains it scrolled off the top. That matters most for the two
  // entries the banner added — a tap from the promo band and a cold load on
  // `…/bio#trabaja` — where the visitor arrives with no context at all.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      rootRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    return () => window.clearTimeout(id);
  }, [open]);

  const openPanel = useCallback(() => {
    if (openRef.current) return;
    openRef.current = true;
    setOpen(true);
    trackApplyOpen("bio");
  }, []);

  // Opened from elsewhere on the page: the hiring slide in the promo banner, or
  // a visitor landing directly on `…/bio#trabaja` (the link that gets shared in
  // a story). See `lib/careers-panel.ts` for why it takes both a hash and an
  // event.
  useEffect(() => {
    const openFromHash = () => {
      if (window.location.hash === `#${CAREERS_PANEL_ID}`) openPanel();
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    window.addEventListener(CAREERS_PANEL_EVENT, openPanel);
    return () => {
      window.removeEventListener("hashchange", openFromHash);
      window.removeEventListener(CAREERS_PANEL_EVENT, openPanel);
    };
  }, [openPanel]);

  const toggle = () => {
    if (openRef.current) {
      openRef.current = false;
      setOpen(false);
      return;
    }
    openPanel();
  };

  return (
    <div
      id={CAREERS_PANEL_ID}
      ref={rootRef}
      className="w-full"
      style={{ marginTop: 12 }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls="bio-trabaja-panel"
        className="relative flex w-full cursor-pointer items-stretch overflow-hidden text-left"
        style={{
          minHeight: 68,
          background: "var(--color-paper)",
          border: `1px solid ${open ? "var(--color-gold)" : "var(--hair)"}`,
          padding: 0,
        }}
      >
        <span
          className="flex min-w-0 flex-1 flex-col justify-center"
          style={{ padding: "12px 16px" }}
        >
          <span
            className="block font-display"
            style={{ fontSize: 19, lineHeight: 1.12, color: "var(--color-ink)" }}
          >
            {dict.bio.rowLabel}
          </span>
          <span
            className="block font-sans uppercase"
            style={{
              marginTop: 6,
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: "0.18em",
              color: sent ? "var(--color-gold)" : "var(--color-ink-mute)",
            }}
          >
            {sent ? dict.bio.successShort : dict.bio.rowSub}
          </span>
        </span>
        <span
          aria-hidden
          className="flex shrink-0 items-center font-display leading-none"
          style={{
            paddingRight: 18,
            fontSize: 22,
            color: "var(--color-gold)",
          }}
        >
          {open ? "−" : "+"}
        </span>
      </button>

      {open && (
        <div
          id="bio-trabaja-panel"
          style={{
            background: "var(--color-paper)",
            borderLeft: "1px solid var(--hair)",
            borderRight: "1px solid var(--hair)",
            borderBottom: "1px solid var(--hair)",
            padding: "18px 16px 20px",
          }}
        >
          <p
            className="m-0 mb-4 font-sans"
            style={{
              fontSize: 12,
              lineHeight: 1.6,
              color: "var(--color-ink-mute)",
            }}
          >
            {dict.body}
          </p>
          <PostulacionForm
            dict={dict}
            lang={lang}
            roles={roles}
            surface="bio"
            tone="light"
            compact
            onSent={() => setSent(true)}
          />
        </div>
      )}
    </div>
  );
}
