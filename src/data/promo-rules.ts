// Las reglas de las promos del estudio — la única fuente de verdad.
//
// Este archivo **no importa nada** a propósito: `scripts/build-combo-map.mjs`
// lo copia tal cual a `admin/src/data/promo-rules.ts`, porque la imagen del
// panel no contiene la landing. La landing lo usa para pintar los afiches
// (`promo-prices.ts`); el panel, para aplicar el descuento solo al reservar y
// al cerrar la cuenta (`admin/src/lib/promos.ts`).
//
// - `weekday`: día de la cita en que aplica, 0 = domingo … 6 = sábado.
// - `regularId`: id de `src/data/pricing.ts` del servicio que se rebaja. Un
//   combo no aparece acá: en día de promo paga lo menor entre su precio y sus
//   dos mitades con la promo puesta (`admin/src/lib/promos.ts`), sin sumar
//   las dos rebajas.
// - Las promos **no se acumulan**: si aplican varias, gana el descuento mayor.

export const PROMO_RULES = {
  // 15% sobre los montajes, con el precio de promo redondeado hacia abajo a la
  // centena para que nunca sea menos del 15% (97.750 → 97.700). Un test en
  // `promos.test.ts` lo recalcula contra `pricing.ts`: si sube un precio de
  // lista, falla hasta que se actualice acá.
  "martes-montajes": {
    weekday: 2,
    items: [
      { key: "polygel-sculpted", regularId: "polygel-sculpted", promoCOP: 102000 },
      { key: "acrylic-sculpted", regularId: "acrylic-sculpted", promoCOP: 97700 },
      { key: "polygel-dual", regularId: "polygel-dual", promoCOP: 93500 },
      { key: "builder-gel-dual", regularId: "builder-gel-dual", promoCOP: 89200 },
      { key: "press-on", regularId: "press-on", promoCOP: 85000 },
    ],
  },
  "sabado-press": {
    weekday: 6,
    items: [{ key: "press-on", regularId: "press-on", promoCOP: 80000 }],
  },
  "miercoles-pies": {
    weekday: 3,
    items: [
      { key: "traditional-feet", regularId: "traditional-feet", promoCOP: 25000 },
      { key: "semi-permanent-feet", regularId: "semi-permanent-feet", promoCOP: 40000 },
    ],
  },
} as const;

/** Martes de montajes: el porcentaje que anuncia el afiche. */
export const MARTES_MONTAJES_PERCENT = 15;

/** Primera visita: este porcentaje sobre los servicios (no sobre adicionales). */
export const FIRST_VISIT_PERCENT = 10;
