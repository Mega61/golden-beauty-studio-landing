import { describe, expect, it } from "vitest";

import {
  axisMax,
  deltaAgainst,
  formatRate,
  linearScale,
  MARK,
  niceTicks,
  NOT_MEASURABLE,
  sparklinePath,
} from "./scale";

describe("linearScale", () => {
  it("mapea el dominio completo al rango completo", () => {
    const scale = linearScale(100);
    expect(scale(0)).toBe(0);
    expect(scale(50)).toBe(50);
    expect(scale(100)).toBe(100);
  });

  it("el rango por defecto es 100, porque el CSS quiere porcentajes", () => {
    expect(linearScale(200)(50)).toBe(25);
    expect(linearScale(200).size).toBe(100);
  });

  it("un dominio vacío devuelve 0, no `NaN`", () => {
    // Un `NaN` en un `width` de CSS deja la barra con el ancho del contenedor,
    // que es lo contrario de lo que el dato dice.
    const scale = linearScale(0);
    expect(scale(0)).toBe(0);
    expect(scale(1000)).toBe(0);
    expect(scale.max).toBe(0);
  });

  it("un dominio negativo o no finito se trata como vacío", () => {
    expect(linearScale(-5)(10)).toBe(0);
    expect(linearScale(Number.NaN)(10)).toBe(0);
    expect(linearScale(Number.POSITIVE_INFINITY)(10)).toBe(0);
  });

  it("un valor negativo o basura no dibuja hacia atrás", () => {
    const scale = linearScale(100);
    expect(scale(-20)).toBe(0);
    expect(scale(Number.NaN)).toBe(0);
  });

  it("expone su dominio y su tamaño para que el eje no los adivine", () => {
    const scale = linearScale(250, 300);
    expect(scale.max).toBe(250);
    expect(scale.size).toBe(300);
  });
});

