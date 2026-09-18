import { type NextRequest, NextResponse } from "next/server";

import { adminOrigin, bookingUrl, clientIp, fail, rateLimited } from "../guards";

/**
 * What can be booked and with whom. Read-only proxy to the panel.
 *
 * Called once when the booking page mounts, so the per-IP allowance is tight
 * compared to the availability route — a person loads this once, a script
 * loads it in a loop.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_MAX = 20;

export async function GET(req: NextRequest) {
  if (rateLimited(clientIp(req), RATE_MAX)) return fail("rate_limited", 429);

  const origin = adminOrigin();
  if (!origin) return fail("unavailable", 503);

  try {
    const res = await fetch(bookingUrl(origin, "catalogo"), {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!res.ok) return fail("unavailable", res.status === 503 ? 503 : 502);

    const body: unknown = await res.json();
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[reservas/catalogo] el panel no respondió", error);
    return fail("unavailable", 503);
  }
}
