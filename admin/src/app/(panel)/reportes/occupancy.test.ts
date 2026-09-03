import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";
import type { WorkingPlan, WorkingPlanException } from "@/lib/ea";
import type { Interval, OccupancyAppointment } from "@/lib/metrics";

import {
  dayWindow,
  minutesOfDay,
  occupancyByProvider,
  slotLabel,
  slotOf,
  SLOTS,
  stationHourOccupancy,
  windowOverRange,
  type DayWindow,
} from "./occupancy";

const day = (value: string) => parseEaLocalDate(value);
const at = (value: string) => parseEaLocalDateTime(value);

/** 2026-08-31 fue lunes; 2026-09-06, domingo. */
const MONDAY = day("2026-08-31");
const SUNDAY = day("2026-09-06");

const PLAN: WorkingPlan = {
  monday: { start: "09:00", end: "18:00", breaks: [{ start: "13:00", end: "14:00" }] },
  tuesday: { start: "09:00", end: "18:00", breaks: [] },
  wednesday: { start: "09:00", end: "18:00", breaks: [] },
  thursday: { start: "09:00", end: "18:00", breaks: [] },
  friday: { start: "09:00", end: "18:00", breaks: [] },
  saturday: { start: "09:00", end: "15:00", breaks: [] },
  sunday: null,
};

function appointment(start: string, end: string, attended = true): OccupancyAppointment {
  return { start: at(start), end: at(end), attended };
}

describe("minutesOfDay", () => {
  it("lee `HH:MM` y `HH:MM:SS`", () => {
    expect(minutesOfDay("09:00")).toBe(540);
    expect(minutesOfDay("09:30:00")).toBe(570);
    expect(minutesOfDay("00:00")).toBe(0);
    expect(minutesOfDay("23:59")).toBe(1439);
    expect(minutesOfDay(" 9:05 ")).toBe(545);
  });

  it("rechaza lo que no es una hora, sin lanzar", () => {
    // El `working_plan` es un TEXT con JSON editado desde la interfaz de EA:
    // nada garantiza que traiga horas válidas.
    for (const bad of [null, undefined, "", "mediodía", "24:00", "12:60", "9", "9:5"]) {
      expect(minutesOfDay(bad), String(bad)).toBeNull();
    }
  });
});

describe("dayWindow", () => {
  it("abre según el día de la semana y saca el descanso del denominador", () => {
    const window = dayWindow(MONDAY, PLAN);
    expect(window.open).toEqual([
      { start: "2026-08-31 09:00:00", end: "2026-08-31 18:00:00" },
    ]);
    expect(window.breaks).toEqual([
      { start: "2026-08-31 13:00:00", end: "2026-08-31 14:00:00" },
    ]);
  });

  it("un día en `null` no se trabaja", () => {
    expect(dayWindow(SUNDAY, PLAN)).toEqual({ open: [], breaks: [] });
  });

  it("sin plan cargado no se inventa una jornada", () => {
    // Una técnica sin `working_plan` en EA es una fila a medio configurar. La
    // respuesta segura es "no tiene horas", no "trabaja de 9 a 6".
    expect(dayWindow(MONDAY, null)).toEqual({ open: [], breaks: [] });
    expect(dayWindow(MONDAY, undefined)).toEqual({ open: [], breaks: [] });
  });

  it("recorta un descanso que se sale de la jornada", () => {
    // EA no valida esos rangos. Un descanso de 13:00 a 20:00 sobre una jornada
    // que cierra a las 18:00 restaría dos horas que nunca estuvieron
    // disponibles, e inflaría la ocupación.
    const plan: WorkingPlan = {
      ...PLAN,
      monday: { start: "09:00", end: "18:00", breaks: [{ start: "13:00", end: "20:00" }] },
    };
    expect(dayWindow(MONDAY, plan).breaks).toEqual([
      { start: "2026-08-31 13:00:00", end: "2026-08-31 18:00:00" },
    ]);
  });

  it("descarta un descanso completamente fuera de la jornada", () => {
    const plan: WorkingPlan = {
      ...PLAN,
      monday: { start: "09:00", end: "18:00", breaks: [{ start: "19:00", end: "20:00" }] },
    };
    expect(dayWindow(MONDAY, plan).breaks).toEqual([]);
  });

  it("una jornada invertida o de duración cero no abre", () => {
    for (const bad of [
      { start: "18:00", end: "09:00", breaks: [] },
      { start: "09:00", end: "09:00", breaks: [] },
      { start: "nueve", end: "18:00", breaks: [] },
    ]) {
      expect(dayWindow(MONDAY, { ...PLAN, monday: bad }).open, bad.start).toEqual([]);
    }
  });

  it("una jornada hasta medianoche cierra a las 23:59:59, no desborda al día siguiente", () => {
    const plan: WorkingPlan = {
      ...PLAN,
      monday: { start: "20:00", end: "24:00", breaks: [] },
    };
    // `24:00` no se puede leer como hora, así que ese día no abre — y eso está
    // bien: el caso real es `23:59`.
    expect(dayWindow(MONDAY, plan).open).toEqual([]);

    const late: WorkingPlan = {
      ...PLAN,
      monday: { start: "20:00", end: "23:59", breaks: [] },
    };
    expect(dayWindow(MONDAY, late).open[0].end).toBe("2026-08-31 23:59:00");
  });
});

