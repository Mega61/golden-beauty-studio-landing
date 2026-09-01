import { afterEach, describe, expect, it } from "vitest";

import {
  assignLanes,
  buildDayGrid,
  CalendarLayoutError,
  findPlanException,
  GRID_LAYER,
  parsePlanTime,
  resolveWorkingWindow,
  weekdayKeyOf,
  type DayGridInput,
  type GridProvider,
} from "./calendar-layout";
import {
  parseEaLocalDate,
  parseEaLocalDateTime,
  type EaLocalDate,
} from "./ea/datetime";
import type {
  Appointment,
  BlockedPeriod,
  Unavailability,
  WorkingPlan,
  WorkingPlanException,
} from "./ea/types";

/**
 * Igual que en los tests de A1: la zona se fija **dentro** del test y no con un
 * prefijo `TZ=… npm test`, porque en Git Bash sobre Windows ese prefijo no
 * llega al proceso y el test correría verde sin haber probado nada.
 */
const originalTZ = process.env.TZ;

afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

// ---------------------------------------------------------------------------
// Fábricas
// ---------------------------------------------------------------------------

const dt = parseEaLocalDateTime;
const d = parseEaLocalDate;

/** El lunes de referencia de todo el archivo. `2026-08-31` es lunes. */
const MONDAY = d("2026-08-31");

let nextId = 1;

function appointment(
  start: string,
  end: string,
  extra: Partial<Appointment> = {},
): Appointment {
  return {
    id: nextId++,
    bookedAt: null,
    start: dt(start),
    end: dt(end),
    hash: null,
    location: null,
    meetingLink: null,
    color: null,
    status: "Booked",
    notes: null,
    customerId: null,
    providerId: 1,
    serviceId: 10,
    googleCalendarId: null,
    caldavCalendarId: null,
    ...extra,
  };
}

function unavailability(
  start: string,
  end: string,
  extra: Partial<Unavailability> = {},
): Unavailability {
  return {
    id: nextId++,
    bookedAt: null,
    start: dt(start),
    end: dt(end),
    hash: null,
    location: null,
    notes: null,
    providerId: 1,
    googleCalendarId: null,
    caldavCalendarId: null,
    ...extra,
  };
}

function blockedPeriod(
  start: string,
  end: string,
  name: string | null = null,
): BlockedPeriod {
  return { id: nextId++, name, start: dt(start), end: dt(end), notes: null };
}

const NINE_TO_SIX = { start: "09:00", end: "18:00", breaks: [] };

function plan(overrides: Partial<WorkingPlan> = {}): WorkingPlan {
  return {
    sunday: null,
    monday: NINE_TO_SIX,
    tuesday: NINE_TO_SIX,
    wednesday: NINE_TO_SIX,
    thursday: NINE_TO_SIX,
    friday: NINE_TO_SIX,
    saturday: NINE_TO_SIX,
    ...overrides,
  };
}

function provider(id: number, name: string, overrides: Partial<GridProvider> = {}): GridProvider {
  return { id, name, workingPlan: plan(), ...overrides };
}

/** Jornada de 8 a 8, filas de 15 minutos. Es el default de § La agenda. */
const RANGE = {
  date: MONDAY,
  startMinute: 8 * 60,
  endMinute: 20 * 60,
  slotMinutes: 15,
};

function grid(input: Partial<DayGridInput> = {}) {
  return buildDayGrid({
    range: RANGE,
    providers: [provider(1, "Lina")],
    ...input,
  });
}

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

describe("parsePlanTime", () => {
  it("acepta HH:MM y HH:MM:SS", () => {
    expect(parsePlanTime("09:00")).toBe(540);
    expect(parsePlanTime("09:30:00")).toBe(570);
    expect(parsePlanTime("9:05")).toBe(545);
  });

  it("degrada a null en vez de reventar, porque el plan es JSON sin validar", () => {
    expect(parsePlanTime(null)).toBeNull();
    expect(parsePlanTime(undefined)).toBeNull();
    expect(parsePlanTime("")).toBeNull();
    expect(parsePlanTime("mañana")).toBeNull();
    expect(parsePlanTime("25:00")).toBeNull();
    expect(parsePlanTime("09:60")).toBeNull();
  });

  it("acepta 24:00 — EA lo usa para 'hasta la medianoche'", () => {
    expect(parsePlanTime("24:00")).toBe(1440);
  });
});

describe("weekdayKeyOf", () => {
  it("no depende de la zona del proceso", () => {
    for (const tz of ["UTC", "America/Bogota", "Pacific/Kiritimati", "Pacific/Niue"]) {
      process.env.TZ = tz;
      expect(weekdayKeyOf(d("2026-08-31"))).toBe("monday");
      expect(weekdayKeyOf(d("2026-09-06"))).toBe("sunday");
    }
  });
});

