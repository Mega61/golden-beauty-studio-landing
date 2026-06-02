// Shape mirrors the future Strapi Single Type `link-bio` and its repeatable
// components `bio-link` / `bio-social`. Keeping the field names exact means the
// swap from mock → Strapi only touches `bio.ts` (the `getBio` body) — the
// `Bio` component and its call site in `bio/page.tsx` stay untouched.

// One destination row. Exactly one link in the list carries `primary: true`;
// that one is promoted to the gold gradient CTA slot and excluded from the
// hairline rows.
export type BioLink = {
  key: string;
  label: string; // rendered in Cormorant (rows) / Inter caps (primary CTA)
  sub: string; // Inter caps sub-label
  href: string;
  primary?: boolean;
  external?: boolean; // open in a new tab with rel="noopener"
  image?: string; // square thumbnail shown at the left of the row
};

export type BioSocial = {
  key: string;
  short: string; // 2-letter initials shown in the chip — "IG" / "WA" / "TT"
  label: string; // accessible name — "Instagram"
  href: string;
};

// The pinned promo band. Derived from the same active scenario the landing
// uses (`getActiveScenario`); `null` when no promo is running.
export type BioPromo = {
  tag: string; // period descriptor — "Apertura · Junio 2026"
  title: string; // editorial headline — Cormorant italic
  href: string;
  image?: string; // featured image — the banner's photographic background
  cta: string; // gold caps call-to-action on the banner
};

export type BioData = {
  handle: string;
  tagline: string;
  location: string;
  avatar: string;
  links: BioLink[];
  socials: BioSocial[];
};

// Per-language copy only (no hrefs). `getBio` merges this with the env-derived
// destinations in `siteConfig`. Keys MUST match across `bio.es.ts` / `bio.en.ts`.
export type BioCopy = {
  handle: string;
  tagline: string;
  location: string;
  promoCta: string; // banner CTA label — "Ver la promoción"
  links: Record<
    "agendar" | "whatsapp" | "servicios" | "instagram" | "maps",
    { label: string; sub: string }
  >;
  socials: Record<"ig" | "wa" | "tt", string>;
};
