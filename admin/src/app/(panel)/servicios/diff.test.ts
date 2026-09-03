import { describe, expect, it } from "vitest";

import type { Service } from "@/lib/ea";
import type { ServiceMap } from "@/db/types";

import { buildCatalogDiff, publishPayload } from "./diff";
import type { PricingEntry } from "./pricing-parse";

function entry(patch: Partial<PricingEntry> & { id: string }): PricingEntry {
  return {
    id: patch.id,
    categoryId: patch.categoryId ?? "montajes",
    priceCOP: patch.priceCOP ?? 120000,
    durationMin: patch.durationMin === undefined ? 150 : patch.durationMin,
    fromPrice: patch.fromPrice ?? false,
    showcaseOnly: patch.showcaseOnly ?? false,
  };
}

function service(patch: Partial<Service> & { id: number }): Service {
  return {
    id: patch.id,
    name: patch.name ?? "Servicio",
    duration: patch.duration === undefined ? 150 : patch.duration,
    price: patch.price === undefined ? 120000 : patch.price,
    currency: "COP",
    location: null,
    description: null,
    color: null,
    slotInterval: null,
    attendantsNumber: 1,
    isPrivate: false,
    serviceCategoryId: null,
  };
}

function mapping(pricingId: string, eaServiceId: number, published: Date | null = null): ServiceMap {
  return {
    pricing_id: pricingId,
    ea_service_id: eaServiceId,
    last_published_at: published,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe("buildCatalogDiff", () => {
  it("marca al día lo que coincide en precio y duración", () => {
    const diff = buildCatalogDiff(
      [entry({ id: "a", priceCOP: 120000, durationMin: 150 })],
      [service({ id: 1, price: 120000, duration: 150 })],
      [mapping("a", 1)],
    );

    expect(diff.rows).toHaveLength(1);
    expect(diff.rows[0].state).toBe("al-dia");
    expect(diff.rows[0].differing).toEqual([]);
    expect(diff.publishable).toEqual([]);
  });

  it("detecta precio distinto, duración distinta, y las dos a la vez", () => {
    const diff = buildCatalogDiff(
      [
        entry({ id: "precio", priceCOP: 130000, durationMin: 150 }),
        entry({ id: "duracion", priceCOP: 120000, durationMin: 180 }),
        entry({ id: "ambas", priceCOP: 999000, durationMin: 999 }),
      ],
      [service({ id: 1 }), service({ id: 2 }), service({ id: 3 })],
      [mapping("precio", 1), mapping("duracion", 2), mapping("ambas", 3)],
    );

    const byId = new Map(diff.rows.map((r) => [r.pricingId, r]));
    expect(byId.get("precio")?.differing).toEqual(["precio"]);
    expect(byId.get("duracion")?.differing).toEqual(["duracion"]);
    expect(byId.get("ambas")?.differing).toEqual(["precio", "duracion"]);
    expect(diff.counts.desincronizado).toBe(3);
    expect(diff.publishable).toHaveLength(3);
  });

  it("un servicio sin precio en EA cuenta como diferencia, no como coincidencia", () => {
    // Un servicio sin precio congela `null` al agendar y esa cita no se liquida.
    const diff = buildCatalogDiff(
      [entry({ id: "a", priceCOP: 120000 })],
      [service({ id: 1, price: null })],
      [mapping("a", 1)],
    );
    expect(diff.rows[0].differing).toEqual(["precio"]);
  });

  it("la duración null de la vitrina no se publica: un adicional no ocupa tiempo propio", () => {
    // Publicarla pondría en cero la duración de un servicio agendable, y una
    // cita de duración cero rompe la grilla.
    const diff = buildCatalogDiff(
      [entry({ id: "design-per-nail", categoryId: "extras", priceCOP: 10000, durationMin: null })],
      [service({ id: 1, price: 10000, duration: 10 })],
      [mapping("design-per-nail", 1)],
    );
    expect(diff.rows[0].state).toBe("al-dia");
    expect(diff.rows[0].differing).toEqual([]);
  });

  it("un id de la vitrina sin fila en service_map queda sin vincular", () => {
    const diff = buildCatalogDiff([entry({ id: "nuevo" })], [], []);
    expect(diff.rows[0].state).toBe("sin-vincular");
    expect(diff.rows[0].eaServiceId).toBeNull();
    expect(diff.counts["sin-vincular"]).toBe(1);
  });

  it("conserva la marca 'solo vitrina' para que la pantalla no la reclame igual", () => {
    const diff = buildCatalogDiff(
      [entry({ id: "adorno", showcaseOnly: true })],
      [],
      [],
    );
    expect(diff.rows[0].state).toBe("sin-vincular");
    expect(diff.rows[0].showcaseOnly).toBe(true);
  });

  it("una fila del mapa que apunta a un servicio borrado es mapa-roto, no al-dia", () => {
    const diff = buildCatalogDiff([entry({ id: "a" })], [], [mapping("a", 99)]);
    expect(diff.rows[0].state).toBe("mapa-roto");
    expect(diff.rows[0].eaServiceId).toBe(99);
    expect(publishPayload(diff.rows[0])).toBeNull();
  });

  it("un servicio de EA que nadie reclama sale como solo-en-ea", () => {
    const diff = buildCatalogDiff([], [service({ id: 7, name: "Interno" })], []);
    expect(diff.rows[0]).toMatchObject({
      state: "solo-en-ea",
      pricingId: null,
      eaServiceId: 7,
      eaName: "Interno",
    });
  });

  it("ordena primero lo que hay que atender y deja al-dia al final", () => {
    const diff = buildCatalogDiff(
      [
        entry({ id: "ok" }),
        entry({ id: "roto" }),
        entry({ id: "suelto" }),
        entry({ id: "difiere", priceCOP: 999 }),
      ],
      [service({ id: 1 }), service({ id: 4 }), service({ id: 9, name: "Ajeno" })],
      [mapping("ok", 1), mapping("roto", 77), mapping("difiere", 4)],
    );

    expect(diff.rows.map((r) => r.state)).toEqual([
      "desincronizado",
      "sin-vincular",
      "mapa-roto",
      "solo-en-ea",
      "al-dia",
    ]);
  });

  it("el orden es estable: no depende del orden de entrada", () => {
    const a = buildCatalogDiff(
      [entry({ id: "b" }), entry({ id: "a" })],
      [],
      [],
    );
    const b = buildCatalogDiff(
      [entry({ id: "a" }), entry({ id: "b" })],
      [],
      [],
    );
    expect(a.rows.map((r) => r.key)).toEqual(b.rows.map((r) => r.key));
  });

  it("cuenta cada estado", () => {
    const diff = buildCatalogDiff([], [], []);
    expect(diff.counts).toEqual({
      "al-dia": 0,
      desincronizado: 0,
      "sin-vincular": 0,
      "mapa-roto": 0,
      "solo-en-ea": 0,
    });
  });
});

describe("publishPayload", () => {
  it("solo publica lo desincronizado, y solo precio y duración", () => {
    const diff = buildCatalogDiff(
      [entry({ id: "a", priceCOP: 130000, durationMin: 180 })],
      [service({ id: 5, price: 120000, duration: 150, color: "#7cbae8" })],
      [mapping("a", 5)],
    );

    // Ni color ni nombre ni nada más: `service.color` es de solo escritura en
    // la API de EA y un leer-modificar-guardar lo borraría.
    expect(publishPayload(diff.rows[0])).toEqual({
      eaServiceId: 5,
      price: 130000,
      duration: 180,
    });
  });

  it("no publica lo que ya está al día ni lo que no está vinculado", () => {
    const alDia = buildCatalogDiff([entry({ id: "a" })], [service({ id: 1 })], [mapping("a", 1)]);
    expect(publishPayload(alDia.rows[0])).toBeNull();

    const suelto = buildCatalogDiff([entry({ id: "b" })], [], []);
    expect(publishPayload(suelto.rows[0])).toBeNull();
  });

  it("lleva duration null cuando la vitrina dice que el ítem no ocupa tiempo propio", () => {
    const diff = buildCatalogDiff(
      [entry({ id: "extra", durationMin: null, priceCOP: 11000 })],
      [service({ id: 3, price: 10000, duration: 10 })],
      [mapping("extra", 3)],
    );
    expect(publishPayload(diff.rows[0])).toEqual({
      eaServiceId: 3,
      price: 11000,
      duration: null,
    });
  });
});
