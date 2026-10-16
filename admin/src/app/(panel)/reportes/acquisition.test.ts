import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";
import { splitCustomers, type VisitRecord } from "@/lib/metrics";

import {
  acquisitionReport,
  monthsInPeriod,
  parseAdSpendForm,
  parseMonth,
  partialMonths,
  type AdSpendEntry,
} from "./acquisition";
import type { FinanceRow } from "./aggregate";

const at = (value: string) => parseEaLocalDateTime(value);
const day = (value: string) => parseEaLocalDate(value);

const AUGUST = { from: day("2026-08-01"), to: day("2026-08-31") };

const NUEVA_A = "+573001110001";
const NUEVA_B = "+573001110002";
const VIEJA = "+573001110003";

/** Una nueva (A, dos visitas en el mes), otra nueva (B), y una que vuelve. */
const VISITS: VisitRecord[] = [
  { customerKey: VIEJA, at: at("2026-05-10 10:00:00"), attended: true },
  { customerKey: VIEJA, at: at("2026-08-05 10:00:00"), attended: true },
  { customerKey: NUEVA_A, at: at("2026-08-08 14:00:00"), attended: true },
  { customerKey: NUEVA_A, at: at("2026-08-22 14:00:00"), attended: true },
  { customerKey: NUEVA_B, at: at("2026-08-15 15:00:00"), attended: true },
];

function finance(id: number, start: string, charged: number | null): FinanceRow {
  return {
    eaAppointmentId: id,
    eaProviderId: 7,
    secondaryEaProviderId: null,
    startAt: at(start),
    bookedServiceId: 1,
    performedServiceId: 1,
    snapshot: charged,
    snapshotSource: "webhook",
    discount: 0,
    amountCharged: charged,
    tip: 5_000,
    payments: [],
    varianceReasonCode: null,
    closed: charged !== null,
    houseCourtesy: false,
    items: [],
  };
}

const FINANCE = [
  finance(1, "2026-08-05 10:00:00", 150_000), // vieja: no entra
  finance(2, "2026-08-08 14:00:00", 95_000), // nueva A
  finance(3, "2026-08-22 14:00:00", 60_000), // nueva A, segunda visita
  finance(4, "2026-08-15 15:00:00", null), // nueva B, sin cerrar: no entra
];

const CUSTOMER_OF = new Map<number, string | null>([
  [1, VIEJA],
  [2, NUEVA_A],
  [3, NUEVA_A],
  [4, NUEVA_B],
]);

function report(adSpend: AdSpendEntry[] | null, overrides: Partial<Parameters<typeof acquisitionReport>[0]> = {}) {
  return acquisitionReport({
    period: AUGUST,
    visits: VISITS,
    finance: FINANCE,
    customerOf: CUSTOMER_OF,
    adSpend,
    ...overrides,
  });
}

describe("acquisitionReport — la definición de clienta nueva no se toca", () => {
  it("cuenta las mismas nuevas que splitCustomers(), que es lo que usa el reporte de clientas", () => {
    const result = report([{ month: "2026-08", channel: "meta", amountCop: 300_000 }]);
    expect(result.newCustomers).toBe(splitCustomers(VISITS, AUGUST).newCustomers.length);
    expect(result.newCustomers).toBe(2);
  });
});

describe("acquisitionReport — costo por clienta nueva", () => {
  it("divide la inversión del mes entre las nuevas, a peso entero", () => {
    const result = report([
      { month: "2026-08", channel: "meta", amountCop: 250_000 },
      { month: "2026-08", channel: "google", amountCop: 50_001 },
    ]);
    expect(result.state).toBe("ok");
    expect(result.spend).toBe(300_001);
    expect(result.costPerNew).toBe(150_001); // 150.000,5 → redondeo a peso
    expect(Number.isInteger(result.costPerNew)).toBe(true);
    expect(result.byChannel).toEqual([
      { channel: "meta", amount: 250_000 },
      { channel: "google", amount: 50_001 },
    ]);
  });

  it("'ya recuperado' = lo que pagaron las nuevas en cuentas cerradas ÷ inversión, sin propinas", () => {
    const result = report([{ month: "2026-08", channel: "meta", amountCop: 310_000 }]);
    // 95.000 + 60.000 de la nueva A; la B no cerró; la vieja no es nueva.
    expect(result.revenueFromNew).toBe(155_000);
    expect(result.newWithRevenue).toBe(1);
    expect(result.recovered).toBeCloseTo(0.5, 10);
  });

  it("una cuenta de una nueva fuera del periodo no entra", () => {
    const result = report([{ month: "2026-08", channel: "meta", amountCop: 100_000 }], {
      finance: [...FINANCE, finance(5, "2026-09-02 10:00:00", 500_000)],
      customerOf: new Map([...CUSTOMER_OF, [5, NUEVA_A]]),
    });
    expect(result.revenueFromNew).toBe(155_000);
  });
});

