import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";
import {
  isStatusId,
  normalizeStatusId,
  resolveStatus,
  STATUS_HEX,
  STATUS_IDS,
  STATUS_META,
  type StatusToken,
} from "./status";

/**
 * Estos tests son el contrato de la paleta de estados. Un cambio de hex que
 * baje el contraste, o que acerque dos estados hasta volverlos
 * indistinguibles, tiene que ponerse rojo acá y no descubrirse en producción
 * con la agenda ya llena.
 */

const PAPER = "#fbf8f3";
const CREAM = "#f3ecdf";
const TOKENS = Object.keys(STATUS_HEX) as StatusToken[];

describe("resolveStatus", () => {
  it("reconoce el id tal cual", () => {
    expect(resolveStatus("no-asistio").id).toBe("no-asistio");
    expect(resolveStatus("completada").label).toBe("Completada");
  });

  it("reconoce la etiqueta con tilde y con mayúsculas", () => {
    expect(resolveStatus("No asistió").id).toBe("no-asistio");
    expect(resolveStatus("NO ASISTIÓ").id).toBe("no-asistio");
    expect(resolveStatus("  Reservada  ").id).toBe("reservada");
  });

  it("un estado que no conoce cae en `desconocido`, no en uno inventado", () => {
    // El `status` de EA es texto libre y su lista se edita desde la interfaz de
    // EA: renombrar un estado allá no puede producir acá una pastilla que
    // afirme algo falso.
    expect(resolveStatus("Rescheduled").id).toBe("desconocido");
    expect(resolveStatus("Draft").id).toBe("desconocido");
    expect(resolveStatus("").id).toBe("desconocido");
    expect(resolveStatus(null).id).toBe("desconocido");
    expect(resolveStatus(undefined).id).toBe("desconocido");
  });

  it("normalizeStatusId es un normalizador de texto, no un mapa de EA", () => {
    expect(normalizeStatusId("No asistió")).toBe("no-asistio");
    expect(normalizeStatusId("no_asistio")).toBe("no-asistio");
    // No traduce: eso es de A1/C1.
    expect(normalizeStatusId("Booked")).toBe("booked");
    expect(isStatusId("booked")).toBe(false);
  });
});

describe("paleta de estados — contraste", () => {
  it.each(TOKENS)(
    "la etiqueta de %s mide ≥4.5:1 sobre su propio tinte",
    (token) => {
      const { ink, tint } = STATUS_HEX[token];
      expect(contrastRatio(ink, tint)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(TOKENS)(
    "la etiqueta de %s también mide ≥4.5:1 sobre marfil y sobre crema",
    (token) => {
      // La pastilla no siempre lleva su tinte: en la lista de dos líneas y en
      // la impresión la etiqueta cae sobre el fondo de la página.
      const { ink } = STATUS_HEX[token];
      expect(contrastRatio(ink, PAPER)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ink, CREAM)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(TOKENS)("el punto de %s mide ≥3:1 sobre su tinte", (token) => {
    const { dot, tint } = STATUS_HEX[token];
    expect(contrastRatio(dot, tint)).toBeGreaterThanOrEqual(3);
  });

  it.each(TOKENS)("el punto de %s mide ≥3:1 sobre marfil y crema", (token) => {
    // El mismo tono alimenta después las series de los gráficos de reportes,
    // que se dibujan directo sobre la superficie.
    const { dot } = STATUS_HEX[token];
    expect(contrastRatio(dot, PAPER)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(dot, CREAM)).toBeGreaterThanOrEqual(3);
  });

  it("el filete se ve contra su tinte", () => {
    for (const token of TOKENS) {
      const { line, tint } = STATUS_HEX[token];
      expect(contrastRatio(line, tint)).toBeGreaterThan(1.3);
    }
  });
});

describe("paleta de estados — separación entre tonos", () => {
  /**
   * ΔE euclidiana en OKLab ×100 — la misma métrica y el mismo modelo de
   * simulación (Machado-Oliveira-Fernandes 2009, severidad 1.0) que usa el
   * validador de la skill `dataviz`. Se reimplementa acá para no arrastrar una
   * dependencia por treinta líneas de aritmética.
   */
  const MACHADO = {
    protan: [
      [0.152286, 1.052583, -0.204868],
      [0.114503, 0.786281, 0.099216],
      [-0.003882, -0.048116, 1.051998],
    ],
    deutan: [
      [0.367322, 0.860646, -0.227968],
      [0.280085, 0.672501, 0.047413],
      [-0.01182, 0.04294, 0.968881],
    ],
  } as const;

  const s2lin = (c: number) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

  const lin = (hex: string): [number, number, number] =>
    [0, 2, 4].map((i) =>
      s2lin(parseInt(hex.replace("#", "").slice(i, i + 2), 16) / 255),
    ) as [number, number, number];

  function oklab([r, g, b]: [number, number, number]) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ] as const;
  }

  function simulate(
    hex: string,
    kind: keyof typeof MACHADO,
  ): [number, number, number] {
    const [r, g, b] = lin(hex);
    const M = MACHADO[kind];
    const clamp = (c: number) => Math.max(0, Math.min(1, c));
    return [
      clamp(M[0][0] * r + M[0][1] * g + M[0][2] * b),
      clamp(M[1][0] * r + M[1][1] * g + M[1][2] * b),
      clamp(M[2][0] * r + M[2][1] * g + M[2][2] * b),
    ];
  }

  function deltaE(a: string, b: string, kind?: keyof typeof MACHADO) {
    const x = oklab(kind ? simulate(a, kind) : lin(a));
    const y = oklab(kind ? simulate(b, kind) : lin(b));
    return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
  }

  const dots = STATUS_IDS.map((id) => STATUS_HEX[id].dot);

  it("los cinco puntos se distinguen entre sí con visión normal (ΔE ≥ 15)", () => {
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        expect(
          deltaE(dots[i], dots[j]),
          `${STATUS_IDS[i]} ↔ ${STATUS_IDS[j]}`,
        ).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it("y bajo deuteranopía y protanopía simuladas (ΔE ≥ 8)", () => {
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const worst = Math.min(
          deltaE(dots[i], dots[j], "deutan"),
          deltaE(dots[i], dots[j], "protan"),
        );
        expect(worst, `${STATUS_IDS[i]} ↔ ${STATUS_IDS[j]}`).toBeGreaterThanOrEqual(8);
      }
    }
  });

  it("ningún estado se parece al dorado, que es acción y no dato", () => {
    // Si un punto de estado se acercara al dorado de los botones, el color
    // dejaría de significar "acción" y empezaría a significar dos cosas.
    for (const [i, dot] of dots.entries()) {
      expect(deltaE(dot, "#ac8231"), STATUS_IDS[i]).toBeGreaterThan(12);
    }
  });
});

describe("catálogo", () => {
  it("cada token tiene etiqueta, descripción y sus cuatro hex", () => {
    for (const token of TOKENS) {
      expect(STATUS_META[token].label.length).toBeGreaterThan(0);
      expect(STATUS_META[token].description.length).toBeGreaterThan(0);
      const hex = STATUS_HEX[token];
      for (const v of Object.values(hex)) {
        expect(v).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it("los cinco estados del plan están, y `desconocido` no es uno de ellos", () => {
    expect([...STATUS_IDS]).toEqual([
      "reservada",
      "confirmada",
      "completada",
      "cancelada",
      "no-asistio",
    ]);
    expect(isStatusId("desconocido")).toBe(false);
  });
});
