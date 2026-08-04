"use client";

import { useEffect, useRef, useState } from "react";
import PostulacionForm, { type TrabajaDict } from "./PostulacionForm";
import { trackApplyOpen } from "@/lib/analytics";
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
  const panelRef = useRef<HTMLDivElement>(null);

  // Bring the newly revealed form into view — on a 390 px screen the panel opens
  // mostly below the fold, and a form you have to hunt for is a form you skip.
  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => {
      panelRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 60);
    return () => window.clearTimeout(id);
  }, [open]);

  const toggle = () => {
    setOpen((prev) => {
      if (!prev) trackApplyOpen("bio");
      return !prev;
    });
  };

  return (
    <div className="w-full" style={{ marginTop: 12 }}>
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
          ref={panelRef}
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
