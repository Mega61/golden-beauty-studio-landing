import { describe, expect, it, vi } from "vitest";

import {
  APPOINTMENTS_POLICY,
  PUBLIC_AVAILABILITY_TAG,
  REFERENCE_POLICY,
  createEaCache,
  readPolicyFor,
  resourceOfPath,
  resourceOfWebhookAction,
  tagsInvalidatedBy,
  type CachePolicy,
} from "./cache";
import { EaApiError } from "./errors";

const POLICY: CachePolicy = { ttlMs: 60_000, staleOnErrorMs: 600_000 };

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function rateLimited() {
  return new EaApiError("EA respondió 429", { kind: "rate_limited", status: 429 });
}

/** Una promesa que se resuelve cuando el test lo decide. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TTL", () => {
  it("sirve de memoria dentro del TTL y vuelve a EA después", async () => {
    const c = clock();
    const cache = createEaCache({ now: c.now });
    const load = vi.fn().mockResolvedValueOnce("v1").mockResolvedValueOnce("v2");

    expect(await cache.read("k", ["services"], POLICY, load)).toBe("v1");
    c.advance(59_999);
    expect(await cache.read("k", ["services"], POLICY, load)).toBe("v1");
    expect(load).toHaveBeenCalledTimes(1);

    c.advance(1);
    expect(await cache.read("k", ["services"], POLICY, load)).toBe("v2");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("claves distintas no se mezclan", async () => {
    const cache = createEaCache();
    await cache.read("a", [], POLICY, async () => 1);
    expect(await cache.read("b", [], POLICY, async () => 2)).toBe(2);
  });
});

describe("un solo vuelo", () => {
  it("veinte pedidos simultáneos hacen una sola llamada", async () => {
    const cache = createEaCache();
    const gate = deferred<string>();
    const load = vi.fn(() => gate.promise);

    const all = Promise.all(
      Array.from({ length: 20 }, () => cache.read("k", ["services"], POLICY, load)),
    );
    gate.resolve("v");

    expect(await all).toEqual(Array(20).fill("v"));
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.stats()).toMatchObject({ misses: 1, joins: 19 });
  });

  it("un error en vuelo les llega a todos, y el siguiente pedido reintenta", async () => {
    const cache = createEaCache();
    const gate = deferred<string>();
    const load = vi.fn(() => gate.promise);

    const a = cache.read("k", [], POLICY, load);
    const b = cache.read("k", [], POLICY, load);
    gate.reject(rateLimited());

    await expect(a).rejects.toThrow("429");
    await expect(b).rejects.toThrow("429");
    expect(await cache.read("k", [], POLICY, async () => "ok")).toBe("ok");
  });

  it("un `load` que lanza de forma síncrona no deja el vuelo colgado", async () => {
    const cache = createEaCache();
    const boom = () => {
      throw new Error("síncrono");
    };
    await expect(cache.read("k", [], POLICY, boom as never)).rejects.toThrow("síncrono");
    expect(await cache.read("k", [], POLICY, async () => "ok")).toBe("ok");
  });
});

describe("lo viejo antes que el error", () => {
  it("con un 429 sirve el último valor si no pasa del tope, y avisa", async () => {
    const c = clock();
    const onStale = vi.fn();
    const cache = createEaCache({ now: c.now, onStale });

    await cache.read("k", ["services"], POLICY, async () => "viejo");
    c.advance(61_000);

    const value = await cache.read("k", ["services"], POLICY, () => Promise.reject(rateLimited()));
    expect(value).toBe("viejo");
    expect(onStale).toHaveBeenCalledWith("k", expect.any(EaApiError), 61_000);
  });

  it("pasado el tope de edad, el error sube", async () => {
    const c = clock();
    const cache = createEaCache({ now: c.now, onStale: () => {} });

    await cache.read("k", [], POLICY, async () => "viejo");
    c.advance(600_000);

    await expect(cache.read("k", [], POLICY, () => Promise.reject(rateLimited()))).rejects.toThrow(
      "429",
    );
  });

  it("un error que no es transitorio no se esconde", async () => {
    const c = clock();
    const cache = createEaCache({ now: c.now, onStale: () => {} });
    await cache.read("k", [], POLICY, async () => "viejo");
    c.advance(61_000);

    const unauthorized = new EaApiError("401", { kind: "unauthorized", status: 401 });
    await expect(cache.read("k", [], POLICY, () => Promise.reject(unauthorized))).rejects.toBe(
      unauthorized,
    );
  });

  it("con staleOnErrorMs = 0 nunca sirve lo viejo", async () => {
    const c = clock();
    const cache = createEaCache({ now: c.now, onStale: () => {} });
    await cache.read("k", [], APPOINTMENTS_POLICY, async () => "viejo");
    c.advance(APPOINTMENTS_POLICY.ttlMs);

    await expect(
      cache.read("k", [], APPOINTMENTS_POLICY, () => Promise.reject(rateLimited())),
    ).rejects.toThrow("429");
  });

  it("tras un fallo no reintenta durante el enfriamiento", async () => {
    const c = clock();
    const cache = createEaCache({ now: c.now, onStale: () => {}, errorCooldownMs: 5_000 });
    await cache.read("k", [], POLICY, async () => "viejo");
    c.advance(61_000);

    const failing = vi.fn(() => Promise.reject(rateLimited()));
    await cache.read("k", [], POLICY, failing);
    c.advance(4_999);
    expect(await cache.read("k", [], POLICY, failing)).toBe("viejo");
    expect(failing).toHaveBeenCalledTimes(1);

    c.advance(1);
    await cache.read("k", [], POLICY, failing);
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe("invalidación", () => {
  it("vence lo que lleva la etiqueta y no toca lo demás", async () => {
    const cache = createEaCache();
    await cache.read("s", ["services"], POLICY, async () => "s1");
    await cache.read("c", ["service_categories"], POLICY, async () => "c1");

    cache.invalidate(["services"]);

    expect(await cache.read("s", ["services"], POLICY, async () => "s2")).toBe("s2");
    expect(await cache.read("c", ["service_categories"], POLICY, async () => "c2")).toBe("c1");
  });

  it("lo invalidado ya no es fresco pero sigue siendo respaldo ante un 429", async () => {
    const cache = createEaCache({ onStale: () => {} });
    await cache.read("s", ["services"], POLICY, async () => "s1");
    cache.invalidate(["services"]);

    expect(await cache.read("s", ["services"], POLICY, () => Promise.reject(rateLimited()))).toBe(
      "s1",
    );
  });

  it("una lectura que empezó antes de la escritura no se guarda", async () => {
    const cache = createEaCache();
    const gate = deferred<string>();

    const before = cache.read("a", ["appointments"], POLICY, () => gate.promise);
    cache.invalidate(["appointments"]);

    // Quien pregunta después de la escritura no se cuelga del vuelo viejo.
    const after = cache.read("a", ["appointments"], POLICY, async () => "nuevo");
    gate.resolve("leído antes de escribir");

    expect(await before).toBe("leído antes de escribir");
    expect(await after).toBe("nuevo");
    expect(await cache.read("a", ["appointments"], POLICY, async () => "otra")).toBe("nuevo");
  });

  it("una escritura sobre citas vence citas, horarios y la disponibilidad pública", async () => {
    const cache = createEaCache();
    for (const tag of ["appointments", "availabilities", PUBLIC_AVAILABILITY_TAG, "services"]) {
      await cache.read(tag, [tag], POLICY, async () => "v1");
    }

    cache.invalidateResource("appointments");

    for (const tag of ["appointments", "availabilities", PUBLIC_AVAILABILITY_TAG]) {
      expect(await cache.read(tag, [tag], POLICY, async () => "v2")).toBe("v2");
    }
    expect(await cache.read("services", ["services"], POLICY, async () => "v2")).toBe("v1");
  });

  it("un recurso desconocido vence todo", async () => {
    const cache = createEaCache();
    await cache.read("s", ["services"], POLICY, async () => "v1");
    cache.invalidateResource("recurso_de_ea_2027");
    expect(await cache.read("s", ["services"], POLICY, async () => "v2")).toBe("v2");
  });
});

describe("memoria acotada", () => {
  it("nunca pasa del tope de entradas, y saca primero las más viejas", async () => {
    const cache = createEaCache({ maxEntries: 3 });
    for (const key of ["a", "b", "c", "d"]) await cache.read(key, [], POLICY, async () => key);

    expect(cache.size()).toBe(3);
    expect(await cache.read("a", [], POLICY, async () => "recargada")).toBe("recargada");
    expect(await cache.read("d", [], POLICY, async () => "x")).toBe("d");
  });

  it("antes que una vigente, saca las que ya no sirven ni de respaldo", async () => {
    const c = clock();
    const cache = createEaCache({ now: c.now, maxEntries: 2 });
    await cache.read("vieja", [], APPOINTMENTS_POLICY, async () => 1);
    await cache.read("ref", [], POLICY, async () => 2);
    c.advance(APPOINTMENTS_POLICY.ttlMs);
    await cache.read("nueva", [], POLICY, async () => 3);

    expect(cache.size()).toBe(2);
    expect(await cache.read("ref", [], POLICY, async () => 99)).toBe(2);
  });
});

describe("tablas", () => {
  it("cachea la referencia a 60 s y las citas a 15 s, y no las clientas", () => {
    expect(readPolicyFor("services")).toBe(REFERENCE_POLICY);
    expect(readPolicyFor("blocked_periods")).toBe(REFERENCE_POLICY);
    expect(readPolicyFor("appointments")).toBe(APPOINTMENTS_POLICY);
    expect(readPolicyFor("availabilities")).toBe(APPOINTMENTS_POLICY);
    expect(readPolicyFor("customers")).toBeNull();
    expect(REFERENCE_POLICY.ttlMs).toBe(60_000);
    expect(APPOINTMENTS_POLICY.ttlMs).toBe(15_000);
  });

  it("toda escritura que cambia horarios vence la disponibilidad pública", () => {
    for (const resource of [
      "appointments",
      "unavailabilities",
      "services",
      "providers",
      "blocked_periods",
      "settings",
    ]) {
      expect(tagsInvalidatedBy(resource)).toContain(PUBLIC_AVAILABILITY_TAG);
    }
    expect(tagsInvalidatedBy("customers")).toEqual(["appointments"]);
    expect(tagsInvalidatedBy("nada")).toBeNull();
  });

  it("deduce el recurso de una ruta y de una acción de webhook", () => {
    expect(resourceOfPath("providers/3")).toBe("providers");
    expect(resourceOfPath("service_categories")).toBe("service_categories");
    expect(resourceOfWebhookAction("appointment_save")).toBe("appointments");
    expect(resourceOfWebhookAction("unavailability_delete")).toBe("unavailabilities");
    expect(resourceOfWebhookAction("service_category_save")).toBe("service_categories");
    expect(resourceOfWebhookAction("blocked_period_delete")).toBe("blocked_periods");
    expect(resourceOfWebhookAction("secretary_save")).toBe("secretaries");
    expect(resourceOfWebhookAction("customer_save")).toBe("customers");
    expect(resourceOfWebhookAction("(cuerpo ilegible)")).toBeNull();
  });
});
