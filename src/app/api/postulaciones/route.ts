import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { careersConfig } from "@/config/site";

/**
 * Job-application intake proxy for "Trabaja con nosotros" (landing section +
 * /bio disclosure).
 *
 * The browser posts multipart FormData here; we validate it, then forward it to
 * Strapi's secret-gated POST /api/job-applications/apply. The browser NEVER
 * talks to Strapi directly — that would mean granting the Public role
 * create-permission on the content type plus upload access to the Media Library
 * (i.e. an open file-upload endpoint on the CMS and the GCS bucket). Keeping the
 * secret server-side here means the public surface is this route, and this route
 * only accepts one shape of request.
 *
 * Defence in depth, cheapest first: honeypot → fill-time → per-IP burst →
 * Turnstile (when configured) → size/type → Strapi re-validates everything.
 *
 * Body-size note: Vercel caps a serverless request body at 4.5 MB, so the CV
 * limit is 4 MB (careersConfig.maxBytes) and the form enforces it client-side
 * too — a rejection the applicant can read beats an opaque platform 413.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Minimum seconds between the form rendering and its submission. */
const MIN_FILL_SECONDS = 3;
/** Per-IP burst window. */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 5;

type ErrorReason =
  | "validation"
  | "file_missing"
  | "file_too_large"
  | "file_type"
  | "rate_limited"
  | "captcha"
  | "spam"
  | "cms_unavailable";

function fail(reason: ErrorReason, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, reason, ...extra }, { status });
}

/**
 * In-memory per-IP counter. On serverless this is per-instance and resets on
 * cold start, so it is a speed bump for floods, not a real quota — the durable
 * limit is Strapi's per-phone throttle, which is DB-backed. Kept because it
 * costs nothing and stops the common case (a stuck submit button, a naive bot).
 */
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  // Opportunistic cleanup so the map can't grow without bound.
  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (times.every((t) => now - t >= RATE_WINDOW_MS)) hits.delete(key);
    }
  }
  return recent.length > RATE_MAX;
}

function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Hash the IP before it leaves this process: the CMS gets a stable token for
 * abuse forensics without ever storing an applicant's raw address. Salted with
 * the shared secret so the hash isn't reversible via a rainbow table of IPv4.
 */
function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${ip}|${salt}`).digest("hex").slice(0, 64);
}

/** Cloudflare Turnstile — only enforced when the secret is configured. */
async function turnstileOk(token: string | null, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return true;
  if (!token) return false;
  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret, response: token, remoteip: ip }),
        cache: "no-store",
      },
    );
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch {
    // Verification endpoint unreachable: fail OPEN. Losing a real applicant to
    // a Cloudflare hiccup is worse than admitting the occasional bot, and every
    // other guard (honeypot, fill-time, rate limit, Strapi throttle) still runs.
    return true;
  }
}

const REQUIRED_TEXT_FIELDS = ["full_name", "phone", "role_applied"] as const;

export async function POST(req: NextRequest) {
  const base = process.env.STRAPI_URL?.trim().replace(/\/+$/, "");
  const secret = process.env.STRAPI_CAREERS_SECRET?.trim();
  if (!base || !secret) {
    // Not configured (e.g. a preview deploy without CMS env). The form turns
    // this into "escríbenos por WhatsApp" rather than a dead end.
    return fail("cms_unavailable", 503);
  }

  const ip = clientIp(req);
  if (rateLimited(ip)) return fail("rate_limited", 429);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("validation", 400, { fields: [] });
  }

  const text = (key: string): string => {
    const value = form.get(key);
    return typeof value === "string" ? value.trim() : "";
  };

  // Honeypot: a field hidden from humans and irresistible to form-fillers.
  if (text("empresa") !== "") return fail("spam", 400);

  // Fill-time: a human cannot complete this form in under a few seconds.
  const startedAt = Number(text("started_at"));
  if (Number.isFinite(startedAt) && startedAt > 0) {
    const elapsed = (Date.now() - startedAt) / 1000;
    if (elapsed < MIN_FILL_SECONDS) return fail("spam", 400);
  }

  if (!(await turnstileOk(text("cf-turnstile-response") || null, ip))) {
    return fail("captcha", 400);
  }

  const missing: string[] = REQUIRED_TEXT_FIELDS.filter(
    (field) => text(field) === "",
  );
  if (text("consent") !== "true") missing.push("consent");
  if (missing.length > 0) return fail("validation", 400, { fields: missing });

  const cv = form.get("cv");
  if (!(cv instanceof File) || cv.size === 0) return fail("file_missing", 400);
  if (cv.size > careersConfig.maxBytes) {
    return fail("file_too_large", 413, { maxBytes: careersConfig.maxBytes });
  }
  // Extension check only — the authoritative check is Strapi's magic-byte sniff.
  const ext = cv.name.includes(".")
    ? `.${cv.name.split(".").pop()!.toLowerCase()}`
    : "";
  const accepted: readonly string[] = careersConfig.acceptedExtensions;
  if (!accepted.includes(ext)) {
    return fail("file_type", 415);
  }

  // Rebuild the payload rather than forwarding the client's FormData verbatim:
  // only fields we know about reach the CMS.
  const outbound = new FormData();
  for (const key of [
    "full_name",
    "phone",
    "email",
    "role_applied",
    "experience",
    "portfolio_url",
    "message",
    "consent",
    "source_surface",
    "source_lang",
  ]) {
    const value = text(key);
    if (value !== "") outbound.append(key, value);
  }
  // Techniques is a repeated checkbox field; Strapi joins the list itself.
  for (const value of form.getAll("techniques")) {
    if (typeof value === "string" && value.trim() !== "") {
      outbound.append("techniques", value.trim());
    }
  }
  outbound.append("cv", cv, cv.name);

  let res: Response;
  try {
    res = await fetch(`${base}/api/job-applications/apply`, {
      method: "POST",
      headers: {
        "x-careers-secret": secret,
        "x-applicant-ip-hash": hashIp(ip, secret),
      },
      body: outbound,
      cache: "no-store",
    });
  } catch {
    return fail("cms_unavailable", 503);
  }

  if (res.ok) return NextResponse.json({ ok: true }, { status: 201 });

  // Pass the CMS's verdict through so the form shows the right message; never
  // leak its response body.
  let reason: ErrorReason = "cms_unavailable";
  let fields: unknown;
  try {
    const body = (await res.json()) as { reason?: string; fields?: unknown };
    const passthrough: ErrorReason[] = [
      "validation",
      "file_missing",
      "file_too_large",
      "file_type",
      "rate_limited",
    ];
    if (body.reason && passthrough.includes(body.reason as ErrorReason)) {
      reason = body.reason as ErrorReason;
      fields = body.fields;
    }
  } catch {
    /* non-JSON error body — keep the generic reason */
  }
  const status = reason === "cms_unavailable" ? 503 : res.status;
  return fail(reason, status, fields ? { fields } : undefined);
}