describe("findPlanException", () => {
  const exception = (
    startDate: string | null,
    endDate: string | null,
    id = 7,
  ): WorkingPlanException => ({
    id,
    startDate: startDate === null ? null : d(startDate),
    endDate: endDate === null ? null : d(endDate),
    startTime: "11:00",
    endTime: "15:00",
    breaks: [],
    providerId: 1,
  });

  it("toma la excepción de un solo día", () => {
    expect(findPlanException([exception("2026-08-31", null)], MONDAY)?.id).toBe(7);
  });

  it("toma la excepción de un rango, con los dos bordes incluidos", () => {
    const range = [exception("2026-08-30", "2026-09-01")];
    expect(findPlanException(range, d("2026-08-30"))).not.toBeNull();
    expect(findPlanException(range, d("2026-09-01"))).not.toBeNull();
    expect(findPlanException(range, d("2026-09-02"))).toBeNull();
  });

  it("ignora una excepción sin fecha de inicio en vez de aplicarla a todo", () => {
    expect(findPlanException([exception(null, "2026-12-31")], MONDAY)).toBeNull();
  });

  it("sin excepciones devuelve null", () => {
    expect(findPlanException(undefined, MONDAY)).toBeNull();
    expect(findPlanException([], MONDAY)).toBeNull();
  });
});

