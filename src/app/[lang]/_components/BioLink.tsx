"use client";

import { useEffect } from "react";
import {
  trackBioClick,
  trackBioView,
  type BioClickKind,
} from "@/lib/analytics";

// Fires the `bio_view` event once on mount. Rendered once per bio page.
export function BioView() {
  useEffect(() => {
    trackBioView();
  }, []);
  return null;
}

// One anchor for every clickable on the bio page (CTA, rows, promo, socials).
// Every click flows through `trackBioClick`, giving uniform per-destination
// click-through metrics; external links open in a new tab with rel="noopener".
export function BioLink({
  href,
  linkKey,
  label,
  kind,
  external,
  className,
  style,
  ariaLabel,
  children,
}: {
  href: string;
  linkKey: string;
  label?: string;
  kind: BioClickKind;
  external?: boolean;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  const ext = external
    ? { target: "_blank" as const, rel: "noopener noreferrer" }
    : {};
  return (
    <a
      href={href}
      {...ext}
      aria-label={ariaLabel}
      onClick={() => trackBioClick({ key: linkKey, label, kind, href })}
      className={className}
      style={style}
    >
      {children}
    </a>
  );
}
