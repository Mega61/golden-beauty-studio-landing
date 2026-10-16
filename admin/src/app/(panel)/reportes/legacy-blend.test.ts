import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";

import {
  dailyClose,
  noShowReport,
  type AppointmentRow,
  type FinanceRow,
  type ProviderRow,
  type ServiceRow,
} from "./aggregate";
import {
  legacyNoShowInputs,
  legacyReportRows,
  salesReport,
  salesSeries,
  salesTotal,
  type LegacyRawRow,
} from "./legacy-blend";

const at = (value: string) => parseEaLocalDateTime(value);
const day = (value: string) => parseEaLocalDate(value);

const PROVIDERS: ProviderRow[] = [
  { id: 7, name: "Mariana Ruiz" },
  { id: 8, name: "Daniela Cano" },
];

const SERVICES: ServiceRow[] = [
  { id: 1, name: "Semipermanente manos", durationMin: 60 },
  { id: 2, name: "Forrado", durationMin: 90 },
];

const SEPT = { from: day("2026-09-01"), to: day("2026-09-30") };

function raw(n: number, over: Partial<LegacyRawRow> = {}): LegacyRawRow {
  return {
    sourceId: `AP-${n}`,
    start: at("2026-09-10 10:00:00"),
    serviceName: "Semipermanente manos",
    providerName: "Mariana",
    amountCharged: 50_000,
    status: "Asiste",
    customerKey: `+57300000${String(n).padStart(4, "0")}`,
    clientName: `Cliente ${n}`,
    ...over,
  };
}

function finance(over: Partial<FinanceRow> = {}): FinanceRow {
  return {
    eaAppointmentId: 1,
    eaProviderId: 7,
    secondaryEaProviderId: null,
    startAt: at("2026-09-20 09:00:00"),
    bookedServiceId: 2,
    performedServiceId: 2,
    snapshot: 90_000,
    snapshotSource: "webhook",
    discount: 0,
    amountCharged: 90_000,
    tip: 5_000,
    payments: [{ method: "efectivo", amount: 90_000 }],
    varianceReasonCode: null,
    closed: true,
    items: [],
    ...over,
  };
}

function appointment(over: Partial<AppointmentRow> = {}): AppointmentRow {
  return {
    id: 1,
    start: at("2026-09-20 09:00:00"),
    end: at("2026-09-20 10:30:00"),
    status: "Completada",
    eaProviderId: 7,
    eaServiceId: 2,
    customerKey: "+573001112233",
    googleCalendarId: "evt-1",
    ...over,
  };
}

describe("legacyReportRows", () => {
  it("se queda con el periodo y casa por nombre de pila", () => {
    const rows = legacyReportRows(
      [
        raw(1),
        raw(2, { providerName: "Kati" }),
        raw(3, { start: at("2026-10-01 09:00:00") }),
        raw(4, { start: at("2026-08-31 18:00:00") }),
      ],
      SEPT,
      [],
      PROVIDERS,
    );
    expect(rows.map((row) => [row.sourceId, row.eaProviderId])).toEqual([
      ["AP-1", 7],
      ["AP-2", null],
    ]);
  });

  it("descarta las reservas que ya se recrearon en EA (mismo teléfono, misma hora)", () => {
    const rows = legacyReportRows(
      [raw(1, { start: at("2026-09-20 09:00:00"), customerKey: "+573001112233", status: "Reservado" }), raw(2)],
      SEPT,
      [appointment()],
      PROVIDERS,
    );
    expect(rows.map((row) => row.sourceId)).toEqual(["AP-2"]);
  });
});

