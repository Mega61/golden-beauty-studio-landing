import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";
import type { Interval } from "@/lib/metrics";

import { legacyStatusKind, type FinanceRow } from "./aggregate";
import { demandReport, hourLabel, WEEK_ORDER, type DemandInput } from "./demand";

const at = (value: string) => parseEaLocalDateTime(value);

// Agosto de 2026: el 1 es sábado. Sábados: 1, 8, 15, 22, 29. Martes: 4, 11, 18, 25.
const AUGUST = {
  from: parseEaLocalDate("2026-08-01"),
  to: parseEaLocalDate("2026-08-31"),
};

function finance(start: string, charged: number | null, closed = charged !== null): FinanceRow {
  return {
    eaAppointmentId: Math.floor(Math.random() * 1e9),
    eaProviderId: 7,
    secondaryEaProviderId: null,
    startAt: at(start),
    bookedServiceId: 1,
    performedServiceId: 1,
    snapshot: charged,
    snapshotSource: "webhook",
    discount: 0,
    amountCharged: charged,
    tip: 0,
    payments: [],
    varianceReasonCode: null,
    closed,
    items: [],
  };
}

function open(day: string, from: string, to: string): Interval {
  return { start: at(`${day} ${from}:00`), end: at(`${day} ${to}:00`) };
}

function input(partial: Partial<DemandInput>): DemandInput {
  return {
    period: AUGUST,
    appointments: [],
    legacy: [],
    finance: [],
    open: [],
    ...partial,
  };
}

const idx = (weekday: (typeof WEEK_ORDER)[number]) => WEEK_ORDER.indexOf(weekday);

describe("demandReport — qué cuenta como demanda", () => {
  it("cuenta atendidas, agendadas e inasistencias; deja fuera canceladas y estados desconocidos", () => {
    const report = demandReport(
      input({
        appointments: [
          { start: at("2026-08-08 14:00:00"), status: "Completada" },
          { start: at("2026-08-08 14:30:00"), status: "Reservada" },
          { start: at("2026-08-08 15:00:00"), status: "Confirmada" },
          // La inasistencia es demanda: alguien pidió esa hora.
          { start: at("2026-08-08 15:00:00"), status: "No asistió" },
          { start: at("2026-08-08 16:00:00"), status: "Cancelada" },
          { start: at("2026-08-08 16:00:00"), status: "Pendiente" },
        ],
      }),
    );

    expect(report.total).toBe(4);
    expect(report.noShows).toBe(1);
    expect(report.cancelled).toBe(1);
    expect(report.unmapped).toBe(1);
  });

  it("ubica cada cita por la hora de pared de inicio y su día de la semana (lunes primero)", () => {
    const report = demandReport(
      input({
        appointments: [
          // Sábado 8 de agosto, 2 p. m. y 2:59 p. m. caen en la misma celda.
          { start: at("2026-08-08 14:00:00"), status: "Completada" },
          { start: at("2026-08-08 14:59:00"), status: "Completada" },
          // Lunes 3 de agosto, 9 a. m.
          { start: at("2026-08-03 09:00:00"), status: "Completada" },
        ],
      }),
    );

    expect(report.hours).toEqual([9, 10, 11, 12, 13, 14]);
    expect(report.cells[idx("saturday")][report.hours.indexOf(14)].count).toBe(2);
    expect(report.cells[idx("monday")][report.hours.indexOf(9)].count).toBe(1);
    expect(report.peakHour).toBe(14);
  });

  it("ignora lo que cae fuera del periodo, en EA y en Agenda Pro", () => {
    const report = demandReport(
      input({
        appointments: [{ start: at("2026-07-31 10:00:00"), status: "Completada" }],
        legacy: [{ at: at("2026-09-01 10:00:00"), kind: "atendida" }],
        finance: [finance("2026-09-01 10:00:00", 90_000)],
      }),
    );

    expect(report.total).toBe(0);
    expect(report.days.every((day) => day.revenue === 0)).toBe(true);
    expect(report.busiest).toBeNull();
  });
});

