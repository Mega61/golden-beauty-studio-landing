import { describe, expect, it } from "vitest";

import {
  buildCardShareText,
  cardShareLink,
  cardUrl,
  hoyCardShare,
  pendingShares,
  SHARE_PENDING_DAYS,
  wasSent,
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
  return {
    id: "c-1",
    name: "GERALDINE ORTIZ",
    mobile: "310 362 7503",
    phoneKey: "3103627503",
    publicId: null,
    cards: [],
    ...over,
  };
}

const PUBLIC_ID = "p-geraldine";

describe("cardUrl", () => {
  it("con link permanente usa el de la clienta, no el de la tarjeta", () => {
    expect(cardUrl(BASE, card(), PUBLIC_ID)).toBe(`${BASE}/${PUBLIC_ID}`);
  });

  it("sin link permanente (Stampee viejo) sigue con el de la tarjeta", () => {
    expect(cardUrl(BASE, card())).toBe(`${BASE}/u-1`);
    expect(cardUrl(BASE, card(), null)).toBe(`${BASE}/u-1`);
  });

  it("sin STAMPEE_APP_URL / slug no hay link", () => {
    expect(cardUrl(null, card(), PUBLIC_ID)).toBeNull();
  });
});

describe("wasSent", () => {
  const first = card({ id: "card-1" });
  const second = card({ id: "card-2", uniqueId: "u-2" });

  it("con link permanente, mandar cualquiera de sus tarjetas cuenta para todas", () => {
    const c = client({ publicId: PUBLIC_ID, cards: [first, second] });
    expect(wasSent(c, second, new Set(["card-1"]))).toBe(true);
    expect(wasSent(c, second, new Set())).toBe(false);
  });

  it("sin link permanente es tarjeta por tarjeta: el link viejo abre la tarjeta vieja", () => {
    const c = client({ cards: [first, second] });
    expect(wasSent(c, second, new Set(["card-1"]))).toBe(false);
    expect(wasSent(c, second, new Set(["card-2"]))).toBe(true);
  });
});

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

  it("con link permanente manda el de la clienta", () => {
    const link = cardShareLink({
      phone: "310 362 7503",
      customerName: "Geraldine",
      card: card(),
      cardBaseUrl: BASE,
      publicId: PUBLIC_ID,
    });
    const text = decodeURIComponent(link!.split("text=")[1]);
    expect(text).toContain(`${BASE}/${PUBLIC_ID}`);
    expect(text).not.toContain(`${BASE}/u-1`);
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

  it("con link permanente, una tarjeta nueva de una clienta que ya recibió el link no se vuelve a pedir", () => {
    const old = card({ id: "card-old", stage: "canjeada" });
    const fresh = card({ id: "card-new", uniqueId: "u-new" });
    const c = client({ publicId: PUBLIC_ID, cards: [fresh, old] });
    expect(pendingShares([{ client: c, card: fresh }], new Set(["card-old"]), NOW)).toEqual([]);
    // Sin link permanente, la tarjeta nueva sí se pide: su link es otro.
    const legacy = client({ cards: [fresh, old] });
    expect(pendingShares([{ client: legacy, card: fresh }], new Set(["card-old"]), NOW)).toHaveLength(1);
  });

  it("con link permanente sale una sola fila por clienta, aunque tenga dos tarjetas sin mandar", () => {
    const a = card({ id: "a" });
    const b = card({ id: "b", uniqueId: "u-b" });
    const c = client({ publicId: PUBLIC_ID, cards: [a, b] });
    const rows = [
      { client: c, card: a },
      { client: c, card: b },
    ];
    expect(pendingShares(rows, new Set(), NOW).map((r) => r.card.id)).toEqual(["a"]);
    const legacy = client({ cards: [a, b] });
    expect(
      pendingShares(
        rows.map((r) => ({ ...r, client: legacy })),
        new Set(),
        NOW,
      ),
    ).toHaveLength(2);
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

  it("con link permanente no insiste si ya se le mandó otra de sus tarjetas", () => {
    const fresh = card({ id: "card-2", uniqueId: "u-2" });
    const old = card({ id: "card-1", stage: "canjeada" });
    const args = { ...base, closed: true, cards: [fresh, old], leading: fresh, sent: new Set(["card-1"]) };
    expect(hoyCardShare({ ...args, publicId: PUBLIC_ID })).toBeNull();
    expect(hoyCardShare({ ...args, publicId: null })?.state).toBe("enviar");
  });

  it("con link permanente el botón manda el link de la clienta", () => {
    const share = hoyCardShare({ ...base, closed: true, cards: [card()], leading: card(), publicId: PUBLIC_ID });
    expect(share?.state).toBe("enviar");
    const whatsapp = share && share.state === "enviar" ? share.whatsapp : "";
    expect(decodeURIComponent(whatsapp.split("text=")[1])).toContain(`${BASE}/${PUBLIC_ID}`);
  });

  it("ya mandada, o con todas canjeadas, no insiste", () => {
    expect(hoyCardShare({ ...base, sent: new Set(["card-1"]), closed: true, cards: [card()], leading: card() })).toBeNull();
    expect(
      hoyCardShare({ ...base, closed: true, cards: [card({ stage: "canjeada" })], leading: null }),
    ).toBeNull();
  });
});
