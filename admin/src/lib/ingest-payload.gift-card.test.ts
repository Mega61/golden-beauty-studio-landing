import { describe, expect, it } from "vitest";

import { appointmentIdOfTx } from "./ingest-client";
import {
  IngestIdError,
  buildGiftSaleAdjustmentSourceTxId,
  buildGiftSaleSourceTxId,
  buildPaymentSourceTxId,
  giftSaleKeyOfTx,
} from "./ingest-id";
import {
  IngestPayloadError,
  buildDayClosePayments,
  buildGiftSalePayment,
  buildGiftSaleVoidAdjustment,
  buildIngestAdjustment,
  buildIngestPayment,
  pushableAmountOf,
  type FinanceForIngest,
} from "./ingest-payload";

/**
 * Las tarjetas regalo **en el push a Actual**. Dos reglas que, rotas, cuestan
 * plata sin error visible:
 *
 * 1. El pago de una cuenta con tarjeta **pagada** (`bono`) **no viaja**: esa
 *    plata entró el día de la venta. Mandarla otra vez la cuenta dos veces.
 * 2. La **venta** sí viaja, una vez, con su propia llave `bono:<código>`; su
 *    anulación después de viajar, como `bono:<código>:adj1` en negativo.
 */

const finance = (over: Partial<FinanceForIngest> = {}): FinanceForIngest => ({
  eaAppointmentId: 42,
  amountCharged: 120_000,
  tip: 5_000,
  paidOn: "2026-12-10",
  eaProviderId: 4,
  performedServiceId: 12,
  payments: [{ method: "efectivo", amount: 120_000 }],
  ...over,
});

describe("una cuenta pagada con tarjeta regalo", () => {
  it("toda con la tarjeta y sin propina: ningún movimiento", () => {
    expect(buildIngestPayment(finance({ tip: 0, payments: [{ method: "bono", amount: 120_000 }] }))).toEqual([]);
  });

  it("toda con la tarjeta y con propina: viaja la propina sola, monto 0, con la llave de la cuenta", () => {
    expect(
      buildIngestPayment(
        finance({ tip: 5_000, tipMethod: "transferencia", payments: [{ method: "bono", amount: 120_000 }] }),
      ),
    ).toEqual([
      { source_tx_id: "ea-appt:42", amount: 0, tip: 5_000, method: "transferencia", paid_on: "2026-12-10" },
    ]);
  });

  it("toda con la tarjeta, propina y sin método: no viaja a medias, falla ruidoso", () => {
    expect(() =>
      buildIngestPayment(finance({ tip: 5_000, payments: [{ method: "bono", amount: 120_000 }] })),
    ).toThrow(/propina sin decir el método/);
  });

  it("tarjeta + efectivo: viaja solo el efectivo, con la llave de la cuenta y la propina", () => {
    expect(
      buildIngestPayment(
        finance({
          payments: [
            { method: "bono", amount: 100_000 },
            { method: "efectivo", amount: 20_000 },
          ],
        }),
      ),
    ).toEqual([
      { source_tx_id: "ea-appt:42", amount: 20_000, tip: 5_000, method: "efectivo", paid_on: "2026-12-10" },
    ]);
  });

  it("tarjeta + dos métodos: una llave por método, sin la tarjeta", () => {
    const payments = buildIngestPayment(
      finance({
        payments: [
          { method: "bono", amount: 50_000 },
          { method: "efectivo", amount: 40_000 },
          { method: "transferencia", amount: 30_000 },
        ],
      }),
    );
    expect(payments.map((p) => [p.source_tx_id, p.amount, p.tip])).toEqual([
      ["ea-appt:42:efectivo", 40_000, 5_000],
      ["ea-appt:42:transferencia", 30_000, 0],
    ]);
  });

  it("la suma se sigue verificando con la tarjeta adentro", () => {
    expect(() =>
      buildIngestPayment(
        finance({
          payments: [
            { method: "bono", amount: 100_000 },
            { method: "efectivo", amount: 10_000 },
          ],
        }),
      ),
    ).toThrow(IngestPayloadError);
  });

  it("el día entero no trae ningún bono", () => {
    const lote = buildDayClosePayments([
      finance({ eaAppointmentId: 1, tip: 0, payments: [{ method: "bono", amount: 120_000 }] }),
      finance({ eaAppointmentId: 2 }),
    ]);
    expect(lote.map((p) => p.source_tx_id)).toEqual(["ea-appt:2"]);
    expect(lote.every((p) => (p.method as string) !== "bono")).toBe(true);
  });

  it("lo que viajó es lo cobrado menos la tarjeta", () => {
    expect(pushableAmountOf(120_000, [{ method: "bono", amount: 100_000 }, { method: "efectivo", amount: 20_000 }])).toBe(20_000);
    expect(pushableAmountOf(120_000, [{ method: "efectivo", amount: 120_000 }])).toBe(120_000);
    expect(pushableAmountOf(null, [])).toBe(0);
  });

  it("un ajuste sale con un método de plata, nunca con bono", () => {
    const ajuste = buildIngestAdjustment(
      finance({
        payments: [
          { method: "bono", amount: 100_000 },
          { method: "transferencia", amount: 30_000 },
        ],
        amountCharged: 130_000,
      }),
      10_000,
      1,
    );
    expect(ajuste).toMatchObject({ source_tx_id: "ea-appt:42:adj1", amount: 10_000, method: "transferencia" });
  });

  it("una cuenta solo con tarjeta no tiene con qué mandar un ajuste", () => {
    expect(() =>
      buildIngestAdjustment(finance({ payments: [{ method: "bono", amount: 120_000 }] }), -20_000, 1),
    ).toThrow(/solo con tarjeta regalo/);
  });

  it("…salvo con el método de su propina", () => {
    expect(
      buildIngestAdjustment(
        finance({ tipMethod: "efectivo", payments: [{ method: "bono", amount: 120_000 }] }),
        10_000,
        1,
      ),
    ).toMatchObject({ source_tx_id: "ea-appt:42:adj1", amount: 10_000, tip: 0, method: "efectivo" });
  });
});