describe("dayWindow con excepciones", () => {
  const exception = (over: Partial<WorkingPlanException>): WorkingPlanException => ({
    id: 1,
    startDate: MONDAY,
    endDate: MONDAY,
    startTime: "10:00",
    endTime: "15:00",
    breaks: [],
    providerId: 7,
    ...over,
  });

  it("la excepción gana sobre el plan semanal", () => {
    const window = dayWindow(MONDAY, PLAN, [exception({})]);
    expect(window.open).toEqual([
      { start: "2026-08-31 10:00:00", end: "2026-08-31 15:00:00" },
    ]);
    // El descanso del plan semanal no se arrastra: la excepción reemplaza el
    // día completo, que es la semántica de EA.
    expect(window.breaks).toEqual([]);
  });

  it("`startTime` en `null` es día libre, no medianoche", () => {
    // `Working_plan_exceptions_model::get_by_provider()` de EA pone `null` en el
    // día cuando `start_time` viene vacío. Leerlo como "abre a las 00:00"
    // metería 24 horas al denominador.
    expect(dayWindow(MONDAY, PLAN, [exception({ startTime: null })])).toEqual({
      open: [],
      breaks: [],
    });
  });

  it("una excepción de rango cubre todos sus días", () => {
    const rango = exception({
      startDate: day("2026-08-31"),
      endDate: day("2026-09-02"),
    });
    for (const date of ["2026-08-31", "2026-09-01", "2026-09-02"]) {
      expect(dayWindow(day(date), PLAN, [rango]).open, date).toHaveLength(1);
    }
    expect(dayWindow(day("2026-09-03"), PLAN, [rango]).open[0].start).toBe(
      "2026-09-03 09:00:00",
    );
  });

  it("`endDate` ausente se trata como excepción de un solo día", () => {
    const single = exception({ endDate: null, startTime: null });
    expect(dayWindow(MONDAY, PLAN, [single]).open).toEqual([]);
    expect(dayWindow(day("2026-09-01"), PLAN, [single]).open).toHaveLength(1);
  });

  it("una excepción sin fechas se ignora", () => {
    expect(
      dayWindow(MONDAY, PLAN, [exception({ startDate: null, endDate: null })]).open,
    ).toHaveLength(1);
  });

  it("con dos excepciones sobre la misma fecha gana la última", () => {
    const window = dayWindow(MONDAY, PLAN, [
      exception({ id: 1, startTime: "08:00", endTime: "12:00" }),
      exception({ id: 2, startTime: "14:00", endTime: "20:00" }),
    ]);
    expect(window.open[0].start).toBe("2026-08-31 14:00:00");
  });

  it("una excepción libre en un día que ya era libre sigue siendo libre", () => {
    expect(
      dayWindow(SUNDAY, PLAN, [
        exception({ startDate: SUNDAY, endDate: SUNDAY, startTime: null }),
      ]),
    ).toEqual({ open: [], breaks: [] });
  });
});

describe("windowOverRange", () => {
  it("concatena los días y salta los que no se trabajan", () => {
    const dates = ["2026-08-31", "2026-09-01", "2026-09-06"].map(day);
    const window = windowOverRange(dates, PLAN);
    expect(window.open).toHaveLength(2); // el domingo no abre
    expect(window.breaks).toHaveLength(1); // solo el lunes tiene descanso
  });

  it("un rango vacío devuelve una ventana vacía", () => {
    expect(windowOverRange([], PLAN)).toEqual({ open: [], breaks: [] });
  });
});