describe("salesReport", () => {
  const legacy = legacyReportRows(
    [
      raw(1),
      raw(2, { providerName: "Kati", serviceName: "SEMIPERMANENTE MANOS", amountCharged: 55_000 }),
      raw(3, { status: "Cancelado", amountCharged: 40_000 }),
      raw(4, { status: "No Asiste", amountCharged: null }),
      raw(5, { status: "Reservado", amountCharged: null }),
      raw(6, { amountCharged: null }),
      raw(7, { serviceName: "Uñas en gel", providerName: "Kati", amountCharged: 70_000 }),
    ],
    SEPT,
    [],
    PROVIDERS,
  );

  const report = salesReport(
    [finance(), finance({ eaAppointmentId: 2, closed: false, amountCharged: null })],
    [appointment(), appointment({ id: 2, status: "Reservada" })],
    legacy,
    PROVIDERS,
    SERVICES,
  );

  it("suma lo cobrado del panel y de las atendidas de Agenda Pro, sin propinas", () => {
    expect(report.panelTotal).toBe(90_000);
    // 50.000 + 55.000 + 70.000; la cancelada no vende aunque traiga monto.
    expect(report.legacyTotal).toBe(175_000);
    expect(report.total).toBe(265_000);
  });

  it("cuenta todas las citas y aparte las atendidas", () => {
    expect(report.appointments).toBe(2 + 7);
    expect(report.legacyAppointments).toBe(7);
    // EA: 1 completada. Agenda Pro: AP-1, AP-2, AP-6, AP-7.
    expect(report.attended).toBe(1 + 4);
    expect(report.legacyAttended).toBe(4);
  });

  it("una atendida sin monto se cuenta aparte, nunca como $ 0", () => {
    expect(report.legacyUnpriced).toBe(1);
  });

  it("junta servicios por nombre normalizado y deja aparte los que no casan", () => {
    const semi = report.byService.find((row) => row.key === "s:semipermanente manos");
    expect(semi).toMatchObject({ revenue: 105_000, legacyRevenue: 105_000, count: 2, legacyCount: 2 });
    const forrado = report.byService.find((row) => row.key === "s:forrado");
    expect(forrado).toMatchObject({ revenue: 90_000, legacyRevenue: 0, count: 1 });
    expect(report.byService.find((row) => row.key === "s:unas en gel")?.revenue).toBe(70_000);
  });

  it("por profesional: Mariana suma panel + Agenda Pro; Kati queda con su nombre", () => {
    const mariana = report.byProvider.find((row) => row.key === "p:7");
    expect(mariana).toMatchObject({ name: "Mariana Ruiz", revenue: 140_000, legacyRevenue: 50_000 });
    const kati = report.byProvider.find((row) => row.name === "Kati");
    expect(kati).toMatchObject({ revenue: 125_000, legacyRevenue: 125_000, count: 2 });
    expect(report.byProvider[0].name).toBe("Mariana Ruiz");
  });

  it("salesTotal y salesSeries dan lo mismo que el reporte", () => {
    expect(salesTotal([finance()], legacy)).toBe(report.total);
    const series = salesSeries([finance()], legacy, [day("2026-09-10"), day("2026-09-20")]);
    expect(series).toEqual([175_000, 90_000]);
  });

  it("sin historial es exactamente el ingreso de siempre", () => {
    const plain = salesReport([finance()], [appointment()], [], PROVIDERS, SERVICES);
    expect(plain.total).toBe(90_000);
    expect(plain.legacyAppointments).toBe(0);
  });
});

describe("inasistencia con historial", () => {
  it("las citas de Agenda Pro entran a la tasa por franja", () => {
    const legacy = legacyReportRows(
      [
        raw(1, { start: at("2026-09-10 09:00:00") }),
        raw(2, { start: at("2026-09-10 09:30:00"), status: "No Asiste" }),
        raw(3, { start: at("2026-09-10 10:00:00"), status: "Cancelado" }),
      ],
      SEPT,
      [],
      PROVIDERS,
    );
    const report = noShowReport([appointment()], legacyNoShowInputs(legacy));
    expect(report.scheduled).toBe(4);
    expect(report.noShows).toBe(1);
    expect(report.cancelled).toBe(1);
    expect(report.rate).toBe(0.25);
    expect(report.legacyCount).toBe(3);
  });

  it("sin historial, el reporte no cambia", () => {
    const report = noShowReport([appointment(), appointment({ id: 2, status: "No asistió" })]);
    expect(report.scheduled).toBe(2);
    expect(report.legacyCount).toBe(0);
  });
});

describe("la caja no sabe del historial", () => {
  it("dailyClose solo recibe cuentas del panel: no tiene por dónde entrar Agenda Pro", () => {
    // `dailyClose(finance, appointments, providers)`: su firma no tiene un
    // lugar para el historial, y el cierre es el mismo con o sin él en el
    // periodo. Si alguien le agrega un parámetro de historial, esto obliga a
    // mirarlo.
    expect(dailyClose.length).toBe(3);
    const close = dailyClose([finance()], [appointment()], PROVIDERS);
    expect(close.revenue).toBe(90_000);
  });
});
