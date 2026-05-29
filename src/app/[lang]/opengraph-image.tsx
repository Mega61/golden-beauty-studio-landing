import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Branded social share image, one per language. Generated at build time.
// The brand logo is rasterized to public/og/logo.png by scripts/build-favicon.mjs
// (runs in predev/prebuild); if it's missing we fall back to a text wordmark so
// the build never breaks.

export const alt = "Golden Beauty Studio — nail studio in Sabaneta, Antioquia";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Prerender one image per locale at build time (also validates that the
// Satori render succeeds during the build rather than on first request).
export function generateStaticParams() {
  return [{ lang: "es" }, { lang: "en" }];
}

const TAGLINES: Record<string, string> = {
  es: "Uñas construidas · acrílico, polygel y dipping",
  en: "Bespoke sculpted nails · acrylic, polygel & dipping",
};

async function loadLogo(): Promise<string | null> {
  try {
    const data = await readFile(
      join(process.cwd(), "public", "og", "logo.png"),
      "base64",
    );
    return `data:image/png;base64,${data}`;
  } catch {
    return null;
  }
}

export default async function Image({
  params,
}: {
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  const tagline = TAGLINES[lang] ?? TAGLINES.es;
  const logo = await loadLogo();

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "#f8f4ee",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 28,
            left: 28,
            right: 28,
            bottom: 28,
            border: "2px solid #ac8231",
            display: "flex",
          }}
        />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 30,
          }}
        >
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} width={560} alt="" style={{ objectFit: "contain" }} />
          ) : (
            <div
              style={{
                display: "flex",
                fontSize: 84,
                color: "#2a221c",
                letterSpacing: "-0.02em",
              }}
            >
              Golden Beauty Studio
            </div>
          )}
          <div
            style={{ display: "flex", width: 120, height: 2, background: "#ac8231" }}
          />
          <div style={{ display: "flex", fontSize: 34, color: "#2a221c" }}>
            {tagline}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            bottom: 58,
            display: "flex",
            fontSize: 22,
            letterSpacing: "0.32em",
            color: "#ac8231",
            textTransform: "uppercase",
          }}
        >
          Sabaneta · Antioquia · Colombia
        </div>
      </div>
    ),
    { ...size },
  );
}