describe("occupancyByProvider", () => {
  it("usa `computeOccupancy` de B1 tal cual: no recalcula nada", () => {
    const result = occupancyByProvider([
      {
        eaProviderId: 7,
        name: "Lina",
        window: dayWindow(MONDAY, PLAN),
        blocked: [],
        // 9:00–12:00 atendida sobre una jornada de 9 h con 1 h de descanso:
        // 180 de 480 minutos disponibles.
        appointments: [appointment("2026-08-31 09:00:00", "2026-08-31 12:00:00")],
      },
    ]);

    expect(result[0].occupancy.availableMinutes).toBe(480);
    expect(result[0].occupancy.busyMinutes).toBe(180);
    expect(result[0].occupancy.rate).toBeCloseTo(180 / 480, 6);
  });

  it("una inasistencia no cuenta como ocupada ni reduce el denominador", () => {
    const result = occupancyByProvider([
      {
        eaProviderId: 7,
        name: "Lina",
        window: dayWindow(MONDAY, PLAN),
        blocked: [],
        appointments: [
          appointment("2026-08-31 09:00:00", "2026-08-31 12:00:00", false),
        ],
      },
    ]);
    expect(result[0].occupancy.availableMinutes).toBe(480);
    expect(result[0].occupancy.busyMinutes).toBe(0);
  });

  it("un bloqueo del estudio reduce el denominador", () => {
    const blocked: Interval[] = [
      { start: at("2026-08-31 15:00:00"), end: at("2026-08-31 18:00:00") },
    ];
    const result = occupancyByProvider([
      {
        eaProviderId: 7,
        name: "Lina",
        window: dayWindow(MONDAY, PLAN),
        blocked,
        appointments: [],
      },
    ]);
    expect(result[0].occupancy.availableMinutes).toBe(300); // 480 − 180
  });

  it("un domingo cerrado da `null`, no 0 %", () => {
    const result = occupancyByProvider([
      {
        eaProviderId: 7,
        name: "Lina",
        window: dayWindow(SUNDAY, PLAN),
        blocked: [],
        appointments: [],
      },
    ]);
    expect(result[0].occupancy.availableMinutes).toBe(0);
    expect(result[0].occupancy.rate).toBeNull();
  });

  it("sin técnicas devuelve una lista vacía", () => {
    expect(occupancyByProvider([])).toEqual([]);
  });
});

