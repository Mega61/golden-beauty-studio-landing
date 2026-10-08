// Shape mirrors the Strapi `promo-scenario` Collection Type and its
// `promo-strip` / `promo-item` Components. Keeping the names exact (snake_case
// where Strapi uses snake_case) means the future swap from mock → Strapi only
// touches `promos.ts` — components and call sites stay untouched.

export type PromoStripAccent = "gold" | "ink" | "ivory";
export type PromoItemAccent = "gold" | "mocha" | "ink";

export type PromoStrip = {
  tag: string;
  message: string;
  cta: string;
  href: string;
  until?: string;
  accent: PromoStripAccent;
};

// One line of a promo's price list. Strings arrive already formatted for the
// locale; `was` is the regular price, rendered struck through.
export type PromoPriceRow = {
  label: string;
  price: string;
  was?: string;
};

export type PromoItem = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  cta_label: string;
  cta_href: string;
  ribbon?: string;
  image_url?: string;
  // "portrait" = a 4:5 flyer with its text baked in. It must never be cropped
  // or washed over, so every surface shows it whole (beside the copy on the
  // landing, as a poster thumbnail on the bio). Default: "landscape" (16:9
  // editorial photo, used as a background).
  image_orientation?: "landscape" | "portrait";
  // Describes a flyer's baked-in text for screen readers. Without it the alt
  // falls back to the title, which drops the prices printed on the image.
  image_alt?: string;
  price_rows?: PromoPriceRow[];
  accent: PromoItemAccent;
  badge_day?: string;
  badge_month?: string;
  featured: boolean;
  starts_at?: string;
  ends_at?: string;
  // When present, the CTA opens an inline dialog with these clauses instead of
  // navigating away. Each entry is one numbered clause.
  terms?: string[];
  // With `terms`, the CTA normally becomes the terms button. Setting this keeps
  // `cta_label` → `cta_href` as the main link (book) and opens the terms from a
  // secondary button with this label instead.
  terms_label?: string;
};

export type PromoScenario = {
  slug: string;
  label: string;
  active: boolean;
  starts_at?: string;
  ends_at?: string;
  strip: PromoStrip | null;
  items: PromoItem[];
};

export type PromosBySlug = Record<string, PromoScenario>;