describe("demandReport — Agenda Pro", () => {
  it("las filas heredadas entran al conteo con la misma regla de estado", () => {
    const report = demandReport(
      input({
        legacy: [
          { at: at("2026-08-04 10:00:00"), kind: legacyStatusKind("Asistió") },
          { at: at("2026-08-04 11:00:00"), kind: legacyStatusKind("No asistió") },
          { at: at("2026-08-04 12:00:00"), kind: legacyStatusKind("Cancelada por cliente") },
        ],
      }),
    );

    expect(report.total).toBe(2);
    expect(report.fromLegacy).toBe(2);
    expect(report.noShows).toBe(1);
    expect(report.cancelled).toBe(1);
  });

  it("no suman ingreso: la plata sale solo de appointment_finance", () => {
    const report = demandReport(
      input({ legacy: [{ at: at("2026-08-04 10:00:00"), kind: "atendida" }] }),
    );
    expect(report.days.reduce((sum, day) => sum + day.revenue, 0)).toBe(0);
  });
});

describe("demandReport — ingreso por día", () => {
  it("suma solo cuentas cerradas, por el día de la semana en que empezó la cita", () => {
    const report = demandReport(
      input({
        finance: [
          finance("2026-08-08 10:00:00", 150_000),
          finance("2026-08-15 11:00:00", 95_000),
          // Sin cerrar: no cobró cero, no cobró. No entra.
          finance("2026-08-15 12:00:00", null),
          finance("2026-08-04 09:00:00", 60_000),
        ],
      }),
    );

    const saturday = report.days[idx("saturday")];
    expect(saturday.revenue).toBe(245_000);
    expect(saturday.tickets).toBe(2);
    expect(report.days[idx("tuesday")].revenue).toBe(60_000);
  });

  it("el ingreso es entero y nunca se recalcula: es la suma exacta de lo cobrado", () => {
    const rows = [finance("2026-08-08 10:00:00", 33_333), finance("2026-08-08 11:00:00", 66_667)];
    const report = demandReport(input({ finance: rows }));
    expect(report.days[idx("saturday")].revenue).toBe(100_000);
    expect(Number.isInteger(report.days[idx("saturday")].revenue)).toBe(true);
  });
});

describe("demandReport — el día más lleno y el más flojo", () => {
  // Sábados y martes abiertos todo el mes; el resto cerrado.
  const saturdays = ["01", "08", "15", "22", "29"].map((d) => open(`2026-08-${d}`, "09:00", "15:00"));
  const tuesdays = ["04", "11", "18", "25"].map((d) => open(`2026-08-${d}`, "09:00", "18:00"));

  it("compara citas **por día abierto**, no totales: un mes con cinco sábados no premia al sábado", () => {
    const report = demandReport(
      input({
        open: [...saturdays, ...tuesdays],
        appointments: [
          // 5 citas en 5 sábados = 1 por sábado.
          ...["01", "08", "15", "22", "29"].map((d) => ({
            start: at(`2026-08-${d} 10:00:00`),
            status: "Completada",
          })),
          // 4 citas en 4 martes = 1 por martes, y una más un martes = 1,25.
          ...["04", "11", "18", "25", "25"].map((d) => ({
            start: at(`2026-08-${d} 10:00:00`),
            status: "Completada",
          })),
        ],
      }),
    );

    expect(report.days[idx("saturday")].openDays).toBe(5);
    expect(report.days[idx("tuesday")].openDays).toBe(4);
    expect(report.busiest?.weekday).toBe("tuesday");
    expect(report.slowest?.weekday).toBe("saturday");
  });

  it("un día cerrado no es el más flojo: no tiene días abiertos y queda fuera del ranking", () => {
    const report = demandReport(
      input({
        open: [...saturdays, ...tuesdays],
        appointments: [
          { start: at("2026-08-08 10:00:00"), status: "Completada" },
          { start: at("2026-08-08 11:00:00"), status: "Completada" },
          { start: at("2026-08-04 10:00:00"), status: "Completada" },
        ],
      }),
    );

    const sunday = report.days[idx("sunday")];
    expect(sunday.openDays).toBe(0);
    expect(sunday.perOpenDay).toBeNull();
    expect(report.busiest?.weekday).toBe("saturday");
    expect(report.slowest?.weekday).toBe("tuesday");
  });

  it("un día abierto sin una sola cita sí puede ser el más flojo", () => {
    const report = demandReport(
      input({
        open: [...saturdays, ...tuesdays],
        appointments: [{ start: at("2026-08-08 10:00:00"), status: "Completada" }],
      }),
    );
    expect(report.slowest?.weekday).toBe("tuesday");
    expect(report.slowest?.perOpenDay).toBe(0);
  });

  it("sin citas no hay día más lleno ni más flojo", () => {
    const report = demandReport(input({ open: saturdays }));
    expect(report.busiest).toBeNull();
    expect(report.slowest).toBeNull();
    expect(report.peakHour).toBeNull();
  });

  it("con un solo día abierto no nombra un más flojo que sería el mismo", () => {
    const report = demandReport(
      input({
        open: saturdays,
        appointments: [{ start: at("2026-08-08 10:00:00"), status: "Completada" }],
      }),
    );
    expect(report.busiest?.weekday).toBe("saturday");
    expect(report.slowest).toBeNull();
  });

  it("a igual demanda por día decide la plata, y es determinista", () => {
    const report = demandReport(
      input({
        open: [open("2026-08-04", "09:00", "18:00"), open("2026-08-05", "09:00", "18:00")],
        appointments: [
          { start: at("2026-08-04 10:00:00"), status: "Completada" },
          { start: at("2026-08-05 10:00:00"), status: "Completada" },
        ],
        finance: [finance("2026-08-05 10:00:00", 90_000), finance("2026-08-04 10:00:00", 40_000)],
      }),
    );
    expect(report.busiest?.weekday).toBe("wednesday");
    expect(report.slowest?.weekday).toBe("tuesday");
  });
});

