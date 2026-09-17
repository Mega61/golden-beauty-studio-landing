import { afterEach, describe, expect, it, vi } from "vitest";

import { adminOrigin, bookingUrl, clientIp, rateLimited, turnstileOk } from "./guards";

/** A fresh IP per test: the counter is module state, shared across this file. */
let seq = 0;
const freshIp = () => `10.0.0.${(seq += 1)}`;

const req = (headers: Record<string, string>) =>
  ({ headers: new Headers(headers) }) as unknown as Parameters<typeof clientIp>[0];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("límite por IP", () => {
  it("deja pasar hasta el tope y corta después", () => {
    const ip = freshIp();

    // `max` es el número de pedidos permitidos, así que el que sobra es el
    // siguiente: con 5, el sexto es el que se rechaza.
    for (let i = 0; i < 5; i += 1) expect(rateLimited(ip, 5)).toBe(false);
    expect(rateLimited(ip, 5)).toBe(true);
  });

  it("una IP no gasta el cupo de otra", () => {
    const [a, b] = [freshIp(), freshIp()];

    for (let i = 0; i < 6; i += 1) rateLimited(a, 5);

    expect(rateLimited(b, 5)).toBe(false);
  });
});

describe("de qué IP viene el pedido", () => {
  it("usa el primero de x-forwarded-for: los demás los puso el proxy", () => {
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9, 70.41.3.18" }))).toBe("203.0.113.9");
  });

  it("cae a x-real-ip, y a 'unknown' antes que a undefined", () => {
    expect(clientIp(req({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(req({}))).toBe("unknown");
  });
});

/**
 * Sin secreto configurado, Turnstile **no** bloquea. Es el estado en el que
 * corre el estudio hoy, y tiene que ser un estado soportado y no uno a medias:
 * si esto devolviera `false`, activar la variable a medias tumbaría todas las
 * reservas reales.
 */
describe("Turnstile", () => {
  it("sin secreto, deja pasar sin token", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");

    await expect(turnstileOk(null, "1.1.1.1")).resolves.toBe(true);
  });

  it("con secreto y sin token, rechaza", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "un-secreto");

    await expect(turnstileOk(null, "1.1.1.1")).resolves.toBe(false);
  });

  it("con secreto y token válido, acepta", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "un-secreto");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ success: true })));

    await expect(turnstileOk("tok", "1.1.1.1")).resolves.toBe(true);
  });

  it("con secreto y token que Cloudflare desconoce, rechaza", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "un-secreto");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ success: false })));

    await expect(turnstileOk("tok", "1.1.1.1")).resolves.toBe(false);
  });

  it("si Cloudflare no responde, falla ABIERTO", async () => {
    // Perder una clienta real por un hipo de Cloudflare es peor que dejar pasar
    // un bot: el honeypot, el tiempo de llenado y el límite por IP siguen ahí.
    vi.stubEnv("TURNSTILE_SECRET_KEY", "un-secreto");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });

    await expect(turnstileOk("tok", "1.1.1.1")).resolves.toBe(true);
  });
});

describe("a dónde se proxea", () => {
  it("sin ADMIN_ORIGIN devuelve null en vez de adivinar un localhost", () => {
    // Adivinar colgaría el pedido treinta segundos en un preview de Vercel.
    vi.stubEnv("ADMIN_ORIGIN", "");

    expect(adminOrigin()).toBeNull();
  });

  it("le quita la barra final, que duplicaría la de la ruta", () => {
    vi.stubEnv("ADMIN_ORIGIN", "https://panel.example.com/");

    expect(adminOrigin()).toBe("https://panel.example.com");
  });

  it("la sub-API cuelga de /admin, que es el basePath del panel", () => {
    expect(bookingUrl("https://panel.example.com", "availability")).toBe(
      "https://panel.example.com/admin/api/public/booking/availability",
    );
  });
});