describe("niceTicks", () => {
  it("da números redondos, no fracciones del máximo", () => {
    expect(niceTicks(347_000, 4)).toEqual([0, 100_000, 200_000, 300_000, 400_000]);
    expect(niceTicks(95, 4)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(9, 3)).toEqual([0, 5, 10]);
    expect(niceTicks(0.9, 4)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("el tope de las marcas nunca queda por debajo del máximo", () => {
    for (const max of [1, 7, 42, 99, 100, 101, 1_234, 873_291, 1_000_001]) {
      expect(axisMax(max), String(max)).toBeGreaterThanOrEqual(max);
    }
  });

  it("no deriva en punto flotante", () => {
    // El acumulador suma el paso; sin redondeo la etiqueta diría
    // `299.999,9999999` en vez de `300.000`.
    for (const tick of niceTicks(0.9, 4)) {
      expect(String(tick)).not.toMatch(/\d{6,}/);
    }
  });

  it("sin datos devuelve solo el cero, y no una escala inventada", () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(-100)).toEqual([0]);
    expect(niceTicks(Number.NaN)).toEqual([0]);
    expect(axisMax(0)).toBe(0);
  });

  it("no se va al infinito con un máximo absurdo", () => {
    expect(niceTicks(1e300, 1).length).toBeLessThanOrEqual(25);
  });

  it("con el tope del eje, ninguna barra pasa del 100 %", () => {
    // Es la razón de que `axisMax` exista: la escala se arma con la última
    // marca, no con el máximo del dato.
    for (const max of [1, 37, 873_291]) {
      const scale = linearScale(axisMax(max));
      expect(scale(max), String(max)).toBeLessThanOrEqual(100);
    }
  });
});

describe("sparklinePath", () => {
  it("dibuja dentro de la caja, con aire para el grosor del trazo", () => {
    const path = sparklinePath([1, 5, 3], 100, 40);
    expect(path).not.toBeNull();
    const ys = [...(path ?? "").matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(MARK.line / 2 - 0.01);
      expect(y).toBeLessThanOrEqual(40 - MARK.line / 2 + 0.01);
    }
  });

  it("arranca en x=0 y termina en x=ancho", () => {
    const path = sparklinePath([1, 2, 3, 4], 90, 30) ?? "";
    expect(path.startsWith("M0.00 ")).toBe(true);
    expect(path).toContain("L90.00 ");
  });

  it("con menos de dos puntos devuelve `null`, no una línea plana", () => {
    // Una línea plana afirmaría una estabilidad que nadie midió.
    expect(sparklinePath([], 100, 40)).toBeNull();
    expect(sparklinePath([5], 100, 40)).toBeNull();
  });

  it("una serie constante sale plana y al medio, sin dividir por cero", () => {
    // "No cambió" es justo lo que pasó, y una línea al medio lo dice sin
    // fingir una subida ni una caída.
    for (const values of [
      [7, 7, 7],
      [0, 0, 0],
    ]) {
      const path = sparklinePath(values, 100, 40) ?? "";
      const ys = [...path.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
      expect(new Set(ys).size, String(values)).toBe(1);
      expect(ys[0], String(values)).toBeCloseTo(20, 1);
    }
  });

  it("descarta puntos no finitos en vez de romper el trazo", () => {
    const path = sparklinePath([1, Number.NaN, 3], 100, 40) ?? "";
    expect(path.split("L")).toHaveLength(2);
  });

  it("una caja sin tamaño no dibuja", () => {
    expect(sparklinePath([1, 2], 0, 40)).toBeNull();
    expect(sparklinePath([1, 2], 100, 0)).toBeNull();
  });
});

describe("formatRate", () => {
  it("escribe la tasa como porcentaje", () => {
    expect(formatRate(0.734)).toBe("73 %");
    expect(formatRate(0.734, 1)).toBe("73.4 %");
    expect(formatRate(0)).toBe("0 %");
    expect(formatRate(1)).toBe("100 %");
  });

  it("`null` **no es cero**: dice que no se puede medir", () => {
    // La ocupación de un domingo cerrado y la retención de una cohorte cuya
    // ventana no venció salen las dos `null`. Un 0 % ahí es un dato falso.
    expect(formatRate(null)).toBe(NOT_MEASURABLE);
    expect(formatRate(Number.NaN)).toBe(NOT_MEASURABLE);
    expect(NOT_MEASURABLE).not.toContain("0");
  });
});

describe("deltaAgainst", () => {
  it("da el cambio porcentual con su dirección", () => {
    expect(deltaAgainst(110, 100)).toEqual({ direction: "up", label: "+10 %" });
    expect(deltaAgainst(90, 100)).toEqual({ direction: "down", label: "−10 %" });
  });

  it("usa el menos tipográfico, no el guion", () => {
    expect(deltaAgainst(90, 100)?.label).toContain("−");
    expect(deltaAgainst(90, 100)?.label).not.toContain("-");
  });

  it("sin cambio lo dice con palabras, no con «+0 %»", () => {
    expect(deltaAgainst(100, 100)).toEqual({ direction: "flat", label: "sin cambio" });
    // Un cambio que redondea a cero también es "sin cambio": «+0 %» invita a
    // buscar el decimal que el tile no muestra.
    expect(deltaAgainst(1002, 1000)?.direction).toBe("flat");
  });

  it("contra cero devuelve `null`: «subió infinito por ciento» no es información", () => {
    expect(deltaAgainst(500, 0)).toBeNull();
    expect(deltaAgainst(0, 0)).toBeNull();
  });

  it("un valor no finito no produce un delta", () => {
    expect(deltaAgainst(Number.NaN, 100)).toBeNull();
    expect(deltaAgainst(100, Number.NaN)).toBeNull();
  });

  it("con un anterior negativo el signo sigue significando lo mismo", () => {
    // Se normaliza por el valor absoluto del anterior: pasar de −100 a −50 es
    // una mejora, y tiene que leerse como subida.
    expect(deltaAgainst(-50, -100)?.direction).toBe("up");
  });
});
