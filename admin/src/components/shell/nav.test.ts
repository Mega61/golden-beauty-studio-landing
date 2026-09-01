import { describe, expect, it } from "vitest";
import {
  activeDestinationId,
  bottomBarFor,
  DESTINATIONS,
  destinationsFor,
  overflowFor,
} from "./nav";

describe("destinationsFor", () => {
  it("la dueña ve todo", () => {
    expect(destinationsFor("owner")).toHaveLength(DESTINATIONS.length);
  });

  it("la recepción no ve reportes, diagnóstico ni el link a EA", () => {
    const ids = destinationsFor("reception").map((d) => d.id);
    expect(ids).not.toContain("reportes");
    expect(ids).not.toContain("diagnostico");
    expect(ids).not.toContain("avanzado");
    expect(ids).toContain("caja");
  });

  it("la técnica no ve caja, ni clientas, ni a las demás profesionales", () => {
    const ids = destinationsFor("staff").map((d) => d.id);
    expect(ids).toEqual(["hoy", "agenda", "comisiones"]);
  });
});

describe("bottomBarFor", () => {
  it("la recepción tiene los cuatro y sobra para Más", () => {
    expect(bottomBarFor("reception").map((d) => d.id)).toEqual([
      "hoy",
      "agenda",
      "caja",
      "clientas",
    ]);
    expect(overflowFor("reception").map((d) => d.id)).toEqual([
      "comisiones",
      "servicios",
      "equipo",
    ]);
  });

  it("nunca pasa de cuatro: el quinto lugar es siempre Más", () => {
    for (const role of ["owner", "reception", "staff"] as const) {
      expect(bottomBarFor(role).length).toBeLessThanOrEqual(4);
    }
  });

  it("con un rol corto la barra queda corta, no se rellena", () => {
    // Rellenar cinco casillas con un destino que el rol no puede abrir es una
    // simetría bonita que termina en una pantalla de "no autorizado".
    expect(bottomBarFor("staff").map((d) => d.id)).toEqual(["hoy", "agenda"]);
    expect(overflowFor("staff").map((d) => d.id)).toEqual(["comisiones"]);
  });

  it("los cuatro respetan el orden declarado", () => {
    expect(bottomBarFor("owner").map((d) => d.bottom)).toEqual([1, 2, 3, 4]);
  });

  it("todo destino aparece exactamente una vez entre la barra y Más", () => {
    for (const role of ["owner", "reception", "staff"] as const) {
      const all = [...bottomBarFor(role), ...overflowFor(role)].map((d) => d.id);
      expect(new Set(all).size).toBe(all.length);
      expect(all.sort()).toEqual(destinationsFor(role).map((d) => d.id).sort());
    }
  });
});

describe("activeDestinationId", () => {
  it("la raíz solo ilumina Hoy", () => {
    expect(activeDestinationId("/", "owner")).toBe("hoy");
    expect(activeDestinationId("", "owner")).toBe("hoy");
  });

  it("una subruta ilumina su sección", () => {
    expect(activeDestinationId("/clientes/482", "owner")).toBe("clientas");
    expect(activeDestinationId("/agenda", "owner")).toBe("agenda");
    expect(activeDestinationId("/agenda/", "owner")).toBe("agenda");
  });

  it("`/` no es prefijo de todo", () => {
    // El bug clásico de comparar por prefijo: sin el caso especial de la raíz,
    // toda ruta iluminaría Hoy además de su propia sección.
    expect(activeDestinationId("/reportes", "owner")).toBe("reportes");
  });

  it("una ruta que el rol no puede ver no ilumina nada", () => {
    expect(activeDestinationId("/reportes", "staff")).toBeNull();
    expect(activeDestinationId("/caja", "staff")).toBeNull();
  });

  it("una ruta desconocida no ilumina nada", () => {
    expect(activeDestinationId("/no-existe", "owner")).toBeNull();
  });

  it("`/clientesxyz` no ilumina Clientas", () => {
    // Prefijo con la barra, no prefijo a secas.
    expect(activeDestinationId("/clientesxyz", "owner")).toBeNull();
  });

  it("el link externo a EA nunca queda marcado como activo", () => {
    expect(activeDestinationId("/avanzado", "owner")).toBeNull();
  });
});

describe("catálogo", () => {
  it("no hay ids ni rutas repetidas", () => {
    const ids = DESTINATIONS.map((d) => d.id);
    const hrefs = DESTINATIONS.map((d) => d.href);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("las rutas van sin el basePath: Next lo agrega solo", () => {
    for (const d of DESTINATIONS) {
      expect(d.href.startsWith("/admin")).toBe(false);
      expect(d.href.startsWith("/")).toBe(true);
    }
  });
});
