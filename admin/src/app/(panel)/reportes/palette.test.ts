import { describe, expect, it } from "vitest";

import { contrastRatio } from "@/components/ui/contrast";
import { STATUS_HEX, STATUS_IDS } from "@/components/ui/status";
import {
  CHART_SURFACE,
  DEEMPHASIS,
  inkOnSequential,
  SEQUENTIAL,
  SEQUENTIAL_INK_FLIP,
  SEQUENTIAL_ORDINAL_START,
  SERIES,
  SERIES_CAP,
  seriesColor,
  sequentialStep,
  statusColor,
} from "./palette";

/**
 * El contrato de la paleta de gráficos.
 *
 * Lo que este archivo fija no es "se ve bien": son los números que el validador
 * de `dataviz` escupió cuando se eligió la paleta, recalculados desde los hex.
 * Si mañana alguien aclara un paso de la rampa "para que se vea más suave", el
 * test se pone rojo antes de que el gráfico mienta.
 *
 * La separación entre los cinco puntos de estado —ΔE con visión normal y bajo
 * deuteranopía/protanopía— **ya está fijada en `components/ui/status.test.ts`**
 * y no se repite acá: los cuatro slots categóricos son un subconjunto de esos
 * cinco, así que ese test los cubre. Lo que sí se prueba acá es lo que es
 * propio de este archivo — la banda de lightness, el piso de croma, la rampa
 * secuencial y la elección de tinta sobre relleno.
 */

// ── Aritmética de color ─────────────────────────────────────────────────────
//
// OKLCH, reimplementado en veinte líneas por el mismo motivo que en
// `status.test.ts`: no arrastrar una dependencia para hacer tres raíces cúbicas.

const s2lin = (c: number) =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

const lin = (hex: string): [number, number, number] =>
  [0, 2, 4].map((i) =>
    s2lin(parseInt(hex.replace("#", "").slice(i, i + 2), 16) / 255),
  ) as [number, number, number];

function oklch(hex: string): { L: number; C: number; H: number } {
  const [r, g, b] = lin(hex);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    L,
    C: Math.hypot(A, B),
    H: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360,
  };
}

/** La banda de lightness del modo claro, y el piso de croma, de `dataviz`. */
const BAND = [0.43, 0.77] as const;
const CHROMA_FLOOR = 0.1;

describe("los slots categóricos salen de la paleta de estados", () => {
  it("son literalmente los mismos hex que `STATUS_HEX`, no copias", () => {
    // La identidad importa: si fueran hex copiados a mano, A3 podría cambiar el
    // verde de "completada" y el verde de la serie 3 seguiría siendo el viejo.
    // Dos verdes en la misma pantalla es exactamente lo que este archivo
    // existe para evitar.
    expect(SERIES).toEqual([
      STATUS_HEX.confirmada.dot,
      STATUS_HEX["no-asistio"].dot,
      STATUS_HEX.completada.dot,
      STATUS_HEX.cancelada.dot,
    ]);
  });

  it("el gris de de-énfasis es el tono `reservada`", () => {
    expect(DEEMPHASIS).toBe(STATUS_HEX.reservada.dot);
  });

  it("`statusColor` devuelve el punto del estado, incluido el comodín", () => {
    for (const id of STATUS_IDS) {
      expect(statusColor(id)).toBe(STATUS_HEX[id].dot);
    }
    expect(statusColor("desconocido")).toBe(STATUS_HEX.desconocido.dot);
  });
});

