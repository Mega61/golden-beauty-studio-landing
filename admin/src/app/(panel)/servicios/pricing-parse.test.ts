import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PricingParseError,
  parsePricingSource,
  stripComments,
} from "./pricing-parse";
import { LANDING_PRICING_RELATIVE_PATH } from "./pricing-source";

const MINIMO = `
export const pricing: readonly PriceCategory[] = [
  {
    id: "montajes",
    items: [
      { id: "polygel-sculpted", priceCOP: 120000, durationMin: 150 },
      { id: "press-on", priceCOP: 100000, durationMin: 105, fromPrice: true },
    ],
  },
  {
    id: "extras",
    items: [
      { id: "design-per-nail", priceCOP: 10000, durationMin: null },
    ],
  },
] as const;
`;

describe("stripComments", () => {
  it("quita comentarios de línea y de bloque", () => {
    expect(stripComments("a // hola\nb")).toBe("a \nb");
    expect(stripComments("a /* hola\nmundo */ b")).toBe("a  b");
  });

  it("no toca un // que vive dentro de una cadena", () => {
    expect(stripComments('const u = "https://x.com/y"; // fuera')).toBe(
      'const u = "https://x.com/y"; ',
    );
  });

  it("respeta comillas simples, plantillas y escapes", () => {
    expect(stripComments("const a = 'no // es';")).toBe("const a = 'no // es';");
    expect(stripComments("const a = `no /* es */`;")).toBe("const a = `no /* es */`;");
    expect(stripComments('const a = "esc \\" // adentro";')).toBe(
      'const a = "esc \\" // adentro";',
    );
  });

  it("una cadena sin cerrar no cuelga el parser", () => {
    expect(stripComments('const a = "sin cerrar')).toBe('const a = "sin cerrar');
  });
});

describe("parsePricingSource", () => {
  it("lee categorías, ids, precios y duraciones", () => {
    const entradas = parsePricingSource(MINIMO);

    expect(entradas).toEqual([
      {
        id: "polygel-sculpted",
        categoryId: "montajes",
        priceCOP: 120000,
        durationMin: 150,
        fromPrice: false,
        showcaseOnly: false,
      },
      {
        id: "press-on",
        categoryId: "montajes",
        priceCOP: 100000,
        durationMin: 105,
        fromPrice: true,
        showcaseOnly: false,
      },
      {
        id: "design-per-nail",
        categoryId: "extras",
        priceCOP: 10000,
        durationMin: null,
        fromPrice: false,
        showcaseOnly: false,
      },
    ]);
  });

  it("reconoce la marca 'solo vitrina' que el plan pide y pricing.ts todavía no trae", () => {
    const [entrada] = parsePricingSource(`
      export const pricing = [
        { id: "extras", items: [
          { id: "design-per-nail", priceCOP: 10000, durationMin: null, showcaseOnly: true },
        ] },
      ] as const;
    `);
    expect(entrada.showcaseOnly).toBe(true);
  });

  it("ignora los comentarios del archivo real", () => {
    const entradas = parsePricingSource(`
      // un comentario con { id: "trampa", priceCOP: 1, durationMin: 1 }
      export const pricing = [
        { id: "montajes", items: [
          /* otro */ { id: "real", priceCOP: 1000, durationMin: 30 },
        ] },
      ];
    `);
    expect(entradas.map((e) => e.id)).toEqual(["real"]);
  });

  it("lanza si no encuentra el arreglo, en vez de devolver una lista vacía", () => {
    expect(() => parsePricingSource("export const otraCosa = [];")).toThrow(
      PricingParseError,
    );
  });

  it("lanza si el arreglo queda sin cerrar", () => {
    expect(() => parsePricingSource("export const pricing = [ { id: 'x',")).toThrow(
      /sin cerrar/,
    );
  });

  it("lanza si el arreglo existe pero no produjo ninguna entrada", () => {
    // Es el caso peligroso: sin esto, la pantalla de diff mostraría todo el
    // catálogo de EA como sobrante y ofrecería desvincularlo.
    expect(() => parsePricingSource("export const pricing = [];")).toThrow(/vacía/);
  });

  it("lanza si un ítem no tiene precio o duración", () => {
    expect(() =>
      parsePricingSource(
        'export const pricing = [{ id: "c", items: [{ id: "x", durationMin: 30 }] }];',
      ),
    ).toThrow(/priceCOP/);
    expect(() =>
      parsePricingSource(
        'export const pricing = [{ id: "c", items: [{ id: "x", priceCOP: 1000 }] }];',
      ),
    ).toThrow(/durationMin/);
  });

  it("lanza si un id se repite: es la llave de service_map", () => {
    expect(() =>
      parsePricingSource(`
        export const pricing = [
          { id: "a", items: [{ id: "x", priceCOP: 1, durationMin: 1 }] },
          { id: "b", items: [{ id: "x", priceCOP: 2, durationMin: 2 }] },
        ];
      `),
    ).toThrow(/dos veces/);
  });

  it("lanza si un ítem no tiene id", () => {
    expect(() =>
      parsePricingSource(
        'export const pricing = [{ id: "c", items: [{ priceCOP: 1, durationMin: 1 }] }];',
      ),
    ).toThrow(/no tiene id/);
  });

  it("lanza si un precio no es entero", () => {
    expect(() =>
      parsePricingSource(
        'export const pricing = [{ id: "c", items: [{ id: "x", priceCOP: "mucho", durationMin: 1 }] }];',
      ),
    ).toThrow(/no es un entero/);
  });
});

describe("contra el archivo real de la landing", () => {
  // No es un test de integración disfrazado: `pricing.ts` está en el mismo
  // repositorio y es el único contrato que este parser tiene que cumplir. Si
  // alguien le cambia la forma, el que se entera es este test y no la dueña
  // mirando una pantalla de diff vacía.
  const source = readFileSync(LANDING_PRICING_RELATIVE_PATH, "utf8");
  const entradas = parsePricingSource(source);

  it("lee las seis categorías de la vitrina", () => {
    expect([...new Set(entradas.map((e) => e.categoryId))]).toEqual([
      "montajes",
      "retoques",
      "forrados",
      "sencillos",
      "combos",
      "extras",
    ]);
  });

  it("lee todos los ítems con precio positivo y sin ids repetidos", () => {
    expect(entradas.length).toBeGreaterThanOrEqual(25);
    expect(new Set(entradas.map((e) => e.id)).size).toBe(entradas.length);
    expect(entradas.every((e) => e.priceCOP > 0)).toBe(true);
  });

  it("lee bien un ítem que se puede verificar a ojo en el archivo", () => {
    expect(entradas.find((e) => e.id === "acrylic-sculpted")).toEqual({
      id: "acrylic-sculpted",
      categoryId: "montajes",
      priceCOP: 115000,
      durationMin: 150,
      fromPrice: false,
      showcaseOnly: false,
    });
  });

  it("respeta el durationMin null de un adicional que no ocupa tiempo propio", () => {
    expect(entradas.find((e) => e.id === "design-per-nail")?.durationMin).toBeNull();
  });
});
