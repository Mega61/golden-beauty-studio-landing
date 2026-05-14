type LogoProps = {
  /**
   * Visual scale hint in px.
   * For `variant="text"` this controls the cap-height of the visible wordmark;
   * for `variant="full"` it's the width tier of the lockup.
   */
  size?: number;
  variant?: "full" | "text";
  /**
   * Kept for API compatibility. The brand SVGs carry baked-in gold gradients
   * (deep `#5b2b08` → copper `#a85b23` + radial highlights), so tint overrides
   * are intentionally a no-op here. A future `variant="inverse"` would need
   * white/cream-fill artwork (not yet shipped in `public/logos/`).
   */
  color?: string;
};

/**
 * Brand-mark renderer for Golden Beauty Studio.
 *
 * Sources (in `public/logos/`):
 * - `LogoText.svg` (72 KB) — the script "Golden" wordmark
 * - `LogoSubText.svg` (39 KB) — the "— BEAUTY STUDIO —" subline with rules
 * - `FullLogo.svg` (110 KB) — full lockup, both stacked
 *
 * Texture variants (`FullLogoTexture`, `RoundLogoTexture(Bisel)`, `Texture*`)
 * are 2.3–2.7 MB each and intentionally NOT loaded by this component.
 * Use them via direct `<img>` if a hero / marquee treatment is wanted.
 *
 * The source SVGs ship with a 1500² viewBox and significant internal whitespace.
 * Content extents (measured via sharp at 1500² render):
 *   LogoText.svg     → content 86% × 33% of canvas, top margin 30%, left 7%
 *   LogoSubText.svg  → content 90% × 4.3% of canvas, top margin 48%, left 5%
 *   FullLogo.svg     → content 86% × 33% of canvas, top margin 30%, left 8%
 *
 * To produce a tight bounding box we render each `<img>` oversized inside an
 * `overflow: hidden` clip window and offset to expose only the painted region.
 *
 * Rendered as `<img>` (not `next/image`) to avoid the `dangerouslyAllowSVG`
 * Next config; these are project-owned static assets in `public/`.
 */

// Empirical content extents per source SVG (1500² canvas).
const EXTENTS = {
  wordmark: {
    src: "/logos/LogoText.svg",
    contentHeightRatio: 0.326,
    topMarginRatio: 0.301,
    contentWidthRatio: 0.858,
  },
  subline: {
    src: "/logos/LogoSubText.svg",
    contentHeightRatio: 0.043,
    topMarginRatio: 0.479,
    contentWidthRatio: 0.899,
  },
  full: {
    src: "/logos/FullLogo.svg",
    contentHeightRatio: 0.328,
    topMarginRatio: 0.299,
    contentWidthRatio: 0.861,
  },
} as const;

type CroppedProps = {
  src: string;
  contentH: number;
  contentHeightRatio: number;
  topMarginRatio: number;
  contentWidthRatio: number;
  alt: string;
  style?: React.CSSProperties;
};

function CroppedMark({
  src,
  contentH,
  contentHeightRatio,
  topMarginRatio,
  contentWidthRatio,
  alt,
  style,
}: CroppedProps) {
  // Source is square (1500 × 1500). Rendering height = imgSize.
  // Width auto matches imgSize. Visible content = imgSize × ratio.
  const imgSize = Math.round(contentH / contentHeightRatio);
  const contentW = Math.round(imgSize * contentWidthRatio);
  const topOffset = Math.round(-imgSize * topMarginRatio);

  return (
    <span
      className="logo-clip"
      style={{
        display: "inline-block",
        width: contentW,
        height: contentH,
        overflow: "hidden",
        position: "relative",
        lineHeight: 0,
        ...style,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        decoding="async"
        style={{
          width: imgSize,
          height: imgSize,
          display: "block",
          position: "absolute",
          left: "50%",
          top: topOffset,
          transform: "translateX(-50%)",
          maxWidth: "none",
        }}
      />
    </span>
  );
}

export default function Logo({ size = 64, variant = "full" }: LogoProps) {
  // Both variants render the integrated FullLogo lockup (script + subline +
  // ornamental rules baked into one square SVG). Using the full lockup
  // preserves the brand-designed proportions at every scale.
  //
  // `text` and `full` differ only in tier: `text` is ~size × 2.6 tall (nav /
  // footer / drawer), `full` is ~size × 3.2 tall (hero / about).
  const isText = variant === "text";
  const contentH = Math.round(size * (isText ? 4.5 : 3.2));
  const className = isText ? "logo-text-mark" : "logo-full-mark";
  const alt = isText ? "Golden Beauty Studio" : "Golden Beauty Studio";

  return (
    <span
      className={`${className} inline-block select-none`}
      style={{ lineHeight: 0 }}
    >
      <CroppedMark
        src={EXTENTS.full.src}
        contentH={contentH}
        contentHeightRatio={EXTENTS.full.contentHeightRatio}
        topMarginRatio={EXTENTS.full.topMarginRatio}
        contentWidthRatio={EXTENTS.full.contentWidthRatio}
        alt={alt}
      />
    </span>
  );
}
