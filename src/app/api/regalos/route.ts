import { after, type NextRequest, NextResponse } from "next/server";

import { isPlausiblePhone } from "@/lib/booking";
import {
  GIFT_MESSAGE_MAX,
  GIFT_NAME_MAX,
  GIFT_RECIPIENT_MAX,
  cleanRef,
  cleanText,
  giftOrderErrors,
  parseOrderResult,
} from "@/lib/gift";
import { capiConfigured, sendCapiEvent } from "@/lib/meta-capi";
import { fbcFrom } from "@/lib/meta-events";

import {
  MIN_FILL_SECONDS,
  adminOrigin,
  clientIp,
  fail,
  giftCardsUrl,
  rateLimited,
  turnstileOk,
} from "../reservas/guards";

/**
 * Order a gift card (`/regalar`). The write path, with the same defences as
 * `/api/reservas`: honeypot → fill time → per-IP burst → Turnstile (when
 * configured) → the panel, which looks the amount up from the tier and creates
 * the card in Stampee as `pending_payment`.
 *
 * Nothing is charged here. The buyer pays by transfer, the owner confirms the
 * payment in the panel, and only then does the card become usable — so a bot
 * that slips through costs a row in a list of pending orders, not money. The
 * guards exist to keep that list readable.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Someone buying three gifts is plausible; ten in ten minutes is a script. */
const RATE_MAX = 6;

export async function POST(req: NextRequest) {
  const ip = clientIp(req);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) return fail("validation", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return fail("validation", 400);
  }

  // 1. Honeypot. Same field name as the booking and careers forms.
  if (text(body.empresa) !== "") return fail("spam", 400);

  // 2. Fill time.
  const startedAt = Number(body.startedAt);
  if (Number.isFinite(startedAt) && startedAt > 0) {
    if ((Date.now() - startedAt) / 1000 < MIN_FILL_SECONDS) return fail("spam", 400);
  }

  // 3. Per-IP burst, in its own bucket so browsing tiers never spends it.
  if (rateLimited(ip, RATE_MAX, "regalos")) return fail("rate_limited", 429);

  // 4. Turnstile, if the studio turns it on.
  if (!(await turnstileOk(text(body["cf-turnstile-response"]) || null, ip))) {
    return fail("captcha", 400);
  }

  // Only what the panel accepts, cleaned. No amount: it comes from the tier.
  const input = {
    tierId: text(body.tierId),
    buyerName: cleanText(body.buyerName, GIFT_NAME_MAX),
    buyerPhone: text(body.buyerPhone),
    recipientName: cleanText(body.recipientName, GIFT_RECIPIENT_MAX),
    message: cleanText(body.message, GIFT_MESSAGE_MAX),
  };
  const errors = giftOrderErrors(input, isPlausiblePhone);
  if (errors.length > 0) {
    return fail(errors.includes("buyerPhone") ? "phone" : "validation", 400, { fields: errors });
  }

  const origin = adminOrigin();
  if (!origin) return fail("unavailable", 503);

  const ref = cleanRef(body.ref);
  const payload = {
    tierId: input.tierId,
    buyer: { name: input.buyerName, phone: input.buyerPhone },
    ...(input.recipientName ? { recipientName: input.recipientName } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(ref ? { ref } : {}),
  };

  try {
    const res = await fetch(giftCardsUrl(origin, "order"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const order = parseOrderResult(await res.json().catch(() => null));
      if (!order) {
        console.error("[regalos] el panel respondió sin código o sin link");
        return fail("unavailable", 502);
      }

      // The server copy of the browser's InitiateCheckout, same event id so
      // Meta keeps one. Sent after the response: the buyer never waits on it.
      if (capiConfigured()) {
        const eventId = text(body.eventId) || `gift-${Date.now()}`;
        const referer = req.headers.get("referer") ?? `${req.nextUrl.origin}/es/regalar`;
        const fbclid = (() => {
          try {
            return new URL(referer).searchParams.get("fbclid");
          } catch {
            return null;
          }
        })();
        const [firstName, ...rest] = input.buyerName.split(" ");
        after(() =>
          sendCapiEvent({
            eventName: "InitiateCheckout",
            eventId,
            eventTime: new Date(),
            sourceUrl: referer,
            ip,
            userAgent: req.headers.get("user-agent"),
            fbc: fbcFrom(req.cookies.get("_fbc")?.value, fbclid),
            fbp: req.cookies.get("_fbp")?.value ?? null,
            phone: input.buyerPhone,
            firstName,
            lastName: rest.join(" ") || null,
            customData: {
              currency: "COP",
              ...(order.amountCop > 0 ? { value: order.amountCop } : {}),
              content_type: "product",
              content_ids: [`tarjeta-regalo${order.tierName ? `-${order.tierName.toLowerCase()}` : ""}`],
              content_category: "gift_card",
            },
          }),
        );
      }

      return NextResponse.json(
        { ok: true, order },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }

    // The tier was switched off between loading the page and ordering.
    if (res.status === 404 || res.status === 409 || res.status === 422) return fail("taken", 409);

    if (res.status === 400) {
      const refused = (await res.json().catch(() => null)) as { field?: string } | null;
      const field = refused?.field ?? "";
      if (field === "tierId") return fail("taken", 409);
      return fail(field.toLowerCase().includes("phone") ? "phone" : "validation", 400);
    }

    console.error("[regalos] el panel rechazó el pedido", res.status);
    return fail("unavailable", res.status === 503 ? 503 : 502);
  } catch (error) {
    console.error("[regalos] el panel no respondió", error);
    return fail("unavailable", 503);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
