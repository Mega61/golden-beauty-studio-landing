"use client";

import ReactDOM from "react-dom";
import { siteConfig } from "@/config/site";

// Warms up connections to the third-party origins we actually use, but only
// when they're configured. next/font already handles font preconnects.
export default function Preconnect() {
  if (siteConfig.mapsEmbedUrl) {
    ReactDOM.preconnect("https://www.google.com");
    ReactDOM.prefetchDNS("https://maps.gstatic.com");
  }
  if (siteConfig.gaId) {
    ReactDOM.preconnect("https://www.googletagmanager.com");
    ReactDOM.prefetchDNS("https://www.google-analytics.com");
  }
  return null;
}
