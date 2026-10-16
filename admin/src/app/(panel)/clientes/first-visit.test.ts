import { describe, expect, it } from "vitest";

import { parseEaLocalDateTime } from "@/lib/ea/datetime";
import { hasVisitedBefore, type HistoryEntry } from "./history";

const at = (s: string) => parseEaLocalDateTime(s);

function entry(over: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: "ea-1",
    source: "ea",
    start: at("2026-10-01 14:00:00"),
    serviceName: "Press On",
    providerName: "Mariana",
    rawStatus: "Completada",
    outcome: "atendida",
    amountCharged: null,
    paymentMethods: [],
    courtesy: false,
    ...over,
  } as HistoryEntry;
}

const NOW = at("2026-10-16 15:00:00");

describe("hasVisitedBefore", () => {
  it("sin historial es primera visita", () => {
    expect(hasVisitedBefore([], NOW)).toBe(false);
  });

  it("una visita atendida antes la vuelve recurrente, también de Agenda Pro", () => {
    expect(hasVisitedBefore([entry({})], NOW)).toBe(true);
    expect(hasVisitedBefore([entry({ source: "legacy", id: "legacy-1" })], NOW)).toBe(true);
  });

  it("inasistencias y cancelaciones no cuentan", () => {
    expect(hasVisitedBefore([entry({ outcome: "no-asistio" }), entry({ outcome: "cancelada" })], NOW)).toBe(false);
  });

  it("una cita de EA con cuenta cerrada cuenta aunque el estado siga en Reservada", () => {
    expect(hasVisitedBefore([entry({ outcome: "desconocido", rawStatus: "Reservada", amountCharged: 80000 })], NOW)).toBe(true);
    expect(hasVisitedBefore([entry({ outcome: "desconocido", rawStatus: "Reservada" })], NOW)).toBe(false);
  });

  it("la cita misma (o una futura) no cuenta", () => {
    expect(hasVisitedBefore([entry({ start: NOW })], NOW)).toBe(false);
    expect(hasVisitedBefore([entry({ start: at("2026-10-20 14:00:00") })], NOW)).toBe(false);
  });
});
