import { describe, expect, it } from "vitest";

import { COMBO_COMPOSITION } from "@/data/combo-composition";

import { handsShareBp, toEaIds } from "./combo-source";

/**
 * El reparto manos/pies que se congela al sincronizar un combo.
 *
 * Alimenta `allocation_hands_bp`, que es con lo que `lib/combo-allocation.ts`
 * parte el precio de un combo entre dos técnicas. O sea: es plata en la
 * quincena de alguien. Por eso se prueba una función de cuatro líneas.
 */
describe("handsShareBp", () => {
  it("reparte en proporción al precio de lista de cada mitad", () => {
    // Semipermanente manos 50.000 + pies 55.000: las manos son 47,62 %.
    expect(handsShareBp(50000, 55000)).toBe(4762);
  });

  it("mitades iguales dan exactamente la mitad", () => {
    expect(handsShareBp(50000, 50000)).toBe(5000);
  });

  it("devuelve puntos básicos enteros, nunca un decimal", () => {
    const bp = handsShareBp(85000, 55000);
    expect(Number.isInteger(bp)).toBe(true);
    expect(bp).toBe(6071);
  });

  it("sin precios reparte mitad y mitad en vez de dividir por cero", () => {
    // No es una suposición sobre el trabajo: es que sin precios no hay
    // proporción, y 50/50 es el único reparto que no favorece a nadie por
    // accidente.
    expect(handsShareBp(0, 0)).toBe(5000);
  });

  it("una mitad gratis no saca el reparto de rango", () => {
    expect(handsShareBp(0, 55000)).toBe(0);
    expect(handsShareBp(50000, 0)).toBe(10000);
  });

  it("nunca pasa de 10.000 bp, que es el tope de la columna", () => {
    // `ck_combo_allocation` lo exige en la base; acá se cumple antes de llegar.
    for (const [h, f] of [
      [1, 0],
      [999999, 1],
      [1, 999999],
    ]) {
      const bp = handsShareBp(h, f);
      expect(bp).toBeGreaterThanOrEqual(0);
      expect(bp).toBeLessThanOrEqual(10000);
    }
  });
});

describe("toEaIds", () => {
  const entry = {
    pricingId: "semi-permanent-hands-feet",
    hands: "semi-permanent-hands",
    feet: "semi-permanent-feet",
    priceCOP: 95000,
    durationMin: 120,
    handsPriceCOP: 50000,
    feetPriceCOP: 55000,
  };

  const mapped = new Map([
    ["semi-permanent-hands-feet", 90],
    ["semi-permanent-hands", 10],
    ["semi-permanent-feet", 20],
  ]);

  it("traduce los tres ids de vitrina a los de la agenda", () => {
    expect(toEaIds([entry], mapped)).toEqual([
      { eaServiceId: 90, handsEaServiceId: 10, feetEaServiceId: 20 },
    ]);
  });

  it("se salta el combo si alguna de las tres partes no está publicada", () => {
    // Ofrecer un par cuya mitad no existe en EA es un callejón que solo se
    // descubre al guardar. Se prueban las tres ausencias por separado: con una
    // sola, un `&&` mal puesto pasaría desapercibido.
    for (const falta of ["semi-permanent-hands-feet", "semi-permanent-hands", "semi-permanent-feet"]) {
      const parcial = new Map(mapped);
      parcial.delete(falta);
      expect(toEaIds([entry], parcial), `faltando ${falta}`).toEqual([]);
    }
  });

  it("con el mapa vacío no inventa nada", () => {
    expect(toEaIds([entry], new Map())).toEqual([]);
  });
});

describe("la composición horneada", () => {
  it("trae los cinco combos de la vitrina", () => {
    // El archivo lo genera `scripts/build-combo-map.mjs` de la landing y viaja
    // dentro de la imagen. Que esté vacío significaría que el generador no
    // entendió `pricing.ts` — y que componer combos está apagado en el estudio
    // sin que nada lo diga.
    expect(COMBO_COMPOSITION.length).toBeGreaterThan(0);
  });

  it("ningún combo cuesta más que sus dos mitades", () => {
    // Es la premisa del tachado: si un combo costara más que la suma, la
    // pantalla mostraría un "ahorro" negativo. `lib/combos.ts` ya no tacha en
    // ese caso; esto además avisa si la vitrina se edita mal.
    for (const c of COMBO_COMPOSITION) {
      expect(c.priceCOP, c.pricingId).toBeLessThanOrEqual(c.handsPriceCOP + c.feetPriceCOP);
    }
  });

  it("ninguna mitad es el combo mismo, ni un combo es mitad de otro", () => {
    const combos = new Set(COMBO_COMPOSITION.map((c) => c.pricingId));
    for (const c of COMBO_COMPOSITION) {
      expect(c.hands, c.pricingId).not.toBe(c.feet);
      expect(combos.has(c.hands), `${c.pricingId}.hands`).toBe(false);
      expect(combos.has(c.feet), `${c.pricingId}.feet`).toBe(false);
    }
  });

  it("un par mapea a un solo combo", () => {
    // Dos combos reclamando el mismo par harían que cuál gana lo decidiera el
    // orden del arreglo: un precio elegido por dónde alguien pegó una línea.
    const pares = COMBO_COMPOSITION.map((c) => `${c.hands}+${c.feet}`);
    expect(new Set(pares).size).toBe(pares.length);
  });

  it("todas las duraciones son positivas: `ck_combo_duration` lo exige", () => {
    for (const c of COMBO_COMPOSITION) {
      expect(c.durationMin, c.pricingId).toBeGreaterThan(0);
    }
  });
});
