import WhatsAppIcon from "./WhatsAppIcon";
import TrackedWhatsappLink from "./TrackedWhatsappLink";
import { siteConfig } from "@/config/site";

type FloatingDict = {
  whatsapp: string;
  /** Kept for backwards-compat with the old mobile sticky Agendar bar.
   *  Not used now that the Agendar CTA lives only in the header. */
  cta: string;
};

export default function FloatingActions({ dict }: { dict: FloatingDict }) {
  const { whatsappUrl } = siteConfig;

  if (!whatsappUrl) return null;

  // The Agendar CTA lives in the sticky header (desktop nav pill + mobile
  // drawer trigger), so a duplicate mobile-bar version is redundant and was
  // colliding with this WhatsApp button. Only WhatsApp floats now.
  return (
    <TrackedWhatsappLink
      href={whatsappUrl}
      location="floating"
      aria-label={dict.whatsapp}
      className="group fixed bottom-5 right-5 z-50 flex items-center justify-center rounded-full text-white no-underline lg:bottom-7 lg:right-7 lg:justify-start lg:gap-3"
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
  );
}
