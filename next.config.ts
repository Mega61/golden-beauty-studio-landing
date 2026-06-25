import type { NextConfig } from "next";
import path from "node:path";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
];

// Hosts allowed for next/image remote sources. Lookbook photos are served from
// Strapi → GCS (and/or a Cloudflare-fronted media subdomain). Add the delivery
// host via NEXT_PUBLIC_MEDIA_HOST (e.g. media.goldenbeautystudio.com.co); the
// raw GCS host and localhost dev are always permitted.
const mediaHosts = [
  process.env.NEXT_PUBLIC_MEDIA_HOST,
  "storage.googleapis.com",
].filter((h): h is string => Boolean(h));

const remotePatterns = [
  ...mediaHosts.map((hostname) => ({
    protocol: "https" as const,
    hostname,
    pathname: "/**",
  })),
  {
    protocol: "http" as const,
    hostname: "localhost",
    port: "1337",
    pathname: "/**",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: {
    remotePatterns,
    // Dev only: the local Strapi serves media from http://localhost:1337, which
    // resolves to a private IP (127.0.0.1/::1). Next's image optimizer blocks
    // private-IP upstreams by default as SSRF protection. In production media is
    // served from the public GCS/Cloudflare host, so this stays OFF there.
    dangerouslyAllowLocalIP: process.env.NODE_ENV === "development",
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
