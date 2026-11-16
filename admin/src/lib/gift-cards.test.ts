import { describe, expect, it } from "vitest";

import {
  buildGiftCardShareText,
  checkGiftCard,
  giftCardDiscount,
  giftCardPayment,
  giftCardReasonText,
  giftCodeFromReason,
  giftPaidAt,
  normalizeColombianPhone,
  normalizeGiftCode,
  parseGiftOrder,
  redeemErrorMessage,
  releaseSettled,
  summarizeGiftSales,
  voidBlockReason,
  type GiftCardFacts,
  type GiftCardQuote,
} from "./gift-cards";

/**
 * Las reglas de las tarjetas regalo. Deciden si una tarjeta se puede usar,
 * cuánto cubre y si es pago o descuento: un error acá regala un servicio o
 * cobra dos veces una tarjeta ya pagada.
 */

function tarjeta(over: Partial<GiftCardFacts> = {}): GiftCardFacts {
  return {
    code: "TR-AB12-CD34",
    amountCop: 100_000,
    status: "active",
    funded: true,
    tierName: "Consentida",
    recipientName: "Lucía",
    validFrom: "2026-11-01",
    validTo: "2027-11-01",
    minTicketCop: null,
    rules: {},
    redeemedRef: null,
    ...over,
  };
}

const CTX = { date: "2026-12-10", redeemRef: "ea-appt:501", newOrDormant: false };

describe("normalizeGiftCode", () => {
  it.each([
    ["TR-AB12-CD34", "TR-AB12-CD34"],
    ["tr-ab12-cd34", "TR-AB12-CD34"],
    ["  TR AB12 CD34 ", "TR-AB12-CD34"],
    ["trab12cd34", "TR-AB12-CD34"],
    // Crockford: O se lee como 0; I y L como 1.
    ["TR-ABO2-CDL4", "TR-AB02-CD14"],
  ])("%s → %s", (raw, code) => {
    expect(normalizeGiftCode(raw)).toBe(code);
  });

  it.each(["", "GB-AB12", "TR-AB12-CD3", "TR-AB12-CD345", "TR-AU12-CD34", "XX-AB12-CD34", null, undefined])(
    "rechaza %s",
    (raw) => {
      expect(normalizeGiftCode(raw as string | null | undefined)).toBeNull();
    },
  );
});

describe("checkGiftCard", () => {
  it("una tarjeta activa y vigente se puede usar", () => {
    const check = checkGiftCard(tarjeta(), CTX);
    expect(check).toEqual({
      ok: true,
      quote: {
        code: "TR-AB12-CD34",
        amountCop: 100_000,
        funded: true,
        minTicketCop: null,
        tierName: "Consentida",
        recipientName: "Lucía",
        validTo: "2027-11-01",
      },
    });
  });

  it("sin pagar, usada en otra visita o anulada, no", () => {
    expect(checkGiftCard(tarjeta({ status: "pending_payment" }), CTX)).toMatchObject({
      ok: false,
      message: expect.stringContaining("todavía no está pagada"),
    });
    expect(checkGiftCard(tarjeta({ status: "redeemed", redeemedRef: "ea-appt:9" }), CTX)).toMatchObject({
      ok: false,
      message: expect.stringContaining("ya se usó"),
    });
    expect(checkGiftCard(tarjeta({ status: "void" }), CTX)).toMatchObject({ ok: false });
  });

  it("usada en esta misma cuenta sí: es volver a guardarla", () => {
    expect(checkGiftCard(tarjeta({ status: "redeemed", redeemedRef: "ea-appt:501" }), CTX).ok).toBe(true);
  });

  it("la vigencia se mide el día de la cita, bordes incluidos", () => {
    expect(checkGiftCard(tarjeta(), { ...CTX, date: "2026-11-01" }).ok).toBe(true);
    expect(checkGiftCard(tarjeta(), { ...CTX, date: "2027-11-01" }).ok).toBe(true);
    expect(checkGiftCard(tarjeta(), { ...CTX, date: "2027-11-02" })).toMatchObject({
      ok: false,
      message: expect.stringContaining("venció"),
    });
    expect(checkGiftCard(tarjeta(), { ...CTX, date: "2026-10-31" }).ok).toBe(false);
  });

  it("promocional solo para nuevas: con historial que dice que ya vino, no; sin historial, tampoco", () => {
    const promo = tarjeta({ funded: false, rules: { recipient: "new_or_dormant" } });
    expect(checkGiftCard(promo, { ...CTX, newOrDormant: true }).ok).toBe(true);
    expect(checkGiftCard(promo, { ...CTX, newOrDormant: false }).ok).toBe(false);
    expect(checkGiftCard(promo, { ...CTX, newOrDormant: null })).toMatchObject({
      ok: false,
      message: expect.stringContaining("no se pudo revisar"),
    });
  });

  it("la regla de destinataria no aplica a una tarjeta pagada", () => {
    const pagada = tarjeta({ funded: true, rules: { recipient: "new_or_dormant" } });
    expect(checkGiftCard(pagada, { ...CTX, newOrDormant: false }).ok).toBe(true);
  });
});

