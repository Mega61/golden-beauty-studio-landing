/**
 * The pure half of `/regalar` (tarjetas regalo): parsing what the panel sends,
 * checking what the buyer typed, and the WhatsApp link to pay. Kept out of the
 * components so it can be tested, same as `lib/booking.ts`.
 *
 * Two rules from the contract live here and nowhere else:
 *
 * - **The amount comes from the tier, never from the browser.** The order only
 *   carries a `tierId`; the panel (and Stampee behind it) look the amount up.
 * - **A WhatsApp text never carries a price.** The pay message names the code
 *   and nothing else.
 */

export type GiftTier = {
  id: string;
  name: string;
  amountCop: number;
  description: string;
  validityDays: number;
};

export type GiftOrderResult = {
  code: string;
  amountCop: number;
  tierName: string;
  publicUrl: string;
};

/** Buyer's message on the card. Same cap as the contract. */
export const GIFT_MESSAGE_MAX = 140;
/** Recipient name, as Stampee accepts it on the public card (2–40). */
export const GIFT_RECIPIENT_MAX = 40;
export const GIFT_NAME_MAX = 80;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Unwrap whatever shape the panel answered with: a bare list, `{ tiers }`, or
 * Stampee's `{ ok, data }` envelope passed through. Anything that isn't a
 * usable tier (no id, no positive amount) is dropped rather than rendered as
 * a "$0" card.
 */
export function parseTiers(body: unknown): GiftTier[] {
  let list: unknown = body;
  if (list && typeof list === "object" && !Array.isArray(list)) {
    const o = list as Record<string, unknown>;
    list = o.tiers ?? o.data ?? null;
    if (list && typeof list === "object" && !Array.isArray(list)) {
      list = (list as Record<string, unknown>).tiers ?? null;
    }
  }
  if (!Array.isArray(list)) return [];
  const out: GiftTier[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    const id = str(t.id);
    const name = str(t.name);
    const amountCop = Number(t.amountCop);
    if (!id || !name || !Number.isInteger(amountCop) || amountCop <= 0) continue;
    const validityDays = Number(t.validityDays);
    out.push({
      id,
      name,
      amountCop,
      description: str(t.description),
      validityDays: Number.isInteger(validityDays) && validityDays > 0 ? validityDays : 365,
    });
  }
  return out;
}

/** The order the panel created. Null when a required field is missing. */
export function parseOrderResult(body: unknown): GiftOrderResult | null {
  if (!body || typeof body !== "object") return null;
  let o = body as Record<string, unknown>;
  if (o.data && typeof o.data === "object") o = o.data as Record<string, unknown>;
  const code = str(o.code);
  const publicUrl = str(o.publicUrl);
  const amountCop = Number(o.amountCop);
  if (!code || !/^https?:\/\//i.test(publicUrl)) return null;
  return {
    code,
    publicUrl,
    amountCop: Number.isFinite(amountCop) ? amountCop : 0,
    tierName: str(o.tierName),
  };
}

/**
 * Key for the localized copy of a tier ("Consentida" → "consentida"). Tiers
 * are configured in Stampee in Spanish; the English page describes the known
 * ones from the dictionary and falls back to Stampee's text for new ones.
 */
export function tierKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * `?ref=` from a campaign link (`adviento`, `ig-story`…). Only a short slug
 * survives; anything else is dropped instead of forwarded to the panel.
 */
export function cleanRef(raw: unknown): string | null {
  const v = str(Array.isArray(raw) ? raw[0] : raw).toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,39}$/.test(v) ? v : null;
}

/** Collapse whitespace and cap. Newlines are not kept: the card is one line. */
export function cleanText(raw: unknown, max: number): string {
  return str(raw).replace(/\s+/g, " ").slice(0, max).trim();
}

export type GiftOrderInput = {
  tierId: string;
  buyerName: string;
  buyerPhone: string;
  recipientName: string;
  message: string;
};

export type GiftOrderField = "tierId" | "buyerName" | "buyerPhone" | "recipientName" | "message";

/**
 * What the buyer typed, checked the same way in the browser and in the proxy.
 * The phone check is the booking one (`isPlausiblePhone`), passed in so this
 * file has no imports.
 */
export function giftOrderErrors(
  input: GiftOrderInput,
  isPhone: (raw: string) => boolean,
): GiftOrderField[] {
  const errors: GiftOrderField[] = [];
  if (!input.tierId) errors.push("tierId");
  if (input.buyerName.trim().length < 2 || input.buyerName.length > GIFT_NAME_MAX) errors.push("buyerName");
  if (!isPhone(input.buyerPhone)) errors.push("buyerPhone");
  const r = input.recipientName.trim();
  if (r !== "" && (r.length < 2 || r.length > GIFT_RECIPIENT_MAX)) errors.push("recipientName");
  if (input.message.length > GIFT_MESSAGE_MAX) errors.push("message");
  return errors;
}

/**
 * WhatsApp link to the studio with text.
 *
 * `api.whatsapp.com/send`, never `wa.me`: the `wa.me` redirect mangles emojis
 * on some phones, and the pay message starts with ✨.
 */
export function whatsappSendLink(number: string, text: string): string {
  const digits = number.replace(/\D/g, "");
  const full = digits.length === 10 ? `57${digits}` : digits;
  return `https://api.whatsapp.com/send?phone=${full}&text=${encodeURIComponent(text)}`;
}

/**
 * Payment instructions from `NEXT_PUBLIC_GIFT_PAYMENT_INFO`. One env var, so
 * line breaks are written as a literal `\n` or ` | `. Empty → null, and the
 * page says the studio sends the details on WhatsApp instead.
 */
export function paymentLines(raw: string | undefined | null): string[] | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  const lines = v
    .split(/\\n|\n|\s\|\s/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines : null;
}
