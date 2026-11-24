import { describe, expect, it } from "vitest";

import type { GiftCardQuote } from "@/lib/gift-cards";
import { assertPaymentsCoverCharge } from "@/lib/ticket";

import {
  amountAfterGiftCard,
  draftFromFinance,
  draftToPayments,
  emptyDraft,
  tipMethodFor,
  tipNeedsMethod,
  type TicketDraft,
} from "./draft";

/**
 * El adelanto **en la cuenta** (migración `034`): un pago `abono` que cubre lo
 * que alcance después de la tarjeta regalo; los métodos de la hoja pagan el
 * resto. La misma función en la hoja y en el servidor.
 */

const SERVICIO = 2;

function draft(over: Partial<TicketDraft> = {}): TicketDraft {
  return { ...emptyDraft(7001, SERVICIO, 1_000), ...over };
}

describe("el adelanto paga primero lo que alcance", () => {
  it("parte: adelanto y el resto con el método de la hoja", () => {
    const payments = draftToPayments(draft({ payments: [{ method: "transferencia", amount: 0 }] }), 150_000, null, 50_000);
    expect(payments).toEqual([
      { method: "abono", amount: 50_000 },
      { method: "transferencia", amount: 100_000 },
    ]);
    expect(() => assertPaymentsCoverCharge(payments, 150_000)).not.toThrow();
    expect(amountAfterGiftCard(draft(), 150_000, null, 50_000)).toBe(100_000);
  });

  it("todo: un solo pago abono, aunque la hoja tenga un método elegido", () => {
    expect(draftToPayments(draft({ payments: [{ method: "efectivo", amount: 0 }] }), 150_000, null, 150_000)).toEqual([
      { method: "abono", amount: 150_000 },
    ]);
  });

  it("más que la cuenta: cubre la cuenta (el servidor rechaza el sobrante antes de llegar acá)", () => {
    expect(draftToPayments(draft(), 100_000, null, 150_000)).toEqual([{ method: "abono", amount: 100_000 }]);
    expect(amountAfterGiftCard(draft(), 100_000, null, 150_000)).toBe(0);
  });

  it("sin método elegido y con resto: solo el abono, y el servidor pide el método", () => {
    expect(draftToPayments(draft(), 150_000, null, 50_000)).toEqual([{ method: "abono", amount: 50_000 }]);
  });

  it("con dos métodos para el resto, los montos escritos se respetan", () => {
    expect(
      draftToPayments(
        draft({
          payments: [
            { method: "efectivo", amount: 40_000 },
            { method: "transferencia", amount: 60_000 },
          ],
        }),
        150_000,
        null,
        50_000,
      ),
    ).toEqual([
      { method: "abono", amount: 50_000 },
      { method: "efectivo", amount: 40_000 },
      { method: "transferencia", amount: 60_000 },
    ]);
  });

  it("después de la tarjeta regalo pagada: tarjeta, adelanto, resto", () => {
    const tarjeta: GiftCardQuote = {
      code: "TR-AB12-CD34",
      amountCop: 30_000,
      funded: true,
      minTicketCop: null,
      tierName: null,
      recipientName: null,
      validTo: null,
    };
    const conTarjeta = draft({ giftCardCode: "TR-AB12-CD34", payments: [{ method: "efectivo", amount: 0 }] });
    expect(draftToPayments(conTarjeta, 150_000, tarjeta, 50_000)).toEqual([
      { method: "bono", amount: 30_000 },
      { method: "abono", amount: 50_000 },
      { method: "efectivo", amount: 70_000 },
    ]);
    expect(amountAfterGiftCard(conTarjeta, 150_000, tarjeta, 50_000)).toBe(70_000);
  });

  it("una cortesía no usa adelanto", () => {
    expect(draftToPayments(draft({ houseCourtesy: true }), 0, null, 50_000)).toEqual([]);
    expect(amountAfterGiftCard(draft({ houseCourtesy: true }), 0, null, 50_000)).toBe(0);
  });

  it("sin adelanto, todo como siempre", () => {
    expect(draftToPayments(draft({ payments: [{ method: "efectivo", amount: 0 }] }), 150_000)).toEqual([
      { method: "efectivo", amount: 150_000 },
    ]);
  });
});

describe("la propina cuando el adelanto pagó todo", () => {
  const todo = [{ method: "abono" as const, amount: 150_000 }];

  it("necesita su método, igual que con tarjeta", () => {
    expect(tipNeedsMethod(draft({ tip: 5_000 }), todo)).toBe(true);
    expect(tipMethodFor(draft({ tip: 5_000, payments: [{ method: "efectivo", amount: 0 }] }), todo)).toBe("efectivo");
    expect(tipNeedsMethod(draft({ tip: 5_000, payments: [{ method: "efectivo", amount: 0 }] }), todo)).toBe(false);
  });

  it("al reabrir la cuenta, el abono no es un método de la hoja: lo vuelve a poner el servidor", () => {
    const reabierto = draftFromFinance(7001, SERVICIO, {
      performedServiceId: SERVICIO,
      discount: 0,
      tip: 0,
      amountCharged: 150_000,
      payments: [
        { method: "abono", amount: 50_000 },
        { method: "transferencia", amount: 100_000 },
      ],
      serviceNotes: "",
      varianceReasonCode: null,
      varianceReason: "",
      giftCardCode: null,
      tipMethod: null,
      items: [{ kind: "servicio", eaServiceId: SERVICIO, qty: 1, unitPrice: 150_000, note: null }],
    });
    expect(reabierto.payments).toEqual([{ method: "transferencia", amount: 100_000 }]);
  });
});