function quote(over: Partial<GiftCardQuote> = {}): GiftCardQuote {
  return {
    code: "TR-AB12-CD34",
    amountCop: 50_000,
    funded: false,
    minTicketCop: null,
    tierName: null,
    recipientName: null,
    validTo: null,
    ...over,
  };
}

describe("giftCardDiscount (promocional)", () => {
  it("descuenta su monto, nunca más que el subtotal", () => {
    expect(giftCardDiscount(quote(), 120_000)).toBe(50_000);
    expect(giftCardDiscount(quote(), 30_000)).toBe(30_000);
  });

  it("respeta el ticket mínimo", () => {
    expect(giftCardDiscount(quote({ minTicketCop: 80_000 }), 79_999)).toBeNull();
    expect(giftCardDiscount(quote({ minTicketCop: 80_000 }), 80_000)).toBe(50_000);
  });

  it("una pagada no es descuento", () => {
    expect(giftCardDiscount(quote({ funded: true }), 120_000)).toBeNull();
    expect(giftCardDiscount(null, 120_000)).toBeNull();
  });
});

describe("giftCardPayment (pagada)", () => {
  it("cubre todo lo que alcance, una sola vez y sin vueltas", () => {
    expect(giftCardPayment(quote({ funded: true, amountCop: 100_000 }), 140_000)).toBe(100_000);
    expect(giftCardPayment(quote({ funded: true, amountCop: 100_000 }), 80_000)).toBe(80_000);
    expect(giftCardPayment(quote({ funded: true }), 0)).toBe(0);
  });

  it("una promocional no paga nada", () => {
    expect(giftCardPayment(quote({ funded: false }), 80_000)).toBe(0);
  });
});

describe("el motivo de una cuenta con tarjeta promocional", () => {
  it("va y vuelve", () => {
    expect(giftCardReasonText("TR-AB12-CD34")).toBe("bono TR-AB12-CD34");
    expect(giftCodeFromReason("bono TR-AB12-CD34")).toBe("TR-AB12-CD34");
    expect(giftCodeFromReason("miercoles-pies")).toBeNull();
    expect(giftCodeFromReason(null)).toBeNull();
  });
});

describe("el mensaje para la compradora", () => {
  it("lleva el código y el link, y ningún precio", () => {
    const text = buildGiftCardShareText({
      buyerFirstName: "Ana",
      recipientName: "Lucía",
      code: "TR-AB12-CD34",
      url: "https://stampee.app/golden/regalo/u-1",
    });
    expect(text).toContain("TR-AB12-CD34");
    expect(text).toContain("https://stampee.app/golden/regalo/u-1");
    expect(text).toContain("Lucía");
    expect(text).not.toMatch(/\$|\d{2}\.\d{3}/);
  });
});

describe("summarizeGiftSales", () => {
  it("suma por método y deja fuera las anuladas", () => {
    expect(
      summarizeGiftSales([
        { method: "efectivo", amount: 50_000, voided: false },
        { method: "transferencia", amount: 100_000, voided: false },
        { method: "efectivo", amount: 150_000, voided: true },
      ]),
    ).toEqual({ efectivo: 50_000, transferencia: 100_000, otro: 0, total: 150_000, count: 2, voided: 1 });
  });
});

