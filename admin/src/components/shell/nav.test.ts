import { readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  activeDestinationId,
  bottomBarFor,
  DESTINATIONS,
  destinationsFor,
  overflowFor,
} from "./nav";

/** La interfaz de EA como la ve un navegador. En local, el puerto de `EA_PORT`. */
const EA = "http://localhost:8081";

describe("destinationsFor", () => {
  it("la dueña ve todo, con la URL de EA configurada", () => {
    expect(destinationsFor("owner", EA)).toHaveLength(DESTINATIONS.length);
  });

  it("sin la URL de EA, «Avanzado» no se dibuja", () => {
    // Un enlace que no lleva a ningún lado es peor que no tener el enlace:
    // cuesta un clic descubrirlo y deja la sensación de que el panel está roto.
    // Estuvo apuntando a `/avanzado`, una ruta que nunca existió.
    const ids = destinationsFor("owner").map((d) => d.id);
    expect(ids).not.toContain("avanzado");
    expect(ids).toHaveLength(DESTINATIONS.length - 1);
  });

  it("con la URL, «Avanzado» apunta a ella y no a una ruta del panel", () => {
    const avanzado = destinationsFor("owner", EA).find((d) => d.id === "avanzado");
    expect(avanzado?.href).toBe(EA);
    expect(avanzado?.external).toBe(true);
  });

  it("la URL de EA no se filtra a los demás destinos", () => {
    for (const d of destinationsFor("owner", EA)) {
      if (d.id !== "avanzado") expect(d.href.startsWith("/"), d.id).toBe(true);
    }
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
      // `avanzado` es el único que no es una ruta del panel: su `href` lo pone
      // `destinationsFor()` desde la configuración del despliegue.
      if (d.id === "avanzado") continue;
      expect(d.href.startsWith("/admin"), d.id).toBe(false);
      expect(d.href.startsWith("/"), d.id).toBe(true);
    }
  });

  it("toda ruta del catálogo existe como pantalla", () => {
    // El bug que este test habría atrapado: «Avanzado (EA)» apuntaba a
    // `/avanzado`, un directorio que nunca se creó. Compilaba, pasaba el lint y
    // abría una pestaña nueva en un 404.
    const pantallas = readdirSync(new URL("../../app/(panel)", import.meta.url), {
      withFileTypes: true,
    })
      .filter((e) => e.isDirectory())
      .map((e) => `/${e.name}`);

    for (const d of DESTINATIONS) {
      if (d.external) continue;
      expect(pantallas, `${d.id} → ${d.href}`).toContain(d.href);
    }
  });
});
