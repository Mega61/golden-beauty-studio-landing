import { describe, expect, it, vi } from "vitest";

import type { AppointmentDeposit } from "@/db/types";
import type { IngestClient } from "@/lib/ingest-client";

import { summarizeDayTotals, type DayAccount } from "./day-close";
import { planDepositPush, summarizeDepositSync, syncDeposits } from "./deposits";

/**
 * Los adelantos hacia el CRM, y lo pagado con adelanto en la caja del día. El
 * adelanto es ingreso del día en que entró; usarlo al cobrar la cita no.
 */

const PAGO = new Date("2026-11-23T20:00:00Z"); // 3 p. m. del 23 de noviembre en Bogotá
const CITA = new Date("2026-12-12T15:00:00Z"); // 10 a. m. del 12 de diciembre
const NOCHE = new Date("2026-11-24T08:45:00Z"); // 3:45 a. m. del 24
const DESPUES = new Date("2026-12-02T08:45:00Z");

function adelanto(over: Partial<AppointmentDeposit> = {}): AppointmentDeposit {
  return {
    id: 7,
    ea_appointment_id: 501,
    appointment_start_at: CITA,
    amount: 50_000,
    method: "transferencia",
    paid_at: PAGO,
    paid_ref: null,
    customer_name: "Ana Ruiz",
    customer_phone: "+573001234567",
    created_by: "usr_1",
    created_at: PAGO,
    refunded_amount: null,
    refund_method: null,
    refunded_at: null,
    refunded_by: null,
    refund_reason: null,
    pushed_to_ingest_at: null,
    refund_pushed_at: null,
    ...over,
  };
}

const devuelto = {
  refunded_amount: 20_000,
  refund_method: "efectivo" as const,
  refunded_at: new Date("2026-12-01T17:00:00Z"),
  refunded_by: "usr_owner",
  refund_reason: "La cuenta salió menor",
};

describe("planDepositPush", () => {
  it("un adelanto sin enviar viaja el día en que entró, con la clienta y la cita como notas", () => {
    const plan = planDepositPush([adelanto()], { to: NOCHE });
    expect(plan.payments).toEqual([
      { source_tx_id: "abono:7", amount: 50_000, tip: 0, method: "transferencia", paid_on: "2026-11-23" },
    ]);
    expect(plan.depositIds).toEqual([7]);
    expect(plan.refundIds).toEqual([]);
    expect(plan.labels.get("abono:7")).toEqual({ clientName: "Ana Ruiz", serviceName: "Adelanto cita 2026-12-12" });
  });

  it("el de hoy espera a la noche", () => {
    expect(planDepositPush([adelanto()], { to: PAGO }).payments).toEqual([]);
  });

  it("uno ya enviado con devolución: sale solo el ajuste negativo, el día de la devolución", () => {
    const plan = planDepositPush([adelanto({ pushed_to_ingest_at: NOCHE, ...devuelto })], { to: DESPUES });
    expect(plan.payments).toEqual([
      { source_tx_id: "abono:7:adj1", amount: -20_000, tip: 0, method: "efectivo", paid_on: "2026-12-01" },
    ]);
    expect(plan.depositIds).toEqual([]);
    expect(plan.refundIds).toEqual([7]);
  });

  it("sin enviar y ya devuelto: viajan los dos, porque los dos movimientos fueron reales", () => {
    const plan = planDepositPush([adelanto(devuelto)], { to: DESPUES });
    expect(plan.payments.map((p) => [p.source_tx_id, p.amount])).toEqual([
      ["abono:7", 50_000],
      ["abono:7:adj1", -20_000],
    ]);
    expect(plan.depositIds).toEqual([7]);
    expect(plan.refundIds).toEqual([7]);
  });

  it("una devolución de hoy espera, aunque el adelanto sí salga", () => {
    const plan = planDepositPush([adelanto({ ...devuelto, refunded_at: DESPUES })], { to: DESPUES });
    expect(plan.payments.map((p) => p.source_tx_id)).toEqual(["abono:7"]);
    expect(plan.refundIds).toEqual([]);
  });

  it("antes de INGEST_SINCE no sale, y su devolución tampoco sola", () => {
    const plan = planDepositPush([adelanto(devuelto)], { to: DESPUES, since: "2026-11-24" });
    expect(plan.payments).toEqual([]);
  });

  it("ya enviado y devolución ya enviada: nada", () => {
    expect(
      planDepositPush([adelanto({ pushed_to_ingest_at: NOCHE, ...devuelto, refund_pushed_at: DESPUES })], { to: DESPUES })
        .payments,
    ).toEqual([]);
  });

  it("una fila imposible no tumba el lote: se salta y se dice", () => {
    const plan = planDepositPush([adelanto({ id: 8, amount: 0 }), adelanto()], { to: NOCHE });
    expect(plan.skipped).toEqual([{ id: 8, message: expect.stringContaining("adelanto 8") }]);
    expect(plan.depositIds).toEqual([7]);
  });

  it("sin la fecha de la cita, el rótulo dice solo Adelanto", () => {
    const plan = planDepositPush([adelanto({ appointment_start_at: null, customer_name: null })], { to: NOCHE });
    expect(plan.labels.get("abono:7")).toEqual({ clientName: null, serviceName: "Adelanto" });
  });
});

