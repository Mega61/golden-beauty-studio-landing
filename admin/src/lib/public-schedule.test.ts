import { describe, expect, it } from "vitest";

import type { WorkingPlan, WorkingPlanException } from "@/lib/ea/types";
import { publicSchedule } from "./public-schedule";

const day = { start: "09:00", end: "18:00", breaks: [] };
const plan: WorkingPlan = {
  sunday: null,
  monday: day,
  tuesday: day,
  wednesday: day,
  thursday: day,
  friday: day,
  saturday: day,
};

function ex(partial: Partial<WorkingPlanException>): WorkingPlanException {
  return {
    id: 1,
    startDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    breaks: [],
    providerId: 1,
    ...partial,
  } as WorkingPlanException;
}

describe("publicSchedule", () => {
  it("apaga los días que el plan semanal deja libres", () => {
    expect(publicSchedule(plan, [], "2026-10-15").offWeekdays).toEqual([0]);
  });

  it("sin plan no apaga nada: lo dirá la consulta de horarios", () => {
    expect(publicSchedule(null, [], "2026-10-15").offWeekdays).toEqual([]);
  });

  it("una excepción sin horas cierra cada día de su rango", () => {
    const s = publicSchedule(
      plan,
      [ex({ startDate: "2026-10-20" as never, endDate: "2026-10-22" as never })],
      "2026-10-15",
    );
    expect(s.closedDates).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
  });

  it("una excepción con horas abre un día libre", () => {
    const s = publicSchedule(
      plan,
      [ex({ startDate: "2026-10-18" as never, startTime: "10:00", endTime: "14:00" })],
      "2026-10-15",
    );
    expect(s.openDates).toEqual(["2026-10-18"]);
  });

  it("cerrar gana sobre abrir el mismo día, en cualquier orden", () => {
    const abre = ex({ startDate: "2026-10-18" as never, startTime: "10:00", endTime: "14:00" });
    const cierra = ex({ startDate: "2026-10-18" as never });
    for (const list of [
      [abre, cierra],
      [cierra, abre],
    ]) {
      const s = publicSchedule(plan, list, "2026-10-15");
      expect(s.closedDates).toEqual(["2026-10-18"]);
      expect(s.openDates).toEqual([]);
    }
  });

  it("no manda lo que ya pasó", () => {
    const s = publicSchedule(
      plan,
      [ex({ startDate: "2026-10-10" as never, endDate: "2026-10-16" as never })],
      "2026-10-15",
    );
    expect(s.closedDates).toEqual(["2026-10-15", "2026-10-16"]);
  });

  it("un rango absurdo no se expande para siempre", () => {
    const s = publicSchedule(
      plan,
      [ex({ startDate: "2026-10-15" as never, endDate: "2030-01-01" as never })],
      "2026-10-15",
    );
    expect(s.closedDates.length).toBeLessThanOrEqual(130);
  });
});
