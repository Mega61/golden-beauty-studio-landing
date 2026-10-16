import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";

import {
  TEMPLATE_BODIES,
  cleanParam,
  confirmationParams,
  placeholderCount,
  reminderParams,
  renderTemplate,
  type TemplateAppointment,
} from "./template-params";

const CITA: TemplateAppointment = {
  start: parseEaLocalDateTime("2026-10-16 10:00:00"),
  customerFirstName: "LAURA MARCELA",
  serviceName: "Semipermanente manos",
  providerFirstName: "lina",
};

const SEND_DAY = { today: parseEaLocalDate("2026-10-15"), tomorrow: parseEaLocalDate("2026-10-16") };

describe("confirmationParams", () => {
  it("cuatro parámetros: nombre presentable, servicio, fecha con hora, técnica", () => {
    expect(confirmationParams(CITA)).toEqual([
      "Laura",
      "Semipermanente manos",
      "el viernes 16 de octubre a las 10:00 a. m.",
      "Lina",
    ]);
  });

  it("coincide con la cantidad de variables de la plantilla", () => {
    expect(confirmationParams(CITA)).toHaveLength(placeholderCount(TEMPLATE_BODIES.confirmacion));
  });

  it("la una de la tarde es «a la 1:00 p. m.»", () => {
    expect(confirmationParams({ ...CITA, start: parseEaLocalDateTime("2026-10-16 13:00:00") })[2]).toBe(
      "el viernes 16 de octubre a la 1:00 p. m.",
    );
  });

  it("sin nombre, sin servicio y sin técnica, ningún parámetro queda vacío", () => {
    const params = confirmationParams({
      start: CITA.start,
      customerFirstName: null,
      serviceName: "  ",
      providerFirstName: null,
    });
    expect(params).toEqual([
      "qué tal",
      "belleza",
      "el viernes 16 de octubre a las 10:00 a. m.",
      "nuestro equipo",
    ]);
    for (const p of params) expect(p.trim()).not.toBe("");
  });

  it("el mensaje armado no lleva precio ni género", () => {
    const text = renderTemplate(TEMPLATE_BODIES.confirmacion, confirmationParams(CITA));
    expect(text).not.toMatch(/\$|COP|\d{2,3}\.\d{3}/);
    expect(text).not.toMatch(/\b(querida|querido|bienvenida|bienvenido|linda|hermosa|señora|señor)\b/i);
    expect(text).toContain("Hola Laura, tu cita de Semipermanente manos en Golden Beauty Studio");
    expect(text).toContain("con Lina.");
  });
});

describe("reminderParams", () => {
  it("mañana lleva la fecha", () => {
    expect(reminderParams(CITA, SEND_DAY)[2]).toBe("mañana viernes 16 de octubre a las 10:00 a. m.");
  });

  it("hoy no la necesita", () => {
    expect(reminderParams({ ...CITA, start: parseEaLocalDateTime("2026-10-15 15:30:00") }, SEND_DAY)[2]).toBe(
      "hoy a las 3:30 p. m.",
    );
  });

  it("otro día dice la fecha, nunca un «mañana» falso", () => {
    expect(reminderParams({ ...CITA, start: parseEaLocalDateTime("2026-10-17 09:00:00") }, SEND_DAY)[2]).toBe(
      "el sábado 17 de octubre a las 9:00 a. m.",
    );
  });

  it("coincide con la cantidad de variables de la plantilla", () => {
    expect(reminderParams(CITA, SEND_DAY)).toHaveLength(placeholderCount(TEMPLATE_BODIES.recordatorio));
  });

  it("el recordatorio dice cómo darse de baja", () => {
    expect(TEMPLATE_BODIES.recordatorio).toContain("responde BAJA");
  });
});

describe("cleanParam", () => {
  it("quita saltos de línea, tabs y espacios de más (Meta los rechaza)", () => {
    expect(cleanParam("Uñas\n\tacrílicas    esculpidas", "x")).toBe("Uñas acrílicas esculpidas");
  });

  it("recorta lo muy largo", () => {
    const long = cleanParam("a".repeat(100), "x");
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("las plantillas", () => {
  it("no empiezan ni terminan con una variable, ni tienen dos pegadas (reglas de Meta)", () => {
    for (const body of Object.values(TEMPLATE_BODIES)) {
      expect(body.trimStart().startsWith("{{")).toBe(false);
      expect(body.trimEnd().endsWith("}}")).toBe(false);
      expect(body).not.toMatch(/\}\}\s*\{\{/);
    }
  });
});
