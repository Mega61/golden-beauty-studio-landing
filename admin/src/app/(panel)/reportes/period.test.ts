import { describe, expect, it } from "vitest";

import { parseEaLocalDate } from "@/lib/ea";
import {
  addDays,
  daysBetweenInclusive,
  daysInMonth,
  eachDay,
  parseCadence,
  parseDay,
  periodHref,
  REPORTS_BY_CADENCE,
  resolvePeriod,
  shiftPeriod,
  weekdayKey,
} from "./period";

const d = (value: string) => parseEaLocalDate(value);

describe("daysInMonth", () => {
  it("los meses cortos y los largos", () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("febrero, con las tres reglas del bisiesto", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29); // divisible por 4
    expect(daysInMonth(1900, 2)).toBe(28); // divisible por 100, no por 400
    expect(daysInMonth(2000, 2)).toBe(29); // divisible por 400
  });
});

describe("addDays", () => {
  it("suma dentro del mes", () => {
    expect(addDays(d("2026-08-10"), 5)).toBe("2026-08-15");
  });

  it("cruza el fin de mes", () => {
    expect(addDays(d("2026-08-31"), 1)).toBe("2026-09-01");
    expect(addDays(d("2026-01-31"), 1)).toBe("2026-02-01");
  });

  it("cruza el fin de año en los dos sentidos", () => {
    expect(addDays(d("2026-12-31"), 1)).toBe("2027-01-01");
    expect(addDays(d("2026-01-01"), -1)).toBe("2025-12-31");
  });

  it("resta dentro y fuera del mes", () => {
    expect(addDays(d("2026-03-01"), -1)).toBe("2026-02-28");
    expect(addDays(d("2028-03-01"), -1)).toBe("2028-02-29");
  });

  it("salta varios meses de una", () => {
    expect(addDays(d("2026-01-15"), 90)).toBe("2026-04-15");
    expect(addDays(d("2026-04-15"), -90)).toBe("2026-01-15");
  });

  it("cero es la identidad", () => {
    expect(addDays(d("2026-08-31"), 0)).toBe("2026-08-31");
  });

  it("**no** arrastra la zona del proceso", () => {
    // `new Date("2026-08-31")` parsea como UTC: en Bogotá `getDate()` devuelve
    // 30. Este módulo no toca `Date`, y este test es el que lo fija.
    expect(addDays(d("2026-08-31"), 1)).toBe("2026-09-01");
    expect(addDays(d("2026-01-01"), 0)).toBe("2026-01-01");
  });
});

describe("daysBetweenInclusive", () => {
  it("un solo día cuenta uno", () => {
    expect(daysBetweenInclusive(d("2026-08-31"), d("2026-08-31"))).toBe(1);
  });

  it("un mes completo", () => {
    expect(daysBetweenInclusive(d("2026-08-01"), d("2026-08-31"))).toBe(31);
    expect(daysBetweenInclusive(d("2026-02-01"), d("2026-02-28"))).toBe(28);
    expect(daysBetweenInclusive(d("2028-02-01"), d("2028-02-29"))).toBe(29);
  });

  it("cruzando años", () => {
    expect(daysBetweenInclusive(d("2026-12-30"), d("2027-01-02"))).toBe(4);
    expect(daysBetweenInclusive(d("2026-01-01"), d("2026-12-31"))).toBe(365);
    expect(daysBetweenInclusive(d("2028-01-01"), d("2028-12-31"))).toBe(366);
  });

  it("es coherente con `addDays`", () => {
    const from = d("2026-05-17");
    for (const offset of [0, 1, 13, 40, 200, 400]) {
      expect(daysBetweenInclusive(from, addDays(from, offset))).toBe(offset + 1);
    }
  });
});

