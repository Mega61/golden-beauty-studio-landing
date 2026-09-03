import { describe, expect, it } from "vitest";

import type { WorkingPlan } from "@/lib/ea/types";
import { parseEaLocalDate } from "@/lib/ea/datetime";
import {
  addDays,
  datesFor,
  DEFAULT_DAY_END,
  DEFAULT_DAY_START,
  fetchWindow,
  isRangeMode,
  parseAnchor,
  parseRangeMode,
  RANGE_MODE_DAYS,
  shiftAnchor,
  startOfWeek,
  touchesDates,
  visibleWindow,
} from "./range";

const d = (value: string) => parseEaLocalDate(value);

describe("addDays", () => {
  it("cruza fin de mes y fin de año", () => {
    expect(addDays(d("2026-08-31"), 1)).toBe("2026-09-01");
    expect(addDays(d("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(d("2026-01-01"), -1)).toBe("2025-12-31");
  });

  it("cuenta el 29 de febrero de un bisiesto", () => {
    expect(addDays(d("2028-02-28"), 1)).toBe("2028-02-29");
    expect(addDays(d("2026-02-28"), 1)).toBe("2026-03-01");
  });
});

describe("startOfWeek", () => {
  // Semana ISO. La de EA empieza el domingo porque así viaja su JSON; la que
  // pide la recepción va de lunes a domingo.
  it("un lunes es su propio inicio", () => {
    expect(startOfWeek(d("2026-08-31"))).toBe("2026-08-31"); // lunes
  });

  it("un domingo pertenece a la semana que termina, no a la que empieza", () => {
    expect(startOfWeek(d("2026-09-06"))).toBe("2026-08-31"); // domingo
  });

  it("un miércoles retrocede al lunes", () => {
    expect(startOfWeek(d("2026-09-02"))).toBe("2026-08-31");
  });
});

describe("datesFor", () => {
  it("Día es un solo día, el ancla", () => {
    expect(datesFor("dia", d("2026-09-02"))).toEqual(["2026-09-02"]);
  });

  it("3 días arranca en el ancla, no en el lunes", () => {
    expect(datesFor("tres", d("2026-09-02"))).toEqual([
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
    ]);
  });

  it("Semana se alinea al lunes aunque el ancla sea jueves", () => {
    expect(datesFor("semana", d("2026-09-03"))).toEqual([
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
      "2026-09-03",
      "2026-09-04",
      "2026-09-05",
      "2026-09-06",
    ]);
  });

  it("devuelve tantos días como declara la tabla", () => {
    for (const mode of ["dia", "tres", "semana"] as const) {
      expect(datesFor(mode, d("2026-09-02"))).toHaveLength(RANGE_MODE_DAYS[mode]);
    }
  });
});

describe("shiftAnchor", () => {
  it("en Semana salta siete días", () => {
    expect(shiftAnchor("semana", d("2026-08-31"), 1)).toBe("2026-09-07");
    expect(shiftAnchor("semana", d("2026-08-31"), -1)).toBe("2026-08-24");
  });

  // Con 3 días la recepción quiere correr la ventana, no perder de vista mañana.
  it("en 3 días corre un solo día", () => {
    expect(shiftAnchor("tres", d("2026-08-31"), 1)).toBe("2026-09-01");
  });
});

describe("parseRangeMode / parseAnchor", () => {
  it("acepta los tres modos y nada más", () => {
    expect(parseRangeMode("semana")).toBe("semana");
    expect(parseRangeMode("mes")).toBe("dia");
    expect(parseRangeMode(undefined)).toBe("dia");
    expect(isRangeMode("tres")).toBe(true);
    expect(isRangeMode(7)).toBe(false);
  });

  it("una fecha rota en la URL cae a hoy en vez de reventar", () => {
    const hoy = d("2026-08-31");
    expect(parseAnchor("2026-09-02", hoy)).toBe("2026-09-02");
    expect(parseAnchor("mañana", hoy)).toBe("2026-08-31");
    expect(parseAnchor("2026-13-45", hoy)).toBe("2026-08-31");
    expect(parseAnchor(undefined, hoy)).toBe("2026-08-31");
  });
});

describe("fetchWindow", () => {
  // El día de atrás es el que salva la cita que cruzó la medianoche: su
  // `start_datetime` cae fuera del rango y `from`/`till` son de grano día.
  it("pide un día extra a cada lado", () => {
    expect(fetchWindow([d("2026-09-02")])).toEqual({
      from: "2026-09-01",
      till: "2026-09-03",
    });
  });

  it("no depende del orden de los días", () => {
    const desordenados = [d("2026-09-04"), d("2026-09-02"), d("2026-09-03")];
    expect(fetchWindow(desordenados)).toEqual({ from: "2026-09-01", till: "2026-09-05" });
  });

  it("sin días no hay ventana que pedir", () => {
    expect(() => fetchWindow([])).toThrow(/al menos un día/);
  });
});

describe("touchesDates", () => {
  const dias = [d("2026-09-02"), d("2026-09-03")];

  it("acepta la que empieza el día anterior y sigue corriendo", () => {
    expect(
      touchesDates({ start: "2026-09-01 23:00:00", end: "2026-09-02 01:00:00" }, dias),
    ).toBe(true);
  });

  it("descarta la del día de relleno que no toca nada", () => {
    expect(
      touchesDates({ start: "2026-09-01 10:00:00", end: "2026-09-01 11:00:00" }, dias),
    ).toBe(false);
    expect(
      touchesDates({ start: "2026-09-04 10:00:00", end: "2026-09-04 11:00:00" }, dias),
    ).toBe(false);
  });

  it("una cita de duración cero a medianoche toca su día", () => {
    expect(
      touchesDates({ start: "2026-09-02 00:00:00", end: "2026-09-02 00:00:00" }, dias),
    ).toBe(true);
  });

  it("sin días visibles nada toca nada", () => {
    expect(touchesDates({ start: "2026-09-02 10:00:00", end: "2026-09-02 11:00:00" }, [])).toBe(
      false,
    );
  });
});

describe("visibleWindow", () => {
  const plan = (start: string, end: string): WorkingPlan => ({
    sunday: null,
    monday: { start, end, breaks: [] },
    tuesday: { start, end, breaks: [] },
    wednesday: { start, end, breaks: [] },
    thursday: { start, end, breaks: [] },
    friday: { start, end, breaks: [] },
    saturday: null,
  });

  const miercoles = [d("2026-09-02")];

  it("sin nadie que trabaje antes ni después, es el piso de 8 a 8", () => {
    expect(visibleWindow([{ workingPlan: plan("10:00", "16:00") }], miercoles)).toEqual({
      startMinute: DEFAULT_DAY_START,
      endMinute: DEFAULT_DAY_END,
    });
  });

  // Es un piso, no un recorte: una jornada de 10 a 4 no encoge la grilla, pero
  // una de 7 a 21 sí la abre.
  it("se abre para incluir una jornada más larga", () => {
    expect(visibleWindow([{ workingPlan: plan("07:00", "21:00") }], miercoles)).toEqual({
      startMinute: 7 * 60,
      endMinute: 21 * 60,
    });
  });

  it("toma el extremo de cada técnica, no el de la primera", () => {
    expect(
      visibleWindow(
        [{ workingPlan: plan("07:00", "16:00") }, { workingPlan: plan("11:00", "22:00") }],
        miercoles,
      ),
    ).toEqual({ startMinute: 7 * 60, endMinute: 22 * 60 });
  });

  it("un día libre no encoge nada", () => {
    // El domingo el plan es `null`: se salta en vez de dar 0.
    expect(visibleWindow([{ workingPlan: plan("07:00", "21:00") }], [d("2026-09-06")])).toEqual({
      startMinute: DEFAULT_DAY_START,
      endMinute: DEFAULT_DAY_END,
    });
  });

  it("una excepción de plan manda sobre el plan del día", () => {
    expect(
      visibleWindow(
        [
          {
            workingPlan: plan("10:00", "16:00"),
            workingPlanExceptions: [
              {
                id: 1,
                startDate: d("2026-09-02"),
                endDate: d("2026-09-02"),
                startTime: "06:00",
                endTime: "23:00",
                breaks: [],
                providerId: 7,
              },
            ],
          },
        ],
        miercoles,
      ),
    ).toEqual({ startMinute: 6 * 60, endMinute: 23 * 60 });
  });

  it("descubrir citas ocultas abre la ventana de a una hora", () => {
    expect(visibleWindow([{ workingPlan: plan("10:00", "16:00") }], miercoles, 2, 1)).toEqual({
      startMinute: 6 * 60,
      endMinute: 21 * 60,
    });
  });

  // Un inicio negativo haría que el gutter escribiera horas de ayer, y un fin
  // más allá de las 24 h le pediría al motor el día siguiente.
  it("nunca se sale del día", () => {
    expect(visibleWindow([{ workingPlan: plan("10:00", "16:00") }], miercoles, 20, 20)).toEqual({
      startMinute: 0,
      endMinute: 24 * 60,
    });
  });

  it("sin técnicas devuelve el piso", () => {
    expect(visibleWindow([], miercoles)).toEqual({
      startMinute: DEFAULT_DAY_START,
      endMinute: DEFAULT_DAY_END,
    });
  });
});
