import { describe, expect, it } from "vitest";

import type {
  EaLocalDate,
  WorkingPlan,
  WorkingPlanException,
} from "@/lib/ea";

import {
  buildWeekPlan,
  minutesOfDay,
  netMinutesOfDay,
  upcomingExceptions,
  WEEK_ORDER,
} from "./working-plan";

const JORNADA = {
  start: "09:00",
  end: "18:00",
  breaks: [{ start: "13:00", end: "14:00" }],
};

function plan(patch: Partial<WorkingPlan> = {}): WorkingPlan {
  return {
    sunday: null,
    monday: JORNADA,
    tuesday: JORNADA,
    wednesday: JORNADA,
    thursday: JORNADA,
    friday: JORNADA,
    saturday: null,
    ...patch,
  };
}

function exception(patch: {
  id: number;
  startDate: string | null;
  endDate?: string | null;
  startTime?: string | null;
  endTime?: string | null;
}): WorkingPlanException {
  return {
    id: patch.id,
    startDate: patch.startDate as EaLocalDate | null,
    endDate: (patch.endDate === undefined ? patch.startDate : patch.endDate) as
      | EaLocalDate
      | null,
    startTime: patch.startTime === undefined ? null : patch.startTime,
    endTime: patch.endTime === undefined ? null : patch.endTime,
    breaks: [],
    providerId: 1,
  };
}

describe("minutesOfDay", () => {
  it("lee HH:MM y HH:MM:SS", () => {
    expect(minutesOfDay("09:30")).toBe(570);
    expect(minutesOfDay("9:05")).toBe(545);
    expect(minutesOfDay("18:00:00")).toBe(1080);
    expect(minutesOfDay("00:00")).toBe(0);
  });

  it("devuelve null para lo que no es una hora", () => {
    for (const basura of ["", "  ", "24:00", "12:60", "mediodía", "12", null, undefined]) {
      expect(minutesOfDay(basura), String(basura)).toBeNull();
    }
  });
});

describe("netMinutesOfDay", () => {
  it("resta los descansos", () => {
    expect(netMinutesOfDay(JORNADA)).toBe(9 * 60 - 60);
  });

  it("un día libre son cero minutos", () => {
    expect(netMinutesOfDay(null)).toBe(0);
  });

  it("recorta un descanso que se sale de la jornada en vez de restar de más", () => {
    // EA no valida estos rangos. Sin el recorte, esto daría horas negativas.
    expect(
      netMinutesOfDay({
        start: "09:00",
        end: "18:00",
        breaks: [{ start: "13:00", end: "20:00" }],
      }),
    ).toBe(4 * 60);
  });

  it("nunca baja de cero", () => {
    expect(
      netMinutesOfDay({
        start: "09:00",
        end: "10:00",
        breaks: [
          { start: "08:00", end: "11:00" },
          { start: "09:00", end: "10:00" },
        ],
      }),
    ).toBe(0);
  });

  it("ignora un descanso mal formado en vez de romper el día entero", () => {
    expect(
      netMinutesOfDay({
        start: "09:00",
        end: "11:00",
        breaks: [
          { start: "nada", end: "10:00" },
          { start: "10:30", end: "10:00" },
        ],
      }),
    ).toBe(120);
  });

  it("una jornada invertida o de duración cero son cero, no un negativo", () => {
    expect(netMinutesOfDay({ start: "18:00", end: "09:00", breaks: [] })).toBe(0);
    expect(netMinutesOfDay({ start: "09:00", end: "09:00", breaks: [] })).toBe(0);
  });
});

describe("buildWeekPlan", () => {
  it("empieza en lunes aunque EA guarde el domingo primero", () => {
    expect(buildWeekPlan(plan()).days.map((d) => d.key)).toEqual([...WEEK_ORDER]);
    expect(buildWeekPlan(plan()).days[0].label).toBe("Lunes");
  });

  it("marca los días libres y suma la semana neta", () => {
    const semana = buildWeekPlan(plan());
    expect(semana.days.filter((d) => d.works).map((d) => d.key)).toEqual([
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
    ]);
    expect(semana.weeklyNetMinutes).toBe(5 * (9 * 60 - 60));
    expect(semana.missing).toBe(false);
  });

  it("sin plan lo dice, en vez de mostrar una semana de días libres", () => {
    // Es la diferencia entre "no trabaja" y "esta técnica nunca va a mostrar
    // disponibilidad porque EA no tiene su horario".
    const semana = buildWeekPlan(null);
    expect(semana.missing).toBe(true);
    expect(semana.weeklyNetMinutes).toBe(0);
    expect(semana.days).toHaveLength(7);
  });

  it("copia los descansos de cada día", () => {
    const [lunes] = buildWeekPlan(plan()).days;
    expect(lunes.breaks).toEqual([{ start: "13:00", end: "14:00" }]);
  });
});

describe("upcomingExceptions", () => {
  it("ordena de la más próxima a la más lejana", () => {
    const lista = upcomingExceptions(
      [
        exception({ id: 3, startDate: "2026-10-01" }),
        exception({ id: 1, startDate: "2026-09-05" }),
        exception({ id: 2, startDate: "2026-09-20" }),
      ],
      "2026-09-01",
    );
    expect(lista.map((e) => e.id)).toEqual([1, 2, 3]);
  });

  it("desempata por id para que dos del mismo día no bailen", () => {
    const lista = upcomingExceptions(
      [
        exception({ id: 9, startDate: "2026-09-05" }),
        exception({ id: 4, startDate: "2026-09-05" }),
      ],
      "2026-09-01",
    );
    expect(lista.map((e) => e.id)).toEqual([4, 9]);
  });

  it("recorta el pasado pero conserva un rango que todavía está corriendo", () => {
    const lista = upcomingExceptions(
      [
        exception({ id: 1, startDate: "2026-01-01", endDate: "2026-01-02" }),
        exception({ id: 2, startDate: "2026-08-25", endDate: "2026-09-10" }),
      ],
      "2026-09-01",
    );
    expect(lista.map((e) => e.id)).toEqual([2]);
  });

  it("startTime/endTime en null es 'ese día no trabaja', no un dato faltante", () => {
    const [libre, corta] = upcomingExceptions(
      [
        exception({ id: 1, startDate: "2026-09-05" }),
        exception({ id: 2, startDate: "2026-09-06", startTime: "11:00", endTime: "18:00" }),
      ],
      "2026-09-01",
    );
    expect(libre.dayOff).toBe(true);
    expect(corta.dayOff).toBe(false);
    expect(corta.startTime).toBe("11:00");
  });

  it("una excepción sin fecha se descarta: no se puede ubicar en el calendario", () => {
    expect(upcomingExceptions([exception({ id: 1, startDate: null })], "2026-01-01")).toEqual([]);
  });

  it("sin endDate, el rango es de un solo día", () => {
    const [uno] = upcomingExceptions(
      [exception({ id: 1, startDate: "2026-09-05", endDate: null })],
      "2026-09-01",
    );
    expect(uno.endDate).toBe("2026-09-05");
  });
});
