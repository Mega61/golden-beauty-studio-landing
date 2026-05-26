import { siteConfig } from "@/config/site";
import TrackedBookingLink from "./TrackedBookingLink";

type ContactoDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  address: {
    label: string;
    line1: string;
    line2: string;
    line3: string;
  };
  hours: {
    label: string;
    rows: string[][];
    closed: string;
  };
  ctaBook: string;
  ctaWhatsapp: string;
  socials: string[];
  map: {
    park: string;
    pin: string;
    openIn: string;
    coords: string;
  };
};

export default function Contacto({ dict }: { dict: ContactoDict }) {
  const {
    bookingUrl,
    whatsappUrl,
    mapsEmbedUrl,
    mapsPlaceId,
    instagramUrl,
    tiktokUrl,
  } = siteConfig;
  const addressQuery = encodeURIComponent(
    [dict.address.line1, dict.address.line2].join(", ")
  );
  const mapsHref = mapsPlaceId
    ? `https://www.google.com/maps/search/?api=1&query=${addressQuery}&query_place_id=${mapsPlaceId}`
    : `https://www.google.com/maps/search/?api=1&query=${addressQuery}`;

  const socialUrls: Record<string, string | null> = {
    instagram: instagramUrl,
    tiktok: tiktokUrl,
    google: mapsHref,
  };

  return (
    <section
      id="contacto"
      className="relative overflow-hidden bg-carbon pb-14 pt-16 text-cream md:pb-24 md:pt-[120px]"
    >
      <div className="relative mx-auto max-w-[1280px] px-5 md:px-14">
        <div className="mb-4 flex items-center gap-3 md:mb-6">
          <span aria-hidden className="block h-px w-7 bg-gold-bright" />
          <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.32em] text-gold-bright">
            {dict.eyebrow}
          </span>
        </div>

        <div className="grid grid-cols-1 items-stretch gap-8 md:grid-cols-[1fr_1.2fr] md:gap-16">
          <div>
            <h2
              className="m-0 mb-6 font-display text-[38px] font-normal leading-[1.05] md:text-[56px]"
              style={{ letterSpacing: "-0.015em" }}
            >
              {dict.title1}
              <br />
              <em className="text-gold-grad-light not-italic">
                <span className="italic">{dict.title2_em}</span>
              </em>
            </h2>

            <div className="mb-6 md:mb-8">
              <div className="mb-2 font-sans text-[10px] font-semibold uppercase tracking-[0.28em] text-gold-bright">
                {dict.address.label}
              </div>
              <div className="mb-1 font-display text-[19px] leading-[1.4] text-cream md:text-[22px]">
                {dict.address.line1}
              </div>
              <div
                className="font-sans text-[13px] leading-[1.5]"
                style={{ color: "rgba(243,236,223,0.65)" }}
              >
                {dict.address.line2}
                <br />
                {dict.address.line3}
              </div>
            </div>

            <div className="mb-6 md:mb-8">
              <div className="mb-3 font-sans text-[10px] font-semibold uppercase tracking-[0.28em] text-gold-bright">
                {dict.hours.label}
              </div>
              <ul className="m-0 list-none p-0">
                {dict.hours.rows.map((pair, i) => {
                  const [d, h] = pair;
                  return (
                  <li
                    key={i}
                    className="flex justify-between font-sans text-[13px]"
                    style={{
                      padding: "10px 0",
                      borderBottom: "1px solid rgba(243,236,223,0.12)",
                    }}
                  >
                    <span
                      className="font-medium uppercase tracking-[0.22em]"
                      style={{ color: "rgba(243,236,223,0.7)" }}
                    >
                      {d}
                    </span>
                    <span
                      className="font-display text-[16px] italic"
                      style={{
                        color:
                          h === dict.hours.closed
                            ? "rgba(243,236,223,0.4)"
                            : "var(--color-gold-soft)",
                      }}
                    >
                      {h}
                    </span>
                  </li>
                  );
                })}
              </ul>
            </div>

            {(bookingUrl || whatsappUrl) && (
              <div className="mt-3 grid grid-cols-1 gap-2.5 md:grid-cols-2">
                {bookingUrl && (
                  <TrackedBookingLink
                    href={bookingUrl}
                    location="contacto"
                    className="bg-gold-grad-dark px-4 py-4 text-center font-sans text-[11px] font-semibold uppercase tracking-[0.28em] text-white no-underline md:px-5 md:py-[18px]"
                  >
                    {dict.ctaBook}
                  </TrackedBookingLink>
                )}
                {whatsappUrl && (
                  <a
                    href={whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="bg-transparent px-4 py-4 text-center font-sans text-[11px] font-semibold uppercase tracking-[0.28em] text-cream no-underline md:px-5 md:py-[18px]"
                    style={{ border: "1px solid rgba(243,236,223,0.3)" }}
                  >
                    {dict.ctaWhatsapp}
                  </a>
                )}
              </div>
            )}

            <div
              className="mt-5 flex gap-5 pt-5 md:mt-7"
              style={{ borderTop: "1px solid rgba(243,236,223,0.12)" }}
            >
              {dict.socials.map((s) => {
                const href = socialUrls[s.toLowerCase()] ?? null;
                if (!href) return null;
                return (
                  <a
                    key={s}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-sans text-[10px] font-medium uppercase tracking-[0.28em] no-underline"
                    style={{ color: "rgba(243,236,223,0.6)" }}
                  >
                    {s} ↗
                  </a>
                );
              })}
            </div>
          </div>

          {/* Map — real Google Maps iframe when configured, otherwise stylized SVG */}
          <div
            className="relative overflow-hidden"
            style={{
              minHeight: 280,
              background: "#15110e",
              border: "1px solid rgba(243,236,223,0.1)",
            }}
          >
            {mapsEmbedUrl ? (
              <iframe
                src={mapsEmbedUrl}
                title="Golden Beauty Studio location"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                className="absolute inset-0 h-full w-full"
                style={{
                  border: 0,
                  filter: "grayscale(0.2) brightness(0.85)",
                }}
                allowFullScreen
              />
            ) : (
              <svg
                viewBox="0 0 600 600"
                preserveAspectRatio="xMidYMid slice"
                className="absolute inset-0 h-full w-full"
                style={{ opacity: 0.55 }}
              >
              <defs>
                <pattern
                  id="gbs-grid"
                  width="48"
                  height="48"
                  patternUnits="userSpaceOnUse"
                >
                  <path
                    d="M 48 0 L 0 0 0 48"
                    fill="none"
                    stroke="rgba(243,236,223,0.06)"
                    strokeWidth="1"
                  />
                </pattern>
              </defs>
              <rect width="600" height="600" fill="url(#gbs-grid)" />
              <path
                d="M -20 180 Q 180 200 320 240 T 640 320"
                stroke="rgba(243,236,223,0.15)"
                strokeWidth="22"
                fill="none"
              />
              <path
                d="M -20 180 Q 180 200 320 240 T 640 320"
                stroke="rgba(243,236,223,0.35)"
                strokeWidth="1"
                fill="none"
              />
              <path
                d="M 80 -20 Q 120 200 200 320 T 280 640"
                stroke="rgba(243,236,223,0.12)"
                strokeWidth="14"
                fill="none"
              />
              <path
                d="M 80 -20 Q 120 200 200 320 T 280 640"
                stroke="rgba(243,236,223,0.3)"
                strokeWidth="1"
                fill="none"
              />
              <path
                d="M 420 -20 L 440 640"
                stroke="rgba(243,236,223,0.1)"
                strokeWidth="10"
                fill="none"
              />
              <path
                d="M 420 -20 L 440 640"
                stroke="rgba(243,236,223,0.28)"
                strokeWidth="1"
                fill="none"
              />
              <path
                d="M -20 460 Q 200 440 400 470 T 640 480"
                stroke="rgba(243,236,223,0.1)"
                strokeWidth="10"
                fill="none"
              />
              <path
                d="M -20 460 Q 200 440 400 470 T 640 480"
                stroke="rgba(243,236,223,0.28)"
                strokeWidth="1"
                fill="none"
              />
              <rect
                x="240"
                y="260"
                width="120"
                height="100"
                fill="rgba(172,130,49,0.08)"
                stroke="rgba(231,170,81,0.25)"
                strokeWidth="1"
              />
              <text
                x="300"
                y="318"
                textAnchor="middle"
                fontFamily="Cormorant Garamond, serif"
                fontSize="13"
                fontStyle="italic"
                fill="rgba(243,236,223,0.4)"
              >
                {dict.map.park}
              </text>
              </svg>
            )}

            {/* "Golden · aquí" pin is decorative for the SVG mockup only —
                the real Maps iframe provides its own marker, so we hide it. */}
            {!mapsEmbedUrl && (
              <div
                className="absolute flex flex-col items-center gap-1.5"
                style={{
                  left: "52%",
                  top: "38%",
                  transform: "translate(-50%, -100%)",
                }}
              >
                <div
                  className="bg-gold-grad whitespace-nowrap px-3.5 py-2 font-sans text-[9px] font-bold uppercase tracking-[0.28em] text-carbon"
                  style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}
                >
                  {dict.map.pin}
                </div>
                <div
                  className="h-3.5 w-3.5 rounded-full bg-gold-bright"
                  style={{
                    boxShadow:
                      "0 0 0 4px rgba(231,170,81,0.25), 0 0 0 10px rgba(231,170,81,0.12)",
                  }}
                />
              </div>
            )}

            <a
              href={mapsHref}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute bottom-4 left-4 z-10 flex items-center gap-2 px-3 py-2 no-underline backdrop-blur-md"
              style={{
                background: "rgba(20,16,14,0.7)",
                border: "1px solid rgba(243,236,223,0.12)",
              }}
            >
              <span className="font-display text-[13px] italic text-gold-soft">
                {dict.map.openIn}
              </span>
              <span className="text-gold-bright">↗</span>
            </a>

            <div
              className="absolute right-4 top-4 font-sans text-[9px] uppercase tracking-[0.3em]"
              style={{ color: "rgba(243,236,223,0.4)" }}
            >
              {dict.map.coords}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