describe("stationHourOccupancy", () => {
  /** Jornada del estudio: lunes 9–18 con descanso 13–14 ⇒ 480 minutos. */
  const studioWindow: DayWindow = dayWindow(MONDAY, PLAN);

  function withBusy(...busyPerProvider: number[]) {
    return stationHourOccupancy({
      stations: 2,
      studioWindow,
      studioBlocked: [],
      perProvider: busyPerProvider.map((busy, index) => ({
        eaProviderId: index + 1,
        name: `T${index + 1}`,
        occupancy: {
          availableMinutes: 480,
          busyMinutes: busy,
          overflowMinutes: 0,
          rate: busy / 480,
        },
      })),
    });
  }

  it("la capacidad es puestos × minutos abiertos, no personas × minutos", () => {
    // Es el eje del plan: "con dos estaciones, la capacidad del negocio son
    // horas de puesto, no personas".
    const result = withBusy(0, 0, 0);
    expect(result.openMinutes).toBe(480);
    expect(result.capacityMinutes).toBe(960);
    expect(result.rate).toBe(0);
  });

  it("**no fusiona** los solapes: dos citas simultáneas ocupan dos puestos", () => {
    // Ésta es la diferencia entera con `computeOccupancy`, que fusiona porque
    // mira una sola silla. Tres técnicas al 50 % dejan el estudio al 75 % de
    // sus puestos, no al 50 %.
    const result = withBusy(240, 240, 240);
    expect(result.usedMinutes).toBe(720);
    expect(result.rate).toBeCloseTo(720 / 960, 6);
  });

  it("dos técnicas al 100 % llenan los dos puestos", () => {
    const result = withBusy(480, 480);
    expect(result.rate).toBe(1);
    expect(result.overCapacityMinutes).toBe(0);
  });

  it("tres técnicas al 100 % desbordan, y el desborde se reporta aparte", () => {
    // Físicamente imposible con dos puestos: o alguien atendió sin silla, o la
    // agenda permitió algo que `lib/conflict.ts` debía haber frenado. Se
    // reporta en vez de recortarse en silencio.
    const result = withBusy(480, 480, 480);
    expect(result.usedMinutes).toBe(1440);
    expect(result.overCapacityMinutes).toBe(480);
    expect(result.rate).toBeGreaterThan(1);
  });

  it("el estudio cerrado da `null`, no 0 %", () => {
    const result = stationHourOccupancy({
      stations: 2,
      studioWindow: dayWindow(SUNDAY, PLAN),
      studioBlocked: [],
      perProvider: [],
    });
    expect(result.capacityMinutes).toBe(0);
    expect(result.rate).toBeNull();
    expect(result.overCapacityMinutes).toBe(0);
  });

  it("sin puestos sembrados no se inventa capacidad", () => {
    const result = stationHourOccupancy({
      stations: 0,
      studioWindow,
      studioBlocked: [],
      perProvider: [],
    });
    expect(result.capacityMinutes).toBe(0);
    expect(result.rate).toBeNull();
  });

  it("un número de puestos absurdo se normaliza a entero no negativo", () => {
    expect(
      stationHourOccupancy({
        stations: -3,
        studioWindow,
        studioBlocked: [],
        perProvider: [],
      }).stations,
    ).toBe(0);
    expect(
      stationHourOccupancy({
        stations: 2.7,
        studioWindow,
        studioBlocked: [],
        perProvider: [],
      }).stations,
    ).toBe(2);
  });

  it("los minutos abiertos son la **unión** de las jornadas, no su suma", () => {
    // Dos técnicas en el mismo turno son un turno. Sumarlas duplicaría la
    // capacidad del estudio y haría que la ocupación se viera a la mitad.
    const dobleTurno: DayWindow = {
      open: [...studioWindow.open, ...studioWindow.open],
      breaks: studioWindow.breaks,
    };
    const result = stationHourOccupancy({
      stations: 2,
      studioWindow: dobleTurno,
      studioBlocked: [],
      perProvider: [],
    });
    expect(result.openMinutes).toBe(480);
  });

  it("un bloqueo del estudio recorta la capacidad", () => {
    const result = stationHourOccupancy({
      stations: 2,
      studioWindow,
      studioBlocked: [
        { start: at("2026-08-31 16:00:00"), end: at("2026-08-31 18:00:00") },
      ],
      perProvider: [],
    });
    expect(result.openMinutes).toBe(360);
    expect(result.capacityMinutes).toBe(720);
  });
});

describe("franjas", () => {
  it("ubica una hora de pared en su bloque de dos horas", () => {
    expect(slotOf("2026-08-31 09:30:00")).toBe("08-10");
    expect(slotOf("2026-08-31 10:00:00")).toBe("10-12");
    expect(slotOf("2026-08-31 19:59:00")).toBe("18-20");
  });

  it("los bordes de la franja son `[from, to)`: nadie cae en dos", () => {
    for (const slot of SLOTS) {
      const hour = String(Math.floor(slot.from / 60)).padStart(2, "0");
      expect(slotOf(`2026-08-31 ${hour}:00:00`)).toBe(slot.id);
    }
  });

  it("lo que cae afuera va a `fuera` y **no se descarta**", () => {
    // Una cita a las 7 a. m. es información: el horario cargado en EA no es el
    // real, o alguien trabajó fuera de turno.
    expect(slotOf("2026-08-31 07:00:00")).toBe("fuera");
    expect(slotOf("2026-08-31 20:00:00")).toBe("fuera");
    expect(slotOf("2026-08-31 23:30:00")).toBe("fuera");
  });

  it("acepta una hora suelta además de un datetime completo", () => {
    expect(slotOf("14:15")).toBe("14-16");
  });

  it("una hora ilegible cae en `fuera`, sin lanzar", () => {
    expect(slotOf("")).toBe("fuera");
    expect(slotOf("no es una hora")).toBe("fuera");
  });

  it("cada franja tiene rótulo, y `fuera` también", () => {
    for (const slot of SLOTS) expect(slotLabel(slot.id)).toBe(slot.label);
    expect(slotLabel("fuera")).toBe("Fuera de horario");
  });
});