describe("demandReport — abierto vs. cerrado en el mapa", () => {
  it("una hora fuera de la jornada sin citas sale cerrada; dentro, abierta aunque esté en cero", () => {
    const report = demandReport(
      input({
        open: [open("2026-08-08", "09:00", "15:00")],
        appointments: [{ start: at("2026-08-04 17:00:00"), status: "Completada" }],
      }),
    );

    const saturday = report.cells[idx("saturday")];
    expect(saturday[report.hours.indexOf(9)]).toEqual({ count: 0, open: true });
    expect(saturday[report.hours.indexOf(14)]).toEqual({ count: 0, open: true });
    // 3 p. m.: la jornada termina a las 15:00 en punto, así que esa hora no abre.
    expect(saturday[report.hours.indexOf(15)]).toEqual({ count: 0, open: false });
    // Una cita fuera de jornada abre su celda: pasó, y esconderla escondería
    // la señal de que el plan cargado en EA no es el real.
    expect(report.cells[idx("tuesday")][report.hours.indexOf(17)]).toEqual({ count: 1, open: true });
  });

  it("las horas salen sin huecos, aunque el almuerzo no tenga citas", () => {
    const report = demandReport(
      input({
        appointments: [
          { start: at("2026-08-04 09:00:00"), status: "Completada" },
          { start: at("2026-08-04 16:00:00"), status: "Completada" },
        ],
      }),
    );
    expect(report.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("sin jornada que leer, aproxima los días abiertos con los días que tuvieron citas y lo marca", () => {
    const report = demandReport(
      input({
        appointments: [
          { start: at("2026-08-08 10:00:00"), status: "Completada" },
          { start: at("2026-08-08 11:00:00"), status: "Completada" },
          { start: at("2026-08-04 10:00:00"), status: "Completada" },
        ],
      }),
    );
    expect(report.hasOpenInfo).toBe(false);
    expect(report.days[idx("saturday")].openDays).toBe(1);
    expect(report.days[idx("tuesday")].perOpenDay).toBe(1);
    expect(report.busiest?.weekday).toBe("saturday");
  });

  it("un tramo de jornada que termina a medianoche cubre hasta las 11 p. m.", () => {
    const report = demandReport(
      input({
        open: [{ start: at("2026-08-08 22:00:00"), end: at("2026-08-09 00:00:00") }],
      }),
    );
    expect(report.hours).toEqual([22, 23]);
    expect(report.cells[idx("saturday")].every((cell) => cell.open)).toBe(true);
  });
});

describe("hourLabel", () => {
  it("rotula como las franjas del panel", () => {
    expect(hourLabel(9)).toBe("9 a. m.");
    expect(hourLabel(12)).toBe("12 m.");
    expect(hourLabel(14)).toBe("2 p. m.");
    expect(hourLabel(0)).toBe("12 a. m.");
  });
});

describe("legacyStatusKind", () => {
  it("lee el texto libre de Agenda Pro por exclusión", () => {
    expect(legacyStatusKind("Asistió")).toBe("atendida");
    expect(legacyStatusKind(null)).toBe("atendida");
    expect(legacyStatusKind("")).toBe("atendida");
    expect(legacyStatusKind("Confirmado")).toBe("atendida");
    expect(legacyStatusKind("No asistió")).toBe("no-asistio");
    expect(legacyStatusKind("no-show")).toBe("no-asistio");
    expect(legacyStatusKind("Cancelado")).toBe("cancelada");
    expect(legacyStatusKind("CANCELADA por la clienta")).toBe("cancelada");
  });
});
