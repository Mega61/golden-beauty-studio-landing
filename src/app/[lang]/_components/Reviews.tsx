import { EyebrowLabel } from "./atoms";
import type { Review, ReviewsData } from "@/data/reviews";

type ReviewsDict = {
  eyebrow: string;
  title1: string;
  title2_em: string;
  body: string;
  /** Template with {rating} and {count} placeholders. */
  ratingLabel: string;
  verifiedLabel: string;
  cta: string;
  ctaWrite: string;
};

// Official Google "G" mark — signals these are real, verified Google reviews
// rather than hand-picked testimonials. Inline SVG keeps it crisp and JS-free.
function GoogleG({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  );
}

function Stars({ rating, size = 14 }: { rating: number; size?: number }) {
  const full = Math.round(rating);
  return (
    <span
      aria-hidden
      className="inline-flex gap-[2px] text-gold"
      style={{ fontSize: size }}
    >
      {Array.from({ length: 5 }).map((_, i) => (
        <span key={i} className={i < full ? "opacity-100" : "opacity-25"}>
          ★
        </span>
      ))}
    </span>
  );
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={name}
        width={40}
        height={40}
        loading="lazy"
        decoding="async"
        // Google profile photos 403 when a referrer is sent; suppress it.
        referrerPolicy="no-referrer"
        className="h-10 w-10 shrink-0 rounded-full object-cover"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold-soft/25 font-display text-[17px] italic text-gold"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

// A single testimonial card. Square corners + 1px hairline only — matching the
// house rule that depth comes from hairlines, never radius or shadow.
function ReviewCard({
  review,
  verifiedLabel,
}: {
  review: Review;
  verifiedLabel: string;
}) {
  return (
    <figure className="flex h-full w-[290px] flex-col gap-4 border border-hair bg-cream/60 p-6 md:w-[360px] md:p-7">
      <div className="flex items-center justify-between">
        <Stars rating={review.rating} />
        <span className="inline-flex items-center gap-1.5 font-sans text-[9px] font-semibold uppercase tracking-[0.2em] text-ink-mute">
          <GoogleG size={13} />
          {verifiedLabel}
        </span>
      </div>

      {/* Oversized opening quote — quiet editorial flourish in brand gold. */}
      <span
        aria-hidden
        className="-mb-5 font-display text-[52px] italic leading-none text-gold/30"
      >
        “
      </span>

      <blockquote className="m-0 line-clamp-5 flex-1 font-display text-[15.5px] italic leading-[1.55] text-ink md:text-[16.5px]">
        {review.text}
      </blockquote>

      <figcaption className="mt-1 flex items-center gap-3 border-t border-hair pt-4">
        <Avatar src={review.photoUri} name={review.author} />
        <div className="min-w-0">
          <div className="truncate font-sans text-[12px] font-semibold uppercase tracking-[0.14em] text-ink">
            {review.author}
          </div>
          {review.relativeTime && (
            <div className="font-sans text-[11px] text-ink-mute">
              {review.relativeTime}
            </div>
          )}
        </div>
      </figcaption>
    </figure>
  );
}

export default function Reviews({
  dict,
  data,
}: {
  dict: ReviewsDict;
  data: ReviewsData;
}) {
  const { reviews, rating, count, googleUrl, writeReviewUrl } = data;
  // No verified reviews to show → render nothing (keeps the page honest).
  if (reviews.length === 0) return null;

  const ratingLine =
    rating != null
      ? dict.ratingLabel
          .replace("{rating}", rating.toFixed(1))
          .replace("{count}", String(count ?? reviews.length))
      : null;

  // One "half" of the marquee track must be at least as wide as the viewport, or
  // a gap opens at the end of each loop: the -50% reset jumps past the content
  // before the repeat scrolls into view. Cards are fixed-width (≈360px + 20px
  // margin on desktop), so we repeat the set enough times to overflow even
  // ultrawide screens — entirely at render time, no client JS.
  const CARD_PX = 380; // md card width + mr-5 gap
  const TARGET_HALF_PX = 3600; // covers large desktops and ultrawide displays
  const perHalf = Math.max(
    1,
    Math.ceil(TARGET_HALF_PX / (reviews.length * CARD_PX)),
  );
  // `halfReviews` is the set repeated `perHalf` times — one half of the track.
  const halfReviews = Array.from({ length: perHalf }, () => reviews).flat();

  // Distance scales with the half width, so scale the time too → constant speed.
  const marqueeDuration = `${Math.max(perHalf * reviews.length * 9, 28)}s`;

  // The track holds two identical halves; shifting by -50% lands the second half
  // exactly where the first began (seamless). The duplicate half is hidden from
  // assistive tech / crawlers so the text isn't counted twice.
  const renderHalf = (ariaHidden: boolean) =>
    halfReviews.map((review, i) => (
      <li
        key={`${ariaHidden ? "dup" : "live"}-${i}`}
        className="mr-5 shrink-0"
        aria-hidden={ariaHidden || undefined}
      >
        <ReviewCard review={review} verifiedLabel={dict.verifiedLabel} />
      </li>
    ));

  return (
    <section
      id="reviews"
      className="relative overflow-hidden bg-paper pb-16 pt-18 md:pb-24 md:pt-[120px]"
    >
      <div className="mb-10 px-5 text-center md:mb-14 md:px-14">
        <EyebrowLabel className="text-gold">{dict.eyebrow}</EyebrowLabel>
        <h2
          className="mx-auto mb-4 mt-3.5 max-w-[820px] font-display text-[36px] font-normal leading-[1.04] text-ink md:text-[60px]"
          style={{ letterSpacing: "-0.02em" }}
        >
          {dict.title1}{" "}
          <em className="text-gold-grad italic">{dict.title2_em}</em>
        </h2>
        <p className="mx-auto max-w-[540px] font-sans text-[14px] leading-[1.6] text-ink-soft md:text-base">
          {dict.body}
        </p>

        {/* Aggregate rating — the headline trust signal. */}
        {ratingLine && (
          <div className="mt-7 inline-flex items-center gap-4 border border-hair bg-cream/50 px-6 py-3.5">
            <span
              className="font-display text-[34px] font-normal italic leading-none text-gold"
              style={{ letterSpacing: "-0.02em" }}
            >
              {(rating ?? 5).toFixed(1)}
            </span>
            <span
              className="block h-9 w-px"
              style={{ background: "var(--hair)" }}
              aria-hidden
            />
            <span className="flex flex-col items-start gap-1">
              <Stars rating={rating ?? 5} size={15} />
              <span className="inline-flex items-center gap-1.5 font-sans text-[11px] tracking-[0.02em] text-ink-soft">
                <GoogleG size={13} />
                {ratingLine}
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Marquee — full-bleed rail with gradient edge fades. Scrolls
          continuously; falls back to manual horizontal scroll under
          reduced-motion. */}
      <div
        className="review-marquee-viewport relative w-full"
        role="region"
        aria-label={`${dict.title1} ${dict.title2_em}`.trim()}
        tabIndex={0}
        style={{
          WebkitMaskImage:
            "linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)",
          maskImage:
            "linear-gradient(90deg, transparent, #000 6%, #000 94%, transparent)",
        }}
      >
        <div
          className="review-marquee-track flex w-max"
          style={{ "--marquee-duration": marqueeDuration } as React.CSSProperties}
        >
          <ul className="m-0 flex list-none p-0">{renderHalf(false)}</ul>
          <ul className="m-0 flex list-none p-0" aria-hidden>
            {renderHalf(true)}
          </ul>
        </div>
      </div>

      {/* CTAs — grow the review count (primary) + browse them all (secondary). */}
      {(writeReviewUrl || googleUrl) && (
        <div className="mt-12 flex flex-col items-center justify-center gap-5 px-5 md:mt-14 md:flex-row md:gap-7">
          {writeReviewUrl && (
            <a
              href={writeReviewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2.5 bg-gold-grad px-7 py-3.5 font-sans text-[12px] font-semibold uppercase tracking-[0.24em] text-white no-underline md:px-8 md:py-[17px]"
            >
              <GoogleG size={16} />
              {dict.ctaWrite}
            </a>
          )}
          {googleUrl && (
            <a
              href={googleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2.5 font-sans text-[12px] font-semibold uppercase tracking-[0.24em] text-gold no-underline hover:opacity-80"
            >
              {dict.cta}
              <span className="font-serif text-base leading-none">→</span>
            </a>
          )}
        </div>
      )}
    </section>
  );
}
