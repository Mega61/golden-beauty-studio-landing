// GENERADO POR `npm run build-combo-map` EN LA LANDING. No editar a mano:
// el siguiente `npm run dev` o `npm run build` de la landing lo reescribe, y
// CI falla si quedó desactualizado respecto de `src/data/pricing.ts`.
//
// ## Por qué este archivo existe
//
// La composición de un combo —qué servicio de manos y qué servicio de pies
// reemplaza— la declara la vitrina, que vive en la landing. Pero la imagen del
// panel se construye con contexto `admin/` y no contiene la landing: leer aquel
// archivo en caliente obligaba a montarlo en el contenedor, y una función que
// depende de que alguien se acuerde de montar un archivo es una función que en
// el estudio no existe.
//
// Así que la composición se copia acá, en tiempo de autoría, y viaja dentro de
// la imagen. Lo único que queda por resolver en caliente es la traducción de
// estos ids de vitrina a los numéricos de Easy!Appointments, y eso sale de
// `service_map`, que está en la base del propio panel.
//
// ## Lo que acá NO hay
//
// Aritmética. Los precios de las dos mitades vienen crudos: el reparto de
// comisión (`handsShareBp`) lo calcula `lib/combo-source.ts`, en TypeScript,
// donde está testeado. Un número calculado por el generador sería un número que
// ningún test mira.
//
// Y el **precio del combo no es la suma de sus mitades**: es criterio de la
// dueña y suele ser menor (ver `db/migrations/010-combo.ts`). Las dos cifras
// viajan juntas justamente para poder mostrar la suma tachada al lado del
// precio real.

/** Un combo y las dos mitades que reemplaza, en ids de `src/data/pricing.ts`. */
export type ComboCompositionEntry = {
  pricingId: string;
  hands: string;
  feet: string;
  /** Lo que cuesta el combo. **No** es `handsPriceCOP + feetPriceCOP`. */
  priceCOP: number;
  /** Lo que dura el combo. Tampoco es la suma. */
  durationMin: number;
  /** Precio de lista de la mitad de manos. Solo para tachar y para el reparto. */
  handsPriceCOP: number;
  /** Precio de lista de la mitad de pies. Igual. */
  feetPriceCOP: number;
};

export const COMBO_COMPOSITION: readonly ComboCompositionEntry[] = [
  {
    pricingId: "polygel-overlay-hands-semi-feet",
    hands: "polygel-overlay",
    feet: "semi-permanent-feet",
    priceCOP: 140000,
    durationMin: 150,
    handsPriceCOP: 95000,
    feetPriceCOP: 55000,
  },
  {
    pricingId: "builder-gel-overlay-hands-semi-feet",
    hands: "builder-gel-overlay",
    feet: "semi-permanent-feet",
    priceCOP: 140000,
    durationMin: 150,
    handsPriceCOP: 90000,
    feetPriceCOP: 55000,
  },
  {
    pricingId: "acrylic-overlay-hands-semi-feet",
    hands: "acrylic-overlay",
    feet: "semi-permanent-feet",
    priceCOP: 135000,
    durationMin: 150,
    handsPriceCOP: 85000,
    feetPriceCOP: 55000,
  },
  {
    pricingId: "semi-permanent-hands-feet",
    hands: "semi-permanent-hands",
    feet: "semi-permanent-feet",
    priceCOP: 100000,
    durationMin: 120,
    handsPriceCOP: 50000,
    feetPriceCOP: 55000,
  },
  {
    pricingId: "semi-permanent-hands-traditional-feet",
    hands: "semi-permanent-hands",
    feet: "traditional-feet",
    priceCOP: 85000,
    durationMin: 120,
    handsPriceCOP: 50000,
    feetPriceCOP: 35000,
  },
  {
    pricingId: "rubber-base-leveling-hands-semi-feet",
    hands: "rubber-base-leveling",
    feet: "semi-permanent-feet",
    priceCOP: 120000,
    durationMin: 165,
    handsPriceCOP: 70000,
    feetPriceCOP: 55000,
  },
  {
    pricingId: "rubber-base-leveling-hands-traditional-feet",
    hands: "rubber-base-leveling",
    feet: "traditional-feet",
    priceCOP: 100000,
    durationMin: 150,
    handsPriceCOP: 70000,
    feetPriceCOP: 35000,
  },
  {
    pricingId: "press-on-hands-semi-feet",
    hands: "press-on",
    feet: "semi-permanent-feet",
    priceCOP: 150000,
    durationMin: 180,
    handsPriceCOP: 100000,
    feetPriceCOP: 55000,
  },
  {
    pricingId: "press-on-hands-traditional-feet",
    hands: "press-on",
    feet: "traditional-feet",
    priceCOP: 135000,
    durationMin: 165,
    handsPriceCOP: 100000,
    feetPriceCOP: 35000,
  },
  {
    pricingId: "dipping-hands-semi-feet",
    hands: "dipping",
    feet: "semi-permanent-feet",
    priceCOP: 130000,
    durationMin: 165,
    handsPriceCOP: 80000,
    feetPriceCOP: 55000,
  },
  {
    pricingId: "dipping-hands-traditional-feet",
    hands: "dipping",
    feet: "traditional-feet",
    priceCOP: 105000,
    durationMin: 150,
    handsPriceCOP: 80000,
    feetPriceCOP: 35000,
  },
  {
    pricingId: "builder-gel-dual-hands-semi-feet",
    hands: "builder-gel-dual",
    feet: "semi-permanent-feet",
    priceCOP: 150000,
    durationMin: 225,
    handsPriceCOP: 105000,
    feetPriceCOP: 55000,
  },
  {
    pricingId: "builder-gel-overlay-hands-traditional-feet",
    hands: "builder-gel-overlay",
    feet: "traditional-feet",
    priceCOP: 120000,
    durationMin: 150,
    handsPriceCOP: 90000,
    feetPriceCOP: 35000,
  },
  {
    pricingId: "polygel-sculpted-hands-feet-cleanup",
    hands: "polygel-sculpted",
    feet: "feet-cleanup-only",
    priceCOP: 135000,
    durationMin: 195,
    handsPriceCOP: 120000,
    feetPriceCOP: 25000,
  },
  {
    pricingId: "traditional-hands-feet",
    hands: "traditional-hands",
    feet: "traditional-feet",
    priceCOP: 65000,
    durationMin: 120,
    handsPriceCOP: 30000,
    feetPriceCOP: 35000,
  },
  {
    pricingId: "hands-cleanup-semi-feet",
    hands: "hands-cleanup-only",
    feet: "semi-permanent-feet",
    priceCOP: 75000,
    durationMin: 105,
    handsPriceCOP: 20000,
    feetPriceCOP: 55000,
  },
  {
    pricingId: "hands-feet-cleanup",
    hands: "hands-cleanup-only",
    feet: "feet-cleanup-only",
    priceCOP: 45000,
    durationMin: 75,
    handsPriceCOP: 20000,
    feetPriceCOP: 25000,
  },
];
