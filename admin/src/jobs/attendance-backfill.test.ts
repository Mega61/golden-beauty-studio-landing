import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Db } from "@/db";
import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea/datetime";
import type { Appointment } from "@/lib/ea/types";

/**
 * El backfill de asistencia: la regla pura y la corrida con EA y la base
 * doblados. Lo que importa fijar es qué se escribe —solo el estado, solo a las
 * cerradas que siguen reservadas— y que una ejecución en seco no escribe nada.
 */

let financeRows: { ea_appointment_id: number; closed_at: Date | null }[];
let audits: unknown[];

vi.mock("@/db/repositories", () => ({
  repositories: () => ({
    appointmentFinance: { listByStartRange: async () => financeRows },
    auditLog: {
      append: async (entry: unknown) => {
        audits.push(entry);
      },
    },
  }),
}));

const { planAttendanceBackfill, runAttendanceBackfill, summarizeAttendanceBackfill } =
  await import("./attendance-backfill");

function cita(id: number, status: string, start = "2026-09-10 09:00:00") {
  return { id, status, start: parseEaLocalDateTime(start) } satisfies Pick<
    Appointment,
    "id" | "status" | "start"
  >;
}

describe("planAttendanceBackfill", () => {
  it("marca las cerradas que siguen reservadas, y deja el resto contado", () => {
    const plan = planAttendanceBackfill(
      [1, 2, 3, 4, 5, 6, 7],
      [
        cita(1, "Reservada", "2026-09-11 09:00:00"),
        cita(2, "Confirmada", "2026-09-10 09:00:00"),
        cita(3, "Completada"),
        cita(4, "Cancelada"),
        cita(5, "No asistió"),
        cita(6, "Draft"),
        // 7 no está en EA.
        cita(99, "Reservada"), // sin cuenta cerrada: no se toca.
      ],
    );

    expect(plan.toComplete.map((c) => c.id)).toEqual([2, 5, 1]);
    expect(plan.alreadyCompleted).toBe(1);
    expect(plan.skipped).toEqual([
      { id: 4, status: "Cancelada" },
      { id: 6, status: "Draft" },
    ]);
    expect(plan.notInEa).toEqual([7]);
  });
});

describe("runAttendanceBackfill", () => {
  let updates: { id: number; input: unknown }[];
  const ea = {
    appointments: {
      list: async () => [cita(1, "Reservada"), cita(2, "Completada"), cita(3, "Confirmada")],
      update: async (id: number, input: unknown) => {
        updates.push({ id, input });
        if (id === 3) throw new Error("429");
        return {} as Appointment;
      },
    },
  } as never;

  beforeEach(() => {
    updates = [];
    audits = [];
    financeRows = [
      { ea_appointment_id: 1, closed_at: new Date() },
      { ea_appointment_id: 2, closed_at: new Date() },
      { ea_appointment_id: 3, closed_at: new Date() },
      { ea_appointment_id: 4, closed_at: null },
    ];
  });

  const range = {
    db: {} as Db,
    ea,
    from: parseEaLocalDate("2026-09-01"),
    till: parseEaLocalDate("2026-09-30"),
    sleep: async () => {},
  };

  it("en seco no escribe nada", async () => {
    const report = await runAttendanceBackfill({ ...range, apply: false });
    expect(updates).toEqual([]);
    expect(report.plan.toComplete.map((c) => c.id)).toEqual([1, 3]);
    expect(summarizeAttendanceBackfill(report)).toContain("En seco");
  });

  it("con --aplicar escribe solo el estado, sigue ante un fallo y lo cuenta", async () => {
    const report = await runAttendanceBackfill({ ...range, apply: true });
    expect(updates).toEqual([
      { id: 1, input: { status: "Completada" } },
      { id: 3, input: { status: "Completada" } },
    ]);
    expect(report.written).toEqual([1]);
    expect(report.failed.map((f) => f.id)).toEqual([3]);
    expect(audits).toHaveLength(1);
  });

  it("respeta el tope por corrida y deja el resto para la próxima", async () => {
    const report = await runAttendanceBackfill({ ...range, apply: true, maxWrites: 1 });
    expect(updates.map((u) => u.id)).toEqual([1]);
    expect(report.deferred).toBe(1);
  });

  it("sin cuentas cerradas ni le pregunta a EA", async () => {
    financeRows = [];
    const list = vi.fn(async () => []);
    const report = await runAttendanceBackfill({
      ...range,
      ea: { appointments: { list, update: async () => ({}) } } as never,
      apply: true,
    });
    expect(list).not.toHaveBeenCalled();
    expect(report.plan.toComplete).toEqual([]);
  });
});
