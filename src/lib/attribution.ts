/**
 * Where a visitor came from, kept until they book.
 *
 * GA4 already reads `utm_*` on the landing hit, but GA only sees clicks. The
 * panel sees bookings, attendance and money, and EA has no column for "where
 * did this booking come from". So the landing remembers the origin and sends it
 * with the booking; the panel stores it (`booking_attribution`) and decides the
 * channel (`admin/src/lib/booking-attribution.ts`).
 *
 * ## Last non-direct touch, for 30 days
 *
 * A visit with UTMs, a click id or an external referrer **replaces** what was
 * stored. A visit with none of those (typed URL, bookmark, a WhatsApp link
 * that sends no referrer, or our own pages) **keeps** it. That is GA's own
 * default, and it's the one that makes "came from the Instagram bio, came back
 * two days later by typing the address, booked" count for the bio.
 *
 * Lives in `localStorage`, not a cookie: nothing on the server needs it until
 * the booking, and then it travels in the request body. If storage is blocked
 * (private mode, in-app browsers), the booking still goes through without it.
 */

export type Attribution = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  referrerHost: string | null;
  landingPath: string | null;
  /** Which click id the URL carried. Never the value. */
  clickId: string | null;
  /** ms since epoch. */
  at: number;
};

export const ATTRIBUTION_KEY = "gbs-origen";
export const ATTRIBUTION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const CLICK_IDS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid"] as const;

function param(url: URL, name: string): string | null {
  const value = url.searchParams.get(name)?.trim();
  return value ? value.slice(0, 100) : null;
}

/** The registrable-ish part, so `www.` and the bare domain count as ours. */
function stripWww(host: string): string {
  return host.replace(/^www\./, "");
}

/**
 * What this page load says about the origin, or `null` when it says nothing
 * (direct, or a navigation inside the site) and the stored one should stay.
 */
export function attributionFromVisit(
  href: string,
  referrer: string,
  now: number,
): Attribution | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  let referrerHost: string | null = null;
  if (referrer) {
    try {
      const host = new URL(referrer).hostname.toLowerCase();
      if (stripWww(host) !== stripWww(url.hostname.toLowerCase())) referrerHost = host;
    } catch {
      // A malformed referrer is no referrer.
    }
  }

  const clickId = CLICK_IDS.find((name) => url.searchParams.has(name)) ?? null;
  const source = param(url, "utm_source");

  if (source === null && clickId === null && referrerHost === null) return null;

  return {
    source,
    medium: param(url, "utm_medium"),
    campaign: param(url, "utm_campaign"),
    content: param(url, "utm_content"),
    referrerHost,
    landingPath: url.pathname.slice(0, 255),
    clickId,
    at: now,
  };
}

/** Parses what was stored, dropping it if it's malformed or expired. */
export function readStoredAttribution(raw: string | null, now: number): Attribution | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Attribution>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.at !== "number" || now - parsed.at > ATTRIBUTION_TTL_MS) return null;
    return parsed as Attribution;
  } catch {
    return null;
  }
}

/** Browser only. Call once per full page load. */
export function captureAttribution(): void {
  try {
    const fresh = attributionFromVisit(window.location.href, document.referrer, Date.now());
    if (fresh) window.localStorage.setItem(ATTRIBUTION_KEY, JSON.stringify(fresh));
  } catch {
    // Storage blocked: the booking just goes without an origin.
  }
}

/** Browser only. What to send with a booking, or `null`. */
export function currentAttribution(): Omit<Attribution, "at"> | null {
  try {
    const stored = readStoredAttribution(window.localStorage.getItem(ATTRIBUTION_KEY), Date.now());
    if (!stored) return null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { at, ...rest } = stored;
    return rest;
  } catch {
    return null;
  }
}
