import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `loadAvailability` lee los puestos de `gbs_admin`. En este test nunca llega
// a pedirlos —corta antes, en el servicio—, pero el import tiene que resolver
// sin una base de verdad.
vi.mock("@/db/client", () => ({ getDb: () => ({}) }));
vi.mock("@/db/repositories", () => ({
  stationRepository: () => ({ listAll: async () => [] }),
}));

import { sharedEaCache } from "@/lib/ea/cache";
import { createCachedEaClient } from "@/lib/ea/client";
import { createBooking } from "./data";

/**
 * La garantía que hace segura toda la caché de la reserva pública: **el camino
 * que escribe no lee de memoria.** Se fuerza el peor caso —la caché tiene el
 * servicio, EA ya no— y se exige que `createBooking` lo vea.
 */

const service = {
  id: 17,
  name: "Semipermanente",
  duration: 60,
  price: 80000,
  currency: "COP",
  location: null,
  description: null,
  slotInterval: 15,
  attendantsNumber: 1,
  isPrivate: false,
  serviceCategoryId: null,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createBooking", () => {
  let published = true;
  const gets: string[] = [];

  beforeEach(() => {
    published = true;
    gets.length = 0;
    sharedEaCache().clear();
    vi.stubEnv("EA_API_URL", "http://ea.test/index.php/api/v1/");
    vi.stubEnv("EA_API_TOKEN", "un-token-de-prueba-largo");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo) => {
        const url = new URL(String(input));
        const resource = url.pathname.split("/").pop();
        gets.push(resource ?? "");
        if (resource === "services") return json(published ? [service] : []);
        return json([]);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    sharedEaCache().clear();
  });

  it("re-verifica contra EA aunque la caché tenga el dato, y ve el cambio", async () => {
    // La landing ya consultó: el servicio quedó en caché como reservable.
    const cached = await createCachedEaClient().services.list();
    expect(cached.map((s) => s.id)).toEqual([17]);

    // En EA lo despublicaron después. La caché todavía no se enteró.
    published = false;
    gets.length = 0;

    const result = await createBooking({
      serviceId: 17,
      date: "2026-10-16" as never,
      time: "10:00",
      providerId: null,
      firstName: "Ana",
      lastName: "Pérez",
      phone: "+57 300 123 4567",
    });

    // Con la caché habría seguido de largo (y respondido "taken" por falta de
    // técnicas). Fresco, ve que el servicio ya no existe.
    expect(result).toEqual({ status: "unknown-service" });
    expect(gets).toContain("services");
    expect(gets).toContain("providers");
  });
});
