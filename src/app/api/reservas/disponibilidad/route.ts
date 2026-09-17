import { type NextRequest, NextResponse } from "next/server";

import { adminOrigin, bookingUrl, clientIp, fail, rateLimited } from "../guards";

/**
 * Free slots for the booking flow. Read-only proxy to the panel.
 *
 * No Turnstile and no honeypot here on purpose: this is a read the client makes
 * several times while picking a day, and a challenge on every calendar click is
 * a form nobody finishes. The write path (`../route.ts`) is where the real
 * defences sit. What this does keep is a per-IP limit, because each call costs
 * the panel a fan-out of one request per técnica to EA — and EA cuts off at 100
 * per IP per 120 s, so an unbounded caller here would take the studio's own
 * agenda down with it.
 *
 * The allowance is deliberately loose: a client legitimately clicks through a
 * dozen days looking for a Saturday.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_MAX = 60;

export async function GET(req: NextRequest) {
  if (rateLimited(clientIp(req), RATE_MAX)) return fail("rate_limited", 429);

  const origin = adminOrigin();
  if (!origin) return fail("unavailable", 503);

  const params = req.nextUrl.searchParams;
  const query = new URLSearchParams();
  // Only the three parameters the panel knows. Forwarding the whole query
  // string would let a caller smuggle anything we later add to the sub-API.
  for (const key of ["serviceId", "date", "providerId"]) {
    const value = params.get(key);
    if (value !== null && value !== "") query.set(key, value);
  }

  try {
    const res = await fetch(`${bookingUrl(origin, "availability")}?${query}`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      // The panel already decided whether this is retryable; don't relabel it.
      return fail("unavailable", res.status === 503 ? 503 : 502);
    }

    const body: unknown = await res.json();
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[reservas/disponibilidad] el panel no respondió", error);
    return fail("unavailable", 503);
  }
}
