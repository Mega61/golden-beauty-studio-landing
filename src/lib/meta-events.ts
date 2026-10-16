/**
 * Meta conversion events — the pure half, shared by the browser Pixel and the
 * server-side Conversions API.
 *
 * ## Why both
 *
 * The site runs Meta ads, and until now Meta never saw a booking: the campaigns
 * could only optimise for clicks. The Pixel alone loses a large share of events
 * (iOS, ad blockers, in-app browsers that close on confirm), so the booking —
 * the one event that matters — is also sent from the server, which Meta can't
 * miss. Both copies carry the **same `event_id`**, and Meta keeps one; without
 * it every booking would count twice and the campaign would learn from a lie.
 *
 * ## What leaves the site
 *
 * Only what Meta's matching needs, and the personal parts hashed (SHA-256,
 * normalised first, as Meta specifies): phone, first and last name, country.
 * Never the notes, never the plain phone.
 */

export type MetaEventName = "PageView" | "ViewContent" | "InitiateCheckout" | "Schedule" | "Contact";

/** A fresh id for one event, shared by its Pixel and server copies. */
export function newEventId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rand}`;
}

/**
 * Phone as Meta wants it before hashing: digits only, with country code.
 * A bare Colombian mobile gets 57; anything already international is kept.
 * Returns null for something that isn't a phone, so nothing junk is hashed.
 */
export function normalizePhoneForMeta(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 0) return null;
  if (!trimmed.startsWith("+") && digits.length === 10 && digits.startsWith("3")) return `57${digits}`;
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

/** Names: lowercase, trimmed, accents kept (Meta hashes UTF-8 as typed). */
export function normalizeName(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  return v === "" ? null : v;
}

/**
 * `_fbc` value. The Pixel writes the cookie itself when the visitor lands with
 * `fbclid`; when it didn't (blocked script), it's rebuilt from the click id in
 * the documented format `fb.1.<ms>.<fbclid>`.
 */
export function fbcFrom(cookie: string | null | undefined, fbclid: string | null | undefined, now = Date.now()): string | null {
  if (cookie) return cookie;
  if (fbclid) return `fb.1.${now}.${fbclid}`;
  return null;
}

export type CapiInput = {
  eventName: MetaEventName;
  eventId: string;
  eventTime: Date;
  sourceUrl: string;
  ip: string | null;
  userAgent: string | null;
  fbc: string | null;
  fbp: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  customData?: Record<string, unknown>;
};

/**
 * One Conversions API event. `hash` is injected so this stays pure and
 * testable; the server passes SHA-256 hex.
 */
export function buildCapiEvent(input: CapiInput, hash: (s: string) => string) {
  const ph = input.phone ? normalizePhoneForMeta(input.phone) : null;
  const fn = input.firstName ? normalizeName(input.firstName) : null;
  const ln = input.lastName ? normalizeName(input.lastName) : null;

  const userData: Record<string, unknown> = { country: [hash("co")] };
  if (ph) userData.ph = [hash(ph)];
  if (fn) userData.fn = [hash(fn)];
  if (ln) userData.ln = [hash(ln)];
  if (input.ip && input.ip !== "unknown") userData.client_ip_address = input.ip;
  if (input.userAgent) userData.client_user_agent = input.userAgent;
  if (input.fbc) userData.fbc = input.fbc;
  if (input.fbp) userData.fbp = input.fbp;

  return {
    event_name: input.eventName,
    event_time: Math.floor(input.eventTime.getTime() / 1000),
    event_id: input.eventId,
    action_source: "website" as const,
    event_source_url: input.sourceUrl,
    user_data: userData,
    ...(input.customData ? { custom_data: input.customData } : {}),
  };
}