describe("acquisitionReport — dividir por cero no da un número", () => {
  it("sin ninguna fila de inversión: null y 'sin-inversion', nunca $ 0", () => {
    const result = report([]);
    expect(result.state).toBe("sin-inversion");
    expect(result.spend).toBeNull();
    expect(result.costPerNew).toBeNull();
    expect(result.recovered).toBeNull();
    expect(result.missingMonths).toEqual(["2026-08"]);
  });

  it("inversión de otro mes no cuenta para este", () => {
    const result = report([{ month: "2026-07", channel: "meta", amountCop: 900_000 }]);
    expect(result.state).toBe("sin-inversion");
    expect(result.spend).toBeNull();
  });

  it("una inversión anotada en cero es 'no se pautó', no costo cero", () => {
    const result = report([{ month: "2026-08", channel: "meta", amountCop: 0 }]);
    expect(result.state).toBe("sin-pauta");
    expect(result.spend).toBe(0);
    expect(result.costPerNew).toBeNull();
    expect(result.recovered).toBeNull();
  });

  it("con inversión y sin clientas nuevas: 'sin-clientas', costo null, recuperado 0", () => {
    const result = report([{ month: "2026-08", channel: "meta", amountCop: 200_000 }], {
      visits: VISITS.filter((visit) => visit.customerKey === VIEJA),
    });
    expect(result.state).toBe("sin-clientas");
    expect(result.newCustomers).toBe(0);
    expect(result.costPerNew).toBeNull();
    expect(result.recovered).toBe(0);
    expect(Number.isFinite(result.recovered ?? NaN)).toBe(true);
  });

  it("si ad_spend no se pudo leer, lo dice en vez de suponer cero", () => {
    const result = report(null);
    expect(result.state).toBe("sin-lectura");
    expect(result.spend).toBeNull();
    expect(result.costPerNew).toBeNull();
    // Las nuevas y su plata siguen saliendo: no dependen de la tabla nueva.
    expect(result.newCustomers).toBe(2);
    expect(result.revenueFromNew).toBe(155_000);
  });
});

describe("acquisitionReport — periodos que no son meses enteros", () => {
  it("suma los meses completos que el periodo toca, y los marca como parciales", () => {
    const period = { from: day("2026-07-20"), to: day("2026-08-10") };
    const result = report(
      [
        { month: "2026-07", channel: "meta", amountCop: 400_000 },
        { month: "2026-08", channel: "meta", amountCop: 300_000 },
        { month: "2026-09", channel: "meta", amountCop: 999_999 },
      ],
      { period },
    );
    expect(result.months).toEqual(["2026-07", "2026-08"]);
    expect(result.partialMonths).toEqual(["2026-07", "2026-08"]);
    // Sin prorrateo: la factura completa de los dos meses, nunca una fracción inventada.
    expect(result.spend).toBe(700_000);
  });

  it("dice qué mes del periodo no tiene inversión anotada", () => {
    const period = { from: day("2026-07-01"), to: day("2026-08-31") };
    const result = report([{ month: "2026-08", channel: "meta", amountCop: 300_000 }], { period });
    expect(result.missingMonths).toEqual(["2026-07"]);
    expect(result.partialMonths).toEqual([]);
  });
});

describe("monthsInPeriod / partialMonths", () => {
  it("cruza el año", () => {
    expect(monthsInPeriod({ from: day("2026-11-15"), to: day("2027-02-03") })).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  it("un mes entero no es parcial, ni en febrero bisiesto", () => {
    expect(partialMonths({ from: day("2028-02-01"), to: day("2028-02-29") })).toEqual([]);
    expect(partialMonths({ from: day("2027-02-01"), to: day("2027-02-28") })).toEqual([]);
    expect(partialMonths({ from: day("2028-02-01"), to: day("2028-02-28") })).toEqual(["2028-02"]);
  });

  it("una quincena es parcial", () => {
    expect(partialMonths({ from: day("2026-08-16"), to: day("2026-08-31") })).toEqual(["2026-08"]);
  });
});

describe("parseMonth", () => {
  it("acepta YYYY-MM y nada más", () => {
    expect(parseMonth("2026-08")).toBe("2026-08");
    expect(parseMonth(" 2026-12 ")).toBe("2026-12");
    expect(parseMonth("2026-13")).toBeNull();
    expect(parseMonth("2026-00")).toBeNull();
    expect(parseMonth("2026-8")).toBeNull();
    expect(parseMonth("2026-08-01")).toBeNull();
    expect(parseMonth(202608)).toBeNull();
  });
});

describe("parseAdSpendForm", () => {
  const ok = { month: "2026-08", channel: "meta", amount: "1.200.000", notes: "" };

  it("toma los dígitos de lo que escribió la persona", () => {
    expect(parseAdSpendForm(ok)).toEqual({
      ok: true,
      value: { month: "2026-08", channel: "meta", amountCop: 1_200_000, notes: null },
    });
    expect(parseAdSpendForm({ ...ok, amount: "$ 450000" })).toMatchObject({
      ok: true,
      value: { amountCop: 450_000 },
    });
  });

  it("cero es una cifra válida: el mes que no se pautó", () => {
    expect(parseAdSpendForm({ ...ok, amount: "0" })).toMatchObject({ ok: true, value: { amountCop: 0 } });
  });

  it("rechaza negativos y centavos en vez de pelarles los dígitos", () => {
    expect(parseAdSpendForm({ ...ok, amount: "-200.000" }).ok).toBe(false);
    expect(parseAdSpendForm({ ...ok, amount: "1.500,50" }).ok).toBe(false);
  });

  it("rechaza vacío, cifras absurdas, mes o canal inválidos", () => {
    expect(parseAdSpendForm({ ...ok, amount: "" }).ok).toBe(false);
    expect(parseAdSpendForm({ ...ok, amount: "100000001" }).ok).toBe(false);
    expect(parseAdSpendForm({ ...ok, month: "agosto" }).ok).toBe(false);
    expect(parseAdSpendForm({ ...ok, channel: "tiktok" }).ok).toBe(false);
    expect(parseAdSpendForm({ ...ok, notes: "x".repeat(501) }).ok).toBe(false);
  });

  it("conserva la nota recortada", () => {
    expect(parseAdSpendForm({ ...ok, notes: "  campaña de uñas navideñas " })).toMatchObject({
      ok: true,
      value: { notes: "campaña de uñas navideñas" },
    });
  });
});
