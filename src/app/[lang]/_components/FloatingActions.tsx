import WhatsAppIcon from "./WhatsAppIcon";
import { siteConfig } from "@/config/site";

type FloatingDict = {
  whatsapp: string;
  cta: string;
};

export default function FloatingActions({ dict }: { dict: FloatingDict }) {
  const { whatsappUrl, bookingUrl } = siteConfig;

  if (!whatsappUrl && !bookingUrl) return null;

  return (
    <>
      {/* Mobile sticky bar — Agendar pill only (WhatsApp moved to the unified
          fixed pill below). Renders nothing if no booking URL is configured. */}
      {bookingUrl && (
        <div
          className="pointer-events-none sticky bottom-4 z-40 -mt-16 mb-4 flex justify-end px-4 lg:hidden"
          aria-label="Agendar"
        >
          <a
            href={bookingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pointer-events-auto bg-gold-grad-dark px-5 py-3.5 font-sans text-[11px] font-semibold uppercase tracking-[0.24em] text-white no-underline"
            style={{ boxShadow: "0 8px 24px rgba(91,43,8,0.3)" }}
          >
            {dict.cta}
          </a>
        </div>
      )}

      {/* Unified WhatsApp button — single fixed bottom-right element across
          all breakpoints. Collapses to a 52px circle at <lg, expands to a pill
          with label at lg+. */}
      {whatsappUrl && (
        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={dict.whatsapp}
          className="group fixed bottom-5 right-5 z-50 flex items-center justify-center rounded-full text-white no-underline lg:bottom-7 lg:right-7 lg:justify-start lg:gap-3"
          style={{
            background: "var(--color-whatsapp)",
            boxShadow:
              "0 14px 40px -10px rgba(37,211,102,0.55), 0 6px 14px -6px rgba(0,0,0,0.2)",
            // Tight square padding on mobile (icon-only circle), pill padding at lg+
            padding: "13px",
          }}
        >
          <span
            aria-hidden
            className="flex items-center justify-center rounded-full lg:h-9 lg:w-9"
            style={{ background: "rgba(255,255,255,0.18)" }}
          >
            <WhatsAppIcon size={24} className="lg:hidden" />
            <WhatsAppIcon size={20} className="hidden lg:block" />
          </span>
          <span className="hidden font-sans text-[12px] font-semibold uppercase tracking-[0.22em] lg:inline lg:pr-2">
            {dict.whatsapp}
          </span>
        </a>
      )}
    </>
  );
}
