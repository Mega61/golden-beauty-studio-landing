import { describe, expect, it } from "vitest";

import { createAttemptGate, findCard, firstNameKey } from "./card-lookup";
import { buildSnapshot, type StampeeCustomerRaw } from "./model";

const BASE = "https://loyalty.example.com/golden";

function card(id: string, stamps: number, status = "Active") {
  return {
    id,
    uniqueId: `u-${id}`,
    campaignId: "c1",
    campaignName: "Golden",
    stamps,
    status,
    templateSnapshot: { totalStamps: 8, rewardName: "15% off" },
    history: [],
  };
}

const customers: StampeeCustomerRaw[] = [
  { id: "a", name: "María José Pérez", mobile: "+57 300 123 4567", cards: [card("1", 3)] },
  { id: "b", name: "Laura", mobile: "3109998888", cards: [card("2", 8, "Redeemed"), card("3", 1)] },
  { id: "c", name: "Sin Tarjeta", mobile: "3205554444", cards: [] },
];
const snapshot = buildSnapshot(customers, [
  { id: "c1", name: "Golden", isEnabled: true, totalStamps: 8, bonusStamps: 0, rewardName: "15% off" },
]);

describe("firstNameKey", () => {
  it("ignora tildes, mayúsculas y apellidos", () => {
    expect(firstNameKey("  MARÍA josé")).toBe("maria");
    expect(firstNameKey("Ñata")).toBe("nata");
    expect(firstNameKey("  ")).toBeNull();
  });
});

describe("findCard", () => {
  it("encuentra con celular en cualquier formato y solo el primer nombre", () => {
    const hit = findCard(snapshot, BASE, "300-123-4567", "maria");
    expect(hit).toEqual({ kind: "found", url: `${BASE}/u-1`, stamps: 3, totalStamps: 8, rewardName: "15% off" });
    expect(findCard(snapshot, BASE, "573001234567", "María José")).toMatchObject({ url: `${BASE}/u-1` });
  });

  it("usa el link permanente de la clienta cuando existe", () => {
    const withPublic = {
      ...snapshot,
      clients: snapshot.clients.map((c) => (c.id === "a" ? { ...c, publicId: "p-maria" } : c)),
    };
    expect(findCard(withPublic, BASE, "3001234567", "maria")).toMatchObject({ url: `${BASE}/p-maria` });
  });

  it("con el nombre equivocado no encuentra nada (sin decir de quién es)", () => {
    expect(findCard(snapshot, BASE, "3001234567", "Mariana")).toEqual({ kind: "no-match" });
    expect(findCard(snapshot, BASE, "3001234567", "Pérez")).toEqual({ kind: "no-match" });
  });

  it("un celular que no es de nadie es una clienta nueva", () => {
    expect(findCard(snapshot, BASE, "3157778888", "Ana")).toEqual({ kind: "unknown-phone" });
  });

  it("prefiere la tarjeta activa sobre la canjeada", () => {
    expect(findCard(snapshot, BASE, "3109998888", "laura")).toMatchObject({ url: `${BASE}/u-3` });
  });

  it("una ficha sin tarjetas cuenta como sin tarjeta; un celular incompleto no se busca", () => {
    expect(findCard(snapshot, BASE, "3205554444", "sin")).toEqual({ kind: "unknown-phone" });
    expect(findCard(snapshot, BASE, "1234567", "maria")).toEqual({ kind: "no-match" });
  });
});

describe("createAttemptGate", () => {
  it("bloquea tras N fallos y se libera al pasar la ventana", () => {
    let t = 0;
    const gate = createAttemptGate({ maxFailures: 3, windowMs: 1000, now: () => t });
    for (let i = 0; i < 3; i++) gate.fail("300");
    expect(gate.locked("300")).toBe(true);
    expect(gate.locked("310")).toBe(false);
    t = 1001;
    expect(gate.locked("300")).toBe(false);
  });
});
