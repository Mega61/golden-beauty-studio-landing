import "server-only";
import { LOOKBOOK } from "./lookbook-manifest";
import type { LookbookCategory, LookbookItem } from "./lookbook-manifest";
import { CATEGORY_ORDER } from "./lookbook-categories";

// Slugs the landing knows how to render. A Strapi item whose category slug is
// not in this set is skipped (the grid only has labels/filters for these six).
const KNOWN = new Set<string>(CATEGORY_ORDER);

type StrapiLookbookItem = {
  id: number;
  documentId?: string;
  caption?: string;
  order?: number;
  photo?: { url?: string; hash?: string } | null;
  category?: { slug?: string } | null;
};

function toAbsolute(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${process.env.STRAPI_URL}${url}`;
}

function normalize(data: StrapiLookbookItem[]): LookbookItem[] {
  const out: LookbookItem[] = [];
  for (const d of data ?? []) {
    const slug = d.category?.slug;
    const rawUrl = d.photo?.url;
    if (!slug || !KNOWN.has(slug) || !rawUrl) continue;
    out.push({
      category: slug as LookbookCategory,
      src: toAbsolute(rawUrl),
      basename: d.photo?.hash ?? String(d.documentId ?? d.id),
      caption: d.caption ?? "",
    });
  }
  return out;
}

/**
 * Resolves the lookbook photos. Reads the Strapi `lookbook-item` collection
 * when `STRAPI_URL` is set; otherwise (and on any error or empty result) falls
 * back to the bundled `LOOKBOOK` manifest so the section never goes blank.
 *
 * The category taxonomy + labels stay in code (`lookbook-categories.ts`) — only
 * the photos are CMS-driven. Strapi v5 returns a flat response shape, so fields
 * (`caption`, `photo`, `category`) sit directly on each entry.
 *
 * `async` + Strapi-shaped so the call site in `Lookbook.tsx` just awaits it.
 */
export async function getLookbook(): Promise<readonly LookbookItem[]> {
  const base = process.env.STRAPI_URL;
  if (!base) return LOOKBOOK;
  try {
    const url =
      `${base}/api/lookbook-items` +
      `?populate[photo][fields][0]=url&populate[photo][fields][1]=hash` +
      `&populate[category][fields][0]=slug` +
      `&sort[0]=order:asc&sort[1]=createdAt:asc` +
      `&pagination[pageSize]=200`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) return LOOKBOOK;
    const json = (await res.json()) as { data?: StrapiLookbookItem[] };
    const items = normalize(json.data ?? []);
    return items.length > 0 ? items : LOOKBOOK;
  } catch {
    return LOOKBOOK;
  }
}