describe("syncDeposits", () => {
  function fakeDeps(rows: AppointmentDeposit[], push: IngestClient["push"] | null) {
    const marks: { what: string; ids: number[] }[] = [];
    const repos = {
      appointmentDeposits: {
        listPendingPush: async () => rows,
        markPushed: async (ids: number[]) => void marks.push({ what: "pushed", ids }),
        markRefundPushed: async (ids: number[]) => void marks.push({ what: "refund", ids }),
      },
      auditLog: { append: async () => {} },
    };
    const db = { transaction: () => ({ execute: async (fn: (trx: unknown) => Promise<unknown>) => fn(db) }) };
    vi.doMock("@/db", () => ({ repositories: () => repos }));
    return { marks, db, ingest: push === null ? null : ({ push, since: "2026-10-24" } as IngestClient) };
  }

  it("nada que mandar: nada", async () => {
    vi.resetModules();
    const { db, ingest } = fakeDeps([], null);
    const { syncDeposits: sync } = await import("./deposits");
    expect(await sync({ db: db as never, ingest }, { from: PAGO, to: NOCHE })).toEqual({ state: "nada" });
    vi.doUnmock("@/db");
  });

  it("con el push apagado, dice cuántos esperan y no marca nada", async () => {
    vi.resetModules();
    const { marks, db, ingest } = fakeDeps([adelanto()], null);
    const { syncDeposits: sync } = await import("./deposits");
    expect(await sync({ db: db as never, ingest }, { from: PAGO, to: NOCHE })).toEqual({ state: "apagado", pending: 1 });
    expect(marks).toEqual([]);
    vi.doUnmock("@/db");
  });

  it("manda el lote y marca lo que viajó: el adelanto y la devolución, cada uno con su marca", async () => {
    vi.resetModules();
    const push = vi.fn(async () => ({ sent: 2, status: 200, at: DESPUES }));
    const { marks, db, ingest } = fakeDeps(
      [adelanto(), adelanto({ id: 8, pushed_to_ingest_at: NOCHE, ...devuelto })],
      push,
    );
    const { syncDeposits: sync } = await import("./deposits");
    expect(await sync({ db: db as never, ingest }, { from: PAGO, to: DESPUES, now: DESPUES })).toEqual({
      state: "hecho",
      deposits: 1,
      refunds: 1,
    });
    expect(push).toHaveBeenCalledTimes(1);
    expect(marks).toEqual([
      { what: "pushed", ids: [7] },
      { what: "refund", ids: [8] },
    ]);
    vi.doUnmock("@/db");
  });

  it("si el CRM falla, no marca nada y se reintenta", async () => {
    vi.resetModules();
    const { IngestError } = await import("@/lib/ingest-client");
    const push = vi.fn(async () => {
      throw new IngestError("el CRM no respondió", { retryable: true });
    });
    const { marks, db, ingest } = fakeDeps([adelanto()], push);
    const { syncDeposits: sync } = await import("./deposits");
    const outcome = await sync({ db: db as never, ingest }, { from: PAGO, to: NOCHE });
    expect(outcome).toMatchObject({ state: "fallo", retryable: true });
    expect(marks).toEqual([]);
    vi.doUnmock("@/db");
  });

  it("el resumen de la noche", () => {
    expect(summarizeDepositSync({ state: "nada" })).toBeNull();
    expect(summarizeDepositSync({ state: "apagado", pending: 2 })).toMatch(/2 movimiento/);
    expect(summarizeDepositSync({ state: "hecho", deposits: 2, refunds: 0 })).toBe("adelantos: 2 adelanto(s) enviados");
    expect(summarizeDepositSync({ state: "hecho", deposits: 1, refunds: 1 })).toMatch(/1 devolución/);
    expect(summarizeDepositSync({ state: "fallo", message: "x", retryable: true })).toMatch(/falló — x/);
    expect(typeof syncDeposits).toBe("function");
  });
});

describe("la caja del día con una cuenta pagada en parte con adelanto", () => {
  it("el adelanto no entra al ingreso ni al cajón: va aparte", () => {
    const cuenta = {
      eaAppointmentId: 501,
      closedAt: CITA,
      houseCourtesy: false,
      amountCharged: 150_000,
      tip: 0,
      payments: [
        { method: "abono", amount: 50_000 },
        { method: "efectivo", amount: 100_000 },
      ],
    } as unknown as DayAccount;
    const totals = summarizeDayTotals([cuenta]);
    expect(totals).toMatchObject({ efectivo: 100_000, abono: 50_000, ingreso: 100_000, count: 1 });
  });
});
