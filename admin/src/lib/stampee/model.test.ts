import { describe, expect, it } from "vitest";

import {
  activeRows,
  buildSnapshot,
  clientsForPhone,
  leadingCard,
  loyaltyStage,
  phoneKey,
  summarizeCard,
  type StampeeCampaignRaw,
  type StampeeCardRaw,
} from "./model";

const CAMPAIGN: StampeeCampaignRaw = {
  id: "camp-1",
  name: "Club de manos",
  isEnabled: true,
  rewardName: "Semipermanente gratis",
  totalStamps: 10,
  bonusStamps: 1,
};

function card(over: Partial<StampeeCardRaw> = {}): StampeeCardRaw {
  return {
    id: "card-1",
    uniqueId: "u-1",
    campaignId: "camp-1",
    campaignName: "Club de manos",
    stamps: 4,
    status: "Active",
    templateSnapshot: { totalStamps: 10, rewardName: "Semipermanente gratis", bonusStamps: 1 },
    history: [],
    ...over,
  };
}

describe("phoneKey", () => {
  it("cruza el E.164 de EA con cómo lo escribió Stampee", () => {
    expect(phoneKey("573001234567")).toBe("3001234567");
    expect(phoneKey("+57 300 123 4567")).toBe("3001234567");
    expect(phoneKey("300-123-4567")).toBe("3001234567");
  });

  it("un número corto no es llave", () => {
    expect(phoneKey("12345")).toBeNull();
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey("")).toBeNull();
  });
});

describe("loyaltyStage", () => {
  it("llena y activa es lista; canjeada gana aunque esté llena", () => {
    expect(loyaltyStage("Active", 0)).toBe("lista");
    expect(loyaltyStage("Redeemed", 0)).toBe("canjeada");
  });

  it("a dos sellos o menos está cerca", () => {
    expect(loyaltyStage("Active", 1)).toBe("cerca");
    expect(loyaltyStage("Active", 2)).toBe("cerca");
    expect(loyaltyStage("Active", 3)).toBe("en-curso");
  });
});

describe("summarizeCard", () => {
  it("la meta es la de la tarjeta, no la de la campaña de hoy", () => {
    const summary = summarizeCard(card({ templateSnapshot: { totalStamps: 8 } }), CAMPAIGN);
    expect(summary.totalStamps).toBe(8);
    expect(summary.remaining).toBe(4);
  });

  it("sin foto de la tarjeta usa la campaña", () => {
    const summary = summarizeCard(card({ templateSnapshot: null }), CAMPAIGN);
    expect(summary.totalStamps).toBe(10);
    expect(summary.rewardName).toBe("Semipermanente gratis");
  });

  it("los sellos regalados no cuentan como visitas", () => {
    const summary = summarizeCard(
      card({
        stamps: 6,
        history: [
          { type: "issued", amount: 1, timestamp: 1_000 },
          { type: "stamp_add", amount: 1, timestamp: 2_000 },
          { type: "gift", amount: 2, timestamp: 3_000 },
          { type: "stamp_add", amount: 1, timestamp: 4_000 },
        ],
      }),
      CAMPAIGN,
    );
    expect(summary.gifted).toEqual({ welcome: 1, winBack: 2 });
    expect(summary.fromVisits).toBe(3);
    expect(summary.lastVisitAt).toBe(new Date(4_000).toISOString());
  });

  it("el regalo de bienvenida nunca llena la tarjeta", () => {
    const summary = summarizeCard(
      card({ stamps: 3, templateSnapshot: { totalStamps: 3, bonusStamps: 5 } }),
      CAMPAIGN,
    );
    expect(summary.gifted.welcome).toBe(2);
  });

  it("más sellos que la meta no da faltantes negativos", () => {
    const summary = summarizeCard(card({ stamps: 12 }), CAMPAIGN);
    expect(summary.remaining).toBe(0);
    expect(summary.stage).toBe("lista");
  });

  it("una canjeada sin transacción toma la fecha de cierre", () => {
    const summary = summarizeCard(
      card({ status: "Redeemed", stamps: 10, completedDate: "2026-10-01" }),
      CAMPAIGN,
    );
    expect(summary.stage).toBe("canjeada");
    expect(summary.redeemedAt).toBe("2026-10-01");
  });

  it("acepta el timestamp como texto", () => {
    const summary = summarizeCard(
      card({ history: [{ type: "stamp_add", amount: 1, timestamp: "5000" }] }),
      CAMPAIGN,
    );
    expect(summary.lastVisitAt).toBe(new Date(5_000).toISOString());
  });
});

describe("buildSnapshot", () => {
  const snapshot = buildSnapshot(
    [
      {
        id: "c-1",
        name: "Laura",
        mobile: "300 123 4567",
        cards: [
          card({ id: "a", stamps: 10 }),
          card({ id: "b", status: "Redeemed", stamps: 10 }),
        ],
      },
      { id: "c-2", name: "Ana", mobile: "+573109998877", cards: [card({ id: "c", stamps: 9 })] },
      { id: "c-3", name: "Sofía", mobile: null, cards: [card({ id: "d", stamps: 2 })] },
      // Campaña borrada: sale en la ficha, no en las estadísticas.
      { id: "c-4", name: "Eva", cards: [card({ id: "e", campaignId: "borrada" })] },
    ],
    [CAMPAIGN, { ...CAMPAIGN, id: "camp-2", name: "Vieja", isEnabled: false }],
  );

  it("cuenta las etapas por campaña", () => {
    const stats = snapshot.campaigns.find((c) => c.id === "camp-1");
    expect(stats).toMatchObject({ active: 3, lista: 1, cerca: 1, canjeadas: 1 });
    expect(stats?.distribution).toHaveLength(11);
    expect(stats?.distribution[10]).toBe(1);
    expect(stats?.distribution[9]).toBe(1);
    expect(stats?.distribution[2]).toBe(1);
  });

  it("las campañas activas van primero", () => {
    expect(snapshot.campaigns.map((c) => c.id)).toEqual(["camp-1", "camp-2"]);
  });

  it("las filas activas van de la más cerca del premio a la más lejos", () => {
    expect(activeRows(snapshot).map((r) => r.card.id)).toEqual(["a", "c", "e", "d"]);
  });

  it("cruza por teléfono en cualquier formato", () => {
    expect(clientsForPhone(snapshot, "573001234567").map((c) => c.id)).toEqual(["c-1"]);
    expect(clientsForPhone(snapshot, null)).toEqual([]);
  });

  it("la tarjeta que manda es la activa más cerca del premio", () => {
    const laura = snapshot.clients.find((c) => c.id === "c-1");
    expect(leadingCard(laura?.cards ?? [])?.id).toBe("a");
    expect(leadingCard([])).toBeNull();
  });
});
