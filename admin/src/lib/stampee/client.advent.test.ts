import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  invalidateAdventRewards,
  listAdventRewards,
  loadAvailableAdventWithin,
  redeemAdventReward,
  unredeemAdventReward,
} from "./client";

/**
 * El bloque de Adviento de `client.ts` contra un `fetch` de mentira con las
 * formas de `docs/ADVENT_CONTRACT.md` (Stampee). Lo que se fija: la URL y el
 * cuerpo que salen, la llave, y que cada error vuelva con su frase.
 */

const BASE = "https://stampee.example.co/api";

type Call = { url: string; method: string; body: unknown; auth: string | null };
let calls: Call[] = [];

function respond(status: number, json: unknown) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
      auth: headers.get("authorization"),
    });
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const REWARD = {
  id: "r-1",
  doorNo: 2,
  dayLabel: 4,
  kind: "coupon",
  title: "Retiro gratis",
  subtitle: "",
  terms: ["Una por clienta."],
  code: "GB-AB12",
  status: "available",
  validFrom: "2026-12-04",
  validTo: "2026-12-10",
  openedAt: "2026-12-04T14:00:00.000Z",
  url: null,
  stamps: null,
  giftCardId: null,
  customerId: "c-1",
  customerName: "Laura",
  redeemedAt: null,
  redeemedBy: null,
};

beforeEach(() => {
  calls = [];
  vi.stubEnv("STAMPEE_API_URL", `${BASE}/`);
  vi.stubEnv("STAMPEE_API_KEY", "clave-de-prueba");
  invalidateAdventRewards();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("listAdventRewards", () => {
  it("pide por clienta y estado, con la llave del estudio", async () => {
    respond(200, { ok: true, data: { rewards: [REWARD] } });
    const result = await listAdventRewards({ customerId: "c-1", status: "all" });
    expect(result).toEqual({ ok: true, rewards: [REWARD] });
    expect(calls[0].url).toBe(`${BASE}/advent/rewards?customerId=c-1&status=all`);
    expect(calls[0].auth).toBe("Bearer clave-de-prueba");
  });

  it("sin clienta trae las de todas", async () => {
    respond(200, { ok: true, data: { rewards: [] } });
    await listAdventRewards({ status: "available" });
    expect(calls[0].url).toBe(`${BASE}/advent/rewards?status=available`);
  });

  it("Stampee sin calendario (404) o caído no lanza: devuelve el fallo", async () => {
    respond(404, { ok: false, error: { code: "NOT_FOUND", message: "Not found" } });
    const result = await listAdventRewards({ status: "available" });
    expect(result).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND" });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const down = await listAdventRewards({ status: "available" });
    expect(down).toMatchObject({ ok: false, status: null });
    expect(!down.ok && down.message).toMatch(/no respondió/);
  });

  it("sin STAMPEE_API_URL / KEY no llama a nadie", async () => {
    vi.stubEnv("STAMPEE_API_KEY", "");
    const fetchMock = respond(200, { ok: true, data: { rewards: [] } });
    const result = await listAdventRewards({ status: "available" });
    expect(result).toMatchObject({ ok: false, message: "Stampee no está configurado en el panel." });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("redeemAdventReward", () => {
  it("marca usado con quién lo hizo y la cuenta", async () => {
    respond(200, { ok: true, data: { reward: { ...REWARD, status: "redeemed" }, alreadyRedeemed: false } });
    const result = await redeemAdventReward("GB-AB12", { actorName: "Recepción", ticketRef: "ea-appt:77" });
    expect(result).toMatchObject({ ok: true, alreadyRedeemed: false, reward: { code: "GB-AB12" } });
    expect(calls[0]).toMatchObject({
      url: `${BASE}/advent/rewards/GB-AB12/redeem`,
      method: "POST",
      body: { actorName: "Recepción", ticketRef: "ea-appt:77" },
    });
  });

  it("sin cuenta no manda ticketRef, y codifica el código en la URL", async () => {
    respond(200, { ok: true, data: { reward: REWARD } });
    await redeemAdventReward("GB/1 2", { actorName: "Dueña" });
    expect(calls[0].url).toBe(`${BASE}/advent/rewards/GB%2F1%202/redeem`);
    expect(calls[0].body).toEqual({ actorName: "Dueña" });
  });

  it("un segundo toque vuelve OK con alreadyRedeemed", async () => {
    respond(200, { ok: true, data: { reward: { ...REWARD, status: "redeemed" }, alreadyRedeemed: true } });
    const result = await redeemAdventReward("GB-AB12", { actorName: "Recepción" });
    expect(result).toMatchObject({ ok: true, alreadyRedeemed: true });
  });

  it.each([
    ["EXPIRED", /venció/],
    ["NOT_YET_VALID", /todavía no está vigente/],
    ["NOT_REDEEMABLE", /no es un cupón/],
  ])("409 %s vuelve con su frase", async (code, message) => {
    respond(409, { ok: false, error: { code, message: "conflict" } });
    const result = await redeemAdventReward("GB-AB12", { actorName: "Recepción" });
    expect(result).toMatchObject({ ok: false, status: 409, code });
    expect(!result.ok && result.message).toMatch(message);
  });

  it("un 502 del proxy (no JSON) es un fallo genérico", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })));
    const result = await redeemAdventReward("GB-AB12", { actorName: "Recepción" });
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(!result.ok && result.message).toMatch(/No se marcó nada/);
  });
});

describe("unredeemAdventReward", () => {
  it("deshace con quién lo hizo", async () => {
    respond(200, { ok: true, data: { reward: REWARD } });
    const result = await unredeemAdventReward("GB-AB12", { actorName: "Recepción" });
    expect(result).toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      url: `${BASE}/advent/rewards/GB-AB12/unredeem`,
      method: "POST",
      body: { actorName: "Recepción" },
    });
  });

  it("un fallo vuelve con mensaje", async () => {
    respond(500, { ok: false, error: { code: "INTERNAL", message: "boom" } });
    const result = await unredeemAdventReward("GB-AB12", { actorName: "Recepción" });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(!result.ok && result.message).toMatch(/no deshizo/);
  });
});

describe("loadAvailableAdventWithin", () => {
  it("lee una vez y sirve de caché; marcar usado la invalida", async () => {
    const fetchMock = respond(200, { ok: true, data: { rewards: [REWARD] } });
    expect(await loadAvailableAdventWithin(1_000)).toEqual([REWARD]);
    expect(await loadAvailableAdventWithin(1_000)).toEqual([REWARD]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await redeemAdventReward("GB-AB12", { actorName: "Recepción" });
    await loadAvailableAdventWithin(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("Stampee caído o sin calendario: null, sin lanzar", async () => {
    respond(404, { ok: false, error: { code: "NOT_FOUND" } });
    expect(await loadAvailableAdventWithin(1_000)).toBeNull();
  });

  it("si tarda más que el tope, sale null", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    expect(await loadAvailableAdventWithin(20)).toBeNull();
  });
});
