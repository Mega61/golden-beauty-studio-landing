import { describe, expect, it } from "vitest";

import {
  classifyServiceName,
  suggestService,
  systemOfPricingId,
  type SuggestionCatalog,
} from "./service-suggestion";

/**
 * Un catálogo de EA de juguete: ids de EA = 100 + posición. Lo que importa es
 * que la sugerencia salga en ids de EA y solo de lo que existe.
 */
const PRICING_IDS = [
  "polygel-sculpted",
  "polygel-refill",
  "acrylic-sculpted",
  "acrylic-refill",
  "builder-gel-overlay",
  "builder-gel-refill",
  "semi-permanent-hands",
  "polygel-overlay-hands-semi-feet",
  "polygel-overlay",
  "semi-permanent-feet",
];
const EA: Record<string, number> = Object.fromEntries(PRICING_IDS.map((id, i) => [id, 100 + i]));

const NAMES: Record<string, string> = {
  "polygel-sculpted": "Esculpidas en polygel",
  "polygel-refill": "Retoque polygel",
  "acrylic-sculpted": "Esculpidas en acrílico",
  "acrylic-refill": "Retoque acrílico",
  "builder-gel-overlay": "Forrado en builder gel",
  "builder-gel-refill": "Retoque builder gel",
  "semi-permanent-hands": "Semipermanente manos",
  "polygel-overlay-hands-semi-feet": "Forrado polygel manos + semi pies",
  "polygel-overlay": "Forrado en polygel",
  "semi-permanent-feet": "Semipermanente pies",
};

function catalog(patch: { without?: string[]; extra?: Array<{ id: number; name: string }> } = {}): SuggestionCatalog {
  const kept = PRICING_IDS.filter((id) => !(patch.without ?? []).includes(id));
  return {
    services: [...kept.map((id) => ({ id: EA[id], name: NAMES[id] })), ...(patch.extra ?? [])],
    eaIdOfPricing: new Map(kept.map((id) => [id, EA[id]])),
  };
}

describe("classifyServiceName", () => {
  it("reconoce los nombres de la vitrina tal cual, sin importar tildes ni mayúsculas", () => {
    expect(classifyServiceName("  RETOQUE   polygel ")).toEqual({
      pricingId: "polygel-refill",
      system: "polygel",
      isRetouch: true,
    });
    expect(classifyServiceName("forrado en builder gel").pricingId).toBe("builder-gel-overlay");
    expect(classifyServiceName("Semipermanente manos")).toEqual({
      pricingId: "semi-permanent-hands",
      system: null,
      isRetouch: false,
    });
  });

  it("lee los nombres a mano de Agenda Pro por sistema y clase de trabajo", () => {
    expect(classifyServiceName("Polygel esculpido").pricingId).toBe("polygel-sculpted");
    expect(classifyServiceName("Acrílicas esculpidas").pricingId).toBe("acrylic-sculpted");
    expect(classifyServiceName("Retoque de acrílico").pricingId).toBe("acrylic-refill");
    expect(classifyServiceName("Retoque acrílicas").pricingId).toBe("acrylic-refill");
    expect(classifyServiceName("Polygel dual").pricingId).toBe("polygel-dual");
    expect(classifyServiceName("Uñas acrílicas, forrado").pricingId).toBe("acrylic-overlay");
  });

  it("sabe el sistema aunque no sepa el servicio exacto", () => {
    expect(classifyServiceName("Uñas acrílicas")).toEqual({
      pricingId: null,
      system: "acrylic",
      isRetouch: false,
    });
    // No existe "dual en acrílico" en la vitrina: el sistema sí se sabe.
    expect(classifyServiceName("Acrílico dual")).toMatchObject({ pricingId: null, system: "acrylic" });
  });

  it("un retiro no es un trabajo del sistema", () => {
    expect(classifyServiceName("Retiro de acrílico")).toEqual({
      pricingId: null,
      system: null,
      isRetouch: false,
    });
  });

  it("'Retoque' a secas es retoque sin sistema", () => {
    expect(classifyServiceName("Retoque")).toEqual({ pricingId: null, system: null, isRetouch: true });
  });

  it("la nivelación rubber no es builder gel", () => {
    expect(classifyServiceName("Nivelación base rubber")).toEqual({
      pricingId: "rubber-base-leveling",
      system: null,
      isRetouch: false,
    });
  });

  it("lo que no reconoce queda vacío", () => {
    expect(classifyServiceName("Masaje de manos")).toEqual({ pricingId: null, system: null, isRetouch: false });
    expect(classifyServiceName("")).toEqual({ pricingId: null, system: null, isRetouch: false });
    expect(classifyServiceName(null)).toEqual({ pricingId: null, system: null, isRetouch: false });
  });
});

describe("systemOfPricingId", () => {
  it("un combo cuenta por su mitad de manos", () => {
    expect(systemOfPricingId("polygel-overlay-hands-semi-feet")).toBe("polygel");
    expect(systemOfPricingId("acrylic-overlay-hands-semi-feet")).toBe("acrylic");
    expect(systemOfPricingId("semi-permanent-hands-feet")).toBeNull();
  });
});

