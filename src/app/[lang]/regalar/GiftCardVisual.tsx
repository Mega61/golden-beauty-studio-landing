/**
 * The gift card itself, drawn in CSS: the hero's showpiece, the face of each
 * tier, and the card on the confirmation screen. No hooks, so it renders on
 * the server for the hero and inside the client flow alike.
 *
 * Credit-card proportions on purpose: people read that shape as "a card with
 * money on it" before they read a word. Three finishes, one per tier, so the
 * picker reads as three objects rather than three prices.
 */

export type CardTone = "champagne" | "mocha" | "carbon";

const TONES: Record<
  CardTone,
  { bg: string; text: string; sub: string; amount: string; rule: string; border: string }
> = {
  champagne: {
    bg: "linear-gradient(135deg, #f7ecd8 0%, #ead5ab 46%, #f6ead3 72%, #e2c48e 100%)",
    text: "#2a221c",
    sub: "rgba(42,34,28,0.62)",
    amount: "text-gold-grad",
    rule: "rgba(91,43,8,0.22)",
    border: "rgba(139,106,31,0.35)",
  },
  mocha: {
    bg: "linear-gradient(135deg, #6b4a33 0%, #4a3426 48%, #3a281c 74%, #5e412d 100%)",
    text: "#f3ecdf",
    sub: "rgba(243,236,223,0.66)",
    amount: "text-gold-grad-light",
    rule: "rgba(255,212,159,0.22)",
    border: "rgba(255,212,159,0.28)",
  },
  carbon: {
    bg: "linear-gradient(135deg, #2e241c 0%, #1c1714 50%, #140f0c 74%, #2a2018 100%)",
    text: "#f3ecdf",
    sub: "rgba(243,236,223,0.62)",
    amount: "text-gold-grad-light",
    rule: "rgba(231,170,81,0.3)",
    border: "rgba(231,170,81,0.5)",
  },
};

export function toneFor(index: number): CardTone {
  return (["champagne", "mocha", "carbon"] as const)[Math.min(Math.max(index, 0), 2)];
}

export default function GiftCardVisual({
  tone,
  label,
  amount,
  tierName,
  toLabel,
  toName,
  code,
  size = "lg",
  className = "",
}: {
  tone: CardTone;
  /** "Tarjeta regalo" */
  label: string;
  /** Already formatted for the locale. */
  amount: string;
  tierName?: string;
  toLabel?: string;
  toName?: string;
  /** Real code on the confirmation; a masked placeholder elsewhere. */
  code?: string;
  size?: "lg" | "sm";
  className?: string;
}) {
  const t = TONES[tone];
  const lg = size === "lg";
  return (
    <div
      className={`relative isolate aspect-[1.586] w-full overflow-hidden ${lg ? "rounded-[22px]" : "rounded-[16px]"} ${className}`}
      style={{
        // Type scales with the card, not the viewport: the same card is a
        // hero on desktop and a thumbnail in the tier list.
        containerType: "inline-size",
        background: t.bg,
        color: t.text,
        border: `1px solid ${t.border}`,
        boxShadow: lg
          ? "0 40px 80px -40px rgba(0,0,0,0.65), 0 18px 30px -22px rgba(91,43,8,0.6), inset 0 1px 0 rgba(255,255,255,0.18)"
          : "0 22px 40px -26px rgba(28,23,20,0.55), inset 0 1px 0 rgba(255,255,255,0.18)",
      }}
    >
      {/* Gold-leaf marble, faint: texture you notice only when you look. */}
      <span
        aria-hidden
        className="bg-marble pointer-events-none absolute inset-0 -z-10"
        style={{ opacity: tone === "champagne" ? 0.22 : 0.1, mixBlendMode: tone === "champagne" ? "multiply" : "screen" }}
      />
      {/* The foil sheen: one diagonal highlight, like light across a card. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -inset-y-10 -left-1/3 -z-10 w-2/3 rotate-[18deg]"
        style={{
          background:
            "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,241,214,0.22) 50%, rgba(255,255,255,0) 100%)",
        }}
      />
      {/* Inner hairline frame. */}
      <span
        aria-hidden
        className={`pointer-events-none absolute ${lg ? "inset-[10px] rounded-[15px]" : "inset-[7px] rounded-[11px]"}`}
        style={{ border: `1px solid ${t.rule}` }}
      />

      <div className={`relative flex h-full flex-col justify-between ${lg ? "p-[7%]" : "p-[7.5%]"}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="leading-none">
            <span
              className={`block font-script ${tone === "champagne" ? "text-gold-grad" : "text-gold-grad-light"} text-[11cqw]`}
              style={{ lineHeight: 0.8 }}
            >
              Golden
            </span>
            <span
              className={`mt-1 block font-sans font-semibold uppercase text-[clamp(6.5px,1.75cqw,9px)] tracking-[0.42em]`}
              style={{ color: t.sub }}
            >
              Beauty Studio
            </span>
          </div>
          <span
            className={`text-right font-sans font-semibold uppercase text-[clamp(7px,1.9cqw,10px)] tracking-[0.3em]`}
            style={{ color: t.sub }}
          >
            {label}
            {tierName ? (
              <span className={`mt-1 block font-display normal-case italic tracking-normal text-[clamp(13px,3.6cqw,19px)]`} style={{ color: t.text }}>
                {tierName}
              </span>
            ) : null}
          </span>
        </div>

        <div>
          <p
            className={`m-0 font-display leading-none tabular-nums ${t.amount} text-[12.5cqw]`}
            style={{ letterSpacing: "-0.02em" }}
          >
            {amount}
          </p>
          <div
            className={`mt-[5%] flex items-end justify-between gap-3 border-t pt-[3.5%] font-sans text-[clamp(9px,2.4cqw,12px)]`}
            style={{ borderColor: t.rule }}
          >
            {toLabel ? (
              <span className="min-w-0 truncate" style={{ color: t.sub }}>
                {toLabel}{" "}
                <span className="font-display text-[1.35em] italic" style={{ color: t.text }}>
                  {toName}
                </span>
              </span>
            ) : (
              <span />
            )}
            <span className="shrink-0 tabular-nums tracking-[0.18em]" style={{ color: t.sub }}>
              {code ?? "TR-····-····"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
