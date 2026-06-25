import "server-only";

// Studio-space photos for the "05 — El estudio" gallery. Bundled in /public so
// the section always renders; when STRAPI_URL is set and the `studio-photo`
// collection has entries, those replace the bundled set. Alt text falls back to
// the dictionary's spaceAlts (by position) when an entry has no `alt`.
export type StudioPhoto = { src: string; alt?: string };

const FALLBACK: StudioPhoto[] = [
  { src: "/space-01.jpg" },
  { src: "/space-02.jpg" },
  { src: "/space-03.jpg" },
];

type StrapiStudioPhoto = {
  id: number;
  documentId?: string;
  alt?: string | null;
  order?: number;
  photo?: { url?: string; hash?: string } | null;
};

function toAbsolute(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${process.env.STRAPI_URL}${url}`;
}

/**
 * Resolves the studio photos. Reads the Strapi `studio-photo` collection when
 * `STRAPI_URL` is set (ordered by `order`); falls back to the three bundled
 * `/space-0x.jpg` files on any error, empty result, or when the CMS is not
 * configured — so the gallery never goes blank.
 */
export async function getStudioPhotos(): Promise<StudioPhoto[]> {
  const base = process.env.STRAPI_URL;
  if (!base) return FALLBACK;
  try {
    const url =
      `${base}/api/studio-photos` +
      `?populate[photo][fields][0]=url` +
      `&sort[0]=order:asc&sort[1]=createdAt:asc` +
      `&pagination[pageSize]=50`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return FALLBACK;
    const json = (await res.json()) as { data?: StrapiStudioPhoto[] };
    const items: StudioPhoto[] = [];
    for (const d of json.data ?? []) {
      const raw = d.photo?.url;
      if (!raw) continue;
      items.push({ src: toAbsolute(raw), alt: d.alt ?? undefined });
    }
    return items.length > 0 ? items : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
