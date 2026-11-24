import { describe, expect, it } from "vitest";

import {
  IngestIdError,
  buildDepositAdjustmentSourceTxId,
  buildDepositSourceTxId,
  buildGiftSaleSourceTxId,
  buildPaymentSourceTxId,
  depositKeyOfTx,
} from "./ingest-id";
import {
  IngestPayloadError,
  buildDepositPayment,
  buildDepositRefundAdjustment,
  buildIngestAdjustment,
  buildIngestPayment,
  isPrepaidMethod,
  moneyPaymentsOf,
  pushableAmountOf,
  type FinanceForIngest,
} from "./ingest-payload";

/**
 * Los adelantos **en el push a Actual** (migración `034`). Las mismas dos
 * reglas que las tarjetas regalo, y por la misma razón:
 *
 * 1. El pago `abono` de una cuenta **no viaja**: esa plata entró el día en que
 *    la clienta la pagó. Mandarla otra vez la cuenta dos veces.
 * 2. El **adelanto** sí viaja, una vez, el día en que entró, con su llave
 *    `abono:<id>` — que es la venta que el bot de finanzas enlaza con la
 *    transferencia. Su devolución, como `abono:<id>:adj1` en negativo.
 */

const finance = (over: Partial<FinanceForIngest> = {}): FinanceForIngest => ({
  eaAppointmentId: 42,
  amountCharged: 150_000,
  tip: 0,
  paidOn: "2026-12-12",
  eaProviderId: 4,
  performedServiceId: 12,
  payments: [{ method: "transferencia", amount: 150_000 }],
  ...over,
});

describe("las llaves", () => {
  it("abono:<id> y su ajuste, sin chocar con citas ni tarjetas", () => {
    expect(buildDepositSourceTxId(7)).toBe("abono:7");
    expect(buildDepositAdjustmentSourceTxId(7, 1)).toBe("abono:7:adj1");
    expect(buildDepositSourceTxId(7)).not.toBe(buildPaymentSourceTxId(7));
    expect(buildDepositSourceTxId(7).startsWith("bono:")).toBe(false);
    expect(buildGiftSaleSourceTxId("TR-AB12-CD34").startsWith("abono:")).toBe(false);
  });

  it("un id que no es un entero positivo no hace llave", () => {
    for (const malo of [0, -1, 1.5, Number.NaN]) {
      expect(() => buildDepositSourceTxId(malo)).toThrow(IngestIdError);
      expect(() => buildDepositAdjustmentSourceTxId(malo, 1)).toThrow(IngestIdError);
    }
    expect(() => buildDepositAdjustmentSourceTxId(7, 0)).toThrow(IngestIdError);
  });

  it("se leen de vuelta a la llave del adelanto, y nada más", () => {
    expect(depositKeyOfTx("abono:7")).toBe("abono:7");
    expect(depositKeyOfTx("abono:7:adj1")).toBe("abono:7");
    for (const otra of ["abono:07", "abono:0", "abono:7:adj0", "bono:TR-AB12-CD34", "ea-appt:7", "abono:"]) {
      expect(depositKeyOfTx(otra)).toBeNull();
    }
  });
});

describe("una cuenta pagada en parte con adelanto", () => {
  it("el adelanto no viaja: sale solo el resto, con la llave pelada de la cuenta", () => {
    expect(
      buildIngestPayment(
        finance({
          tip: 10_000,
          payments: [
            { method: "abono", amount: 50_000 },
            { method: "transferencia", amount: 100_000 },
          ],
        }),
      ),
    ).toEqual([
      { source_tx_id: "ea-appt:42", amount: 100_000, tip: 10_000, method: "transferencia", paid_on: "2026-12-12" },
    ]);
  });

  it("tarjeta + adelanto + efectivo: viaja solo el efectivo", () => {
    expect(
      buildIngestPayment(
        finance({
          payments: [
            { method: "bono", amount: 50_000 },
            { method: "abono", amount: 50_000 },
            { method: "efectivo", amount: 50_000 },
          ],
        }),
      ),
    ).toEqual([{ source_tx_id: "ea-appt:42", amount: 50_000, tip: 0, method: "efectivo", paid_on: "2026-12-12" }]);
  });

  it("todo con adelanto: nada, o la propina sola con su método", () => {
    expect(buildIngestPayment(finance({ payments: [{ method: "abono", amount: 150_000 }] }))).toEqual([]);
    expect(
      buildIngestPayment(
        finance({ tip: 5_000, tipMethod: "efectivo", payments: [{ method: "abono", amount: 150_000 }] }),
      ),
    ).toEqual([{ source_tx_id: "ea-appt:42", amount: 0, tip: 5_000, method: "efectivo", paid_on: "2026-12-12" }]);
    expect(() =>
      buildIngestPayment(finance({ tip: 5_000, payments: [{ method: "abono", amount: 150_000 }] })),
    ).toThrow(/tarjeta regalo o adelanto/);
  });

  it("lo que viajó (la base de un ajuste) es lo cobrado menos tarjeta y adelanto", () => {
    expect(
      pushableAmountOf(150_000, [
        { method: "abono", amount: 50_000 },
        { method: "bono", amount: 20_000 },
        { method: "efectivo", amount: 80_000 },
      ]),
    ).toBe(80_000);
    expect(moneyPaymentsOf([{ method: "abono", amount: 1 }])).toEqual([]);
    expect(isPrepaidMethod("abono")).toBe(true);
    expect(isPrepaidMethod("bono")).toBe(true);
    expect(isPrepaidMethod("efectivo")).toBe(false);
  });

  it("un ajuste de una cuenta pagada solo con adelanto no tiene método con el que viajar", () => {
    expect(() =>
      buildIngestAdjustment(finance({ payments: [{ method: "abono", amount: 150_000 }] }), 10_000, 1),
    ).toThrow(/tarjeta regalo o adelanto/);
  });
});

describe("el adelanto, como movimiento", () => {
  const adelanto = { id: 7, amount: 50_000, method: "transferencia" as const, paidOn: "2026-11-23" };

  it("ingreso del día en que entró, sin propina", () => {
    expect(buildDepositPayment(adelanto)).toEqual({
      source_tx_id: "abono:7",
      amount: 50_000,
      tip: 0,
      method: "transferencia",
      paid_on: "2026-11-23",
    });
  });

  it("la devolución: lo devuelto en negativo, por donde y cuando salió", () => {
    expect(
      buildDepositRefundAdjustment({ id: 7, refundedAmount: 20_000, refundMethod: "efectivo", refundedOn: "2026-12-01" }),
    ).toEqual({ source_tx_id: "abono:7:adj1", amount: -20_000, tip: 0, method: "efectivo", paid_on: "2026-12-01" });
  });

  it("lo que no puede ser plata no sale", () => {
    expect(() => buildDepositPayment({ ...adelanto, amount: 0 })).toThrow(IngestPayloadError);
    expect(() => buildDepositPayment({ ...adelanto, amount: 1.5 })).toThrow(IngestPayloadError);
    expect(() => buildDepositPayment({ ...adelanto, paidOn: "23/11/2026" })).toThrow(IngestPayloadError);
    expect(() => buildDepositPayment({ ...adelanto, method: "bono" as never })).toThrow(IngestPayloadError);
    expect(() =>
      buildDepositRefundAdjustment({ id: 7, refundedAmount: 0, refundMethod: "efectivo", refundedOn: "2026-12-01" }),
    ).toThrow(IngestPayloadError);
  });
});
