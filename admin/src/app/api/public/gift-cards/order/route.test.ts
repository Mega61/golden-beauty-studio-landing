import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/public/gift-cards/order`: solo `TIER_REQUIRED` / `TIER_UNAVAILABLE`
 * de Stampee se le dicen a la landing como "nivel no disponible" (campo
 * `tierId`); cualquier otro rechazo es un error general.
 */

let outcome: unknown;
let lastCall: unknown;

vi.mock("@/lib/stampee/client", () => ({
  createGiftCard: async (input: unknown) => {
    lastCall = input;
    return outcome;
  },
}));

const { POST } = await import("./route");

const req = (body: unknown) =>
  ({ json: async () => body }) as unknown as Parameters<typeof POST>[0];

const BODY = { tierId: "t-1", buyer: { name: "Ana Ruiz", phone: "300 123 4567" }, ref: "adviento" };

beforeEach(() => {
  outcome = {
    ok: true,
    card: { code: "TR-AB12-CD34", amountCop: 100_000, tierName: "Consentida", publicUrl: "https://x/golden/regalo/u" },
  };
  lastCall = null;
});

describe("pedido de tarjeta regalo", () => {
  it("201 con la forma que espera la landing, celular normalizado y sello de adviento", async () => {
    const res = await POST(req(BODY));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      ok: true,
      data: { code: "TR-AB12-CD34", amountCop: 100_000, tierName: "Consentida", publicUrl: "https://x/golden/regalo/u" },
    });
    expect(lastCall).toMatchObject({
      tierId: "t-1",
      buyer: { name: "Ana Ruiz", phone: "+573001234567" },
      source: "sale",
      rules: { buyerStampOnPaid: true, ref: "adviento" },
    });
  });

  it.each(["TIER_REQUIRED", "TIER_UNAVAILABLE"])("%s → 422 con campo tierId", async (code) => {
    outcome = { ok: false, status: 400, code, message: "x" };
    const res = await POST(req(BODY));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ field: "tierId" });
  });

  it("cualquier otro 400 de Stampee es un error general, sin campo", async () => {
    outcome = { ok: false, status: 400, code: "VALIDATION", message: "x" };
    const res = await POST(req(BODY));
    expect(res.status).toBe(502);
    expect(await res.json()).not.toHaveProperty("field");
  });

  it("Stampee caído → 503; un celular imposible → 400 sin llamar a Stampee", async () => {
    outcome = { ok: false, status: null, code: null, message: "x" };
    expect((await POST(req(BODY))).status).toBe(503);
    const res = await POST(req({ ...BODY, buyer: { name: "Ana", phone: "123" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: "buyer.phone" });
  });
});
