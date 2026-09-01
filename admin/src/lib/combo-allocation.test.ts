import { describe, expect, it } from "vitest";

import {
  AllocationError,
  FULL_BASIS_POINTS,
  allocateByWeights,
  allocateCombo,
} from "./combo-allocation";

/**
 * Lo que este archivo tiene que demostrar es una sola cosa, y no se demuestra
 * con ejemplos: **el reparto suma exacto, siempre**. Un caso feliz y dos bordes
 * dejarían pasar el modo de falla real, que es un precio raro con una
 * proporción rara donde el peso de residuo se pierde o se duplica.
 *
 * Por eso la mayoría de abajo son tests de propiedad sobre cientos de
 * combinaciones. Los ejemplos que sí hay están para fijar **a quién** le toca
 * el peso de residuo, que es la parte que un test de propiedad no ve.
 */

describe("allocateByWeights — la propiedad que sostiene el módulo", () => {
  it("las partes suman exacto al total, para cualquier monto y cualquier reparto", () => {
    const amounts = [0, 1, 2, 3, 7, 99, 100, 999, 1_000, 12_345, 77_000, 95_000, 135_000, 1_000_003];
    const weightSets: number[][] = [
      [1, 1],
      [1, 2],
      [1, 1, 1],
      [1, 2, 3],
      [7, 11, 13, 17],
      [1, 0],
      [0, 1],
      [1, 0, 1],
      [3333, 3333, 3334],
      [10_000],
      [9_999, 1],
      [1, 1, 1, 1, 1, 1, 1],
    ];

    for (const amount of amounts) {
      for (const weights of weightSets) {
        const shares = allocateByWeights(amount, weights);

        expect(shares).toHaveLength(weights.length);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
        expect(shares.every((s) => Number.isSafeInteger(s))).toBe(true);
      }
    }
  });

  it("también con montos negativos — una corrección que resta", () => {
    // El piso hacia −∞ es lo que mantiene el residuo en [0, n) también acá. Si
    // se hubiera usado truncamiento, este bloque perdería pesos.
    for (let amount = -1; amount >= -500; amount -= 7) {
      for (const weights of [[1, 1], [1, 2, 3], [5000, 5000], [1, 9999]]) {
        expect(allocateByWeights(amount, weights).reduce((a, b) => a + b, 0)).toBe(amount);
      }
    }
  });

  it("ninguna parte se desvía más de un peso de su cuota exacta", () => {
    // Que sume exacto no alcanza: [total, 0, 0] también suma exacto. Esto es lo
    // que hace que el reparto además sea *justo*.
    const weights = [7, 11, 13, 17, 19];
    const totalWeight = weights.reduce((a, b) => a + b, 0);

    for (let amount = 0; amount <= 400; amount += 1) {
      const shares = allocateByWeights(amount, weights);

      for (const [index, share] of shares.entries()) {
        const exact = (amount * weights[index]) / totalWeight;
        expect(Math.abs(share - exact)).toBeLessThan(1);
      }
    }
  });

  it("es determinista: dos llamadas iguales dan lo mismo", () => {
    const first = allocateByWeights(100, [1, 1, 1]);
    const second = allocateByWeights(100, [1, 1, 1]);

    expect(first).toEqual(second);
  });

  it("el peso de residuo va al índice más bajo cuando los residuos empatan", () => {
    // 100 entre tres partes iguales: 33 + 33 + 33 = 99, sobra 1. Los tres
    // residuos son idénticos, así que el desempate por índice es lo único que
    // decide. Fijarlo acá es lo que impide que un cambio de orden de `sort`
    // mueva plata entre dos técnicas sin que nadie lo note.
    expect(allocateByWeights(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("el peso de residuo va a la parte de mayor residuo, no al primero", () => {
    // 10 entre pesos 1 y 2: cuotas exactas 3,33 y 6,66. Sobra 1 y le toca a la
    // segunda, que tiene el residuo mayor.
    expect(allocateByWeights(10, [1, 2])).toEqual([3, 7]);
  });

  it("un monto de cero reparte ceros aunque los pesos sean cero", () => {
    expect(allocateByWeights(0, [0, 0])).toEqual([0, 0]);
  });

  it("una parte de peso cero no recibe nada", () => {
    expect(allocateByWeights(1_000, [1, 0])).toEqual([1_000, 0]);
  });

  it("rechaza repartir plata entre partes sin peso", () => {
    // Devolver ceros haría desaparecer 100.000 pesos en silencio, que es
    // exactamente el modo de falla que este módulo existe para impedir.
    expect(() => allocateByWeights(100_000, [0, 0])).toThrow(AllocationError);
  });

  it("rechaza una lista de partes vacía", () => {
    expect(() => allocateByWeights(100, [])).toThrow(AllocationError);
  });

  it("rechaza un peso negativo", () => {
    expect(() => allocateByWeights(100, [1, -1])).toThrow(/negativo/);
  });

  it("rechaza montos y pesos que no son enteros seguros", () => {
    expect(() => allocateByWeights(10.5, [1, 1])).toThrow(/entero seguro/);
    expect(() => allocateByWeights(100, [1.5, 1])).toThrow(/entero seguro/);
    expect(() => allocateByWeights(Number.NaN, [1, 1])).toThrow(AllocationError);
  });

  it("rechaza un producto monto × peso fuera del entero seguro", () => {
    // No es teórico: `amount * weight` es la única multiplicación del módulo, y
    // si se desborda el reparto deja de sumar exacto sin lanzar nada.
    expect(() => allocateByWeights(Number.MAX_SAFE_INTEGER, [1_000, 1])).toThrow(
      /producto monto × peso/,
    );
  });
});

describe("allocateCombo", () => {
  it("manos + pies suman exacto al precio, para todo precio y toda proporción", () => {
    const prices = [0, 1, 77_000, 95_000, 125_000, 130_000, 135_000, 999_999];

    for (const price of prices) {
      for (let bp = 0; bp <= FULL_BASIS_POINTS; bp += 137) {
        const { hands, feet } = allocateCombo(price, bp);

        expect(hands + feet).toBe(price);
        expect(hands).toBeGreaterThanOrEqual(0);
        expect(feet).toBeGreaterThanOrEqual(0);
      }

      // Los extremos exactos, que el paso de 137 se saltea.
      expect(allocateCombo(price, 0)).toEqual({ hands: 0, feet: price });
      expect(allocateCombo(price, FULL_BASIS_POINTS)).toEqual({ hands: price, feet: 0 });
    }
  });

  it("un combo real, mitad y mitad, con precio impar", () => {
    // 95.000 al 50 % da 47.500 justos; 77.000 al 50 % también. El caso que
    // importa es el impar: el peso sobrante no se puede perder.
    expect(allocateCombo(95_001, 5_000)).toEqual({ hands: 47_501, feet: 47_500 });
  });

  it("respeta la proporción de la fila combo", () => {
    // 135.000 con 60 % a manos: forrado de polygel en manos + semipermanente
    // en pies, que es la composición real del combo más caro del catálogo.
    expect(allocateCombo(135_000, 6_000)).toEqual({ hands: 81_000, feet: 54_000 });
  });

  it("rechaza proporciones fuera de 0–10000 bp", () => {
    expect(() => allocateCombo(100_000, -1)).toThrow(AllocationError);
    expect(() => allocateCombo(100_000, 10_001)).toThrow(AllocationError);
    expect(() => allocateCombo(100_000, 12.5)).toThrow(/entero/);
  });

  it("un combo de precio cero no revienta aunque los pesos den cero", () => {
    expect(allocateCombo(0, 0)).toEqual({ hands: 0, feet: 0 });
  });
});
