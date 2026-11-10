import { describe, expect, it } from "vitest";

import { parseEaLocalDateTime } from "@/lib/ea";
import type { BookingAttribution } from "@/lib/booking-attribution";

import type { AppointmentRow, FinanceRow } from "./aggregate";
import { channelReport } from "./channels";

const at = (value: string) => parseEaLocalDateTime(value);

function appt(id: number, customerKey: string | null, status = "Reservada"): AppointmentRow {
  return {
    id,
    start: at("2026-11-10 10:00:00"),
    end: at("2026-11-10 11:00:00"),
    status,
    eaProviderId: 4,
    eaServiceId: 1,
    customerKey,
    googleCalendarId: "x",
  };
}

function attr(partial: Partial<BookingAttribution>): BookingAttribution {
  return {
    source: null,
    medium: null,
    campaign: null,
    content: null,
    referrerHost: null,
    landingPath: null,
    clickId: null,
    ...partial,
  };
}

function closed(id: number, charged: number, houseCourtesy = false): FinanceRow {
  return {
    eaAppointmentId: id,
    eaProviderId: 4,
    secondaryEaProviderId: null,
    startAt: at("2026-11-10 10:00:00"),
    bookedServiceId: 1,
    performedServiceId: 1,
    snapshot: charged,
    snapshotSource: "webhook",
    discount: 0,
    amountCharged: charged,
    tip: 0,
    payments: [],
    varianceReasonCode: null,
    closed: true,
    houseCourtesy,
    items: [],
  };
}

const NUEVA = "+573001110001";
const VIEJA = "+573001110002";

describe("channelReport", () => {
  const report = channelReport({
    appointments: [
      appt(1, NUEVA),
      appt(2, VIEJA),
      appt(3, VIEJA),
      appt(4, NUEVA, "Cancelada"),
      appt(5, VIEJA), // agendada en el panel: sin fila
    ],
    attributions: new Map([
      [1, attr({ source: "instagram", medium: "bio" })],
      [2, attr({ referrerHost: "l.instagram.com" })],
      [3, attr({ source: "google", medium: "maps" })],
      [4, attr({ source: "instagram" })],
    ]),
    finance: [closed(1, 90_000), closed(2, 60_000), closed(3, 0, true)],
    newCustomers: new Set([NUEVA]),
  });

  it("agrupa por canal, de más a menos reservas", () => {
    expect(report.rows.map((row) => [row.channel, row.bookings])).toEqual([
      ["instagram", 2],
      ["google-maps", 1],
    ]);
  });

  it("no cuenta canceladas, y lo que no tiene fila va aparte", () => {
    expect(report.webBookings).toBe(3);
    expect(report.withoutOrigin).toBe(1);
  });

  it("primeras visitas y plata cobrada (una cortesía no es plata)", () => {
    const instagram = report.rows.find((row) => row.channel === "instagram");
    expect(instagram).toMatchObject({ firstVisits: 1, paid: 150_000 });
    expect(report.rows.find((row) => row.channel === "google-maps")?.paid).toBe(0);
  });
});
