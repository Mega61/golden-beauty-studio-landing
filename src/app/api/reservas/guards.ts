import { NextResponse, type NextRequest } from "next/server";

/**
 * Shared defences for the public booking proxy.
 *
 * Lifted from `api/postulaciones/route.ts` rather than reinvented — same threat,
 * same shape, and having two slightly different rate limiters in one codebase is
 * how one of them silently stops working. The difference is what's behind them:
 * postulaciones writes a job application to Strapi, this writes a **real
 * appointment into a real calendar**, so a flood here costs the studio a técnica
 * standing around for a client who never existed.
 *
 * The browser never talks to the panel directly. The panel lives on the VM and
 * holds the Easy!Appointments token; exposing it would mean exposing EA.
 */

/** Minimum seconds between the form rendering and its submission. */
export const MIN_FILL_SECONDS = 3;

const RATE_WINDOW_MS = 10 * 60 * 1000;

export type GuardReason =
  | "validation"
  | "rate_limited"
  | "captcha"
  | "spam"
  | "taken"
  | "unavailable";

export function fail(reason: GuardReason, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json(
    { ok: false, reason, ...extra },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * In-memory per-IP counter.
 *
 * On serverless this is per-instance and resets on cold start, so it is a speed
 * bump for floods rather than a real quota. The durable limit lives further in:
 * EA itself cuts off at 100 requests per IP per 120 s, and the panel refuses any
 * slot that isn't genuinely free. Kept because it costs nothing and stops the
 * common case — a stuck submit button, a naive bot.
 */
const hits = new Map<string, number[]>();

export function rateLimited(ip: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);

  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length > max;
}

export function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Cloudflare Turnstile — only enforced when the secret is configured.
 *
 * Unset is a supported state, not a half-finished one: the honeypot, the fill
 * timer and the per-IP limit all still run, and the studio can turn this on the
 * day spam actually appears without touching code.
 */
export async function turnstileOk(token: string | null, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return true;
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
      cache: "no-store",
    });
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    // Verification endpoint unreachable: fail OPEN, same as postulaciones.
    // Losing a real booking to a Cloudflare hiccup is worse than admitting the
    // occasional bot, and every other guard still runs.
    return true;
  }
}

/**
 * Where the panel lives. Same variable the `/admin` rewrite uses.
 *
 * Absent means the booking flow is off — which is the correct state for a
 * Vercel preview, and the reason this returns null instead of guessing a
 * localhost that would hang the request for 30 seconds.
 */
export function adminOrigin(): string | null {
  return process.env.ADMIN_ORIGIN?.replace(/\/$/, "") || null;
}

/** The panel is served under `/admin`, so its public API sits below that. */
export function bookingUrl(origin: string, path: string): string {
  return `${origin}/admin/api/public/booking/${path}`;
}
