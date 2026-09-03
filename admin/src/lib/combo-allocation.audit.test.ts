import { describe, expect, it } from "vitest";

import { FULL_BASIS_POINTS, allocateByWeights, allocateCombo } from "./combo-allocation";

/**
 * AUDITORÍA ADVERSARIAL — `gbs-money-auditor`, paquete B1.
 *
 * `allocateByWeights` es compartido por tres cosas: el prorrateo del descuento
 * del ticket, el reparto del combo entre manos y pies, y el reparto de la base
 * de comisión entre dos técnicas. Un error de residuo acá se paga en tres
 * lugares distintos, así que se ataca con propiedades sobre miles de
 * combinaciones, no con ejemplos.
 */

const WEIGHT_SETS: number[][] = [
  [1, 1],
  [1, 2],
  [1, 1, 1],
  [5_000, 5_000],
  [3_333, 6_667],
  [1, 9_999],
  [7, 11, 13, 17, 19],
  [0, 1],
  [1, 0],
  [0, 5_000, 0, 5_000],
  [115_000, 30_000, 20_000],
  [1, 1, 1, 1, 1, 1, 1],
  [10, 20, 30], // no suman 100 ni 10000: solo importa la proporción
  [2, 2, 2, 3],
];

describe("AUDIT · allocateByWeights — la suma exacta, en grande", () => {
  it("suma exacto para miles de combinaciones, incluidos montos negativos", () => {
    let cases = 0;

    for (let amount = -5_000; amount <= 5_000; amount += 7) {
      for (const weights of WEIGHT_SETS) {
        if (weights.every((w) => w === 0)) continue;

        const shares = allocateByWeights(amount, weights);

        expect(shares).toHaveLength(weights.length);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
        cases += 1;
      }
    }

    expect(cases).toBeGreaterThan(10_000);
  });

  it("ninguna parte se desvía más de un peso de su cuota exacta, TAMBIÉN en negativo", () => {
    for (let amount = -2_000; amount <= 0; amount += 1) {
      for (const weights of WEIGHT_SETS) {
        if (weights.every((w) => w === 0)) continue;

        const totalWeight = weights.reduce((a, b) => a + b, 0);
        const shares = allocateByWeights(amount, weights);

        for (const [index, share] of shares.entries()) {
          expect(Math.abs(share - (amount * weights[index]) / totalWeight)).toBeLessThan(1);
        }
      }
    }
  });

  it("una parte de peso cero nunca recibe un peso de residuo, para ningún monto", () => {
    for (let amount = -3_000; amount <= 3_000; amount += 13) {
      for (const weights of [
        [0, 1],
        [1, 0],
        [0, 5_000, 0, 5_000],
        [0, 0, 7, 11, 13],
        [1, 1, 1, 0],
      ]) {
        const shares = allocateByWeights(amount, weights);

        for (const [index, weight] of weights.entries()) {
          if (weight === 0) expect(Math.abs(shares[index])).toBe(0);
        }
      }
    }
  });

  it("es determinista bajo repetición", () => {
    for (let amount = -500; amount <= 500; amount += 3) {
      for (const weights of WEIGHT_SETS) {
        if (weights.every((w) => w === 0)) continue;
        expect(allocateByWeights(amount, weights)).toEqual(
          allocateByWeights(amount, weights),
        );
      }
    }
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * HALLAZGO 1 — el reparto NO es simétrico respecto del signo.
 *
 * El módulo declara que `amount` puede ser negativo porque "una corrección
 * posterior al cierre entra como renglón nuevo, y ese renglón puede restar"
 * (`combo-allocation.ts:62`). El sentido entero de una corrección es cancelar
 * el movimiento que corrige. Pero el residuo se asigna por índice ascendente en
 * los dos sentidos, así que:
 *
 *     allocateByWeights(-a, w)  ≠  allocateByWeights(a, w).map(negar)
 *
 * El total sí cancela; **el reparto por parte no**. En el caso de producción —
 * un combo 50/50 con precio impar, o un renglón repartido 5000/5000 entre dos
 * técnicas — cada corrección deja +1 peso pegado a la primera parte y −1 a la
 * segunda, para siempre y sin marca.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("AUDIT · una corrección tiene que deshacer el reparto que corrige", () => {
  it("el combo 50/50 de precio impar: la reversa no devuelve lo que el cobro atribuyó", () => {
    const cobro = allocateCombo(95_001, FULL_BASIS_POINTS / 2);
    const reversa = allocateCombo(-95_001, FULL_BASIS_POINTS / 2);

    // El plan atribuye ingreso a los servicios de manos y de pies subyacentes
    // vía la fila `combo`. Si el cobro le atribuye 47.501 a manos, la reversa
    // del mismo cobro tiene que quitarle exactamente 47.501.
    expect(reversa.hands).toBe(-cobro.hands);
    expect(reversa.feet).toBe(-cobro.feet);
  });

  it("propiedad general: repartir −a es repartir a con el signo cambiado", () => {
    const rotos: string[] = [];

    for (let amount = 1; amount <= 300; amount += 1) {
      for (const weights of WEIGHT_SETS) {
        if (weights.every((w) => w === 0)) continue;

        const positivo = allocateByWeights(amount, weights);
        const negativo = allocateByWeights(-amount, weights);
        const esperado = positivo.map((share) => -share);

        if (JSON.stringify(negativo) !== JSON.stringify(esperado)) {
          rotos.push(
            `amount=${amount} weights=[${weights}] → ${JSON.stringify(negativo)} ` +
              `en vez de ${JSON.stringify(esperado)}`,
          );
        }
      }
    }

    expect(rotos.slice(0, 5)).toEqual([]);
  });
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * HALLAZGO 1b — el reparto emite **cero negativo**.
 *
 * `commission.ts:176-179` identifica el peligro y lo tapa dentro de
 * `roundPesos()`: "`-0` es igual a `0` con `===` pero distinto con `Object.is`,
 * que es lo que usan los tests y varios `Map`. Normalizarlo acá evita que un
 * cero negativo se filtre a una fila de `commission_entry` y a un reporte."
 *
 * `allocateByWeights()` no lo hace, y su salida entra sin pasar por `roundPesos`
 * a `TicketLine.discountShare`/`netTotal` y a `CommissionResult.baseAmount`
 * (vía `splitBase`, `commission.ts:350`). Con monto negativo, toda parte de
 * cuota cero sale `-0`.
 * ────────────────────────────────────────────────────────────────────────────
 */
describe("AUDIT · ninguna parte sale como cero negativo", () => {
  it("una parte de peso cero en una corrección devuelve +0, no −0", () => {
    const shares = allocateByWeights(-1_000, [0, 10_000]);

    expect(Object.is(shares[0], 0)).toBe(true);
  });

  it("una proporción de combo en 0 bp con precio negativo tampoco", () => {
    expect(Object.is(allocateCombo(-95_000, 0).hands, 0)).toBe(true);
  });
});
