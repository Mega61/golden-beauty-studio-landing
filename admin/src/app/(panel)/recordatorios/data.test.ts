import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";
import type { ManualReminderRow } from "@/lib/whatsapp/manual-reminder";

import { deliveryLabelOf, linkFor, nextEaDate, sentLabelOf } from "./data";

const TODAY = parseEaLocalDate("2026-10-15");

function row(overrides: Partial<ManualReminderRow> = {}): ManualReminderRow {
  return {
    appointment: {
      eaAppointmentId: 1,
      start: parseEaLocalDateTime("2026-10-16 10:00:00"),
      status: "Reservada",
      phoneE164: "+573001234567",
      customerFirstName: "Laura",
      customerName: "Laura Gómez",
      serviceName: "Pedicure",
    },
    day: "manana",
    kind: "recordatorio_24h",
    state: "pendiente",
    existing: null,
    ...overrides,
  };
}

describe("nextEaDate", () => {
  it.each([
    ["2026-10-15", "2026-10-16"],
    ["2026-10-31", "2026-11-01"],
    ["2026-12-31", "2027-01-01"],
    ["2028-02-28", "2028-02-29"],
    ["2027-02-28", "2027-03-01"],
  ])("%s → %s", (date, expected) => {
    expect(nextEaDate(parseEaLocalDate(date))).toBe(expected);
  });
});

describe("sentLabelOf", () => {
  it("manual, hoy: quién y a qué hora de Bogotá", () => {
    expect(
      sentLabelOf(
        { channel: "manual", sentAt: new Date("2026-10-15T14:12:00Z"), sentByName: "Lina" },
        TODAY,
      ),
    ).toBe("Recordada por Lina a las 9:12 a. m.");
  });

  it("con fecha cuando no fue hoy", () => {
    expect(
      sentLabelOf(
        { channel: "manual", sentAt: new Date("2026-10-14T21:00:00Z"), sentByName: "Lina" },
        TODAY,
      ),
    ).toBe("Recordada por Lina el 14 oct a las 4 p. m.");
  });

  it("sin nombre (cuenta dada de baja) y automática", () => {
    expect(
      sentLabelOf({ channel: "manual", sentAt: null, sentByName: null }, TODAY),
    ).toBe("Recordada por alguien del equipo");
    expect(
      sentLabelOf(
        { channel: "cloud_api", sentAt: new Date("2026-10-15T14:00:00Z"), sentByName: null },
        TODAY,
      ),
    ).toBe("Recordada automáticamente a las 9 a. m.");
  });
});

describe("linkFor", () => {
  it("pendiente: al número de la ficha, con el texto del día", () => {
    const link = linkFor(row(), null) as string;
    const url = new URL(link);
    expect(url.pathname).toBe("/573001234567");
    expect(url.searchParams.get("text")).toContain("mañana viernes 16 de octubre");
  });

  it("recordada: al número al que se mandó, no al de la ficha de hoy", () => {
    const link = linkFor(row({ state: "recordada" }), "+573110000000") as string;
    expect(new URL(link).pathname).toBe("/573110000000");
  });

  it("sin enlace en los demás estados, aunque haya número", () => {
    for (const state of ["opt-out", "sin-telefono", "estado-no-aplica", "no-enviada"] as const) {
      expect(linkFor(row({ state }), "+573001234567"), state).toBeNull();
    }
  });

  it("sin número no hay enlace", () => {
    expect(linkFor(row({ state: "recordada" }), null)).toBeNull();
  });
});

describe("fallo del envío automático", () => {
  it("tiene enlace de wa.me al número de la ficha, para mandarlo a mano", () => {
    const link = linkFor(row({ state: "fallo-automatico" }), null) as string;
    expect(new URL(link).pathname).toBe("/573001234567");
  });
});

describe("deliveryLabelOf", () => {
  it("dice lo que contó Meta, solo en envíos automáticos", () => {
    expect(deliveryLabelOf({ channel: "cloud_api", status: "entregado" })).toBe("Entregado");
    expect(deliveryLabelOf({ channel: "cloud_api", status: "leido" })).toBe("Leído");
    expect(deliveryLabelOf({ channel: "cloud_api", status: "enviado" })).toMatch(/sin confirmación/);
    expect(deliveryLabelOf({ channel: "manual", status: "enviado" })).toBeNull();
  });
});
