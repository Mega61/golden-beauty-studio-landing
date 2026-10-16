import { describe, expect, it } from "vitest";

import {
  firstNameKey,
  isShadowedByEa,
  LEGACY_DEFAULT_MINUTES,
  legacyDurationMinutes,
  legacyReportKind,
  legacyStatusKind,
  matchLegacyProvider,
  normalizeName,
  phoneKey,
} from "./legacy-history";

describe("normalizeName / firstNameKey", () => {
  it("quita tildes, mayúsculas y espacios de más", () => {
    expect(normalizeName("  Uñas   ACRÍLICAS ")).toBe("unas acrilicas");
    expect(normalizeName(null)).toBe("");
  });

  it("el nombre de pila es la primera palabra normalizada", () => {
    expect(firstNameKey("María José Gómez")).toBe("maria");
    expect(firstNameKey("   ")).toBeNull();
    expect(firstNameKey(undefined)).toBeNull();
  });
});

describe("matchLegacyProvider", () => {
  const providers = [
    { id: 4, firstName: "Mariana" },
    { id: 5, firstName: "Daniela" },
  ];

  it("casa por nombre de pila, sin importar tildes ni mayúsculas", () => {
    expect(matchLegacyProvider("Mariana", providers)).toBe(4);
    expect(matchLegacyProvider("MARIANA", providers)).toBe(4);
    expect(matchLegacyProvider("Mariana Ruiz", providers)).toBe(4);
    expect(matchLegacyProvider("Danièla", providers)).toBe(5);
  });

  it("quien ya no está en EA (Kati) no casa con nadie", () => {
    expect(matchLegacyProvider("Kati", providers)).toBeNull();
  });

  it("sin nombre no casa", () => {
    expect(matchLegacyProvider(null, providers)).toBeNull();
    expect(matchLegacyProvider("", providers)).toBeNull();
  });

  it("dos profesionales con el mismo nombre de pila: no se adivina", () => {
    const twins = [...providers, { id: 9, firstName: "mariana" }];
    expect(matchLegacyProvider("Mariana", twins)).toBeNull();
  });
});

describe("legacyDurationMinutes", () => {
  const services = [
    { name: "Esculpidas en acrílico", duration: 150 },
    { name: "Semipermanente manos", duration: 60 },
    { name: "Sin duración", duration: null },
    { name: "Cero", duration: 0 },
  ];

  it("toma la duración del servicio de EA con el mismo nombre (sin tildes ni mayúsculas)", () => {
    expect(legacyDurationMinutes("esculpidas en ACRILICO", services)).toEqual({
      minutes: 150,
      derived: true,
    });
    expect(legacyDurationMinutes("Semipermanente  manos", services)).toEqual({
      minutes: 60,
      derived: true,
    });
  });

  it("sin servicio que case, una hora y marcado como supuesto", () => {
    expect(legacyDurationMinutes("Uñas en gel", services)).toEqual({
      minutes: LEGACY_DEFAULT_MINUTES,
      derived: false,
    });
    expect(LEGACY_DEFAULT_MINUTES).toBe(60);
  });

  it("un servicio sin duración o en cero no sirve para derivar", () => {
    expect(legacyDurationMinutes("Sin duración", services).derived).toBe(false);
    expect(legacyDurationMinutes("Cero", services).minutes).toBe(60);
    expect(legacyDurationMinutes("", services).minutes).toBe(60);
  });
});

describe("isShadowedByEa", () => {
  const ea = [
    { start: "2026-10-16 10:00:00", phone: "+573001112233", customerName: "Ana Mesa" },
    { start: "2026-10-17 15:00:00", phone: null, customerName: "Paula Arenas" },
  ];

  it("misma hora y mismo teléfono (con o sin +57) = ya está en EA", () => {
    expect(
      isShadowedByEa({ start: "2026-10-16 10:00:00", phone: "300 111 2233", clientName: "Ana" }, ea),
    ).toBe(true);
  });

  it("mismo teléfono a otra hora es otra cita", () => {
    expect(
      isShadowedByEa({ start: "2026-10-16 11:00:00", phone: "+573001112233", clientName: "Ana" }, ea),
    ).toBe(false);
  });

  it("misma hora, otra persona, no se descarta", () => {
    expect(
      isShadowedByEa({ start: "2026-10-16 10:00:00", phone: "+573009999999", clientName: "Ana Mesa" }, ea),
    ).toBe(false);
  });

  it("sin teléfono en un lado, decide el nombre normalizado", () => {
    expect(
      isShadowedByEa({ start: "2026-10-17 15:00:00", phone: "+573001112299", clientName: "paula ARENAS" }, ea),
    ).toBe(true);
    expect(
      isShadowedByEa({ start: "2026-10-17 15:00:00", phone: null, clientName: null }, ea),
    ).toBe(false);
  });

  it("los segundos no cuentan: el minuto sí", () => {
    expect(
      isShadowedByEa({ start: "2026-10-16 10:00:30", phone: "3001112233", clientName: null }, ea),
    ).toBe(true);
  });

  it("phoneKey: los últimos diez dígitos, o nada si es basura", () => {
    expect(phoneKey("+57 300-111-2233")).toBe("3001112233");
    expect(phoneKey("123")).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });
});

describe("estado de Agenda Pro", () => {
  it("legacyStatusKind: atendida por exclusión", () => {
    expect(legacyStatusKind("Asiste")).toBe("atendida");
    expect(legacyStatusKind("Cancelado")).toBe("cancelada");
    expect(legacyStatusKind("No Asiste")).toBe("no-asistio");
    expect(legacyStatusKind(null)).toBe("atendida");
  });

  it("legacyReportKind: lo reservado todavía no pasó", () => {
    expect(legacyReportKind("Reservado")).toBe("reservada");
    expect(legacyReportKind("Confirmado")).toBe("reservada");
    expect(legacyReportKind("Asiste")).toBe("atendida");
    expect(legacyReportKind("No Asiste")).toBe("no-asistio");
    expect(legacyReportKind("Cancelado")).toBe("cancelada");
    expect(legacyReportKind(null)).toBe("atendida");
  });
});
