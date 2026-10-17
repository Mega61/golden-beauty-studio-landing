import { type NextRequest, NextResponse } from "next/server";

import { adminOrigin, bookingUrl, clientIp, fail, rateLimited } from "../guards";

/**
 * The price of the visit with whichever promo applies — day promo, or 10% off
 * a first visit. Read-only proxy to the panel, which computes everything from
 * EA's prices: the browser sends ids, a date and (once typed) the phone, never
 * a price.
 *
 * Its own bucket, and a tight one: with a phone this answers "has this number
 * been here before?", which the owner accepted as the cost of showing the 10%
 * up front — but it shouldn't be a free lookup service. The flow calls it a few
 * times per booking (debounced on the phone field, again if the day changes);
 * twenty in ten minutes is generous for a person and useless for a scraper.
 * The panel adds a global cap of its own behind this, because the panel can
 * also be reached through the `/admin` rewrite without passing through here.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_MAX = 20;

export async function POST(req: NextRequest) {
  if (rateLimited(clientIp(req), RATE_MAX, "cotizar")) return fail("rate_limited", 429);

  const origin = adminOrigin();
  if (!origin) return fail("unavailable", 503);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) return fail("validation", 400);
    body = parsed as Record<string, unknown>;
  } catch {
    return fail("validation", 400);
  }

  // Only the fields the panel knows — same rule as the other proxies.
  const payload = {
    serviceId: body.serviceId,
    thenServiceId: body.thenServiceId ?? null,
    date: body.date,
    phone: typeof body.phone === "string" ? body.phone.trim() : null,
  };

  try {
    const res = await fetch(bookingUrl(origin, "cotizar"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (res.status === 400) return fail("validation", 400);
    if (!res.ok) return fail("unavailable", res.status === 503 ? 503 : 502);

    const quote: unknown = await res.json();
    return NextResponse.json(quote, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[reservas/cotizar] el panel no respondió", error);
    return fail("unavailable", 503);
  }
}
