"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import WhatsAppIcon from "./WhatsAppIcon";
import TrackedWhatsappLink from "./TrackedWhatsappLink";
import { siteConfig } from "@/config/site";
import { trackBookingClick } from "@/lib/analytics";

type FloatingDict = {
  whatsapp: string;
  /** The floating booking pill. */
  cta: string;
};

/**
 * The two ways to book, always under the thumb: a gold "Agendar" pill and the
 * WhatsApp circle, as **one** cluster in the bottom-right corner.
 *
 * The booking pill used to be a separate mobile bar, and it was removed because
 * it collided with the WhatsApp button. Laid out side by side in one flex row
 * they can't collide: the row owns the spacing.
 *
 * The pill appears once the hero is behind the visitor. Over the hero it would
 * sit next to the hero's own big CTA saying the same thing; after it, it's the
 * only booking button on screen while she reads prices, reviews and photos —
 * which is exactly where the decision happens.
 */
export default function FloatingActions({
  dict,
  bookingHref,
}: {
  dict: FloatingDict;
  bookingHref: string | null;
}) {
  const { whatsappUrl } = siteConfig;
  const [pastHero, setPastHero] = useState(false);

  useEffect(() => {
    const onScroll = () => setPastHero(window.scrollY > window.innerHeight * 0.7);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  if (!whatsappUrl && !bookingHref) return null;

  const external = bookingHref ? /^https?:\/\//i.test(bookingHref) : false;

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex items-center gap-3 lg:bottom-7 lg:right-7">
      {bookingHref && (
        <Link
          href={bookingHref}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          onClick={() => trackBookingClick("floating")}
          aria-hidden={!pastHero}
          tabIndex={pastHero ? 0 : -1}
          className={`flex h-[50px] items-center gap-2.5 whitespace-nowrap rounded-full bg-gold-grad pl-5 pr-6 font-sans text-[12px] font-semibold uppercase tracking-[0.2em] text-white no-underline transition-all duration-300 ease-out motion-reduce:transition-none ${
            pastHero ? "pointer-events-auto translate-y-0 opacity-100" : "translate-y-3 opacity-0"
          }`}
          style={{
            boxShadow:
              "0 14px 40px -10px rgba(172,130,49,0.6), 0 6px 14px -6px rgba(0,0,0,0.2)",
          }}
        >
          <svg
            aria-hidden
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3.5" y="5" width="17" height="15" rx="2" />
            <path d="M3.5 10h17M8 3v4M16 3v4" />
          </svg>
          {dict.cta}
        </Link>
      )}

      {whatsappUrl && (
        <TrackedWhatsappLink
          href={whatsappUrl}
          location="floating"
          aria-label={dict.whatsapp}
          className="group pointer-events-auto flex items-center justify-center rounded-full text-white no-underline lg:justify-start lg:gap-3"
          style={{
            background: "var(--color-whatsapp)",
            boxShadow:
              "0 14px 40px -10px rgba(37,211,102,0.55), 0 6px 14px -6px rgba(0,0,0,0.2)",
            padding: "13px",
          }}
        >
          <span
            aria-hidden
            className="flex items-center justify-center rounded-full lg:h-5 lg:w-7"
            style={{ background: "rgba(255,255,255,0.18)" }}
          >
            <WhatsAppIcon size={24} className="lg:hidden" />
            <WhatsAppIcon size={20} className="hidden lg:block" />
          </span>
          <span className="hidden font-sans text-[12px] font-semibold uppercase tracking-[0.22em] lg:inline lg:pr-2">
            {dict.whatsapp}
          </span>
        </TrackedWhatsappLink>
      )}
    </div>
  );
}