describe("la venta de una tarjeta", () => {
  const venta = { code: "TR-AB12-CD34", amount: 100_000, method: "transferencia" as const, paidOn: "2026-12-01" };

  it("viaja con su llave, sin propina, el día del pago", () => {
    expect(buildGiftSalePayment(venta)).toEqual({
      source_tx_id: "bono:TR-AB12-CD34",
      amount: 100_000,
      tip: 0,
      method: "transferencia",
      paid_on: "2026-12-01",
    });
  });

  it("su anulación posterior al envío es el mismo monto en negativo, llave adj1, mismo día y método", () => {
    expect(buildGiftSaleVoidAdjustment(venta)).toEqual({
      source_tx_id: "bono:TR-AB12-CD34:adj1",
      amount: -100_000,
      tip: 0,
      method: "transferencia",
      paid_on: "2026-12-01",
    });
  });

  it("rechaza lo que no puede viajar", () => {
    expect(() => buildGiftSalePayment({ ...venta, amount: 0 })).toThrow(IngestPayloadError);
    expect(() => buildGiftSalePayment({ ...venta, paidOn: "1/12/2026" })).toThrow(IngestPayloadError);
    expect(() => buildGiftSalePayment({ ...venta, code: "tr-ab12-cd34" })).toThrow(IngestIdError);
    // Un método que no es de plata nunca viaja (ni `bono`, ni basura).
    expect(() => buildGiftSalePayment({ ...venta, method: "bono" as never })).toThrow(IngestPayloadError);
  });

  it("la anulación tampoco viaja sin monto", () => {
    expect(() => buildGiftSaleVoidAdjustment({ ...venta, amount: 0 })).toThrow(IngestPayloadError);
  });
});

describe("las llaves de las tarjetas", () => {
  it("no chocan con las de las citas ni se leen como una cita", () => {
    const sale = buildGiftSaleSourceTxId("TR-AB12-CD34");
    expect(sale).toBe("bono:TR-AB12-CD34");
    expect(sale).not.toBe(buildPaymentSourceTxId(42));
    expect(appointmentIdOfTx(sale)).toBeNull();
    expect(buildGiftSaleAdjustmentSourceTxId("TR-AB12-CD34", 1)).toBe("bono:TR-AB12-CD34:adj1");
  });

  it("la venta y su ajuste comparten la llave base (las notas de Actual)", () => {
    expect(giftSaleKeyOfTx("bono:TR-AB12-CD34")).toBe("bono:TR-AB12-CD34");
    expect(giftSaleKeyOfTx("bono:TR-AB12-CD34:adj1")).toBe("bono:TR-AB12-CD34");
    expect(giftSaleKeyOfTx("ea-appt:42")).toBeNull();
  });

  it("un código que no es canónico no produce llave", () => {
    expect(() => buildGiftSaleSourceTxId("TR-AB12")).toThrow(IngestIdError);
    expect(() => buildGiftSaleAdjustmentSourceTxId("TR-AB12-CD34", 0)).toThrow(IngestIdError);
  });
});
