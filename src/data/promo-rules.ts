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
//   combo no aparece acá: ya trae su propio descuento.
// - Las promos **no se acumulan**: si aplican varias, gana el descuento mayor.

export const PROMO_RULES = {
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

/** Primera visita: este porcentaje sobre los servicios (no sobre adicionales). */
export const FIRST_VISIT_PERCENT = 10;
