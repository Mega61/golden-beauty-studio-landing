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

export type PromoItem = {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  cta_label: string;
  cta_href: string;
  ribbon?: string;
  image_url?: string;
  accent: PromoItemAccent;
  badge_day?: string;
  badge_month?: string;
  featured: boolean;
  starts_at?: string;
  ends_at?: string;
  // When present, the CTA opens an inline dialog with these clauses instead of
  // navigating away. Each entry is one numbered clause.
  terms?: string[];
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
