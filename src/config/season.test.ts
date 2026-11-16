import { describe, expect, it } from "vitest";
import { adventFor, parseSeasonOverride, seasonFor } from "./season";

/** Un instante a la hora de Bogotá (UTC−5) dada. */
const bogota = (iso: string) => new Date(`${iso}-05:00`);

describe("seasonFor — ventana por fecha", () => {
  it("está apagada antes del 16 de noviembre", () => {
    expect(seasonFor(bogota("2026-11-15T23:59:59"))).toBeNull();
  });

  it("se prende a la medianoche del 16 de noviembre en Bogotá, no en UTC", () => {
    expect(seasonFor(new Date("2026-11-16T03:00:00Z"))).toBeNull();
    expect(seasonFor(bogota("2026-11-16T00:00:00"))).toBe("navidad");
    expect(seasonFor(bogota("2026-11-30T23:59:59"))).toBe("navidad");
  });

  it("la banda del adviento no sale en noviembre aunque ya haya adornos", () => {
    expect(seasonFor(bogota("2026-11-20T12:00:00"))).toBe("navidad");
    expect(adventFor(bogota("2026-11-20T12:00:00"))).toBe(false);
  });

  it("sigue el 31 de diciembre y en Reyes", () => {
    expect(seasonFor(bogota("2026-12-31T23:00:00"))).toBe("navidad");
    expect(seasonFor(bogota("2027-01-06T23:59:59"))).toBe("navidad");
  });

  it("se apaga el 7 de enero", () => {
    expect(seasonFor(bogota("2027-01-07T00:00:00"))).toBeNull();
  });
});

describe("seasonFor — NEXT_PUBLIC_SEASON", () => {
  it("navidad la fuerza fuera de fecha", () => {
    expect(seasonFor(bogota("2026-07-15T12:00:00"), "navidad")).toBe("navidad");
  });

  it("off la apaga en plena temporada", () => {
    expect(seasonFor(bogota("2026-12-20T12:00:00"), "off")).toBeNull();
  });

  it("un valor desconocido o vacío deja mandar al calendario", () => {
    expect(seasonFor(bogota("2026-12-20T12:00:00"), "halloween")).toBe("navidad");
    expect(seasonFor(bogota("2026-07-15T12:00:00"), "  ")).toBeNull();
  });
});

describe("parseSeasonOverride", () => {
  it("tolera mayúsculas y espacios", () => {
    expect(parseSeasonOverride(" Navidad ")).toBe("navidad");
    expect(parseSeasonOverride("OFF")).toBe("off");
    expect(parseSeasonOverride("false")).toBe("off");
    expect(parseSeasonOverride(undefined)).toBeNull();
  });
});

describe("adventFor", () => {
  it("anuncia el calendario del 1 al 24 de diciembre", () => {
    expect(adventFor(bogota("2026-11-30T23:59:00"))).toBe(false);
    expect(adventFor(bogota("2026-12-01T00:00:00"))).toBe(true);
    expect(adventFor(bogota("2026-12-24T23:59:00"))).toBe(true);
  });

  it("se calla después de la última puerta, aunque siga la temporada", () => {
    expect(adventFor(bogota("2026-12-25T00:00:00"))).toBe(false);
    expect(seasonFor(bogota("2026-12-25T00:00:00"))).toBe("navidad");
  });

  it("obedece el override", () => {
    expect(adventFor(bogota("2026-07-15T12:00:00"), "navidad")).toBe(true);
    expect(adventFor(bogota("2026-12-10T12:00:00"), "off")).toBe(false);
  });
});