describe("suggestService", () => {
  it("sin visitas no hay sugerencia", () => {
    expect(suggestService([], catalog())).toBeNull();
  });

  it("después de un montaje de polygel toca el retoque de polygel", () => {
    const s = suggestService(
      [{ serviceName: "Esculpidas en polygel", serviceId: EA["polygel-sculpted"] }],
      catalog(),
    );
    expect(s).toEqual({
      serviceId: EA["polygel-refill"],
      label: "Agendar retoque de Polygel",
      reason: "Su última visita fue Esculpidas en polygel.",
      kind: "retoque",
    });
  });

  it("después de un retoque toca otro retoque del mismo sistema", () => {
    const s = suggestService([{ serviceName: "Retoque acrílico", serviceId: EA["acrylic-refill"] }], catalog());
    expect(s?.serviceId).toBe(EA["acrylic-refill"]);
    expect(s?.label).toBe("Agendar retoque de Acrílico");
  });

  it("un forrado de builder gel se retoca como builder gel", () => {
    const s = suggestService(
      [{ serviceName: "Forrado en builder gel", serviceId: EA["builder-gel-overlay"] }],
      catalog(),
    );
    expect(s?.serviceId).toBe(EA["builder-gel-refill"]);
  });

  it("un combo se decide por sus manos", () => {
    const s = suggestService(
      [{ serviceName: "Forrado polygel manos + semi pies", serviceId: EA["polygel-overlay-hands-semi-feet"] }],
      catalog(),
    );
    expect(s?.serviceId).toBe(EA["polygel-refill"]);
  });

  it("solo decide la visita más reciente", () => {
    const s = suggestService(
      [
        { serviceName: "Semipermanente manos", serviceId: EA["semi-permanent-hands"] },
        { serviceName: "Esculpidas en polygel", serviceId: EA["polygel-sculpted"] },
      ],
      catalog(),
    );
    expect(s).toMatchObject({ kind: "repetir", serviceId: EA["semi-permanent-hands"], label: "Repetir: Semipermanente manos" });
  });

  it("lo que no es de un sistema se repite, con el nombre de hoy en EA", () => {
    const s = suggestService(
      [{ serviceName: "Semipermanente manos", serviceId: EA["semi-permanent-hands"] }],
      catalog(),
    );
    expect(s).toEqual({
      serviceId: EA["semi-permanent-hands"],
      label: "Repetir: Semipermanente manos",
      reason: "Su última visita fue Semipermanente manos.",
      kind: "repetir",
    });
  });

  it("Agenda Pro: el sistema sale del nombre", () => {
    const s = suggestService([{ serviceName: "Acrílicas esculpidas", serviceId: null }], catalog());
    expect(s?.serviceId).toBe(EA["acrylic-refill"]);
  });

  it("Agenda Pro: 'Uñas acrílicas' alcanza para saber que es retoque de acrílico", () => {
    const s = suggestService([{ serviceName: "Uñas acrílicas", serviceId: null }], catalog());
    expect(s?.serviceId).toBe(EA["acrylic-refill"]);
  });

  it("Agenda Pro: un servicio sin sistema se repite por su nombre de vitrina", () => {
    const s = suggestService([{ serviceName: "semipermanente MANOS", serviceId: null }], catalog());
    expect(s).toMatchObject({ kind: "repetir", serviceId: EA["semi-permanent-hands"] });
  });

  it("Agenda Pro: un servicio sin sistema se repite si su nombre es el de un servicio de EA", () => {
    const s = suggestService(
      [{ serviceName: "Spa de manos", serviceId: null }],
      catalog({ extra: [{ id: 900, name: "Spa de manos" }] }),
    );
    expect(s).toMatchObject({ kind: "repetir", serviceId: 900 });
  });

  it("Agenda Pro: lo que no se reconoce no sugiere nada", () => {
    expect(suggestService([{ serviceName: "Masaje", serviceId: null }], catalog())).toBeNull();
  });

  it("'Retoque' a secas busca el sistema en las visitas anteriores", () => {
    const s = suggestService(
      [
        { serviceName: "Retoque", serviceId: null },
        { serviceName: "Polygel esculpido", serviceId: null },
      ],
      catalog(),
    );
    expect(s?.serviceId).toBe(EA["polygel-refill"]);
  });

  it("'Retoque' a secas sin nada antes no sugiere", () => {
    expect(suggestService([{ serviceName: "Retoque", serviceId: null }], catalog())).toBeNull();
  });

  it("un servicio de EA sin vincular se lee por su nombre", () => {
    const s = suggestService(
      [{ serviceName: "Retoque builder gel (viejo)", serviceId: 777 }],
      catalog(),
    );
    expect(s?.serviceId).toBe(EA["builder-gel-refill"]);
  });

  it("si el retoque no está publicado en EA, no inventa nada", () => {
    const s = suggestService(
      [{ serviceName: "Esculpidas en polygel", serviceId: EA["polygel-sculpted"] }],
      catalog({ without: ["polygel-refill"] }),
    );
    expect(s).toBeNull();
  });

  it("si el servicio a repetir ya no existe en EA, no sugiere", () => {
    const s = suggestService(
      [{ serviceName: "Semipermanente manos", serviceId: EA["semi-permanent-hands"] }],
      catalog({ without: ["semi-permanent-hands"] }),
    );
    expect(s).toBeNull();
  });
});
