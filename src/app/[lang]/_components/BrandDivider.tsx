type Tone = "light" | "dark";

/**
 * Magazine-style section break.
 *
 * Renders `LogoSubText.svg` (the "— BEAUTY STUDIO —" with two ornamental
 * rules) centered with generous breathing room. Used between major sections
 * to give the eye a beat and quietly reinforce the brand at every seam.
 *
 * `tone="dark"` inverts the colors via CSS filter for use on the carbon
 * (Diccionario) background. `tone="light"` (default) is for ivory sections.
 *
 * The source SVG is a 1500² square with 95% horizontal whitespace and 96%
 * vertical whitespace, so we crop tightly via `overflow: hidden` + scaled img.
 * Empirical content extents (matches the constants in `Logo.tsx`):
 *   content height ratio = 0.043 of canvas, top margin = 0.479.
 */
export default function BrandDivider({
  tone = "light",
}: {
  tone?: Tone;
}) {
  const contentH = 14;
  // SubText fills only 4.3% of its 1500² canvas — render the img ~23× the
  // visible height and clip the rest.
  const imgH = Math.round(contentH / 0.043);
  const topOffset = Math.round(-imgH * 0.479);

  const bg = tone === "dark" ? "var(--color-carbon)" : "transparent";
  // Source artwork uses gold-deep ink — invert + recolor for dark sections.
  const filter =
    tone === "dark"
      ? "brightness(0) saturate(100%) invert(74%) sepia(38%) saturate(427%) hue-rotate(2deg) brightness(95%) contrast(89%)"
      : "none";

  return (
    <div
      className="brand-divider relative flex items-center justify-center"
      role="separator"
      aria-hidden
      style={{
        background: bg,
        padding: "32px 16px",
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: "min(380px, 80vw)",
          height: contentH,
          overflow: "hidden",
          position: "relative",
          lineHeight: 0,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logos/LogoSubText.svg"
          alt=""
          aria-hidden
          decoding="async"
          style={{
            width: imgH,
            height: imgH,
            display: "block",
            position: "absolute",
            left: "50%",
            top: topOffset,
            transform: "translateX(-50%)",
            maxWidth: "none",
            filter,
          }}
        />
      </span>
    </div>
  );
}
