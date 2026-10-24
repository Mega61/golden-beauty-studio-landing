// GENERADO POR `npm run build-combo-map` EN LA LANDING. No editar a mano:
// sale de `src/data/pricing.ts` (los ids) y de
// `src/app/[lang]/dictionaries/es.json` (los nombres), y CI falla si quedó
// desactualizado.
//
// Son los nombres que ve la clienta: los mismos de la lista de precios de la
// landing. `scripts/catalogo.js` los usa para crear en Easy!Appointments los
// servicios que faltan; la imagen del panel no contiene la landing, así que
// leer el diccionario en caliente no es una opción.

/** El nombre en español de cada id de la vitrina. */
export const SERVICE_NAMES: Readonly<Record<string, string>> = {
  "polygel-sculpted": "Esculpidas en polygel",
  "acrylic-sculpted": "Esculpidas en acrílico",
  "polygel-dual": "Dual system polygel",
  "builder-gel-dual": "Dual system builder gel",
  "press-on": "Press on",
  "polygel-refill": "Retoque polygel",
  "builder-gel-refill": "Retoque builder gel",
  "acrylic-refill": "Retoque acrílico",
  "polygel-overlay": "Forrado en polygel",
  "builder-gel-overlay": "Forrado en builder gel",
  "acrylic-overlay": "Forrado en acrílico",
  "dipping": "Dipping",
  "rubber-base-leveling": "Nivelación base rubber",
  "semi-permanent-feet": "Semipermanente pies",
  "semi-permanent-no-color": "Semipermanente sin color",
  "semi-permanent-hands": "Semipermanente manos",
  "traditional-feet": "Tradicional pies",
  "traditional-hands": "Tradicional manos",
  "feet-cleanup-only": "Solo limpieza pies",
  "hands-cleanup-only": "Solo limpieza manos",
  "polygel-overlay-hands-semi-feet": "Forrado polygel manos + semi pies",
  "builder-gel-overlay-hands-semi-feet": "Forrado builder gel manos + semi pies",
  "acrylic-overlay-hands-semi-feet": "Forrado acrílico manos + semi pies",
  "semi-permanent-hands-feet": "Semipermanente manos + pies",
  "semi-permanent-hands-traditional-feet": "Semipermanente manos + tradicional pies",
  "rubber-base-leveling-hands-semi-feet": "Nivelación base rubber + semi pies",
  "rubber-base-leveling-hands-traditional-feet": "Nivelación base rubber + tradicional pies",
  "press-on-hands-semi-feet": "Press on + semi pies",
  "press-on-hands-traditional-feet": "Press on + tradicional pies",
  "dipping-hands-semi-feet": "Dipping + semi pies",
  "dipping-hands-traditional-feet": "Dipping + tradicional pies",
  "builder-gel-dual-hands-semi-feet": "Dual system builder gel + semi pies",
  "builder-gel-overlay-hands-traditional-feet": "Forrado builder gel manos + tradicional pies",
  "polygel-sculpted-hands-feet-cleanup": "Esculpidas polygel + limpieza pies",
  "traditional-hands-feet": "Tradicional manos + pies",
  "hands-cleanup-semi-feet": "Limpieza manos + semi pies",
  "hands-feet-cleanup": "Limpieza manos + pies",
  "system-removal": "Retiro de sistema previo",
  "single-dual-system-nail": "Uña dual system individual",
  "single-press-on-nail": "Press-on individual",
  "design-per-nail": "Diseño / decoración por uña",
  "in-depth-foot-cleaning": "Limpieza profunda de pies",
};

/** Las categorías de la vitrina, en su orden, con la etiqueta de la landing. */
export const SERVICE_CATEGORIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "montajes", label: "Montajes" },
  { id: "retoques", label: "Retoques" },
  { id: "forrados", label: "Forrados" },
  { id: "sencillos", label: "Sencillos" },
  { id: "combos", label: "Combos" },
  { id: "extras", label: "Extras" },
];
