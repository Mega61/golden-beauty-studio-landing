declare global {
  interface Window {
    gtag?: (
      command: "event",
      name: string,
      params?: Record<string, unknown>,
    ) => void;
  }
}

export function trackEvent(
  name: string,
  params?: Record<string, unknown>,
): void {
  if (typeof window === "undefined" || typeof window.gtag !== "function") {
    return;
  }
  window.gtag("event", name, params);
}

export function trackBookingClick(
  location: string,
  extra?: Record<string, unknown>,
): void {
  trackEvent("book_appointment", { location, ...extra });
}

export function trackPricingClick(location: string): void {
  trackEvent("view_pricing", { location });
}

export function trackWhatsappClick(
  location: string,
  extra?: Record<string, unknown>,
): void {
  trackEvent("contact_whatsapp", { location, ...extra });
}

/* ── Link-in-bio (the /bio Linktree replacement) ──────────────────────────── */

// Fired once when the bio page mounts — the denominator for click-through rate.
// (GA4 also auto-logs a `page_view` with page_path=/es/bio; this is a dedicated
// event so the bio funnel is trivial to isolate in reports.)
export function trackBioView(): void {
  trackEvent("bio_view");
}

export type BioClickKind = "cta" | "row" | "promo" | "social";

// Single funnel event for every clickable on the bio page, so you can compare
// click-through per destination. Booking/WhatsApp clicks ALSO fire their
// canonical conversion events, so existing GA goals still capture bio-sourced
// bookings and contacts (attributed with location "bio").
export function trackBioClick(params: {
  key: string;
  label?: string;
  kind: BioClickKind;
  href?: string;
}): void {
  const { key, label, kind, href } = params;
  trackEvent("bio_link_click", {
    link_key: key,
    link_label: label,
    link_kind: kind,
    link_url: href,
  });
  if (key === "agendar") {
    trackBookingClick("bio", { link_key: key, link_kind: kind });
  } else if (key === "whatsapp" || key === "wa") {
    trackWhatsappClick("bio", { link_key: key, link_kind: kind });
  } else if (kind === "promo") {
    // Dedicated promo event (GA4 recommended `select_promotion`), so the
    // pinned banner gets first-class metrics independent of generic link
    // clicks. `label` carries the active scenario tag (e.g. "Apertura · …").
    trackEvent("select_promotion", {
      location: "bio",
      promotion_name: label,
      link_url: href,
    });
  }
}