describe("resolveWorkingWindow", () => {
  it("usa el plan del día de la semana", () => {
    const resolved = resolveWorkingWindow(provider(1, "Lina"), MONDAY);
    expect(resolved.window).toMatchObject({
      startMinute: 540,
      endMinute: 1080,
      source: "plan",
      exceptionId: null,
    });
  });

  it("un día sin plan es día libre, y el null es información", () => {
    const resolved = resolveWorkingWindow(provider(1, "Lina"), d("2026-09-06"));
    expect(resolved.window.startMinute).toBeNull();
    expect(resolved.window.endMinute).toBeNull();
  });

  it("sin workingPlan tampoco revienta", () => {
    const resolved = resolveWorkingWindow({ workingPlan: null }, MONDAY);
    expect(resolved.window.startMinute).toBeNull();
  });

  it("la excepción reemplaza al plan, con sus propios descansos", () => {
    const resolved = resolveWorkingWindow(
      {
        workingPlan: plan({
          monday: { start: "09:00", end: "18:00", breaks: [{ start: "12:00", end: "13:00" }] },
        }),
        workingPlanExceptions: [
          {
            id: 42,
            startDate: MONDAY,
            endDate: null,
            startTime: "11:00",
            endTime: "15:00",
            breaks: [{ start: "13:00", end: "13:30" }],
            providerId: 1,
          },
        ],
      },
      MONDAY,
    );

    expect(resolved.window).toMatchObject({
      startMinute: 660,
      endMinute: 900,
      source: "plan-exception",
      exceptionId: 42,
    });
    // El descanso del plan viejo NO sobrevive: la excepción manda entera.
    expect(resolved.breaks).toEqual([{ startMinute: 780, endMinute: 810 }]);
    expect(resolved.breakOrigin).toBe("plan-exception");
  });

  it("una excepción sin horas es día libre", () => {
    const resolved = resolveWorkingWindow(
      {
        workingPlan: plan(),
        workingPlanExceptions: [
          {
            id: 43,
            startDate: MONDAY,
            endDate: null,
            startTime: null,
            endTime: null,
            breaks: [],
            providerId: 1,
          },
        ],
      },
      MONDAY,
    );

    expect(resolved.window.startMinute).toBeNull();
    expect(resolved.window.source).toBe("plan-exception");
    expect(resolved.breaks).toEqual([]);
  });

  it("descarta descansos invertidos o de duración cero", () => {
    const resolved = resolveWorkingWindow(
      {
        workingPlan: plan({
          monday: {
            start: "09:00",
            end: "18:00",
            breaks: [
              { start: "13:00", end: "13:00" },
              { start: "15:00", end: "14:00" },
              { start: "12:00", end: "12:30" },
            ],
          },
        }),
      },
      MONDAY,
    );

    expect(resolved.breaks).toEqual([{ startMinute: 720, endMinute: 750 }]);
  });

  it("un día del plan sin la lista de descansos no revienta", () => {
    // El plan viaja como JSON dentro de `user_settings` de EA: nadie garantiza
    // que la clave `breaks` exista.
    const resolved = resolveWorkingWindow(
      {
        workingPlan: plan({
          monday: { start: "09:00", end: "18:00" } as WorkingPlan["monday"],
        }),
      },
      MONDAY,
    );
    expect(resolved.breaks).toEqual([]);
  });

  it("un plan con fin antes del inicio se lee como día libre, no como jornada negativa", () => {
    const resolved = resolveWorkingWindow(
      { workingPlan: plan({ monday: { start: "18:00", end: "09:00", breaks: [] } }) },
      MONDAY,
    );
    expect(resolved.window.startMinute).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Carriles
// ---------------------------------------------------------------------------

describe("assignLanes", () => {
  const span = (a: number, b: number) => ({ startMinute: a, endMinute: b });

  it("sin solape, todo va a carril 0 a ancho completo", () => {
    expect(assignLanes([span(0, 60), span(60, 120), span(200, 260)])).toEqual([
      { lane: 0, laneCount: 1 },
      { lane: 0, laneCount: 1 },
      { lane: 0, laneCount: 1 },
    ]);
  });

  it("tocar el borde NO es solape — la regla exacta de has_provider_conflict", () => {
    expect(assignLanes([span(0, 60), span(60, 120)])).toEqual([
      { lane: 0, laneCount: 1 },
      { lane: 0, laneCount: 1 },
    ]);
  });

  it("dos encimadas se reparten la columna a la mitad", () => {
    expect(assignLanes([span(0, 60), span(30, 90)])).toEqual([
      { lane: 0, laneCount: 2 },
      { lane: 1, laneCount: 2 },
    ]);
  });

  it("tres encimadas dan tres carriles", () => {
    expect(assignLanes([span(0, 90), span(10, 90), span(20, 90)])).toEqual([
      { lane: 0, laneCount: 3 },
      { lane: 1, laneCount: 3 },
      { lane: 2, laneCount: 3 },
    ]);
  });

  it("el ancho es por grupo de solape, no por columna", () => {
    // Dos encimadas temprano y una sola después: la de después usa el ancho
    // entero en vez de quedarse con un tercio de la columna todo el día.
    const lanes = assignLanes([span(0, 60), span(30, 90), span(200, 260)]);
    expect(lanes[0].laneCount).toBe(2);
    expect(lanes[1].laneCount).toBe(2);
    expect(lanes[2].laneCount).toBe(1);
  });

  it("reutiliza el carril que quedó libre dentro del mismo grupo", () => {
    //   A ▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉▉ 0–120
    //   B ▉▉▉▉             10–40
    //   C        ▉▉▉▉      50–80   ← vuelve al carril de B
    const lanes = assignLanes([span(0, 120), span(10, 40), span(50, 80)]);
    expect(lanes).toEqual([
      { lane: 0, laneCount: 2 },
      { lane: 1, laneCount: 2 },
      { lane: 1, laneCount: 2 },
    ]);
  });

  it("con inicio y fin idénticos desempata por orden de entrada", () => {
    expect(assignLanes([span(0, 60), span(0, 60)])).toEqual([
      { lane: 0, laneCount: 2 },
      { lane: 1, laneCount: 2 },
    ]);
  });

  it("el resultado sigue el orden de entrada, no el cronológico", () => {
    const lanes = assignLanes([span(30, 90), span(0, 60)]);
    expect(lanes[1].lane).toBe(0);
    expect(lanes[0].lane).toBe(1);
  });

  it("una lista vacía no revienta", () => {
    expect(assignLanes([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildDayGrid — estructura
// ---------------------------------------------------------------------------

describe("buildDayGrid · rango y gutter", () => {
  it("rechaza un rango imposible en vez de devolver una grilla vacía", () => {
    expect(() => grid({ range: { ...RANGE, endMinute: RANGE.startMinute } })).toThrow(
      CalendarLayoutError,
    );
    expect(() => grid({ range: { ...RANGE, slotMinutes: 0 } })).toThrow(CalendarLayoutError);
    expect(() => grid({ range: { ...RANGE, slotMinutes: -15 } })).toThrow(CalendarLayoutError);
    expect(() => grid({ range: { ...RANGE, startMinute: Number.NaN } })).toThrow(
      CalendarLayoutError,
    );
  });

  it("48 filas de 15 minutos para una jornada de 8 a 8", () => {
    const day = grid();
    expect(day.rowCount).toBe(48);
    expect(day.slots).toHaveLength(48);
    expect(day.slots[0]).toEqual({ minute: 480, wall: dt("2026-08-31 08:00:00"), isHour: true });
    expect(day.slots[1].isHour).toBe(false);
    expect(day.slots[47].wall).toBe(dt("2026-08-31 19:45:00"));
  });

  it("el intervalo es parámetro: no se asume 15", () => {
    const day = grid({ range: { ...RANGE, slotMinutes: 30 } });
    expect(day.rowCount).toBe(24);
    expect(day.slots[1].minute).toBe(510);

    const fine = grid({ range: { ...RANGE, slotMinutes: 5 } });
    expect(fine.rowCount).toBe(144);
  });

  it("la jornada tampoco es fija", () => {
    const day = grid({
      range: { date: MONDAY, startMinute: 6 * 60, endMinute: 23 * 60, slotMinutes: 60 },
    });
    expect(day.rowCount).toBe(17);
    expect(day.slots[0].minute).toBe(360);
  });

  it("una jornada que no es múltiplo del intervalo redondea hacia arriba", () => {
    const day = grid({
      range: { date: MONDAY, startMinute: 0, endMinute: 50, slotMinutes: 15 },
    });
    expect(day.rowCount).toBe(4);
  });
});

describe("buildDayGrid · jornada vacía", () => {
  it("sin nada que pintar devuelve la estructura completa, no null", () => {
    const day = grid();
    expect(day.columns).toHaveLength(1);
    expect(day.columns[0].events).toEqual([]);
    expect(day.columns[0].hiddenBefore).toBe(0);
    expect(day.columns[0].hiddenAfter).toBe(0);
    expect(day.nowLine).toBeNull();
    expect(day.orphanAppointments).toEqual([]);
  });

  it("sin técnicas devuelve cero columnas y no revienta", () => {
    const day = grid({ providers: [], appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00")] });
    expect(day.columns).toEqual([]);
    expect(day.orphanAppointments).toHaveLength(1);
  });

  it("un día libre pinta el rango entero como fuera de horario", () => {
    const day = buildDayGrid({
      range: { ...RANGE, date: d("2026-09-06") },
      providers: [provider(1, "Lina")],
    });

    const offHours = day.columns[0].bands.filter((b) => b.kind === "off-hours");
    expect(offHours).toHaveLength(1);
    expect(offHours[0]).toMatchObject({ startMinute: 480, endMinute: 1200 });
    expect(day.columns[0].window.startMinute).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildDayGrid — capas
// ---------------------------------------------------------------------------

describe("buildDayGrid · capas", () => {
  it("apila de abajo hacia arriba en el orden que fija § La agenda", () => {
    const day = buildDayGrid({
      range: RANGE,
      providers: [
        provider(1, "Lina", {
          workingPlan: plan({
            monday: { start: "09:00", end: "18:00", breaks: [{ start: "12:00", end: "13:00" }] },
          }),
        }),
      ],
      unavailabilities: [unavailability("2026-08-31 15:00:00", "2026-08-31 16:00:00")],
      blockedPeriods: [blockedPeriod("2026-08-31 17:00:00", "2026-08-31 18:00:00", "Festivo")],
    });

    const layers = day.columns[0].bands.map((b) => b.layer);
    expect(layers).toEqual([...layers].sort((a, b) => a - b));

    const byKind = Object.fromEntries(day.columns[0].bands.map((b) => [b.kind, b.layer]));
    expect(byKind["off-hours"]).toBe(GRID_LAYER.offHours);
    expect(byKind.break).toBe(GRID_LAYER.planBreak);
    expect(byKind.unavailable).toBe(GRID_LAYER.block);
    expect(byKind.blocked).toBe(GRID_LAYER.block);
  });

  it("el descanso de una excepción va por encima del descanso del plan", () => {
    const day = buildDayGrid({
      range: RANGE,
      providers: [
        provider(1, "Lina", {
          workingPlanExceptions: [
            {
              id: 9,
              startDate: MONDAY,
              endDate: null,
              startTime: "11:00",
              endTime: "17:00",
              breaks: [{ start: "13:00", end: "14:00" }],
              providerId: 1,
            },
          ],
        }),
      ],
    });

    const brk = day.columns[0].bands.find((b) => b.kind === "break");
    expect(brk).toMatchObject({
      origin: "plan-exception",
      layer: GRID_LAYER.planException,
      startMinute: 780,
      endMinute: 840,
    });
  });

  it("fuera de horario es el complemento de la ventana dentro del rango", () => {
    const day = grid();
    const off = day.columns[0].bands.filter((b) => b.kind === "off-hours");
    expect(off.map((b) => [b.startMinute, b.endMinute])).toEqual([
      [480, 540],
      [1080, 1200],
    ]);
  });

  it("si la jornada visible cabe dentro del horario laboral no hay fuera de horario", () => {
    const day = grid({
      range: { date: MONDAY, startMinute: 10 * 60, endMinute: 12 * 60, slotMinutes: 15 },
    });
    expect(day.columns[0].bands.filter((b) => b.kind === "off-hours")).toEqual([]);
  });

  it("el descanso se recorta a la ventana laboral antes que al rango", () => {
    // Un descanso de 8 a 10 con jornada de 9 a 18: solo cuenta de 9 a 10, para
    // que no se dibuje gris sobre gris en la franja de fuera de horario.
    const day = buildDayGrid({
      range: RANGE,
      providers: [
        provider(1, "Lina", {
          workingPlan: plan({
            monday: { start: "09:00", end: "18:00", breaks: [{ start: "08:00", end: "10:00" }] },
          }),
        }),
      ],
    });

    const brk = day.columns[0].bands.find((b) => b.kind === "break");
    expect(brk).toMatchObject({ startMinute: 540, endMinute: 600, clippedStart: true });
  });

  it("un descanso fuera de la ventana laboral no produce banda", () => {
    const day = buildDayGrid({
      range: RANGE,
      providers: [
        provider(1, "Lina", {
          workingPlan: plan({
            monday: { start: "09:00", end: "18:00", breaks: [{ start: "19:00", end: "20:00" }] },
          }),
        }),
      ],
    });
    expect(day.columns[0].bands.filter((b) => b.kind === "break")).toEqual([]);
  });

  it("un descanso dentro de la jornada pero fuera del rango visible tampoco", () => {
    const day = buildDayGrid({
      range: { date: MONDAY, startMinute: 14 * 60, endMinute: 18 * 60, slotMinutes: 15 },
      providers: [
        provider(1, "Lina", {
          workingPlan: plan({
            monday: { start: "09:00", end: "18:00", breaks: [{ start: "12:00", end: "13:00" }] },
          }),
        }),
      ],
    });
    expect(day.columns[0].bands.filter((b) => b.kind === "break")).toEqual([]);
  });

  it("un bloqueo del estudio se replica en todas las columnas", () => {
    const day = buildDayGrid({
      range: RANGE,
      providers: [provider(1, "Lina"), provider(2, "Sara")],
      blockedPeriods: [blockedPeriod("2026-08-31 10:00:00", "2026-08-31 11:00:00", "Festivo")],
    });

    for (const column of day.columns) {
      const blocked = column.bands.find((b) => b.kind === "blocked");
      expect(blocked).toMatchObject({
        label: "Festivo",
        startMinute: 600,
        endMinute: 660,
        origin: "blocked-period",
      });
    }
  });

  it("un bloqueo de varios días se recorta al rango y lo dice", () => {
    const day = grid({
      blockedPeriods: [blockedPeriod("2026-12-24 00:00:00", "2026-12-27 00:00:00", "Navidad")],
      range: { ...RANGE, date: d("2026-12-25") },
    });

    const blocked = day.columns[0].bands.find((b) => b.kind === "blocked");
    expect(blocked).toMatchObject({
      startMinute: 480,
      endMinute: 1200,
      clippedStart: true,
      clippedEnd: true,
    });
  });

  it("descarta bandas que no tocan el rango", () => {
    const day = grid({
      blockedPeriods: [blockedPeriod("2026-08-31 05:00:00", "2026-08-31 06:00:00")],
      unavailabilities: [unavailability("2026-08-31 21:00:00", "2026-08-31 22:00:00")],
    });
    expect(day.columns[0].bands.filter((b) => b.kind === "blocked")).toEqual([]);
    expect(day.columns[0].bands.filter((b) => b.kind === "unavailable")).toEqual([]);
  });

  it("una indisponibilidad de duración cero no produce banda", () => {
    const day = grid({
      unavailabilities: [unavailability("2026-08-31 10:00:00", "2026-08-31 10:00:00")],
    });
    expect(day.columns[0].bands.filter((b) => b.kind === "unavailable")).toEqual([]);
  });

  it("las bandas traen key estable y el id del registro que las produjo", () => {
    const block = unavailability("2026-08-31 15:00:00", "2026-08-31 16:00:00", {
      notes: "Médico",
    });
    const day = grid({ unavailabilities: [block] });
    const band = day.columns[0].bands.find((b) => b.kind === "unavailable");

    expect(band?.sourceId).toBe(block.id);
    expect(band?.label).toBe("Médico");
    expect(band?.key).toBe(`unavailable:${block.id}:900`);
  });
});

// ---------------------------------------------------------------------------
// buildDayGrid — citas y bordes
// ---------------------------------------------------------------------------

describe("buildDayGrid · citas", () => {
  it("posiciona una cita normal con la geometría lista para el CSS", () => {
    const day = grid({
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:30:00")],
    });

    expect(day.columns[0].events[0]).toMatchObject({
      startMinute: 600,
      endMinute: 690,
      durationMinutes: 90,
      renderHeightMinutes: 90,
      lane: 0,
      laneCount: 1,
      offset: 0,
      width: 1,
      clippedStart: false,
      clippedEnd: false,
      startsPreviousDay: false,
      continuesNextDay: false,
      layer: GRID_LAYER.appointment,
    });
  });

  it("dibuja el error: dos citas encimadas se ven las dos", () => {
    // La API de EA acepta citas encimadas (hueco #4), así que esto llega.
    const day = grid({
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00"),
        appointment("2026-08-31 10:30:00", "2026-08-31 11:30:00"),
      ],
    });

    expect(day.columns[0].events).toHaveLength(2);
    expect(day.columns[0].events.map((e) => [e.lane, e.laneCount, e.offset, e.width])).toEqual([
      [0, 2, 0, 0.5],
      [1, 2, 0.5, 0.5],
    ]);
  });

  it("una cita que termina cuando otra empieza NO se reparte la columna", () => {
    const day = grid({
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00"),
        appointment("2026-08-31 11:00:00", "2026-08-31 12:00:00"),
      ],
    });
    expect(day.columns[0].events.every((e) => e.laneCount === 1)).toBe(true);
  });

  it("recorta la cita que cruza el fin de la jornada y lo marca", () => {
    const day = grid({
      appointments: [appointment("2026-08-31 19:00:00", "2026-08-31 21:30:00")],
    });

    expect(day.columns[0].events[0]).toMatchObject({
      startMinute: 1140,
      endMinute: 1200,
      // La duración real sigue siendo 150: la agenda no puede mentir sobre
      // cuánto dura solo porque el bloque no cabe.
      durationMinutes: 150,
      clippedStart: false,
      clippedEnd: true,
      continuesNextDay: false,
    });
  });

  it("recorta la cita que empieza antes del inicio de la jornada", () => {
    const day = grid({
      appointments: [appointment("2026-08-31 07:30:00", "2026-08-31 09:00:00")],
    });

    expect(day.columns[0].events[0]).toMatchObject({
      startMinute: 480,
      endMinute: 540,
      durationMinutes: 90,
      clippedStart: true,
      clippedEnd: false,
    });
  });

  it("una cita de duración cero se dibuja igual, con alto mínimo de una fila", () => {
    const day = grid({
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 10:00:00")],
    });

    expect(day.columns[0].events[0]).toMatchObject({
      startMinute: 600,
      endMinute: 600,
      durationMinutes: 0,
      renderHeightMinutes: 15,
    });
  });

  it("una cita de duración cero no tapa a la que sí está pasando", () => {
    const day = grid({
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00"),
        appointment("2026-08-31 10:30:00", "2026-08-31 10:30:00"),
      ],
    });
    expect(day.columns[0].events.map((e) => e.laneCount)).toEqual([2, 2]);
  });

  it("minEventMinutes es parámetro", () => {
    const day = grid({
      minEventMinutes: 30,
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 10:10:00")],
    });
    expect(day.columns[0].events[0].renderHeightMinutes).toBe(30);
  });

  it("una cita invertida (fin antes del inicio) se trata como punto y no se pierde", () => {
    const day = grid({
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 09:00:00")],
    });
    expect(day.columns[0].events).toHaveLength(1);
    expect(day.columns[0].events[0].durationMinutes).toBe(0);
  });

  it("ordena por hora y después por carril", () => {
    const day = grid({
      appointments: [
        appointment("2026-08-31 14:00:00", "2026-08-31 15:00:00"),
        appointment("2026-08-31 09:30:00", "2026-08-31 10:30:00"),
        appointment("2026-08-31 09:30:00", "2026-08-31 10:00:00"),
      ],
    });

    const starts = day.columns[0].events.map((e) => e.startMinute);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(day.columns[0].events[0].lane).toBe(0);
    expect(day.columns[0].events[1].lane).toBe(1);
  });
});

describe("buildDayGrid · la medianoche y el día extra que se le pide a EA", () => {
  it("acepta citas de otro día y las descarta sin contarlas como escondidas", () => {
    // `from`/`till` de EA son de grano día y `till` compara contra
    // `end_datetime`, así que la agenda pide un día extra. Esto es ese día.
    const day = grid({
      appointments: [
        appointment("2026-09-01 10:00:00", "2026-09-01 11:00:00"),
        appointment("2026-08-30 10:00:00", "2026-08-30 11:00:00"),
      ],
    });

    expect(day.columns[0].events).toEqual([]);
    expect(day.columns[0].hiddenBefore).toBe(0);
    expect(day.columns[0].hiddenAfter).toBe(0);
  });

  it("una cita que entra desde la noche anterior se recorta y se marca", () => {
    const day = grid({
      appointments: [appointment("2026-08-30 23:00:00", "2026-08-31 09:00:00")],
    });

    expect(day.columns[0].events[0]).toMatchObject({
      startMinute: 480,
      endMinute: 540,
      durationMinutes: 600,
      startsPreviousDay: true,
      continuesNextDay: false,
      clippedStart: true,
    });
  });

  it("una cita que cruza la medianoche hacia adelante también sobrevive", () => {
    const day = grid({
      appointments: [appointment("2026-08-31 19:00:00", "2026-09-01 02:00:00")],
      range: { ...RANGE, endMinute: 24 * 60 },
    });

    expect(day.columns[0].events[0]).toMatchObject({
      startMinute: 1140,
      endMinute: 1440,
      durationMinutes: 420,
      continuesNextDay: true,
      clippedEnd: true,
    });
  });

  it("cuenta las citas del día que caen fuera de la jornada visible", () => {
    const day = grid({
      appointments: [
        appointment("2026-08-31 06:00:00", "2026-08-31 07:00:00"),
        appointment("2026-08-31 21:00:00", "2026-08-31 22:00:00"),
        appointment("2026-08-31 22:30:00", "2026-08-31 23:00:00"),
      ],
    });

    expect(day.columns[0].events).toEqual([]);
    expect(day.columns[0].hiddenBefore).toBe(1);
    expect(day.columns[0].hiddenAfter).toBe(2);
  });

  it("una cita de duración cero fuera de la jornada también se cuenta", () => {
    const day = grid({
      appointments: [appointment("2026-08-31 06:00:00", "2026-08-31 06:00:00")],
    });
    expect(day.columns[0].hiddenBefore).toBe(1);
  });

  it("una cita de duración cero de otro día ni se cuenta ni se dibuja", () => {
    const day = grid({
      appointments: [appointment("2026-09-01 06:00:00", "2026-09-01 06:00:00")],
    });
    expect(day.columns[0].hiddenBefore).toBe(0);
    expect(day.columns[0].events).toEqual([]);
  });
});

describe("buildDayGrid · bloqueo que tapa media cita", () => {
  it("la cita y el bloqueo conviven; ninguno recorta al otro", () => {
    const day = grid({
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 12:00:00")],
      blockedPeriods: [blockedPeriod("2026-08-31 11:00:00", "2026-08-31 13:00:00", "Corte de luz")],
    });

    // El bloqueo es fondo (capa 3) y la cita va encima (capa 4): la cita sigue
    // midiendo dos horas. Un bloqueo que "comiera" la cita escondería trabajo
    // ya agendado, que es lo contrario de lo que la recepción necesita ver.
    expect(day.columns[0].events[0]).toMatchObject({
      startMinute: 600,
      endMinute: 720,
      durationMinutes: 120,
    });

    const blocked = day.columns[0].bands.find((b) => b.kind === "blocked");
    expect(blocked).toMatchObject({ startMinute: 660, endMinute: 780 });
    expect(blocked!.layer).toBeLessThan(day.columns[0].events[0].layer);
  });
});

describe("buildDayGrid · columnas y huérfanos", () => {
  it("reparte cada cita a la columna de su técnica", () => {
    const day = buildDayGrid({
      range: RANGE,
      providers: [provider(1, "Lina"), provider(2, "Sara")],
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", { providerId: 1 }),
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", { providerId: 2 }),
        appointment("2026-08-31 12:00:00", "2026-08-31 13:00:00", { providerId: 2 }),
      ],
    });

    expect(day.columns.map((c) => c.events.length)).toEqual([1, 2]);
    // Cada columna reparte sus carriles por su cuenta: dos citas a la misma
    // hora en columnas distintas NO se parten el ancho.
    expect(day.columns[0].events[0].laneCount).toBe(1);
    expect(day.columns[1].events[0].laneCount).toBe(1);
  });

  it("la misma técnica repetida en dos columnas no duplica sus citas", () => {
    // La vista de 3 días repite a la misma técnica; cada columna es su propio
    // balde y la cita cae en la primera, no en las dos.
    const day = buildDayGrid({
      range: RANGE,
      providers: [provider(1, "Lina"), provider(1, "Lina")],
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00")],
    });
    expect(day.columns.map((c) => c.events.length)).toEqual([1, 0]);
  });

  it("reporta la cita sin técnica en vez de tragársela", () => {
    const orphan = appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", {
      providerId: null,
    });
    const unknown = appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", {
      providerId: 99,
    });

    const day = grid({ appointments: [orphan, unknown] });

    expect(day.orphanAppointments.map((a) => a.id)).toEqual([orphan.id, unknown.id]);
    expect(day.columns[0].events).toEqual([]);
  });

  it("reporta también la indisponibilidad huérfana", () => {
    const day = grid({
      unavailabilities: [
        unavailability("2026-08-31 10:00:00", "2026-08-31 11:00:00", { providerId: null }),
        unavailability("2026-08-31 10:00:00", "2026-08-31 11:00:00", { providerId: 99 }),
      ],
    });
    expect(day.orphanUnavailabilities).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Línea de ahora
// ---------------------------------------------------------------------------

describe("buildDayGrid · línea de ahora", () => {
  it("la dibuja en la hora de pared del estudio, no en la del proceso", () => {
    for (const tz of ["UTC", "America/Bogota", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      // 2026-08-31 15:30:00 en Bogotá (UTC−5) es 20:30 UTC.
      const day = grid({ now: new Date("2026-08-31T20:30:00Z") });
      expect(day.nowLine).toEqual({ minute: 930, wall: dt("2026-08-31 15:30:00") });
    }
  });

  it("no la dibuja si el instante cae en otro día", () => {
    expect(grid({ now: new Date("2026-09-01T20:30:00Z") }).nowLine).toBeNull();
  });

  it("no la dibuja fuera del rango visible", () => {
    // 06:00 en Bogotá, antes de que arranque la jornada de la grilla.
    expect(grid({ now: new Date("2026-08-31T11:00:00Z") }).nowLine).toBeNull();
    // 21:00 en Bogotá, después.
    expect(grid({ now: new Date("2026-09-01T02:00:00Z") }).nowLine).toBeNull();
  });

  it("sin instante, o con uno inválido, no hay línea", () => {
    expect(grid().nowLine).toBeNull();
    expect(grid({ now: null }).nowLine).toBeNull();
    expect(grid({ now: new Date("no es una fecha") }).nowLine).toBeNull();
  });

  it("respeta una zona explícita distinta a la del estudio", () => {
    // 16:30 UTC son las 11:30 en Bogotá. Las dos caen dentro del rango, así
    // que el test distingue de verdad qué zona se usó.
    const bogota = grid({ now: new Date("2026-08-31T16:30:00Z") });
    expect(bogota.nowLine?.minute).toBe(11 * 60 + 30);

    const utc = grid({ now: new Date("2026-08-31T16:30:00Z"), timeZone: "UTC" });
    expect(utc.nowLine?.minute).toBe(16 * 60 + 30);
  });
});

// ---------------------------------------------------------------------------
// Invariante de zona
// ---------------------------------------------------------------------------

describe("buildDayGrid · la zona del proceso no cambia ningún resultado", () => {
  it("da exactamente la misma grilla en las cuatro zonas del ensayo", () => {
    const build = () =>
      buildDayGrid({
        range: RANGE,
        providers: [
          {
            id: 1,
            name: "Lina",
            workingPlan: plan({
              monday: { start: "09:00", end: "18:00", breaks: [{ start: "12:00", end: "13:00" }] },
            }),
          },
        ],
        appointments: [
          { ...appointment("2026-08-30 23:00:00", "2026-08-31 09:30:00"), id: 1 },
          { ...appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00"), id: 2 },
          { ...appointment("2026-08-31 19:00:00", "2026-09-01 01:00:00"), id: 3 },
        ],
        blockedPeriods: [
          { ...blockedPeriod("2026-08-31 14:00:00", "2026-08-31 15:00:00", "Cierre"), id: 100 },
        ],
        now: new Date("2026-08-31T20:30:00Z"),
      });

    process.env.TZ = "UTC";
    const reference = JSON.stringify(build());

    for (const tz of ["America/Bogota", "Pacific/Kiritimati", "Pacific/Niue"]) {
      process.env.TZ = tz;
      expect(JSON.stringify(build())).toBe(reference);
    }
  });
});

// ---------------------------------------------------------------------------
// Contrato de salida
// ---------------------------------------------------------------------------

describe("buildDayGrid · contrato", () => {
  it("devuelve la fecha ya validada y el rango tal cual entró", () => {
    const day = grid();
    expect(day.date).toBe(MONDAY);
    expect(day.range).toEqual(RANGE);
  });

  it("rechaza una fecha que no es YYYY-MM-DD", () => {
    expect(() =>
      buildDayGrid({
        range: { ...RANGE, date: "31/08/2026" as unknown as EaLocalDate },
        providers: [],
      }),
    ).toThrow();
  });

  it("cada cita conserva su objeto original, para que la ficha no vuelva a pedirlo", () => {
    const cita = appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", {
      notes: "Trae su diseño",
    });
    const day = grid({ appointments: [cita] });
    expect(day.columns[0].events[0].appointment).toBe(cita);
    expect(day.columns[0].events[0].key).toBe(`appointment:${cita.id}`);
  });
});
