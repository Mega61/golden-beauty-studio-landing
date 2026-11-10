"use client";

import { useEffect } from "react";

import { captureAttribution } from "@/lib/attribution";

/**
 * Remembers where this visit came from (UTMs, click id, referrer) so the
 * booking can carry it. Once per full page load: client navigations keep the
 * same URL params and referrer, so they would only repeat the first read.
 */
export default function AttributionCapture() {
  useEffect(() => {
    captureAttribution();
  }, []);
  return null;
}
