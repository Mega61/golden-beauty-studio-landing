import { describe, expect, it } from "vitest";

import type { GridProvider } from "@/lib/calendar-layout";
import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea/datetime";
import type { Appointment } from "@/lib/ea/types";

import { buildAgendaList } from "./agenda-list";

const d = (value: string) => parseEaLocalDate(value);

let nextId = 1;
function appointment(start: string, end: string, extra: Partial<Appointment> = {}): Appointment {
  return {
    id: nextId++,
    bookedAt: null,
    start: parseEaLocalDateTime(start),
    end: parseEaLocalDateTime(end),
    hash: null,
    location: null,
    meetingLink: null,
    color: null,
    status: "Reservada",
    notes: null,
    customerId: null,
    providerId: 1,
    serviceId: 10,
    googleCalendarId: null,
    caldavCalendarId: null,
    ...extra,
  };
}

const PROVIDERS: GridProvider[] = [
  { id: 1, name: "Lina", workingPlan: null },
  { id: 2, name: "Daniela", workingPlan: null },
];

describe("buildAgendaList", () => {
  it("un bloque por día pedido, en orden, aunque esté vacío", () => {
    const days = buildAgendaList([d("2026-10-24"), d("2026-10-25")], new Map());
    expect(days).toEqual([
      { date: "2026-10-24", rows: [] },
      { date: "2026-10-25", rows: [] },
    ]);
  });

  it("ordena por hora y, a la misma hora, por columna de la grilla", () => {
    const tarde = appointment("2026-10-24 15:00:00", "2026-10-24 16:00:00", { providerId: 1 });
    const daniela = appointment("2026-10-24 09:00:00", "2026-10-24 10:00:00", { providerId: 2 });
    const lina = appointment("2026-10-24 09:00:00", "2026-10-24 10:30:00", { providerId: 1 });

    const [day] = buildAgendaList(
      [d("2026-10-24")],
      new Map([[d("2026-10-24"), { providers: PROVIDERS, appointments: [tarde, daniela, lina] }]]),
    );

    expect(day.rows.map((r) => [r.appointment.id, r.providerName])).toEqual([
      [lina.id, "Lina"],
      [daniela.id, "Daniela"],
      [tarde.id, "Lina"],
    ]);
  });

  it("una cita va en el día en que empieza, no en el siguiente", () => {
    // El rango que se le pide a EA trae un día de más a cada lado.
    const ayer = appointment("2026-10-23 18:00:00", "2026-10-23 19:00:00");
    const hoy = appointment("2026-10-24 10:00:00", "2026-10-24 11:00:00");

    const [day] = buildAgendaList(
      [d("2026-10-24")],
      new Map([[d("2026-10-24"), { providers: PROVIDERS, appointments: [ayer, hoy] }]]),
    );
    expect(day.rows.map((r) => r.appointment.id)).toEqual([hoy.id]);
  });

  it("una cita sin profesional sale igual, rotulada", () => {
    const huerfana = appointment("2026-10-24 10:00:00", "2026-10-24 11:00:00", { providerId: 99 });
    const [day] = buildAgendaList(
      [d("2026-10-24")],
      new Map([[d("2026-10-24"), { providers: PROVIDERS, appointments: [huerfana] }]]),
    );
    expect(day.rows).toEqual([{ appointment: huerfana, providerName: "Sin profesional" }]);
  });
});
