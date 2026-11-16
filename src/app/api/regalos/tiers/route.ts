import { type NextRequest, NextResponse } from "next/server";

import { parseTiers } from "@/lib/gift";

import { adminOrigin, clientIp, fail, giftCardsUrl, rateLimited } from "../../reservas/guards";

/**
 * The gift-card tiers on sale. Read-only proxy to the panel, same shape as
 * `/api/reservas/catalogo`.
 *
 * The page renders them on the server; the browser only calls this when that
 * render couldn't reach the panel. Tight per-IP allowance for the same reason
 * as the catalog: a person loads it once.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_MAX = 20;

export async function GET(req: NextRequest) {
  if (rateLimited(clientIp(req), RATE_MAX, "regalos-tiers")) return fail("rate_limited", 429);

  const origin = adminOrigin();
  if (!origin) return fail("unavailable", 503);

  try {
    const res = await fetch(giftCardsUrl(origin, "tiers"), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return fail("unavailable", res.status === 503 ? 503 : 502);

    // Normalised here so the browser gets one shape whatever the panel sends.
    const tiers = parseTiers(await res.json());
    if (tiers.length === 0) return fail("unavailable", 503);
    return NextResponse.json({ ok: true, tiers }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[regalos/tiers] el panel no respondió", error);
    return fail("unavailable", 503);
  }
}
