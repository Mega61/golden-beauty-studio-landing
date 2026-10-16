import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";

import { legacyPaymentReport, type LegacyPaymentRow } from "./legacy-payments";

const at = (value: string) => parseEaLocalDateTime(value);
const day = (value: string) => parseEaLocalDate(value);

function row(
  saleKey: string,
  paidAt: string,
  amount: number,
  method: LegacyPaymentRow["method"],
  tip = 0,
  courtesy = false,
): LegacyPaymentRow {
  return { saleKey, paidAt: at(paidAt), amount, tip, method, courtesy };
}

const JULY = { from: day("2026-07-01"), to: day("2026-07-31") };

describe("legacyPaymentReport", () => {
  it("reparte el periodo por método, con su parte del total", () => {
    const report = legacyPaymentReport(
      [
        row("1", "2026-07-02 10:00:00", 60_000, "efectivo"),
        row("2", "2026-07-03 10:00:00", 140_000, "transferencia"),
        row("3", "2026-08-01 09:00:00", 99_000, "efectivo"),
      ],
      JULY,
    );
    expect(report.period.total).toBe(200_000);
    expect(report.period.byMethod).toEqual([
      { method: "efectivo", label: "Efectivo", amount: 60_000, count: 1, share: 0.3 },
      { method: "transferencia", label: "Transferencia", amount: 140_000, count: 1, share: 0.7 },
      { method: "otro", label: "Otro", amount: 0, count: 0, share: 0 },
    ]);
  });

  it("va por fecha de pago, con los bordes del periodo inclusivos", () => {
    const report = legacyPaymentReport(
      [
        row("1", "2026-06-30 23:59:00", 1_000, "efectivo"),
        row("2", "2026-07-01 00:00:00", 2_000, "efectivo"),
        row("3", "2026-07-31 23:59:00", 4_000, "efectivo"),
        row("4", "2026-08-01 00:00:00", 8_000, "efectivo"),
      ],
      JULY,
    );
    expect(report.period.total).toBe(6_000);
  });

  it("la propina va aparte: no entra al total ni al ticket promedio", () => {
    const report = legacyPaymentReport(
      [
        row("1", "2026-07-02 10:00:00", 100_000, "efectivo", 10_000),
        row("2", "2026-07-03 10:00:00", 50_000, "transferencia"),
      ],
      JULY,
    );
    expect(report.period).toMatchObject({ total: 150_000, tips: 10_000, averageTicket: 75_000 });
  });

  it("el ticket es por venta: un pago dividido cuenta una vez, y se redondea al peso", () => {
    const report = legacyPaymentReport(
      [
        row("A", "2026-07-02 10:00:00", 30_000, "efectivo"),
        row("A", "2026-07-02 10:01:00", 20_000, "transferencia"),
        row("B", "2026-07-03 10:00:00", 50_001, "transferencia"),
        row("C", "2026-07-04 10:00:00", 50_000, "transferencia"),
      ],
      JULY,
    );
    expect(report.period).toMatchObject({ payments: 4, sales: 3, total: 150_001, averageTicket: 50_000 });
  });

  it("sin pagos en el periodo: total cero, sin ticket ni partes (no 0 %)", () => {
    const report = legacyPaymentReport([row("1", "2026-08-02 10:00:00", 1_000, "efectivo")], JULY);
    expect(report.period).toMatchObject({ total: 0, payments: 0, sales: 0, averageTicket: null });
    expect(report.period.byMethod.every((entry) => entry.share === null)).toBe(true);
  });

  it("los meses van todos, en orden, con el del periodo marcado", () => {
    const report = legacyPaymentReport(
      [
        row("3", "2026-08-01 09:00:00", 99_000, "efectivo", 1_000),
        row("1", "2026-06-02 10:00:00", 60_000, "efectivo"),
        row("2", "2026-07-03 10:00:00", 140_000, "transferencia"),
      ],
      JULY,
    );
    expect(report.months.map((month) => [month.month, month.label, month.inPeriod, month.total, month.tips])).toEqual([
      ["2026-06", "junio 2026", false, 60_000, 0],
      ["2026-07", "julio 2026", true, 140_000, 0],
      ["2026-08", "agosto 2026", false, 99_000, 1_000],
    ]);
  });

  it("un periodo de varios meses marca todos los que toca", () => {
    const report = legacyPaymentReport(
      [row("1", "2026-06-30 10:00:00", 1, "efectivo"), row("2", "2026-07-01 10:00:00", 1, "efectivo")],
      { from: day("2026-06-16"), to: day("2026-07-15") },
    );
    expect(report.months.map((month) => month.inPeriod)).toEqual([true, true]);
  });

  it("la cortesía queda fuera de lo cobrado, del reparto y del ticket, y se cuenta aparte", () => {
    const report = legacyPaymentReport(
      [
        row("A", "2026-07-02 10:00:00", 100_000, "efectivo"),
        row("B", "2026-07-03 10:00:00", 50_000, "transferencia"),
        row("C", "2026-07-04 10:00:00", 90_000, "transferencia", 0, true),
        row("D", "2026-07-05 10:00:00", 60_000, "efectivo", 0, true),
      ],
      JULY,
    );
    expect(report.period).toMatchObject({
      total: 150_000,
      payments: 2,
      sales: 2,
      averageTicket: 75_000,
      courtesy: { sales: 2, amount: 150_000 },
    });
    expect(report.period.byMethod.map((entry) => entry.amount)).toEqual([100_000, 50_000, 0]);
    expect(report.months[0].courtesy).toEqual({ sales: 2, amount: 150_000 });
  });

  it("un periodo con solo cortesías: cero cobrado, sin ticket, y la cortesía a la vista", () => {
    const report = legacyPaymentReport([row("C", "2026-07-04 10:00:00", 90_000, "efectivo", 0, true)], JULY);
    expect(report.period).toMatchObject({ total: 0, sales: 0, averageTicket: null, courtesy: { sales: 1, amount: 90_000 } });
  });
});
