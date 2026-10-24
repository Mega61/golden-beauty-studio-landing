import { describe, expect, it } from "vitest";

import { eaLocalToInstant, parseEaLocalDateTime } from "@/lib/ea";

import {
  confirmationStateOf,
  planManualConfirmations,
  type ConfirmationAppointment,
} from "./manual-confirmation";
import type { ExistingReminder } from "./manual-reminder";

const wall = (value: string) => parseEaLocalDateTime(value);
// Sábado 24 de octubre de 2026, 3:00 p. m. en Bogotá.
const NOW = eaLocalToInstant(wall("2026-10-24 15:00:00"));

let nextId = 100;
function cita(overrides: Partial<ConfirmationAppointment> = {}): ConfirmationAppointment {
  return {
    eaAppointmentId: nextId++,
    start: wall("2026-10-29 10:00:00"),
    end: wall("2026-10-29 11:00:00"),
    bookedAt: wall("2026-10-24 14:00:00"),
    status: "Reservada",
    phoneE164: "+573001234567",
    customerFirstName: "Laura",
    customerName: "Laura Gómez",
    serviceName: "Semipermanente manos",
    customerId: 7,
    providerId: 4,
    ...overrides,
  };
}

function enviada(id: number, extra: Partial<ExistingReminder> = {}): ExistingReminder {
  return {
    eaAppointmentId: id,
    kind: "confirmacion",
    status: "enviado",
    channel: "manual",
    sentAt: NOW,
    sentByName: "Recepción",
    ...extra,
  };
}

const plan = (appointments: ConfirmationAppointment[], existing: ExistingReminder[] = []) =>
  planManualConfirmations({ appointments, existing, optedOut: new Set(), now: NOW });

describe("planManualConfirmations", () => {
  it("una reserva nueva sin confirmar queda pendiente", () => {
    const a = cita();
    expect(plan([a]).map((r) => [r.appointment.eaAppointmentId, r.state])).toEqual([
      [a.eaAppointmentId, "pendiente"],
    ]);
  });

  it("la más reciente arriba", () => {
    const vieja = cita({ bookedAt: wall("2026-10-20 09:00:00") });
    const nueva = cita({ bookedAt: wall("2026-10-24 14:30:00") });
    expect(plan([vieja, nueva]).map((r) => r.appointment.eaAppointmentId)).toEqual([
      nueva.eaAppointmentId,
      vieja.eaAppointmentId,
    ]);
  });

  it("deja fuera las reservas de hace más de una semana y las citas que ya empezaron", () => {
    const antigua = cita({ bookedAt: wall("2026-10-10 09:00:00") });
    const yaPaso = cita({ start: wall("2026-10-24 09:00:00"), end: wall("2026-10-24 10:00:00") });
    expect(plan([antigua, yaPaso])).toEqual([]);
  });

  it("manos + pies sin combo: una fila, con los dos servicios", () => {
    // La convención de `lib/visits.ts`: misma persona, misma profesional, fin == inicio.
    const manos = cita({
      start: wall("2026-10-29 09:00:00"),
      end: wall("2026-10-29 11:30:00"),
      serviceName: "Esculpidas en acrílico",
    });
    const pies = cita({
      start: wall("2026-10-29 11:30:00"),
      end: wall("2026-10-29 12:45:00"),
      serviceName: "Semipermanente pies",
    });
    const rows = plan([pies, manos]);
    expect(rows).toHaveLength(1);
    expect(rows[0].appointment.eaAppointmentId).toBe(manos.eaAppointmentId);
    expect(rows[0].serviceName).toBe("Esculpidas en acrílico y Semipermanente pies");
    expect(rows[0].partIds).toEqual([manos.eaAppointmentId, pies.eaAppointmentId]);
  });

  it("lo que ya salió, por cualquiera de los dos canales, queda confirmado", () => {
    const manual = cita();
    const auto = cita();
    const rows = plan([manual, auto], [
      enviada(manual.eaAppointmentId),
      enviada(auto.eaAppointmentId, { channel: "cloud_api", status: "entregado", sentByName: null }),
    ]);
    expect(rows.map((r) => r.state)).toEqual(["confirmada", "confirmada"]);
  });

  it("un recordatorio no cuenta como confirmación", () => {
    const a = cita();
    const [row] = plan([a], [enviada(a.eaAppointmentId, { kind: "recordatorio_24h" })]);
    expect(row.state).toBe("pendiente");
  });
});

describe("confirmationStateOf", () => {
  const base = { status: "Reservada", phoneE164: "+573001234567", existing: null, optedOut: new Set<string>() };

  it("las mismas preguntas que el envío automático", () => {
    expect(confirmationStateOf(base)).toBe("pendiente");
    expect(confirmationStateOf({ ...base, status: "Cancelada" })).toBe("estado-no-aplica");
    expect(confirmationStateOf({ ...base, phoneE164: null })).toBe("sin-telefono");
    expect(confirmationStateOf({ ...base, optedOut: new Set(["+573001234567"]) })).toBe("opt-out");
  });

  it("un fallo del automático se puede mandar a mano", () => {
    expect(
      confirmationStateOf({ ...base, existing: { channel: "cloud_api", status: "fallido" } }),
    ).toBe("fallo-automatico");
  });

  it("lo que ya salió manda sobre la baja posterior", () => {
    expect(
      confirmationStateOf({
        ...base,
        existing: { channel: "manual", status: "enviado" },
        optedOut: new Set(["+573001234567"]),
      }),
    ).toBe("confirmada");
  });
});