describe("voidBlockReason", () => {
  const base = { voided: false, pushed: false, cardStatus: "active" as const, canFixAfterSync: false };
  it("sin viajar, recepción anula", () => {
    expect(voidBlockReason(base)).toBeNull();
  });
  it("ya en Actual, solo la dueña", () => {
    expect(voidBlockReason({ ...base, pushed: true })).toMatch(/Solo la dueña/);
    expect(voidBlockReason({ ...base, pushed: true, canFixAfterSync: true })).toBeNull();
  });
  it("una tarjeta usada no se anula, ni una venta ya anulada", () => {
    expect(voidBlockReason({ ...base, cardStatus: "redeemed", canFixAfterSync: true })).toMatch(/ya se usó/);
    expect(voidBlockReason({ ...base, voided: true })).toMatch(/ya está anulada/);
  });
});

describe("giftPaidAt", () => {
  const now = new Date("2026-12-10T20:00:00Z"); // 3 p. m. en Bogotá
  it("hoy es ahora; un día anterior es su mediodía en Bogotá; el futuro no", () => {
    expect(giftPaidAt("2026-12-10", now)).toBe(now);
    expect(giftPaidAt("2026-12-09", now)?.toISOString()).toBe("2026-12-09T17:00:00.000Z");
    expect(giftPaidAt("2026-12-11", now)).toBeNull();
  });
});

describe("el pedido de la landing", () => {
  const body = {
    tierId: "tier-1",
    buyer: { name: "  Ana   Ruiz ", phone: "300 123 4567" },
    recipientName: "Lucía",
    message: "Feliz navidad",
    ref: "Adviento",
  };

  it("normaliza el celular como lo escribió la persona", () => {
    expect(parseGiftOrder(body)).toEqual({
      ok: true,
      order: {
        tierId: "tier-1",
        buyerName: "Ana Ruiz",
        buyerPhone: "+573001234567",
        recipientName: "Lucía",
        message: "Feliz navidad",
        ref: "adviento",
      },
    });
  });

  it.each([
    ["300 123 4567", "+573001234567"],
    ["+57 300 123 4567", "+573001234567"],
    ["573001234567", "+573001234567"],
    ["(300) 123-4567", "+573001234567"],
    ["123 4567", null],
    ["601 123 4567", null],
    ["no tengo", null],
  ])("celular %s → %s", (raw, e164) => {
    expect(normalizeColombianPhone(raw)).toBe(e164);
  });

  it("nombra el campo malo", () => {
    expect(parseGiftOrder({ ...body, tierId: "" })).toEqual({ ok: false, field: "tierId" });
    expect(parseGiftOrder({ ...body, buyer: { name: "A", phone: "3001234567" } })).toEqual({
      ok: false,
      field: "buyer.name",
    });
    expect(parseGiftOrder({ ...body, buyer: { name: "Ana", phone: "123" } })).toEqual({
      ok: false,
      field: "buyer.phone",
    });
    expect(parseGiftOrder({ ...body, message: "x".repeat(141) })).toEqual({ ok: false, field: "message" });
    expect(parseGiftOrder({ ...body, recipientName: "L" })).toEqual({ ok: false, field: "recipientName" });
    expect(parseGiftOrder(null)).toEqual({ ok: false, field: "body" });
  });

  it("lo opcional ausente queda en null", () => {
    expect(parseGiftOrder({ tierId: "t", buyer: { name: "Ana", phone: "3001234567" } })).toMatchObject({
      ok: true,
      order: { recipientName: null, message: null, ref: null },
    });
  });
});

describe("los rechazos de Stampee, para la técnica", () => {
  it.each([
    ["ALREADY_REDEEMED", 409, "ya se usó"],
    ["NOT_PAID", 409, "todavía no está pagada"],
    ["VOID", 409, "anulada"],
    ["EXPIRED", 409, "venció"],
    ["NOT_YET_VALID", 409, "todavía no vale"],
    ["VALIDATION", 400, "más de lo que vale"],
    [null, 400, "no aceptó"],
    [null, 503, "no respondió"],
  ])("%s → %s", (code, status, texto) => {
    expect(redeemErrorMessage(code, status, "TR-AB12-CD34")).toContain(texto);
  });

  it("liberar: solo el OK y REF_MISMATCH cierran el asunto", () => {
    expect(releaseSettled({ ok: true })).toBe(true);
    expect(releaseSettled({ ok: false, code: "REF_MISMATCH" })).toBe(true);
    expect(releaseSettled({ ok: false, code: "NOT_REDEEMED" })).toBe(false);
    expect(releaseSettled({ ok: false, code: null })).toBe(false);
  });
});
