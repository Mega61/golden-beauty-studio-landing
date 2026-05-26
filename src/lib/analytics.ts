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
