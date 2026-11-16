import { describe, expect, it, vi } from "vitest";

import type { GiftCardSale } from "@/db/types";
import type { IngestClient } from "@/lib/ingest-client";

import { summarizeDayTotals, type DayAccount } from "./day-close";
import { planGiftSalePush, summarizeGiftSaleSync, syncGiftCardSales } from "./gift-card-sales";

/**
 * Las ventas de tarjetas regalo hacia el CRM, y lo pagado con tarjeta en la
 * caja del día. La venta es ingreso del día del pago; la redención no.
 */

const PAGO = new Date("2026-12-01T20:00:00Z"); // 3 p. m. del 1 de diciembre en Bogotá

function venta(over: Partial<GiftCardSale> = {}): GiftCardSale {
  return {
    id: 1,
    stampee_gift_card_id: "gc-1",
    code: "TR-AB12-CD34",
    tier_name: "Consentida",
    amount: 100_000,
    method: "transferencia",
    paid_at: PAGO,
    paid_ref: null,
    buyer_name: "Ana Ruiz",
    buyer_phone: "+573001234567",
    created_by: "usr_1",
    created_at: PAGO,
    voided_at: null,
    voided_by: null,
    void_reason: null,
    pushed_to_ingest_at: null,
    void_pushed_at: null,
    ...over,
  };
}

describe("planGiftSalePush", () => {
  it("una venta sin enviar viaja, con la compradora y el nivel como notas", () => {
    const plan = planGiftSalePush([venta()]);
    expect(plan.payments).toEqual([
      { source_tx_id: "bono:TR-AB12-CD34", amount: 100_000, tip: 0, method: "transferencia", paid_on: "2026-12-01" },
    ]);
    expect(plan.saleIds).toEqual([1]);
    expect(plan.voidIds).toEqual([]);
    expect(plan.labels.get("bono:TR-AB12-CD34")).toEqual({
      clientName: "Ana Ruiz",
      serviceName: "Tarjeta regalo Consentida",
    });
  });

  it("anulada antes de viajar: no viaja nunca", () => {
    expect(planGiftSalePush([venta({ voided_at: PAGO })]).payments).toEqual([]);
  });

  it("anulada después de viajar: sale el ajuste negativo una vez", () => {
    const enviada = { pushed_to_ingest_at: PAGO, voided_at: new Date("2026-12-05T15:00:00Z") };
    const plan = planGiftSalePush([venta(enviada)]);
    expect(plan.payments.map((p) => [p.source_tx_id, p.amount, p.paid_on])).toEqual([
      ["bono:TR-AB12-CD34:adj1", -100_000, "2026-12-01"],
    ]);
    expect(plan.voidIds).toEqual([1]);
    expect(planGiftSalePush([venta({ ...enviada, void_pushed_at: PAGO })]).payments).toEqual([]);
  });

  it("ya enviada y vigente: nada", () => {
    expect(planGiftSalePush([venta({ pushed_to_ingest_at: PAGO })]).payments).toEqual([]);
  });

  it("anterior al corte: no viaja", () => {
    expect(planGiftSalePush([venta()], { since: "2026-12-02" }).payments).toEqual([]);
    expect(planGiftSalePush([venta()], { since: "2026-12-01" }).payments).toHaveLength(1);
  });
});

describe("syncGiftCardSales", () => {
  function fakeDeps(rows: GiftCardSale[], push: IngestClient["push"] | null) {
    const marks: { what: string; ids: number[] }[] = [];
    const repos = {
      giftCardSales: {
        listPendingPush: async () => rows,
        markPushed: async (ids: number[]) => void marks.push({ what: "sale", ids }),
        markVoidPushed: async (ids: number[]) => void marks.push({ what: "void", ids }),
      },
      auditLog: { append: async () => {} },
    };
    const db = { transaction: () => ({ execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(db) }) };
    vi.doMock("@/db", () => ({ repositories: () => repos }));
    return { marks, db, ingest: push === null ? null : ({ push, since: "2026-10-24" } as IngestClient) };
  }

  it("manda el lote y marca lo que viajó", async () => {
    vi.resetModules();
    const push = vi.fn(async () => ({ sent: 2, status: 200, at: PAGO }));
    const { marks, db, ingest } = fakeDeps(
      [venta(), venta({ id: 2, code: "TR-ZZZZ-0000", pushed_to_ingest_at: PAGO, voided_at: PAGO })],
      push,
    );
    const { syncGiftCardSales: sync } = await import("./gift-card-sales");
    const outcome = await sync({ db: db as never, ingest }, { from: PAGO, to: PAGO });
    expect(outcome).toEqual({ state: "hecho", sales: 1, voids: 1 });
    expect(push).toHaveBeenCalledTimes(1);
    expect(marks).toEqual([
      { what: "sale", ids: [1] },
      { what: "void", ids: [2] },
    ]);
    vi.doUnmock("@/db");
  });

  it("con el push apagado no marca nada", async () => {
    vi.resetModules();
    const { marks, db, ingest } = fakeDeps([venta()], null);
    const { syncGiftCardSales: sync } = await import("./gift-card-sales");
    expect(await sync({ db: db as never, ingest }, { from: PAGO, to: PAGO })).toEqual({ state: "apagado", pending: 1 });
    expect(marks).toEqual([]);
    vi.doUnmock("@/db");
  });

  it("el resumen de la noche lo dice en una línea", () => {
    expect(summarizeGiftSaleSync({ state: "nada" })).toBeNull();
    expect(summarizeGiftSaleSync({ state: "hecho", sales: 2, voids: 0 })).toBe("tarjetas regalo: 2 venta(s) enviadas");
    expect(typeof syncGiftCardSales).toBe("function");
  });
});

describe("la caja del día con tarjeta regalo", () => {
  const cuenta = (payments: DayAccount["payments"], amount: number): DayAccount => ({
    financeId: 1,
    eaAppointmentId: 1,
    amountCharged: amount,
    tip: 0,
    payments,
    paidOn: "2026-12-10",
    eaProviderId: 4,
    performedServiceId: 1,
    houseCourtesy: false,
    closedAt: PAGO,
    dayCloseId: null,
    pushedToIngestAt: null,
  });

  it("lo pagado con tarjeta va aparte: ni ingreso ni cajón", () => {
    const totals = summarizeDayTotals([
      cuenta([{ method: "bono", amount: 100_000 }, { method: "efectivo", amount: 20_000 }], 120_000),
      cuenta([{ method: "bono", amount: 50_000 }], 50_000),
    ]);
    expect(totals).toMatchObject({ efectivo: 20_000, bono: 150_000, ingreso: 20_000, count: 2, sinMetodo: 0 });
  });
});
