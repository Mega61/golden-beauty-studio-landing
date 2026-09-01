import { describe, expect, it } from "vitest";
import {
  formatCOP,
  formatDateLong,
  formatDateShort,
  formatDuration,
  formatHour12,
  formatPesos,
  formatPhoneCO,
  formatTime,
  formatTimeRange,
  parsePesos,
  parseWallClock,
} from "./format";

describe("formatCOP", () => {
  it("pinta pesos sin centavos", () => {
    expect(formatCOP(120000)).toBe("$ 120.000");
    expect(formatCOP(180000)).toBe("$ 180.000");
    expect(formatCOP(0)).toBe("$ 0");
  });

  it("usa un espacio normal, no un espacio duro", () => {
    // Si el separador fuera U+00A0 este texto no se podría buscar ni comparar
    // en un test sin depender de la versión de ICU del runtime.
    expect(formatCOP(1000)).not.toContain(" ");
    expect(formatCOP(1000).charCodeAt(1)).toBe(32);
  });

  it("redondea a pesos enteros, nunca muestra una fracción", () => {
    expect(formatCOP(120000.4)).toBe("$ 120.000");
    expect(formatCOP(120000.6)).toBe("$ 120.001");
  });

  it("no revienta con un número que no es número", () => {
    expect(formatCOP(Number.NaN)).toBe("—");
    expect(formatCOP(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formatPesos deja la cifra sin el signo", () => {
    expect(formatPesos(120000)).toBe("120.000");
    expect(formatPesos(Number.NaN)).toBe("—");
  });
});

describe("parsePesos", () => {
  it("lee lo que sea que la usuaria haya pegado", () => {
    expect(parsePesos("120000")).toBe(120000);
    expect(parsePesos("120.000")).toBe(120000);
    expect(parsePesos("$ 120.000")).toBe(120000);
    expect(parsePesos("  1 200 000  ")).toBe(1200000);
  });

  it("un campo vacío es null, no cero", () => {
    // Cero es un total válido (una cortesía); vacío es "todavía no escribió".
    expect(parsePesos("")).toBeNull();
    expect(parsePesos("$")).toBeNull();
    expect(parsePesos("abc")).toBeNull();
  });

  it("descarta el signo negativo en vez de aceptarlo", () => {
    // Un cobro negativo no existe; el ajuste va por otro camino.
    expect(parsePesos("-5000")).toBe(5000);
  });
});

describe("formatHour12", () => {
  it("omite los minutos en punto", () => {
    expect(formatHour12(14)).toBe("2 p. m.");
    expect(formatHour12(9)).toBe("9 a. m.");
  });

  it("escribe el meridiano al estilo colombiano", () => {
    expect(formatHour12(14, 30)).toBe("2:30 p. m.");
    expect(formatHour12(8, 5)).toBe("8:05 a. m.");
  });

  it("resuelve mediodía y medianoche", () => {
    expect(formatHour12(0)).toBe("12 a. m.");
    expect(formatHour12(12)).toBe("12 p. m.");
    expect(formatHour12(0, 30)).toBe("12:30 a. m.");
    expect(formatHour12(23, 59)).toBe("11:59 p. m.");
  });
});

describe("formatTime / formatTimeRange", () => {
  it("lee la hora de pared sin pasar por Date", () => {
    expect(formatTime("2026-08-31 14:30:00")).toBe("2:30 p. m.");
    expect(formatTime("2026-08-31T14:30:00")).toBe("2:30 p. m.");
  });

  it("un string que no parsea sale como raya, no como Invalid Date", () => {
    expect(formatTime("mañana")).toBe("—");
    expect(formatTime("2026-13-01 10:00:00")).toBe("—");
    expect(formatTime("2026-08-31 25:00:00")).toBe("—");
  });

  it("escribe el meridiano una sola vez cuando los dos extremos coinciden", () => {
    expect(formatTimeRange("2026-08-31 14:00:00", "2026-08-31 15:30:00")).toBe(
      "2 – 3:30 p. m.",
    );
  });

  it("lo escribe dos veces cuando el rango cruza el mediodía", () => {
    expect(formatTimeRange("2026-08-31 11:30:00", "2026-08-31 13:00:00")).toBe(
      "11:30 a. m. – 1 p. m.",
    );
  });
});

describe("formatDateLong", () => {
  it("da el día de la semana correcto sin depender de la zona del proceso", () => {
    // 2026-08-31 fue lunes. Este test tiene que dar lo mismo bajo TZ=UTC y bajo
    // TZ=America/Bogota: si alguien mete un `new Date(string)` acá, en Bogotá
    // la fecha se corre un día y esto lo caza.
    expect(formatDateLong("2026-08-31 09:00:00")).toBe("lunes 31 de agosto");
    expect(formatDateLong("2026-01-01 00:00:00")).toBe("jueves 1 de enero");
    expect(formatDateLong("2026-01-01 00:00:00", true)).toBe(
      "jueves 1 de enero de 2026",
    );
  });

  it("formatDateShort abrevia el mes", () => {
    expect(formatDateShort("2026-08-31 09:00:00")).toBe("31 ago");
    expect(formatDateShort("2026-12-05 09:00:00")).toBe("5 dic");
  });
});

describe("formatDuration", () => {
  it("cubre los tres casos", () => {
    expect(formatDuration(45)).toBe("45 min");
    expect(formatDuration(90)).toBe("1 h 30 min");
    expect(formatDuration(120)).toBe("2 h");
    expect(formatDuration(0)).toBe("0 min");
    expect(formatDuration(-10)).toBe("0 min");
  });
});

describe("formatPhoneCO", () => {
  it("separa un E.164 colombiano", () => {
    expect(formatPhoneCO("+573001234567")).toBe("+57 300 123 4567");
  });

  it("deja pasar lo que no reconoce en vez de romper la ficha", () => {
    expect(formatPhoneCO("+14155550123")).toBe("+14155550123");
    expect(formatPhoneCO("3001234567")).toBe("3001234567");
  });
});

describe("parseWallClock", () => {
  it("acepta los dos separadores de EA", () => {
    expect(parseWallClock("2026-08-31 14:30:00")).toEqual({
      y: 2026,
      m: 8,
      d: 31,
      hh: 14,
      mm: 30,
    });
    expect(parseWallClock("2026-08-31T14:30")).toEqual({
      y: 2026,
      m: 8,
      d: 31,
      hh: 14,
      mm: 30,
    });
  });

  it("rechaza lo que no es una hora de pared", () => {
    expect(parseWallClock("")).toBeNull();
    expect(parseWallClock("2026-08-31")).toBeNull();
    expect(parseWallClock("2026-00-31 10:00:00")).toBeNull();
    expect(parseWallClock("2026-08-31 10:60:00")).toBeNull();
  });
});
