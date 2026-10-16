import { describe, expect, it } from "vitest";

import { buildCatalogDiff } from "@/app/(panel)/servicios/diff";
import { parsePricingSource, type PricingEntry } from "@/app/(panel)/servicios/pricing-parse";
import { SERVICE_CATEGORIES, SERVICE_NAMES } from "@/data/service-names";
import { SHOWCASE_PRICING_SOURCE } from "@/data/showcase-pricing";
import type { ServiceMap } from "@/db/types";
import type { Service } from "@/lib/ea";

import {
  bookableServiceIds,
  describeStep,
  parseProviderIds,
  planCatalogSetup,
  planProviderServices,
  type CatalogStep,
} from "./catalog-setup";

function entry(patch: Partial<PricingEntry> & { id: string }): PricingEntry {
  return {
    id: patch.id,
    categoryId: patch.categoryId ?? "montajes",
    priceCOP: patch.priceCOP ?? 120000,
    durationMin: patch.durationMin === undefined ? 150 : patch.durationMin,
    fromPrice: false,
    showcaseOnly: patch.showcaseOnly ?? false,
    composedOf: null,
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

function mapping(pricingId: string, eaServiceId: number): ServiceMap {
  return {
    pricing_id: pricingId,
    ea_service_id: eaServiceId,
    last_published_at: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

const kinds = (steps: CatalogStep[]) => Object.fromEntries(steps.map((s) => [s.pricingId, s.kind]));

describe("planCatalogSetup", () => {
  it("en una EA recién instalada, crea todo lo agendable con el nombre de la landing", () => {
    const showcase = parsePricingSource(SHOWCASE_PRICING_SOURCE);
    // Lo que trae una EA nueva: un servicio de ejemplo y ningún vínculo.
    const diff = buildCatalogDiff(showcase, [service({ id: 1, name: "Service" })], []);

    const plan = planCatalogSetup({
      rows: diff.rows,
      names: SERVICE_NAMES,
      order: Object.keys(SERVICE_NAMES),
    });

    expect(plan.steps.map((s) => s.pricingId)).toEqual(Object.keys(SERVICE_NAMES));
    // Lo único que no se crea es lo que `createPayload()` rechaza: los
    // adicionales sin duración propia.
    const blocked = plan.steps.filter((s) => s.kind === "bloqueado").map((s) => s.pricingId);
    expect(blocked).toEqual(showcase.filter((e) => e.durationMin === null).map((e) => e.id));
    expect(plan.counts.crear).toBe(showcase.length - blocked.length);
    expect(plan.counts.vinculado).toBe(0);
    expect(plan.unclaimed).toEqual([{ eaServiceId: 1, name: "Service" }]);

    for (const step of plan.steps) {
      if (step.kind !== "crear") continue;
      const source = showcase.find((e) => e.id === step.pricingId)!;
      expect(step.payload).toEqual({
        name: SERVICE_NAMES[step.pricingId],
        price: source.priceCOP,
        duration: source.durationMin,
        attendantsNumber: 1,
      });
    }

    // Los combos también: son los que la pantalla no podía crear sin tipear.
    const combo = plan.steps.find((s) => s.pricingId === "semi-permanent-hands-feet");
    expect(combo?.kind).toBe("crear");
    expect(combo && describeStep(combo)).toContain('"Semipermanente manos + pies"');
  });

  it("es idempotente: sobre lo que dejó la primera corrida, no hay nada que hacer", () => {
    const showcase = [entry({ id: "a" }), entry({ id: "b", durationMin: 60, priceCOP: 50000 })];
    const names = { a: "Servicio A", b: "Servicio B" };

    const first = planCatalogSetup({ rows: buildCatalogDiff(showcase, [], []).rows, names });
    expect(first.counts).toEqual({ crear: 2, vincular: 0, vinculado: 0, bloqueado: 0 });

    // Lo que quedó en EA y en el mapa después de aplicar el primer plan.
    const services: Service[] = [];
    const map: ServiceMap[] = [];
    first.steps.forEach((step, index) => {
      if (step.kind !== "crear") return;
      services.push(
        service({
          id: 100 + index,
          name: step.payload.name,
          price: step.payload.price,
          duration: step.payload.duration,
        }),
      );
      map.push(mapping(step.pricingId, 100 + index));
    });

    const second = planCatalogSetup({ rows: buildCatalogDiff(showcase, services, map).rows, names });
    expect(second.counts).toEqual({ crear: 0, vincular: 0, vinculado: 2, bloqueado: 0 });
    expect(second.steps.every((s) => s.kind === "vinculado" && !s.desincronizado)).toBe(true);
  });

  it("no toca lo ya vinculado, y avisa si quedó desincronizado", () => {
    const rows = buildCatalogDiff(
      [entry({ id: "a", priceCOP: 130000 })],
      [service({ id: 7, name: "A", price: 120000 })],
      [mapping("a", 7)],
    ).rows;

    const [step] = planCatalogSetup({ rows, names: { a: "A" } }).steps;
    expect(step).toMatchObject({ kind: "vinculado", eaServiceId: 7, desincronizado: true });
    expect(describeStep(step)).toContain("publicar desde Servicios");
  });

  it("bloquea con motivo: sin nombre, sin duración, solo vitrina y mapa roto", () => {
    const rows = buildCatalogDiff(
      [
        entry({ id: "sin-nombre" }),
        entry({ id: "adicional", categoryId: "extras", durationMin: null }),
        entry({ id: "vitrina", showcaseOnly: true }),
        entry({ id: "roto" }),
      ],
      [],
      [mapping("roto", 99)],
    ).rows;

    const plan = planCatalogSetup({
      rows,
      names: { adicional: "Adicional", vitrina: "Vitrina", roto: "Roto" },
    });

    expect(kinds(plan.steps)).toEqual({
      "sin-nombre": "bloqueado",
      adicional: "bloqueado",
      vitrina: "bloqueado",
      roto: "bloqueado",
    });
    const reason = (id: string) =>
      (plan.steps.find((s) => s.pricingId === id) as { reason: string }).reason;
    expect(reason("sin-nombre")).toContain("es.json");
    expect(reason("adicional")).toContain("duración");
    expect(reason("vitrina")).toContain("solo vitrina");
    expect(reason("roto")).toContain("99");
  });

  it("vincula en vez de duplicar un servicio huérfano con el mismo nombre", () => {
    // Lo que deja una corrida anterior cuyo vínculo falló: creado en EA, sin fila
    // en el mapa.
    const rows = buildCatalogDiff(
      [entry({ id: "a" }), entry({ id: "b" })],
      [service({ id: 5, name: "  servicio a " }), service({ id: 6, name: "Otro" })],
      [],
    ).rows;

    const plan = planCatalogSetup({ rows, names: { a: "Servicio A", b: "Servicio B" } });
    expect(plan.steps.find((s) => s.pricingId === "a")).toMatchObject({
      kind: "vincular",
      eaServiceId: 5,
    });
    expect(plan.steps.find((s) => s.pricingId === "b")?.kind).toBe("crear");
    expect(plan.unclaimed).toEqual([{ eaServiceId: 6, name: "Otro" }]);
  });

  it("no reclama un huérfano cuyo nombre está repetido en la agenda", () => {
    const rows = buildCatalogDiff(
      [entry({ id: "a" })],
      [service({ id: 5, name: "A" }), service({ id: 6, name: "A" })],
      [],
    ).rows;
    expect(planCatalogSetup({ rows, names: { a: "A" } }).steps[0].kind).toBe("crear");
  });
});

describe("parseProviderIds", () => {
  it("lee la lista y quita repetidos", () => {
    expect(parseProviderIds(["--aplicar", "--asignar=2,5,2"])).toEqual([2, 5]);
    expect(parseProviderIds(["--aplicar"])).toEqual([]);
  });

  it("rechaza lo que no sea una lista de enteros positivos", () => {
    for (const bad of ["--asignar", "--asignar=", "--asignar=0", "--asignar=2,x", "--asignar=2,,3"]) {
      expect(() => parseProviderIds([bad]), bad).toThrow(/--asignar/);
    }
  });
});

describe("planProviderServices", () => {
  it("solo agrega, y conserva lo que la técnica ya tenía", () => {
    expect(planProviderServices([9, 3], [1, 3, 4])).toEqual({ add: [1, 4], next: [9, 3, 1, 4] });
  });

  it("no hace nada si ya los tenía todos", () => {
    expect(planProviderServices([1, 2, 3], [3, 1])).toEqual({ add: [], next: [1, 2, 3] });
    expect(planProviderServices(null, [])).toEqual({ add: [], next: [] });
  });
});

describe("bookableServiceIds", () => {
  it("son los vinculados que existen en EA, no los huérfanos ni el mapa roto", () => {
    const rows = buildCatalogDiff(
      [entry({ id: "a" }), entry({ id: "b", priceCOP: 1 }), entry({ id: "c" }), entry({ id: "d" })],
      [service({ id: 1 }), service({ id: 2 }), service({ id: 3 })],
      [mapping("a", 1), mapping("b", 2), mapping("c", 99)],
    ).rows;
    expect(bookableServiceIds(rows)).toEqual([1, 2]);
  });
});

describe("los datos horneados", () => {
  it("cada id de la vitrina tiene nombre, y cada categoría su etiqueta", () => {
    const showcase = parsePricingSource(SHOWCASE_PRICING_SOURCE);
    expect(Object.keys(SERVICE_NAMES).sort()).toEqual(showcase.map((e) => e.id).sort());
    expect(SERVICE_CATEGORIES.map((c) => c.id)).toEqual([...new Set(showcase.map((e) => e.categoryId))]);
    for (const c of SERVICE_CATEGORIES) expect(c.label).not.toBe("");
  });
});
