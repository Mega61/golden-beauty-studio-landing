// Single source of truth for service prices and durations.
// Edit a number here, push, and Vercel redeploys with both languages updated.
// Translated names/descriptions live in src/app/[lang]/dictionaries/{es,en}.json,
// keyed by the same ids declared below.

export type PriceItem = {
  id: string;
  priceCOP: number;
  fromPrice?: boolean;
  durationMin: number | null;
};

export type PriceCategory = {
  id: string;
  items: PriceItem[];
};

export const pricing: readonly PriceCategory[] = [
  {
    id: "montajes",
    items: [
      { id: "polygel-sculpted", priceCOP: 120000, durationMin: 150 },
      { id: "acrylic-sculpted", priceCOP: 115000, durationMin: 150 },
      { id: "polygel-dual", priceCOP: 110000, durationMin: 150 },
      { id: "builder-gel-dual", priceCOP: 105000, durationMin: 150 },
      { id: "press-on", priceCOP: 100000, durationMin: 105 },
    ],
  },
  {
    id: "retoques",
    items: [
      { id: "polygel-refill", priceCOP: 90000, durationMin: 120 },
      { id: "builder-gel-refill", priceCOP: 85000, durationMin: 120 },
      { id: "acrylic-refill", priceCOP: 80000, durationMin: 120 },
    ],
  },
  {
    id: "forrados",
    items: [
      { id: "polygel-overlay", priceCOP: 95000, durationMin: 90 },
      { id: "builder-gel-overlay", priceCOP: 90000, durationMin: 90 },
      { id: "acrylic-overlay", priceCOP: 85000, durationMin: 90 },
      { id: "dipping", priceCOP: 80000, durationMin: 90 },
      { id: "rubber-base-leveling", priceCOP: 70000, durationMin: 90 },
    ],
  },
  {
    id: "sencillos",
    items: [
      { id: "semi-permanent-hands", priceCOP: 50000, durationMin: 60 },
      { id: "semi-permanent-feet", priceCOP: 55000, durationMin: 75 },
      { id: "hands-cleanup-only", priceCOP: 30000, durationMin: 30 },
      { id: "feet-cleanup-only", priceCOP: 35000, durationMin: 45 },
    ],
  },
  {
    id: "extras",
    items: [
      { id: "system-removal", priceCOP: 20000, durationMin: 30 },
      { id: "single-sculpted-nail", priceCOP: 10000, durationMin: 10 },
      { id: "design-per-nail", priceCOP: 10000, durationMin: null },
      { id: "in-depth-foot-cleaning", priceCOP: 15000, durationMin: 10 },
    ],
  },
] as const;
