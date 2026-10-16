import "server-only";

import { createHash } from "node:crypto";

import { buildCapiEvent, type CapiInput } from "./meta-events";

/**
 * Server-side Conversions API. Sends one event; never throws.
 *
 * Configured with `NEXT_PUBLIC_META_PIXEL_ID` (the same id the Pixel uses) and
 * `META_CAPI_ACCESS_TOKEN` (Events Manager → the pixel → Settings → Generate
 * access token). Either missing means off, silently — the booking must never
 * depend on Meta. `META_TEST_EVENT_CODE` routes events to the "Test events" tab
 * while checking the setup; leave it unset in production.
 *
 * Callers run this inside `after()`, so the client's confirmation never waits
 * on Facebook's latency.
 */
const GRAPH_VERSION = process.env.META_GRAPH_VERSION?.trim() || "v23.0";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export function capiConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim() && process.env.META_CAPI_ACCESS_TOKEN?.trim());
}

export async function sendCapiEvent(input: CapiInput): Promise<void> {
  const pixelId = process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim();
  const token = process.env.META_CAPI_ACCESS_TOKEN?.trim();
  if (!pixelId || !token) return;

  const body: Record<string, unknown> = { data: [buildCapiEvent(input, sha256)] };
  const testCode = process.env.META_TEST_EVENT_CODE?.trim();
  if (testCode) body.test_event_code = testCode;

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      // The token is in the URL; log the status and Meta's message, never the URL.
      const detail = await res.text().catch(() => "");
      console.error("[meta-capi] Meta rechazó el evento", input.eventName, res.status, detail.slice(0, 300));
    }
  } catch (error) {
    console.error("[meta-capi] no se pudo enviar", input.eventName, error instanceof Error ? error.message : error);
  }
}
