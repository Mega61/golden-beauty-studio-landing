"use client";

import { useEffect, useState } from "react";

/**
 * Fixed-position "back to top" button. Stacks above the WhatsApp pill on the
 * right edge. Fades in once the user has scrolled past ~80% of one viewport,
 * fades out near the top.
 *
 * Inherits the page's `scroll-behavior: smooth` via `window.scrollTo({
 * behavior: 'smooth' })`, so the `prefers-reduced-motion` override in
 * globals.css also disables this button's animation for sensitive users.
 */
export default function BackToTop({ label }: { label: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setVisible(window.scrollY > window.innerHeight * 0.8);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <button
      type="button"
      aria-label={label}
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      className={`group fixed right-5 z-50 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border bg-ivory text-ink transition-all duration-300 lg:right-7 ${
        visible
          ? "pointer-events-auto translate-y-0 opacity-100"
          : "pointer-events-none translate-y-2 opacity-0"
      }`}
      style={{
        bottom: "calc(env(safe-area-inset-bottom, 0px) + 80px)",
        borderColor: "var(--hair)",
        boxShadow:
          "0 8px 22px -10px rgba(40,30,20,0.32), 0 2px 6px -2px rgba(40,30,20,0.12)",
      }}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M7 11 V3" />
        <path d="M3 7 L7 3 L11 7" />
      </svg>
    </button>
  );
}
