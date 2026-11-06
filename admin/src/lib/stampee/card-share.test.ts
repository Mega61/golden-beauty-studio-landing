import { describe, expect, it } from "vitest";

import {
  buildCardShareText,
  cardShareLink,
  hoyCardShare,
  pendingShares,
  SHARE_PENDING_DAYS,
} from "./card-share";
import type { LoyaltyCard, LoyaltyClient } from "./model";

const NOW = new Date("2026-11-06T15:00:00Z");
const BASE = "https://loyalty.example.co/golden";

function card(over: Partial<LoyaltyCard> = {}): LoyaltyCard {
  return {
    id: "card-1",
    uniqueId: "u-1",
    campaignId: "camp-1",
    campaignName: "Club de manos",
    rewardName: "Semipermanente gratis",
    stage: "en-curso",
    stamps: 1,
    totalStamps: 8,
    remaining: 7,
    gifted: { welcome: 0, winBack: 0 },
    fromVisits: 1,
    issuedAt: "2026-11-05T13:00:00.000Z",
    lastVisitAt: null,
    redeemedAt: null,
    ...over,
  };
}

function client(over: Partial<LoyaltyClient> = {}): LoyaltyClient {
  return { id: "c-1", name: "GERALDINE ORTIZ", mobile: "310 362 7503", phoneKey: "3103627503", cards: [], ...over };
}

describe("buildCardShareText", () => {
  it("saluda con el nombre presentable y lleva el link en su renglón", () => {
    const text = buildCardShareText({
      customerName: "GERALDINE ORTIZ",
      stamps: 1,
      totalStamps: 8,
      rewardName: "Semipermanente gratis",
      url: `${BASE}/u-1`,
    });
    expect(text.startsWith("¡Hola, Geraldine! ✨")).toBe(true);
    expect(text).toContain("Ya tienes 1 de 8 sellos. Al completarla te ganas: Semipermanente gratis 🎁");
    expect(text.split("\n")).toContain(`👉 ${BASE}/u-1`);
  });

  it("sin nombre ni premio no inventa nada", () => {
    const text = buildCardShareText({ customerName: null, stamps: 3, totalStamps: 8, rewardName: "", url: "x" });
    expect(text.startsWith("¡Hola! ✨")).toBe(true);
    expect(text).toContain("Ya tienes 3 de 8 sellos. Al completarla te ganas un premio 🎁");
  });
});

describe("cardShareLink", () => {
  it("abre api.whatsapp.com (no wa.me, que rompe los emojis) con el número sin +", () => {
    const link = cardShareLink({ phone: "310 362 7503", customerName: "Geraldine", card: card(), cardBaseUrl: BASE });
    expect(link).not.toBeNull();
    expect(link!.startsWith("https://api.whatsapp.com/send?phone=573103627503&text=")).toBe(true);
    expect(decodeURIComponent(link!.split("text=")[1])).toContain(`${BASE}/u-1`);
  });

  it("sin el link público de Stampee o sin número no hay botón", () => {
    expect(cardShareLink({ phone: "3103627503", customerName: null, card: card(), cardBaseUrl: null })).toBeNull();
    expect(cardShareLink({ phone: "no tiene", customerName: null, card: card(), cardBaseUrl: BASE })).toBeNull();
  });
});

describe("pendingShares", () => {
  it("pide las tarjetas recientes que nadie ha mandado", () => {
    const rows = [{ client: client(), card: card() }];
    expect(pendingShares(rows, new Set(), NOW)).toHaveLength(1);
    expect(pendingShares(rows, new Set(["card-1"]), NOW)).toHaveLength(0);
  });

  it(`no pide las de hace más de ${SHARE_PENDING_DAYS} días, ni las sin fecha, ni las canjeadas`, () => {
    const old = new Date(NOW.getTime() - (SHARE_PENDING_DAYS + 1) * 86_400_000).toISOString();
    const rows = [
      { client: client(), card: card({ id: "a", issuedAt: old }) },
      { client: client(), card: card({ id: "b", issuedAt: null }) },
      { client: client(), card: card({ id: "c", stage: "canjeada" }) },
    ];
    expect(pendingShares(rows, new Set(), NOW)).toEqual([]);
  });

  it("no pide la de una clienta sin celular usable: no habría a dónde mandarla", () => {
    expect(pendingShares([{ client: client({ mobile: null }), card: card() }], new Set(), NOW)).toEqual([]);
  });
});

describe("hoyCardShare", () => {
  const base = { sent: new Set<string>(), phone: "+573103627503", customerName: "Geraldine", cardBaseUrl: BASE };

  it("con la cuenta abierta no dice nada", () => {
    expect(hoyCardShare({ ...base, closed: false, cards: [card()], leading: card() })).toBeNull();
  });

  it("cuenta cerrada y sin tarjeta: llega mañana", () => {
    expect(hoyCardShare({ ...base, closed: true, cards: [], leading: null })).toEqual({ state: "manana" });
  });

  it("cuenta cerrada con tarjeta sin mandar: el botón", () => {
    const share = hoyCardShare({ ...base, closed: true, cards: [card()], leading: card() });
    expect(share?.state).toBe("enviar");
    expect(share && share.state === "enviar" ? share.cardId : null).toBe("card-1");
  });

  it("ya mandada, o con todas canjeadas, no insiste", () => {
    expect(hoyCardShare({ ...base, sent: new Set(["card-1"]), closed: true, cards: [card()], leading: card() })).toBeNull();
    expect(
      hoyCardShare({ ...base, closed: true, cards: [card({ stage: "canjeada" })], leading: null }),
    ).toBeNull();
  });
});
