import { type NextRequest, NextResponse } from "next/server";

import {
  MIN_FILL_SECONDS,
  adminOrigin,
  bookingUrl,
  clientIp,
  fail,
  rateLimited,
  turnstileOk,
} from "./guards";

/**
 * Confirm a booking. The write path, and the only one with full defences.
 *
 * Defence in depth, cheapest first: honeypot → fill-time → per-IP burst →
 * Turnstile (when configured) → the panel re-verifies the slot against fresh
 * data before writing anything. That last step is the one that actually
 * matters: everything here can be replayed by someone with curl, so none of it
 * is load-bearing for correctness — it exists to keep the cheap floods away
 * from the panel, and from EA's own rate limit behind it.
 *
 * The browser never sees the Easy!Appointments token, and EA is never reachable
 * from the internet. This route and its read-only sibling are the whole public
 * surface of the booking flow.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A person books once or twice. Five in ten minutes from one IP is a script. */
const RATE_MAX = 5;

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

  // 1. Honeypot: a field a person never sees and never fills. Same name as the
  //    careers form, so both surfaces stay one convention.
  if (text(body.empresa) !== "") return fail("spam", 400);

  // 2. Fill time. A form submitted faster than a human can read it wasn't read.
  const startedAt = Number(body.startedAt);
  if (Number.isFinite(startedAt) && startedAt > 0) {
    if ((Date.now() - startedAt) / 1000 < MIN_FILL_SECONDS) return fail("spam", 400);
  }

  // 3. Per-IP burst.
  if (rateLimited(ip, RATE_MAX)) return fail("rate_limited", 429);

  // 4. Turnstile, if the studio ever turns it on.
  if (!(await turnstileOk(text(body["cf-turnstile-response"]) || null, ip))) {
    return fail("captcha", 400);
  }

  const origin = adminOrigin();
  if (!origin) return fail("unavailable", 503);

  // Only the fields the panel accepts. The guard fields stay here — the panel
  // has no idea what a honeypot is and shouldn't have to.
  const payload = {
    serviceId: body.serviceId,
    date: body.date,
    time: body.time,
    providerId: body.providerId ?? null,
    firstName: text(body.firstName),
    lastName: text(body.lastName),
    phone: text(body.phone),
    notes: text(body.notes) || null,
  };

  try {
    const res = await fetch(bookingUrl(origin, "reservar"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    if (res.status === 201) {
      const created: unknown = await res.json();
      return NextResponse.json(
        { ok: true, booking: created },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Someone took the slot between listing and confirming. It's a race, not a
    // mistake the client made, and the form has to say so without blaming her.
    if (res.status === 409) return fail("taken", 409);

    if (res.status === 400) return fail("validation", 400);

    console.error("[reservas] el panel rechazó la reserva", res.status);
    return fail("unavailable", res.status === 503 ? 503 : 502);
  } catch (error) {
    console.error("[reservas] el panel no respondió", error);
    return fail("unavailable", 503);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
