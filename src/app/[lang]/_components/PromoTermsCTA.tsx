"use client";

import { useEffect, useRef, useState } from "react";

type Dict = {
  termsEyebrow: string;
  termsClose: string;
  termsCloseAria: string;
};

type Props = {
  label: string;
  ctaText: string;       // tailwind text-* class for the CTA
  ruleColor: string;     // top border on the CTA row
  title: string;         // dialog headline (re-uses the item title)
  terms: string[];       // clauses
  dict: Dict;
};

export default function PromoTermsCTA({
  label,
  ctaText,
  ruleColor,
  title,
  terms,
  dict,
}: Props) {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Sync open state with the native <dialog>'s show/close so backdrop, focus
  // trap and ESC key are all handled by the browser.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <>
      <div className="mt-6 pt-4" style={{ borderTop: `1px solid ${ruleColor}` }}>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`inline-flex cursor-pointer items-center gap-2 bg-transparent p-0 font-sans text-[11px] font-semibold uppercase tracking-[0.28em] ${ctaText}`}
        >
          {label}
          <span className="font-display text-[15px] italic leading-none">→</span>
        </button>
      </div>

      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          // Click outside the dialog content closes it. <dialog> renders the
          // backdrop as the dialog element itself, so a target===dialog click
          // is a backdrop click.
          if (e.target === dialogRef.current) setOpen(false);
        }}
        aria-labelledby="promo-terms-title"
        className="m-auto max-w-[560px] border border-hair bg-ivory p-0 text-ink backdrop:bg-[rgba(20,16,14,0.55)] backdrop:backdrop-blur-[3px]"
        style={{ borderRadius: 0 }}
      >
        <div className="flex flex-col gap-6 px-7 py-9 md:px-10 md:py-11">
          <div className="flex items-start justify-between gap-4">
            <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold">
              {dict.termsEyebrow}
            </span>
            <button
              type="button"
              aria-label={dict.termsCloseAria}
              onClick={() => setOpen(false)}
              className="-mr-2 -mt-2 cursor-pointer bg-transparent p-2 font-sans text-xl leading-none text-ink"
            >
              ×
            </button>
          </div>

          <h3
            id="promo-terms-title"
            className="m-0 font-display font-normal italic leading-[1.05] text-[26px] md:text-[32px]"
            style={{ letterSpacing: "-0.01em" }}
          >
            {title}
          </h3>

          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {terms.map((clause, i) => (
              <li
                key={i}
                className="grid grid-cols-[28px_1fr] gap-3 font-sans text-[13px] leading-[1.6] text-ink-soft"
              >
                <span className="font-display text-[15px] italic leading-[1.4] text-gold">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span>{clause}</span>
              </li>
            ))}
          </ol>

          <div className="mt-2 flex justify-end pt-2" style={{ borderTop: "1px solid var(--hair)" }}>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="cursor-pointer bg-transparent p-0 pt-4 font-sans text-[11px] font-semibold uppercase tracking-[0.28em] text-gold"
            >
              {dict.termsClose}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
