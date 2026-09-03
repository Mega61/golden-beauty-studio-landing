import { describe, expect, it } from "vitest";

import {
  FEATURED_EXTRAS,
  PREFERRED_EXTRAS,
  UNCATEGORIZED,
  filterGroups,
  findService,
  groupServicesForPicker,
  isExtrasCategory,
  mainServices,
  normalizeName,
  orderExtras,
  type CatalogService,
  type TicketCatalog,
} from "./catalog";

function service(over: Partial<CatalogService> & { eaServiceId: number }): CatalogService {
  return {
    name: `Servicio ${over.eaServiceId}`,
    listPrice: 10_000,
    durationMin: 60,
    categoryId: 1,
    categoryName: "Montajes",
    pricingId: null,
    isExtra: false,
    ...over,
  };
}

const CATALOGO: TicketCatalog = {
  services: [
    service({ eaServiceId: 1, name: "Press-on", categoryName: "Montajes", pricingId: "press-on" }),
    service({
      eaServiceId: 2,
      name: "Polygel esculpida",
      categoryName: "Montajes",
      pricingId: "polygel-sculpted",
    }),
    service({
      eaServiceId: 3,
      name: "Forrado en acrílico",
      categoryId: 2,
      categoryName: "Forrados",
      pricingId: "acrylic-overlay",
    }),
    service({
      eaServiceId: 10,
      name: "Diseño por uña",
      categoryId: 9,
      categoryName: "Extras",
      pricingId: "design-per-nail",
      isExtra: true,
      listPrice: 10_000,
    }),
    service({
      eaServiceId: 11,
      name: "Retiro de sistema",
      categoryId: 9,
      categoryName: "Extras",
      pricingId: "system-removal",
      isExtra: true,
      listPrice: 20_000,
    }),
    service({
      eaServiceId: 12,
      name: "Aromaterapia",
      categoryId: 9,
      categoryName: "Extras",
      pricingId: null,
      isExtra: true,
      listPrice: 5_000,
    }),
  ],
};

describe("normalizeName", () => {
  it("borra tildes, mayúsculas y espacios de sobra", () => {
    expect(normalizeName("  Adicionáles  ")).toBe("adicionales");
    expect(normalizeName("EXTRAS")).toBe("extras");
  });
});

describe("isExtrasCategory", () => {
  it("reconoce el id de la vitrina y las formas que una persona escribiría", () => {
    expect(isExtrasCategory("extras")).toBe(true);
    expect(isExtrasCategory("Extras")).toBe(true);
    expect(isExtrasCategory("Adicionales")).toBe(true);
    expect(isExtrasCategory("adicional")).toBe(true);
    expect(isExtrasCategory("extra")).toBe(true);
  });

  it("no confunde otra categoría con la de adicionales", () => {
    expect(isExtrasCategory("Montajes")).toBe(false);
    expect(isExtrasCategory("")).toBe(false);
    expect(isExtrasCategory(null)).toBe(false);
    expect(isExtrasCategory(undefined)).toBe(false);
  });
});

describe("findService", () => {
  it("encuentra por id y devuelve null sin id", () => {
    expect(findService(CATALOGO, 3)?.name).toBe("Forrado en acrílico");
    expect(findService(CATALOGO, null)).toBeNull();
    expect(findService(CATALOGO, 999)).toBeNull();
  });
});

describe("mainServices", () => {
  it("deja fuera los adicionales: no son 'lo que se hizo'", () => {
    expect(mainServices(CATALOGO).map((s) => s.eaServiceId)).toEqual([1, 2, 3]);
  });
});

