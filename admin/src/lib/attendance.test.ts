import { describe, expect, it } from "vitest";

import {
  canConfirm,
  attendanceOutcome,
  attendanceView,
  attendanceWindowOpen,
  noShowRate,
  planAttendanceWrite,
  restoreStatus,
  statusAfterClose,
  unmarkedAppointments,
} from "./attendance";

describe("attendanceWindowOpen", () => {
  it("se abre quince minutos antes de la hora", () => {
    expect(attendanceWindowOpen("2026-10-16 10:00:00", "2026-10-16 09:44:00")).toBe(false);
    expect(attendanceWindowOpen("2026-10-16 10:00:00", "2026-10-16 09:45:00")).toBe(true);
    expect(attendanceWindowOpen("2026-10-16 10:00:00", "2026-10-16 15:00:00")).toBe(true);
  });

  it("una hora que no parsea no abre nada", () => {
    expect(attendanceWindowOpen("", "2026-10-16 15:00:00")).toBe(false);
  });
});

describe("attendanceView", () => {
  const open = { closed: false, windowOpen: true } as const;

  it("una reserva ya en hora ofrece los dos botones; antes, nada", () => {
    expect(attendanceView({ ...open, status: "Reservada" })).toEqual({ kind: "marcar" });
    expect(attendanceView({ ...open, status: "Confirmada" })).toEqual({ kind: "marcar" });
    expect(attendanceView({ ...open, status: "Reprogramada" })).toEqual({ kind: "marcar" });
    expect(attendanceView({ ...open, status: "Reservada", windowOpen: false })).toEqual({
      kind: "temprano",
    });
  });

  it("lo marcado se puede deshacer mientras no haya cuenta cerrada", () => {
    expect(attendanceView({ ...open, status: "No asistió" })).toEqual({
      kind: "marcada",
      mark: "no-asistio",
      undoable: true,
    });
    expect(attendanceView({ ...open, status: "Completada" })).toEqual({
      kind: "marcada",
      mark: "llego",
      undoable: true,
    });
    expect(attendanceView({ ...open, status: "Completada", closed: true })).toEqual({
      kind: "marcada",
      mark: "llego",
      undoable: false,
    });
  });

  it("con la cuenta cerrada llegó, diga lo que diga EA", () => {
    expect(attendanceView({ ...open, status: "Reservada", closed: true })).toMatchObject({
      kind: "marcada",
      mark: "llego",
    });
  });

  it("cancelada o desconocido: nada que marcar", () => {
    expect(attendanceView({ ...open, status: "Cancelada" })).toEqual({ kind: "nada" });
    expect(attendanceView({ ...open, status: "Draft" })).toEqual({ kind: "nada" });
    expect(attendanceView({ ...open, status: "" })).toEqual({ kind: "nada" });
  });
});

describe("planAttendanceWrite", () => {
  const base = { closed: false, windowOpen: true } as const;

  it("Llegó escribe Completada; No asistió escribe «No asistió»", () => {
    expect(planAttendanceWrite({ ...base, mark: "llego", currentStatus: "Reservada" })).toEqual({
      ok: true,
      status: "Completada",
    });
    expect(
      planAttendanceWrite({ ...base, mark: "no-asistio", currentStatus: "Confirmada" }),
    ).toEqual({ ok: true, status: "No asistió" });
  });

  it("si ya estaba así no escribe: cada PUT es un sync con Google y quizá un correo", () => {
    expect(planAttendanceWrite({ ...base, mark: "llego", currentStatus: "Completada" })).toEqual({
      ok: true,
      status: null,
    });
    expect(
      planAttendanceWrite({ ...base, mark: "no-asistio", currentStatus: "No asistió" }),
    ).toEqual({ ok: true, status: null });
  });

  it("no se acusa de inasistencia a quien tiene la cuenta cerrada", () => {
    const plan = planAttendanceWrite({
      ...base,
      closed: true,
      mark: "no-asistio",
      currentStatus: "Reservada",
    });
    expect(plan.ok).toBe(false);
  });

  it("no se marca antes de la hora", () => {
    expect(
      planAttendanceWrite({ ...base, windowOpen: false, mark: "no-asistio", currentStatus: "Reservada" })
        .ok,
    ).toBe(false);
    expect(
      planAttendanceWrite({ ...base, windowOpen: false, mark: "llego", currentStatus: "Reservada" }).ok,
    ).toBe(false);
  });

  it("un «No asistió» por error se corrige con Llegó", () => {
    expect(planAttendanceWrite({ ...base, mark: "llego", currentStatus: "No asistió" })).toEqual({
      ok: true,
      status: "Completada",
    });
  });

  it("Deshacer vuelve al estado previo si era una reserva; si no, a Reservada", () => {
    expect(
      planAttendanceWrite({
        ...base,
        mark: "deshacer",
        currentStatus: "No asistió",
        restoreTo: "Confirmada",
      }),
    ).toEqual({ ok: true, status: "Confirmada" });
    expect(
      planAttendanceWrite({
        ...base,
        mark: "deshacer",
        currentStatus: "Completada",
        restoreTo: "Cancelada",
      }),
    ).toEqual({ ok: true, status: "Reservada" });
    expect(
      planAttendanceWrite({ ...base, mark: "deshacer", currentStatus: "Completada" }),
    ).toEqual({ ok: true, status: "Reservada" });
  });

  it("con la cuenta cerrada no se deshace", () => {
    expect(
      planAttendanceWrite({ ...base, closed: true, mark: "deshacer", currentStatus: "Completada" })
        .ok,
    ).toBe(false);
  });

  it("una cancelada o un estado desconocido se rechazan", () => {
    expect(planAttendanceWrite({ ...base, mark: "llego", currentStatus: "Cancelada" }).ok).toBe(
      false,
    );
    expect(planAttendanceWrite({ ...base, mark: "llego", currentStatus: "Pendiente" }).ok).toBe(
      false,
    );
  });
});