describe("eachDay", () => {
  it("devuelve los días en orden, extremos incluidos", () => {
    expect(eachDay(d("2026-08-30"), d("2026-09-02"))).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  it("un rango de un día devuelve ese día", () => {
    expect(eachDay(d("2026-08-31"), d("2026-08-31"))).toEqual(["2026-08-31"]);
  });
});

describe("weekdayKey", () => {
  it("usa las claves del `working_plan` de EA", () => {
    // 2026-08-31 fue lunes. Verificado contra el calendario, no contra `Date`.
    expect(weekdayKey(d("2026-08-31"))).toBe("monday");
    expect(weekdayKey(d("2026-09-06"))).toBe("sunday");
    expect(weekdayKey(d("2026-09-05"))).toBe("saturday");
  });

  it("avanza un día de la semana por día de calendario, sin saltos", () => {
    const order = [
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
      "sunday",
    ];
    for (const [i, expected] of order.entries()) {
      expect(weekdayKey(addDays(d("2026-08-31"), i))).toBe(expected);
    }
  });

  it("acierta en enero y febrero, que es donde Zeller se equivoca si se copia mal", () => {
    // El desplazamiento de enero y febrero al año anterior es la parte de la
    // congruencia que se implementa mal con más frecuencia.
    expect(weekdayKey(d("2026-01-01"))).toBe("thursday");
    expect(weekdayKey(d("2026-02-01"))).toBe("sunday");
    expect(weekdayKey(d("2028-02-29"))).toBe("tuesday");
    expect(weekdayKey(d("2000-01-01"))).toBe("saturday");
  });
});

describe("parseCadence", () => {
  it("acepta las tres", () => {
    expect(parseCadence("dia")).toBe("dia");
    expect(parseCadence("quincena")).toBe("quincena");
    expect(parseCadence("mes")).toBe("mes");
  });

  it("cae en mes ante cualquier otra cosa", () => {
    expect(parseCadence(undefined)).toBe("mes");
    expect(parseCadence("")).toBe("mes");
    expect(parseCadence("año")).toBe("mes");
  });
});

describe("parseDay", () => {
  it("acepta una fecha bien formada", () => {
    expect(parseDay("2026-08-31")).toBe("2026-08-31");
  });

  it("rechaza formatos y fechas imposibles en vez de lanzar", () => {
    // La URL la escribe quien pegó un link, no un cliente de API.
    expect(parseDay(undefined)).toBeNull();
    expect(parseDay("")).toBeNull();
    expect(parseDay("31-08-2026")).toBeNull();
    expect(parseDay("2026-8-1")).toBeNull();
    expect(parseDay("2026-13-01")).toBeNull();
    expect(parseDay("2026-00-01")).toBeNull();
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("2026-02-29")).toBeNull(); // 2026 no es bisiesto
    expect(parseDay("2028-02-29")).toBe("2028-02-29");
    expect(parseDay("2026-08-00")).toBeNull();
  });
});

describe("resolvePeriod", () => {
  const today = d("2026-08-20");

  it("día: el ancla, un solo día", () => {
    const period = resolvePeriod({ cadencia: "dia", ancla: "2026-08-12" }, today);
    expect(period).toMatchObject({
      cadence: "dia",
      from: "2026-08-12",
      to: "2026-08-12",
      label: "12 de agosto de 2026",
    });
  });

  it("mes: el mes completo del ancla", () => {
    const period = resolvePeriod({ cadencia: "mes", ancla: "2026-02-14" }, today);
    expect(period).toMatchObject({
      from: "2026-02-01",
      to: "2026-02-28",
      label: "febrero de 2026",
    });
  });

  it("quincena: primera mitad si el ancla es del 1 al 15", () => {
    for (const day of ["01", "07", "15"]) {
      const period = resolvePeriod(
        { cadencia: "quincena", ancla: `2026-08-${day}` },
        today,
      );
      expect(period.from).toBe("2026-08-01");
      expect(period.to).toBe("2026-08-15");
      expect(period.label).toBe("1 – 15 de agosto de 2026");
    }
  });

  it("quincena: segunda mitad si el ancla es del 16 en adelante, y cierra en el fin de mes real", () => {
    expect(resolvePeriod({ cadencia: "quincena", ancla: "2026-08-16" }, today).to).toBe(
      "2026-08-31",
    );
    expect(resolvePeriod({ cadencia: "quincena", ancla: "2026-02-28" }, today).to).toBe(
      "2026-02-28",
    );
    expect(resolvePeriod({ cadencia: "quincena", ancla: "2026-04-30" }, today).to).toBe(
      "2026-04-30",
    );
  });

  it("sin ancla usa hoy, y hoy entra por parámetro", () => {
    // Un reporte que consulta el reloj por su cuenta no se puede testear.
    expect(resolvePeriod({ cadencia: "mes" }, d("2026-11-03"))).toMatchObject({
      from: "2026-11-01",
      to: "2026-11-30",
    });
  });

  it("un ancla basura cae en el periodo de hoy en vez de reventar", () => {
    expect(resolvePeriod({ cadencia: "mes", ancla: "ayer" }, today).from).toBe(
      "2026-08-01",
    );
  });

  it("un rango explícito gana sobre la cadencia", () => {
    // Es la salida para el día en que los cortes de quincena reales no sean
    // 1–15 / 16–fin: la decisión está pendiente y este parámetro la absorbe.
    const period = resolvePeriod(
      { cadencia: "quincena", desde: "2026-08-06", hasta: "2026-08-20" },
      today,
    );
    expect(period).toMatchObject({ from: "2026-08-06", to: "2026-08-20" });
  });

  it("un rango invertido o a medias se ignora y vuelve la cadencia", () => {
    expect(
      resolvePeriod(
        { cadencia: "mes", ancla: "2026-08-20", desde: "2026-08-20", hasta: "2026-08-06" },
        today,
      ).from,
    ).toBe("2026-08-01");
    expect(
      resolvePeriod({ cadencia: "mes", ancla: "2026-08-20", desde: "2026-08-06" }, today)
        .from,
    ).toBe("2026-08-01");
  });

  it("rotula un rango que cruza meses sin fingir que es un mes", () => {
    const period = resolvePeriod(
      { cadencia: "mes", desde: "2026-08-25", hasta: "2026-09-04" },
      today,
    );
    expect(period.label).toBe("25 de agosto – 4 de septiembre de 2026");
  });
});

describe("shiftPeriod", () => {
  const today = d("2026-08-20");

  it("día: un día para atrás y para adelante", () => {
    const period = resolvePeriod({ cadencia: "dia", ancla: "2026-09-01" }, today);
    expect(shiftPeriod(period, -1).from).toBe("2026-08-31");
    expect(shiftPeriod(period, 1).from).toBe("2026-09-02");
  });

  it("mes: el mes de al lado, cruzando el año", () => {
    const enero = resolvePeriod({ cadencia: "mes", ancla: "2026-01-10" }, today);
    expect(shiftPeriod(enero, -1)).toMatchObject({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    expect(shiftPeriod(enero, 1)).toMatchObject({
      from: "2026-02-01",
      to: "2026-02-28",
    });
  });

  it("quincena: cae siempre sobre una quincena de verdad, no sobre un rango de 15 días", () => {
    // Es la razón de que esto desplace el ancla y vuelva a resolver en vez de
    // restar la duración: media quincena tiene 15 días y la otra 13, 14, 15 o
    // 16, y restar días produciría rangos que no son ninguna quincena.
    const segunda = resolvePeriod({ cadencia: "quincena", ancla: "2026-03-20" }, today);
    expect(segunda).toMatchObject({ from: "2026-03-16", to: "2026-03-31" });

    const primera = shiftPeriod(segunda, -1);
    expect(primera).toMatchObject({ from: "2026-03-01", to: "2026-03-15" });

    const febrero = shiftPeriod(primera, -1);
    expect(febrero).toMatchObject({ from: "2026-02-16", to: "2026-02-28" });

    expect(shiftPeriod(febrero, 1)).toMatchObject({
      from: "2026-03-01",
      to: "2026-03-15",
    });
  });

  it("ir y volver deja el mismo periodo", () => {
    for (const cadencia of ["dia", "quincena", "mes"] as const) {
      const period = resolvePeriod({ cadencia, ancla: "2026-07-17" }, today);
      const roundTrip = shiftPeriod(shiftPeriod(period, 1), -1);
      expect(roundTrip.from, cadencia).toBe(period.from);
      expect(roundTrip.to, cadencia).toBe(period.to);
    }
  });
});

describe("periodHref", () => {
  it("ancla el periodo en su primer día, para que la URL sea estable", () => {
    const period = resolvePeriod({ cadencia: "mes", ancla: "2026-08-20" }, d("2026-08-20"));
    expect(periodHref(period)).toBe("/reportes?cadencia=mes&ancla=2026-08-01");
  });

  it("acepta otra base", () => {
    const period = resolvePeriod({ cadencia: "dia", ancla: "2026-08-20" }, d("2026-08-20"));
    expect(periodHref(period, "/otro")).toBe("/otro?cadencia=dia&ancla=2026-08-20");
  });
});

describe("REPORTS_BY_CADENCE", () => {
  it("cubre los nueve reportes del plan, sin repetir ninguno", () => {
    const all = Object.values(REPORTS_BY_CADENCE).flat();
    expect(all).toHaveLength(9);
    expect(new Set(all).size).toBe(9);
  });
});
