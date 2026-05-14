// Hand-edited category metadata. The slugs match folder names under
// `public/lookbook/<category>/` and the auto-generated `LookbookCategory`
// union in `lookbook-manifest.ts`. To add a new category:
//   1. Create the folder under public/lookbook/
//   2. Add an entry below + include it in CATEGORY_ORDER
//   3. The manifest script regenerates the type on next predev/prebuild.

import type { LookbookCategory } from "./lookbook-manifest";

export const CATEGORY_LABELS: Record<
  LookbookCategory,
  { es: string; en: string }
> = {
  acrilico: { es: "Acrílico", en: "Acrylic" },
  polygel: { es: "Polygel", en: "Polygel" },
  "builder-gel": { es: "Builder gel", en: "Builder gel" },
  dipping: { es: "Dipping", en: "Dipping" },
  semipermanente: { es: "Semi", en: "Semi" },
  "press-on": { es: "Press On", en: "Press On" },
};

// Display order of filter buttons after the implicit "Todos" / "All" pill.
export const CATEGORY_ORDER: LookbookCategory[] = [
  "acrilico",
  "polygel",
  "builder-gel",
  "dipping",
  "semipermanente",
  "press-on",
];