describe("orderExtras", () => {
  it("pone los preferidos adelante, en el orden del plan", () => {
    expect(orderExtras(CATALOGO).map((s) => s.pricingId)).toEqual([
      "design-per-nail",
      "system-removal",
      null,
    ]);
  });

  it("ordena por nombre lo que no está en la lista de preferidos", () => {
    const catalogo: TicketCatalog = {
      services: [
        service({ eaServiceId: 20, name: "Zeta", isExtra: true, pricingId: null }),
        service({ eaServiceId: 21, name: "Alfa", isExtra: true, pricingId: null }),
      ],
    };
    expect(orderExtras(catalogo).map((s) => s.name)).toEqual(["Alfa", "Zeta"]);
  });

  it("acepta un orden inyectado, que es cómo entrará el ranking medido", () => {
    const orden = orderExtras(CATALOGO, ["system-removal"]);
    expect(orden[0].pricingId).toBe("system-removal");
  });

  it("los cinco destacados son un tope, no un supuesto sobre el catálogo", () => {
    expect(FEATURED_EXTRAS).toBe(5);
    expect(PREFERRED_EXTRAS.length).toBeGreaterThanOrEqual(FEATURED_EXTRAS);
  });
});

describe("groupServicesForPicker", () => {
  it("abre con la categoría del servicio actual, aunque no sea la primera", () => {
    // Alfabéticamente Forrados va antes que Montajes; con un press-on agendado
    // el que tiene que estar arriba es Montajes.
    expect(groupServicesForPicker(CATALOGO, 1).map((g) => g.categoryName)).toEqual([
      "Montajes",
      "Forrados",
    ]);
  });

  it("no reordena de más cuando la categoría del actual ya era la primera", () => {
    expect(groupServicesForPicker(CATALOGO, 3).map((g) => g.categoryName)).toEqual([
      "Forrados",
      "Montajes",
    ]);
  });

  it("no reordena si no hay servicio elegido", () => {
    expect(groupServicesForPicker(CATALOGO, null).map((g) => g.categoryName)).toEqual([
      "Forrados",
      "Montajes",
    ]);
  });

  it("no reordena por un adicional: los adicionales no son servicio realizado", () => {
    expect(groupServicesForPicker(CATALOGO, 10).map((g) => g.categoryName)).toEqual([
      "Forrados",
      "Montajes",
    ]);
  });

  it("manda al final los que EA dejó sin categoría, pero no los esconde", () => {
    const catalogo: TicketCatalog = {
      services: [
        service({ eaServiceId: 30, name: "Suelto", categoryId: null, categoryName: "" }),
        service({ eaServiceId: 31, name: "Con casa", categoryName: "Montajes" }),
      ],
    };
    const grupos = groupServicesForPicker(catalogo, 30);
    expect(grupos.map((g) => g.categoryName)).toEqual(["Montajes", UNCATEGORIZED]);
    expect(grupos[1].services.map((s) => s.name)).toEqual(["Suelto"]);
  });

  it("los deja al final también cuando vienen últimos de EA", () => {
    const catalogo: TicketCatalog = {
      services: [
        service({ eaServiceId: 31, name: "Con casa", categoryName: "Montajes" }),
        service({ eaServiceId: 30, name: "Suelto", categoryId: null, categoryName: "" }),
      ],
    };
    expect(groupServicesForPicker(catalogo, null).map((g) => g.categoryName)).toEqual([
      "Montajes",
      UNCATEGORIZED,
    ]);
  });

  it("ordena los servicios dentro de cada categoría por nombre", () => {
    const grupos = groupServicesForPicker(CATALOGO, null);
    expect(grupos[1].services.map((s) => s.name)).toEqual(["Polygel esculpida", "Press-on"]);
  });
});

describe("filterGroups", () => {
  const grupos = groupServicesForPicker(CATALOGO, null);

  it("sin texto devuelve todo", () => {
    expect(filterGroups(grupos, "").length).toBe(grupos.length);
    expect(filterGroups(grupos, "   ").length).toBe(grupos.length);
  });

  it("busca sin tildes y sin mayúsculas", () => {
    const r = filterGroups(grupos, "ACRILICO");
    expect(r).toHaveLength(1);
    expect(r[0].services.map((s) => s.name)).toEqual(["Forrado en acrílico"]);
  });

  it("descarta los grupos que quedan vacíos", () => {
    expect(filterGroups(grupos, "polygel").map((g) => g.categoryName)).toEqual(["Montajes"]);
  });

  it("sin coincidencias devuelve vacío, no el catálogo entero", () => {
    expect(filterGroups(grupos, "zzz")).toEqual([]);
  });
});
