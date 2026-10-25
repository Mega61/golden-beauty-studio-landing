import { describe, expect, it } from "vitest";

import {
  filterOptions,
  matchesQuery,
  monthGrid,
  normalizeSearch,
  parseTypedTime,
  parseIsoDate,
  shiftIsoDate,
  shiftMonth,
  timeOptions,
} from "./picker-model";

const SERVICIOS = [
  { value: 1, label: "Semipermanente manos", detail: "1 h" },
  { value: 2, label: "Semipermanente pies", detail: "1 h" },
  { value: 3, label: "Pedicure spa", detail: "1 h 30 min" },
  { value: 4, label: "Esculpidas en acrílico", detail: "2 h" },
];

describe("búsqueda", () => {
  it("ignora tildes, mayúsculas y espacios de más", () => {
    expect(normalizeSearch("  Acrílico   SPA ")).toBe("acrilico spa");
  });

  it("cada palabra tiene que aparecer, en cualquier orden", () => {
    expect(filterOptions(SERVICIOS, "pies semi").map((o) => o.value)).toEqual([2]);
    expect(filterOptions(SERVICIOS, "semi").map((o) => o.value)).toEqual([1, 2]);
  });

  it("encuentra sin tildes lo que se escribió con tildes", () => {
    expect(filterOptions(SERVICIOS, "acrilico").map((o) => o.value)).toEqual([4]);
  });

  it("busca también en el detalle", () => {
    expect(filterOptions(SERVICIOS, "30 min").map((o) => o.value)).toEqual([3]);
  });

  it("una búsqueda vacía muestra todo", () => {
    expect(filterOptions(SERVICIOS, "   ")).toHaveLength(4);
  });

  it("las palabras clave cuentan aunque no se dibujen", () => {
    expect(matchesQuery({ value: 1, label: "Lina", keywords: "manicurista" }, "manicur")).toBe(true);
  });
});

describe("timeOptions", () => {
  it("arma la grilla y la rotula en 12 h", () => {
    const opts = timeOptions(30, { from: "09:00", to: "10:00" });
    expect(opts.map((o) => o.value)).toEqual(["09:00", "09:30", "10:00"]);
    expect(opts[1].label).toBe("9:30 a. m.");
  });

  it("mete en su lugar una hora que no cae en la grilla", () => {
    const opts = timeOptions(30, { from: "09:00", to: "10:00", include: "09:10" });
    expect(opts.map((o) => o.value)).toEqual(["09:00", "09:10", "09:30", "10:00"]);
  });

  it("se encuentra escribiendo como se dice: 930, 9:30, 21:30, pm", () => {
    const opts = timeOptions(30);
    expect(filterOptions(opts, "9:30").map((o) => o.value)).toEqual(["09:30", "21:30"]);
    expect(filterOptions(opts, "930").map((o) => o.value)).toContain("09:30");
    expect(filterOptions(opts, "2130").map((o) => o.value)).toEqual(["21:30"]);
    expect(filterOptions(opts, "9:30 pm").map((o) => o.value)).toEqual(["21:30"]);
  });
});

describe("calendario", () => {
  it("las semanas van de lunes a domingo", () => {
    // Octubre de 2026 empieza en jueves.
    const weeks = monthGrid(2026, 10);
    expect(weeks[0]).toEqual([null, null, null, "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(weeks.at(-1)?.filter(Boolean).at(-1)).toBe("2026-10-31");
    expect(weeks.every((w) => w.length === 7)).toBe(true);
  });

  it("corre meses cruzando el año", () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ y: 2027, m: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ y: 2025, m: 12 });
  });

  it("corre días cruzando el mes", () => {
    expect(shiftIsoDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftIsoDate("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("rechaza fechas que no existen", () => {
    expect(parseIsoDate("2026-02-30")).toBeNull();
    expect(parseIsoDate("hoy")).toBeNull();
  });
});

describe("parseTypedTime", () => {
  it.each([
    ["910", "09:10"],
    ["9:10", "09:10"],
    ["9:10 pm", "21:10"],
    ["9:10 p. m.", "21:10"],
    ["2 pm", "14:00"],
    ["2p", "14:00"],
    ["12 am", "00:00"],
    ["12:30 pm", "12:30"],
    ["21:10", "21:10"],
    ["1730", "17:30"],
  ])("%s → %s", (input, expected) => {
    expect(parseTypedTime(input)).toBe(expected);
  });

  it.each(["", "hola", "25:00", "9:75", "13 pm", "12345"])("%s no es una hora", (input) => {
    expect(parseTypedTime(input)).toBeNull();
  });
});