describe("confirmar", () => {
  const plan = (mark: "confirmar" | "desconfirmar", currentStatus: string, extra = {}) =>
    planAttendanceWrite({ mark, currentStatus, closed: false, windowOpen: false, ...extra });

  it("se ofrece solo mientras la cita está por confirmar y sin cuenta", () => {
    expect(canConfirm("Reservada", false)).toBe(true);
    expect(canConfirm("Reprogramada", null)).toBe(true);
    expect(canConfirm("Confirmada", false)).toBe(false);
    expect(canConfirm("Completada", false)).toBe(false);
    expect(canConfirm("Cancelada", false)).toBe(false);
    expect(canConfirm("Reservada", true)).toBe(false);
  });

  it("pasa a Confirmada a cualquier hora, días antes también", () => {
    expect(plan("confirmar", "Reservada")).toEqual({ ok: true, status: "Confirmada" });
  });

  it("si ya estaba confirmada no escribe nada", () => {
    expect(plan("confirmar", "Confirmada")).toEqual({ ok: true, status: null });
  });

  it("no confirma lo que ya pasó", () => {
    expect(plan("confirmar", "Completada").ok).toBe(false);
    expect(plan("confirmar", "No asistió").ok).toBe(false);
    expect(plan("confirmar", "Reservada", { closed: true }).ok).toBe(false);
    expect(plan("confirmar", "Cancelada").ok).toBe(false);
  });

  it("deshacer vuelve al estado exacto de antes", () => {
    expect(plan("desconfirmar", "Confirmada", { restoreTo: "Reprogramada" })).toEqual({
      ok: true,
      status: "Reprogramada",
    });
    expect(plan("desconfirmar", "Confirmada", { restoreTo: "Completada" })).toEqual({
      ok: true,
      status: "Reservada",
    });
    expect(plan("desconfirmar", "Completada")).toEqual({ ok: true, status: null });
  });
});

describe("restoreStatus", () => {
  it("solo vuelve a una reserva", () => {
    expect(restoreStatus("Confirmada")).toBe("Confirmada");
    expect(restoreStatus(" Reprogramada ")).toBe("Reprogramada");
    expect(restoreStatus("No asistió")).toBe("Reservada");
    expect(restoreStatus(null)).toBe("Reservada");
  });
});

describe("statusAfterClose", () => {
  it("una reserva o un «No asistió» pasan a Completada al cerrar la cuenta", () => {
    expect(statusAfterClose("Reservada")).toBe("Completada");
    expect(statusAfterClose("Confirmada")).toBe("Completada");
    expect(statusAfterClose("Booked")).toBe("Completada");
    expect(statusAfterClose("No asistió")).toBe("Completada");
  });

  it("no reescribe lo que ya está, ni toca canceladas ni desconocidos", () => {
    expect(statusAfterClose("Completada")).toBeNull();
    expect(statusAfterClose("Cancelada")).toBeNull();
    expect(statusAfterClose("Draft")).toBeNull();
    expect(statusAfterClose("")).toBeNull();
  });
});

describe("attendanceOutcome", () => {
  it("la cuenta cerrada gana sobre el estado, salvo una cancelada", () => {
    expect(attendanceOutcome("reservada", { closed: true, started: true })).toBe("asistio");
    expect(attendanceOutcome("no-asistio", { closed: true, started: true })).toBe("asistio");
    expect(attendanceOutcome("cancelada", { closed: true, started: true })).toBe("cancelada");
  });

  it("una reserva sin cuenta: pendiente si no empezó, sin marcar si ya", () => {
    expect(attendanceOutcome("confirmada", { closed: false, started: false })).toBe("pendiente");
    expect(attendanceOutcome("confirmada", { closed: false, started: true })).toBe("sin-marcar");
  });
});

describe("noShowRate", () => {
  it("no asistió sobre las marcadas, y null sin ninguna", () => {
    expect(noShowRate(2, 7)).toBeCloseTo(2 / 9, 6);
    expect(noShowRate(0, 0)).toBeNull();
  });
});

describe("unmarkedAppointments", () => {
  it("solo las que ya terminaron, siguen reservadas y no tienen cuenta", () => {
    const rows = [
      { id: 1, end: "2026-10-16 10:00:00", status: "Reservada", closed: false },
      { id: 2, end: "2026-10-16 10:00:00", status: "Reservada", closed: true },
      { id: 3, end: "2026-10-16 10:00:00", status: "No asistió", closed: false },
      { id: 4, end: "2026-10-16 18:00:00", status: "Confirmada", closed: false },
      { id: 5, end: "2026-10-16 09:00:00", status: "Cancelada", closed: false },
    ];
    expect(unmarkedAppointments(rows, "2026-10-16 12:00:00").map((row) => row.id)).toEqual([1]);
  });
});
