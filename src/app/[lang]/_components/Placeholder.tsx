type Tone = "cream" | "gold" | "ink";

// Tone-specific tint overlay for the textured backdrop + label color.
const TONE_STYLES: Record<
  Tone,
  { overlay: string; labelColor: string; labelBg: string; labelBorder: string }
> = {
  cream: {
    overlay:
      "linear-gradient(160deg, rgba(248,244,238,0.45), rgba(239,231,218,0.7))",
    labelColor: "var(--color-ink-soft)",
    labelBg: "var(--color-ivory)",
    labelBorder: "var(--hair)",
  },
  gold: {
    overlay:
      "linear-gradient(160deg, rgba(255,212,159,0.32), rgba(231,170,81,0.45))",
    labelColor: "var(--color-gold-deep)",
    labelBg: "var(--color-gold-pale)",
    labelBorder: "rgba(91,43,8,0.18)",
  },
  ink: {
    overlay:
      "linear-gradient(160deg, rgba(28,23,20,0.55), rgba(28,23,20,0.78))",
    labelColor: "var(--color-gold-soft)",
    labelBg: "rgba(28,23,20,0.7)",
    labelBorder: "rgba(231,170,81,0.25)",
  },
};

/**
 * Placeholder used for Lookbook tiles without real photos and for the
 * Estudio lamp-detail slot. Renders the brand round logo (textured + beveled)
 * centered on a gold-leaf marble backdrop, tinted per `tone`, with a small
 * caption underneath. Replaces the previous candy-striped placeholder.
 */
export default function Placeholder({
  label,
  tone = "cream",
  className = "",
}: {
  label: string;
  tone?: Tone;
  className?: string;
}) {
  const t = TONE_STYLES[tone];

  return (
    <div
      className={`relative flex h-full w-full items-center justify-center overflow-hidden ${className}`}
      style={{
        backgroundImage: 'url("/logos/optimized/Texture.webp")',
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
    >
      {/* Tone tint */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{ background: t.overlay }}
      />

      {/* Centered round brand seal */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/logos/optimized/RoundLogoTextureBisel.webp"
        alt=""
        aria-hidden
        decoding="async"
        loading="lazy"
        className="relative"
        style={{
          width: "45%",
          maxWidth: 240,
          aspectRatio: "1 / 1",
          objectFit: "contain",
          filter:
            tone === "ink"
              ? "drop-shadow(0 8px 18px rgba(0,0,0,0.45))"
              : "drop-shadow(0 6px 14px rgba(91,43,8,0.18))",
        }}
      />

      {/* Caption */}
      <span
        className="absolute font-sans"
        style={{
          bottom: "8%",
          left: "50%",
          transform: "translateX(-50%)",
          background: t.labelBg,
          padding: "5px 10px",
          border: `1px solid ${t.labelBorder}`,
          color: t.labelColor,
          fontSize: 10,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </div>
  );
}