describe("los cuatro slots pasan los checks computables", () => {
  it("caen dentro de la banda de lightness del modo claro", () => {
    for (const hex of SERIES) {
      const { L } = oklch(hex);
      expect(L, hex).toBeGreaterThanOrEqual(BAND[0]);
      expect(L, hex).toBeLessThanOrEqual(BAND[1]);
    }
  });

  it("superan el piso de croma: ninguno lee como gris", () => {
    for (const hex of SERIES) {
      expect(oklch(hex).C, hex).toBeGreaterThanOrEqual(CHROMA_FLOOR);
    }
  });

  it("miden ≥3:1 contra la superficie real de la tarjeta", () => {
    // Contra `--color-paper`, que es el fondo de `.ui-card`, y no contra la
    // superficie por defecto del skill: un contraste medido contra la
    // superficie equivocada no dice nada.
    for (const hex of SERIES) {
      expect(contrastRatio(hex, CHART_SURFACE), hex).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("`reservada` queda fuera de la categórica, y es medible por qué", () => {
  it("está fuera de la banda de lightness", () => {
    expect(oklch(DEEMPHASIS).L).toBeLessThan(BAND[0]);
  });

  it("está por debajo del piso de croma: a ese croma lee como gris", () => {
    expect(oklch(DEEMPHASIS).C).toBeLessThan(CHROMA_FLOOR);
  });

  it("no aparece entre los slots de serie", () => {
    expect(SERIES).not.toContain(DEEMPHASIS);
  });
});

describe("`seriesColor` no cicla", () => {
  it("devuelve el slot pedido dentro del tope", () => {
    for (const [index, hex] of SERIES.entries()) {
      expect(seriesColor(index)).toBe(hex);
    }
  });

  it("pasado el tope devuelve el gris, no un tono repetido", () => {
    // Un noveno tono generado es indistinguible de uno existente bajo
    // daltonismo. El gris dice "esta serie no se puede distinguir por color" en
    // vez de mentir con un azul repetido.
    expect(seriesColor(SERIES_CAP)).toBe(DEEMPHASIS);
    expect(seriesColor(99)).toBe(DEEMPHASIS);
  });
});

describe("el dorado nunca codifica un dato", () => {
  it("no está en la categórica ni en la rampa", () => {
    for (const gold of ["#ac8231", "#8b6a1f", "#6d5214", "#e7aa51"]) {
      expect(SERIES as readonly string[]).not.toContain(gold);
      expect(SEQUENTIAL as readonly string[]).not.toContain(gold);
      expect(DEEMPHASIS).not.toBe(gold);
    }
  });
});

describe("la rampa secuencial", () => {
  it("es de un solo tono: la dispersión de matiz no llega a 2°", () => {
    const hues = SEQUENTIAL.map((hex) => oklch(hex).H);
    expect(Math.max(...hues) - Math.min(...hues)).toBeLessThan(2);
  });

  it("va de claro a oscuro, monótona", () => {
    const ls = SEQUENTIAL.map((hex) => oklch(hex).L);
    for (let i = 1; i < ls.length; i++) {
      expect(ls[i], SEQUENTIAL[i]).toBeLessThan(ls[i - 1]);
    }
  });

  it("cada escalón se ve: ΔL adyacente ≥ 0.06", () => {
    const ls = SEQUENTIAL.map((hex) => oklch(hex).L);
    for (let i = 1; i < ls.length; i++) {
      expect(ls[i - 1] - ls[i], `paso ${i}`).toBeGreaterThanOrEqual(0.06);
    }
  });

  it("el arranque ordinal despega de la superficie (≥2:1) y el paso previo no", () => {
    // Es la razón de que `SEQUENTIAL_ORDINAL_START` exista. El extremo claro de
    // la rampa es legal en un mapa de calor —ahí significa "casi cero" y puede
    // acercarse al fondo— y no lo es en una barra discreta.
    const start = SEQUENTIAL[SEQUENTIAL_ORDINAL_START];
    expect(contrastRatio(start, CHART_SURFACE)).toBeGreaterThanOrEqual(2);
    const previous = SEQUENTIAL[SEQUENTIAL_ORDINAL_START - 1];
    expect(contrastRatio(previous, CHART_SURFACE)).toBeLessThan(2);
  });
});

describe("`sequentialStep`", () => {
  it("reparte `[0,1]` entre los siete pasos, extremos incluidos", () => {
    expect(sequentialStep(0)).toBe(SEQUENTIAL[0]);
    expect(sequentialStep(1)).toBe(SEQUENTIAL[SEQUENTIAL.length - 1]);
    expect(sequentialStep(0.99)).toBe(SEQUENTIAL[SEQUENTIAL.length - 1]);
  });

  it("recorta fuera de rango en vez de salirse de la rampa", () => {
    expect(sequentialStep(-3)).toBe(SEQUENTIAL[0]);
    expect(sequentialStep(42)).toBe(SEQUENTIAL[SEQUENTIAL.length - 1]);
  });

  it("sin dato devuelve `null`, que no es el paso más claro", () => {
    // Un domingo cerrado no tiene 0 % de ocupación: no tiene ocupación. La
    // celda se dibuja vacía, igual que `computeOccupancy()` devuelve `null`.
    expect(sequentialStep(null)).toBeNull();
    expect(sequentialStep(Number.NaN)).toBeNull();
  });
});

describe("`inkOnSequential` mide, no estima", () => {
  it("toda etiqueta dentro de una celda alcanza 4.5:1", () => {
    for (const step of SEQUENTIAL) {
      expect(contrastRatio(inkOnSequential(step), step), step).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("el corte está donde el blanco empieza a ganarle a la tinta", () => {
    for (const [index, step] of SEQUENTIAL.entries()) {
      const expected = index >= SEQUENTIAL_INK_FLIP ? "#ffffff" : "#2a221c";
      expect(inkOnSequential(step), step).toBe(expected);
    }
  });

  it("un relleno que no es de la rampa cae en tinta, que es lo seguro", () => {
    // Los rellenos claros son mayoría en cualquier paleta de este panel; ante
    // un hex desconocido, la tinta oscura falla en el lado bueno.
    expect(inkOnSequential("#ffffff")).toBe("#2a221c");
  });
});
