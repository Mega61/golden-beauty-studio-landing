import "server-only";
import { siteConfig } from "@/config/site";
import type { Locale } from "@/app/[lang]/dictionaries";

// ─────────────────────────────────────────────────────────────────────────────
// Google reviews — fetched server-side via the Places API (New).
//
// WHY server-side: the call is made with a SERVER-ONLY key (GOOGLE_PLACES_API_KEY,
// no NEXT_PUBLIC_ prefix) so the key never ships to the browser. The result is
// rendered to static HTML at build / on revalidation, so visitors download zero
// extra JS and crawlers index the review text directly — that's the SEO win.
//
// IMPORTANT — this is the only key in the project that is NOT the Maps Embed key.
// The Embed key (NEXT_PUBLIC_GOOGLE_MAPS_API_KEY) is HTTP-referrer-restricted and
// scoped to "Maps Embed API" only, so it CANNOT make this server-to-server call.
// GOOGLE_PLACES_API_KEY must have "Places API (New)" enabled and should be
// IP-restricted (or at least API-restricted to Places API New), never referrer-
// restricted. See .env.local.example for setup.
//
// NOTE on SEO: we deliberately do NOT emit AggregateRating/Review JSON-LD for the
// business. Google treats reviews about your own business on your own site as
// "self-serving" — it has not shown those star snippets since 2019 and now flags
// the markup as a manual-action risk. These reviews live as visible on-page
// content (fresh, keyword-rich UGC) — that is the legitimate ranking signal.
// ─────────────────────────────────────────────────────────────────────────────

export type Review = {
  author: string;
  authorUri: string | null;
  photoUri: string | null;
  rating: number;
  text: string;
  relativeTime: string;
};

export type ReviewsData = {
  /** Aggregate star rating for the place, e.g. 4.9 (null if unavailable). */
  rating: number | null;
  /** Total number of ratings on Google (null if unavailable). */
  count: number | null;
  /** Curated reviews to display (Google returns at most 5). */
  reviews: Review[];
  /** Deep link to the full Google listing / reviews. */
  googleUrl: string | null;
  /** Deep link to Google's "write a review" dialog for this place. */
  writeReviewUrl: string | null;
};

// Only surface clearly positive reviews in the on-page strip. The full set
// (including any lower ratings) is always one click away via `googleUrl`.
const MIN_RATING = 4;

function googleListingUrl(placeId: string | null): string | null {
  return placeId
    ? `https://search.google.com/local/reviews?placeid=${placeId}`
    : null;
}

function writeReviewUrl(placeId: string | null): string | null {
  return placeId
    ? `https://search.google.com/local/writereview?placeid=${placeId}`
    : null;
}

function normalizeReview(r: unknown): Review | null {
  if (typeof r !== "object" || r === null) return null;
  const rev = r as Record<string, unknown>;
  const textNode = (rev.text ?? rev.originalText) as
    | { text?: string }
    | undefined;
  const text = textNode?.text?.trim() ?? "";
  const attr = rev.authorAttribution as
    | { displayName?: string; uri?: string; photoUri?: string }
    | undefined;
  const author = attr?.displayName?.trim() ?? "";
  const rating = typeof rev.rating === "number" ? rev.rating : 0;
  // A review with no body or no author isn't usable social proof.
  if (!text || !author) return null;
  return {
    author,
    authorUri: attr?.uri ?? null,
    photoUri: attr?.photoUri ?? null,
    rating,
    text,
    relativeTime:
      typeof rev.relativePublishTimeDescription === "string"
        ? rev.relativePublishTimeDescription
        : "",
  };
}

/**
 * Resolves Google reviews for the given locale. Returns empty data (so the
 * section self-hides) when the key/place id are missing or the request fails —
 * the landing must never break because Google is unreachable.
 *
 * `languageCode` asks Google to return translated review text matching the UI
 * language; `regionCode` biases formatting to Colombia.
 *
 * Declared `async` and cached for a day: the Places Details call that includes
 * `reviews` is billed per request, and reviews change slowly, so once per
 * revalidation window is plenty.
 */
export async function getReviews(lang: Locale): Promise<ReviewsData> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();
  const placeId = siteConfig.mapsPlaceId;
  const googleUrl = googleListingUrl(placeId);
  const writeUrl = writeReviewUrl(placeId);
  const empty: ReviewsData = {
    rating: null,
    count: null,
    reviews: [],
    googleUrl,
    writeReviewUrl: writeUrl,
  };

  if (!apiKey || !placeId) return empty;

  const languageCode = lang === "es" ? "es" : "en";
  const url =
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}` +
    `?languageCode=${languageCode}&regionCode=CO`;

  try {
    const res = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "rating,userRatingCount,googleMapsUri,reviews",
      },
      // Revalidate daily — reviews change slowly and each call is billed.
      next: { revalidate: 86400 },
    });
    if (!res.ok) return empty;

    const data = (await res.json()) as {
      rating?: number;
      userRatingCount?: number;
      googleMapsUri?: string;
      reviews?: unknown[];
    };

    const reviews = (data.reviews ?? [])
      .map(normalizeReview)
      .filter((r): r is Review => r !== null && r.rating >= MIN_RATING);

    return {
      rating: typeof data.rating === "number" ? data.rating : null,
      count:
        typeof data.userRatingCount === "number" ? data.userRatingCount : null,
      reviews,
      googleUrl: data.googleMapsUri ?? googleUrl,
      writeReviewUrl: writeUrl,
    };
  } catch {
    return empty;
  }
}
