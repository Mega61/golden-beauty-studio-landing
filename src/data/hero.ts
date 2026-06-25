import "server-only";

// The hero background ships bundled in /public so the page always renders, even
// with no CMS. When STRAPI_URL is set and the Hero single type has an image, we
// serve that instead. Hero text stays in the dictionaries — only the photo is
// CMS-driven.
const FALLBACK_HERO_SRC = "/hero.jpg";

type StrapiMedia = { url?: string; hash?: string } | null;
type StrapiHero = { image?: StrapiMedia } | null;

function toAbsolute(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${process.env.STRAPI_URL}${url}`;
}

/**
 * Resolves the hero background image URL. Reads the Strapi `hero` single type
 * when `STRAPI_URL` is set; falls back to the bundled `/hero.jpg` on any error,
 * empty result, or when the CMS is not configured — so the hero is never blank.
 */
export async function getHeroImage(): Promise<string> {
  const base = process.env.STRAPI_URL;
  if (!base) return FALLBACK_HERO_SRC;
  try {
    const url = `${base}/api/hero?populate[image][fields][0]=url`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return FALLBACK_HERO_SRC;
    const json = (await res.json()) as { data?: StrapiHero };
    const raw = json.data?.image?.url;
    return raw ? toAbsolute(raw) : FALLBACK_HERO_SRC;
  } catch {
    return FALLBACK_HERO_SRC;
  }
}
