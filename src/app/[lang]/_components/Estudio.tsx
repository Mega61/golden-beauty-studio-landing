import EstudioGallery from "./EstudioGallery";
import type { PhotoLightboxDict } from "./PhotoLightbox";

type Stat = { n: string; l: string; s: string };
type EstudioDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  leadItalic: string;
  body1: string;
  body2: string;
  spaceAlts: string[];
  lightbox: PhotoLightboxDict;
  stats: Stat[];
  hygiene: {
    eyebrow: string;
    title1: string;
    title2_em: string;
    intro: string;
    items: string[][];
  };
};

export default function Estudio({ dict }: { dict: EstudioDict }) {
  return (
    <section
      id="estudio"
      className="relative overflow-hidden bg-ivory pb-14 pt-18 md:pb-24 md:pt-[120px]"
    >
      <div className="relative z-[1] mx-auto max-w-[1280px] px-5 md:px-14">
        {/* Oversized "Golden" wordmark as ghosted editorial backdrop.
            Anchored INSIDE the centered content box so it scales with the
            content grid instead of drifting with the viewport. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logos/LogoText.svg"
          alt=""
          aria-hidden
          decoding="async"
          loading="lazy"
          className="pointer-events-none absolute hidden select-none md:block"
          style={{
            right: "-80px",
            top: "40px",
            width: "min(560px, 60%)",
            opacity: 0.14,
            transform: "rotate(-4deg)",
            zIndex: 0,
          }}
        />
        <div className="mb-4 flex items-center gap-3 md:mb-6">
          <span aria-hidden className="block h-px w-7 bg-gold" />
          <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold">
            {dict.eyebrow}
          </span>
        </div>

        <div className="mb-10 grid grid-cols-1 items-start gap-7 md:mb-18 md:grid-cols-[1.2fr_1fr] md:gap-20">
          <h2
            className="m-0 font-display text-[38px] font-normal leading-[1.05] text-ink md:text-[64px]"
            style={{ letterSpacing: "-0.015em" }}
          >
            {dict.title1}
            <br />
            <em className="text-gold-grad not-italic">
              <span className="italic">{dict.title2_em}</span>
            </em>
          </h2>

          <div className="flex flex-col gap-[18px] md:pt-3">
            <p className="m-0 font-display text-[17px] italic leading-[1.55] text-ink md:text-[19px]">
              {dict.leadItalic}
            </p>
            <p className="m-0 max-w-[440px] font-sans text-[14px] leading-[1.7] text-ink-soft md:text-[14.5px]">
              {dict.body1}
            </p>
            <p className="m-0 max-w-[440px] font-sans text-[14px] leading-[1.7] text-ink-soft md:text-[14.5px]">
              {dict.body2}
            </p>
          </div>
        </div>

        <EstudioGallery
          photos={[
            { src: "/space-01.jpg", alt: dict.spaceAlts[0] ?? "" },
            { src: "/space-02.jpg", alt: dict.spaceAlts[1] ?? "" },
            { src: "/space-03.jpg", alt: dict.spaceAlts[2] ?? "" },
          ]}
          dict={dict.lightbox}
        />

        <div
          className="grid grid-cols-2 md:grid-cols-4"
          style={{
            borderTop: "1px solid var(--hair)",
            borderBottom: "1px solid var(--hair)",
          }}
        >
          {dict.stats.map((x, i) => (
            <div
              key={i}
              className="p-6 md:p-8"
              style={{
                borderRight:
                  i < dict.stats.length - 1
                    ? "1px solid var(--hair)"
                    : undefined,
                borderBottom:
                  i < 2 ? "1px solid var(--hair)" : undefined,
              }}
            >
              <div
                className="mb-2 font-display text-[36px] font-normal italic leading-none text-gold md:text-[52px]"
                style={{ letterSpacing: "-0.02em" }}
              >
                {x.n}
              </div>
              <div className="mb-1 font-sans text-[10px] font-semibold uppercase tracking-[0.28em] text-ink">
                {x.l}
              </div>
              <div className="font-display text-[13px] italic leading-[1.4] text-ink-mute">
                {x.s}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-12 grid grid-cols-1 items-start gap-6 md:mt-18 md:grid-cols-[0.8fr_1.2fr] md:gap-14">
          <div>
            <div className="mb-3 font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold">
              {dict.hygiene.eyebrow}
            </div>
            <h3
              className="m-0 font-display text-[26px] font-normal leading-[1.15] text-ink md:text-[34px]"
              style={{ letterSpacing: "-0.01em" }}
            >
              {dict.hygiene.title1}
              <br />
              <em className="italic text-gold">{dict.hygiene.title2_em}</em>
            </h3>
            <p className="mt-4 max-w-[320px] font-sans text-[13px] leading-[1.6] text-ink-soft">
              {dict.hygiene.intro}
            </p>
          </div>
          <ul className="m-0 grid list-none grid-cols-1 p-0 md:grid-cols-2">
            {dict.hygiene.items.map((pair, i) => {
              const [t, d] = pair;
              return (
              <li
                key={i}
                className="flex gap-3.5 py-3.5"
                style={{ borderBottom: "1px solid var(--hair)" }}
              >
                <span
                  className="min-w-[24px] pt-0.5 font-display text-[22px] italic leading-none text-gold"
                  aria-hidden
                >
                  ·
                </span>
                <div>
                  <div className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-[0.22em] text-ink">
                    {t}
                  </div>
                  <div className="font-display text-[14px] italic leading-[1.4] text-ink-soft">
                    {d}
                  </div>
                </div>
              </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
