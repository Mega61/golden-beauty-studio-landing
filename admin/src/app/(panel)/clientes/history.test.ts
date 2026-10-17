import { describe, expect, it } from "vitest";

import type { Appointment, EaLocalDateTime } from "@/lib/ea";
import type { LegacyAppointment } from "@/db/types";

import {
  buildUnifiedHistory,
  legacyStartToWallClock,
  type EaHistoryInput,
} from "./history";

function appointment(patch: { id: number; start: string; status: string }): Appointment {
  return {
    id: patch.id,
    bookedAt: null,
    start: patch.start as EaLocalDateTime,
    end: patch.start as EaLocalDateTime,
    hash: null,
    location: null,
    meetingLink: null,
    color: null,
    status: patch.status,
    notes: null,
    customerId: 1,
    providerId: 2,
    serviceId: 3,
    googleCalendarId: null,
    caldavCalendarId: null,
  };
}

function ea(patch: {
  id: number;
  start: string;
  status: string;
  serviceName?: string | null;
  providerName?: string | null;
  amountCharged?: number | null;
}): EaHistoryInput {
  return {
    appointment: appointment(patch),
    serviceName:
      patch.serviceName === undefined ? "Acrílicas esculpidas" : patch.serviceName,
    providerName: patch.providerName === undefined ? "Lina" : patch.providerName,
    amountCharged: patch.amountCharged ?? null,
  };
}

function legacy(patch: {
  id?: number;
  sourceId: string;
  started: Date;
  service?: string;
  provider?: string | null;
  amount?: number | null;
  status?: string | null;
}): LegacyAppointment {
  return {
    id: patch.id ?? 1,
    source_id: patch.sourceId,
    started_at: patch.started,
    ended_at: null,
    client_phone_e164: "+573001234567",
    client_name: "Ana",
    service_name: patch.service ?? "Semipermanente",
    provider_name: patch.provider ?? "Sara",
    amount_charged: patch.amount ?? null,
    status: patch.status ?? null,
    imported_at: new Date(),
  };
}

describe("legacyStartToWallClock", () => {
  it("es la inversa exacta de cómo mysql2 armó el Date, sin pasar por ninguna zona", () => {
    // Construido con el constructor local, que es lo que hace el driver al
    // parsear un DATETIME. Da lo mismo bajo TZ=UTC que bajo TZ=America/Bogota.
    const d = new Date(2026, 7, 31, 14, 5, 9);
    expect(legacyStartToWallClock(d)).toBe("2026-08-31 14:05:09");
  });

  it("rellena con ceros los componentes de un dígito", () => {
    expect(legacyStartToWallClock(new Date(2025, 0, 2, 3, 4, 5))).toBe(
      "2025-01-02 03:04:05",
    );
  });
});

describe("buildUnifiedHistory", () => {
  it("intercala las dos mitades en una sola línea de tiempo, de la más reciente a la más vieja", () => {
    const { entries } = buildUnifiedHistory(
      [
        ea({ id: 20, start: "2026-03-01 10:00:00", status: "Completada" }),
        ea({ id: 21, start: "2026-01-15 10:00:00", status: "Completada" }),
      ],
      [
        legacy({ sourceId: "AP-1", started: new Date(2026, 1, 10, 9, 0, 0) }),
        legacy({ sourceId: "AP-2", started: new Date(2025, 10, 3, 9, 0, 0) }),
      ],
    );

    expect(entries.map((e) => e.id)).toEqual([
      "ea-20",
      "legacy-AP-1",
      "ea-21",
      "legacy-AP-2",
    ]);
  });

  it("desempata por id para que dos citas a la misma hora no bailen entre renders", () => {
    const a = buildUnifiedHistory(
      [
        ea({ id: 2, start: "2026-03-01 10:00:00", status: "Completada" }),
        ea({ id: 1, start: "2026-03-01 10:00:00", status: "Completada" }),
      ],
      [],
    );
    const b = buildUnifiedHistory(
      [
        ea({ id: 1, start: "2026-03-01 10:00:00", status: "Completada" }),
        ea({ id: 2, start: "2026-03-01 10:00:00", status: "Completada" }),
      ],
      [],
    );
    expect(a.entries.map((e) => e.id)).toEqual(b.entries.map((e) => e.id));
  });

  it("solo 'completada' cuenta como visita: una cita futura confirmada no infla el historial", () => {
    const { summary } = buildUnifiedHistory(
      [
        ea({ id: 1, start: "2026-03-01 10:00:00", status: "Completada" }),
        ea({ id: 2, start: "2026-09-01 10:00:00", status: "Confirmada" }),
        ea({ id: 3, start: "2026-02-01 10:00:00", status: "Cancelada" }),
        ea({ id: 4, start: "2026-02-10 10:00:00", status: "No asistió" }),
      ],
      [],
    );

    expect(summary.entries).toBe(4);
    expect(summary.visits).toBe(1);
    expect(summary.cancellations).toBe(1);
    expect(summary.noShows).toBe(1);
    // "1 de 2 citas": la cancelada y la futura no entran.
    expect(summary.noShowRate).toBe(0.5);
  });

  it("una cita con la cuenta cerrada es visita aunque EA siga diciendo Reservada", () => {
    // Hasta el 2026-10-16 cerrar la cuenta no marcaba nada en EA.
    const { entries, summary } = buildUnifiedHistory(
      [
        ea({ id: 1, start: "2026-03-01 10:00:00", status: "Reservada", amountCharged: 90000 }),
        ea({ id: 2, start: "2026-04-01 10:00:00", status: "Confirmada", amountCharged: 0 }),
        ea({ id: 3, start: "2026-05-01 10:00:00", status: "Reservada" }),
      ],
      [],
    );
    expect(summary.visits).toBe(2);
    expect(entries.find((entry) => entry.id === "ea-3")?.outcome).toBe("desconocido");
    expect(summary.noShowRate).toBe(0);
  });

  it("sin ninguna cita marcada, la tasa es null y no 0 %", () => {
    expect(buildUnifiedHistory([], []).summary.noShowRate).toBeNull();
  });

  it("una fila vieja sin estado cuenta como atendida: es historia que ya pasó", () => {
    const { summary } = buildUnifiedHistory(
      [],
      [
        legacy({ sourceId: "AP-1", started: new Date(2024, 4, 1, 9, 0, 0) }),
        legacy({ sourceId: "AP-2", started: new Date(2024, 5, 1, 9, 0, 0), status: "Cancelada" }),
      ],
    );
    expect(summary.visits).toBe(1);
    expect(summary.cancellations).toBe(1);
  });

  it("suma solo lo cobrado en las visitas, y avisa cuando el total está incompleto", () => {
    const { summary } = buildUnifiedHistory(
      [
        ea({ id: 1, start: "2026-03-01 10:00:00", status: "Completada", amountCharged: 120000 }),
        // Cuenta sin cerrar: monto desconocido, no cero.
        ea({ id: 2, start: "2026-04-01 10:00:00", status: "Completada", amountCharged: null }),
        // Una cancelada con monto no debería sumar nunca.
        ea({ id: 3, start: "2026-05-01 10:00:00", status: "Cancelada", amountCharged: 999000 }),
      ],
      [legacy({ sourceId: "AP-1", started: new Date(2025, 0, 5, 9, 0, 0), amount: 80000 })],
    );

    expect(summary.totalSpent).toBe(200000);
    expect(summary.totalIsPartial).toBe(true);
  });

  it("un total completo no se marca como parcial", () => {
    const { summary } = buildUnifiedHistory(
      [ea({ id: 1, start: "2026-03-01 10:00:00", status: "Completada", amountCharged: 120000 })],
      [],
    );
    expect(summary.totalSpent).toBe(120000);
    expect(summary.totalIsPartial).toBe(false);
  });

  it("la primera y la última visita cruzan las dos mitades", () => {
    const { summary } = buildUnifiedHistory(
      [ea({ id: 1, start: "2026-03-01 10:00:00", status: "Completada" })],
      [legacy({ sourceId: "AP-1", started: new Date(2023, 2, 14, 15, 30, 0) })],
    );

    expect(summary.firstVisit).toBe("2023-03-14 15:30:00");
    expect(summary.lastVisit).toBe("2026-03-01 10:00:00");
  });

  it("sin visitas, la primera y la última son null y el total es cero exacto", () => {
    const { summary } = buildUnifiedHistory(
      [ea({ id: 1, start: "2026-03-01 10:00:00", status: "Cancelada" })],
      [],
    );
    expect(summary.visits).toBe(0);
    expect(summary.firstVisit).toBeNull();
    expect(summary.lastVisit).toBeNull();
    expect(summary.totalSpent).toBe(0);
    expect(summary.totalIsPartial).toBe(false);
  });

  it("una historia vacía no rompe nada", () => {
    const { entries, summary } = buildUnifiedHistory([], []);
    expect(entries).toEqual([]);
    expect(summary.entries).toBe(0);
  });

  it("no inventa nombres: sin servicio ni técnica lo dice", () => {
    const { entries } = buildUnifiedHistory(
      [
        ea({
          id: 1,
          start: "2026-03-01 10:00:00",
          status: "Completada",
          serviceName: "   ",
          providerName: null,
        }),
      ],
      [],
    );
    expect(entries[0].serviceName).toBe("Servicio sin nombre");
    expect(entries[0].providerName).toBeNull();
  });

  it("conserva el status crudo de cada mitad, sin traducirlo", () => {
    const { entries } = buildUnifiedHistory(
      [ea({ id: 1, start: "2026-03-01 10:00:00", status: "Booked" })],
      [],
    );
    expect(entries[0].rawStatus).toBe("Booked");
    expect(entries[0].outcome).toBe("desconocido");
  });

  it("le pone a cada cita de Agenda Pro el método con que se pagó, si se sabe", () => {
    const { entries } = buildUnifiedHistory(
      [ea({ id: 9, start: "2026-08-01 10:00:00", status: "Completada" })],
      [
        legacy({ id: 1, sourceId: "AP-1", started: new Date(2026, 6, 1, 10, 0, 0), amount: 50_000 }),
        legacy({ id: 2, sourceId: "AP-2", started: new Date(2026, 6, 2, 10, 0, 0), amount: 90_000 }),
        legacy({ id: 3, sourceId: "AP-3", started: new Date(2026, 6, 3, 10, 0, 0), amount: 40_000 }),
      ],
      [
        { legacyAppointmentId: 1, method: "efectivo", courtesy: false },
        // Pago dividido: los dos métodos, en orden fijo aunque lleguen al revés.
        { legacyAppointmentId: 2, method: "transferencia", courtesy: false },
        { legacyAppointmentId: 2, method: "efectivo", courtesy: false },
        { legacyAppointmentId: 2, method: "transferencia", courtesy: false },
        // Un pago enlazado a una cita que no es de esta clienta no aparece.
        { legacyAppointmentId: 77, method: "otro", courtesy: false },
      ],
    );
    const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry.paymentMethods]));
    expect(byId).toEqual({
      "ea-9": [],
      "legacy-AP-1": ["efectivo"],
      "legacy-AP-2": ["efectivo", "transferencia"],
      // Sin pago enlazado: vacío, que es "no se sabe", no "no pagó".
      "legacy-AP-3": [],
    });
  });

  it("el método no cambia la plata del resumen", () => {
    const rows = [legacy({ id: 1, sourceId: "AP-1", started: new Date(2026, 6, 1, 10, 0, 0), amount: 50_000 })];
    const without = buildUnifiedHistory([], rows);
    const withMethod = buildUnifiedHistory([], rows, [{ legacyAppointmentId: 1, method: "efectivo", courtesy: false }]);
    expect(withMethod.summary).toEqual(without.summary);
  });

  it("una cortesía es visita con la marca, sin medio, y no suma al total gastado", () => {
    const { entries, summary } = buildUnifiedHistory(
      [],
      [
        legacy({ id: 1, sourceId: "AP-1", started: new Date(2026, 6, 1, 10, 0, 0), amount: 50_000 }),
        legacy({ id: 2, sourceId: "AP-2", started: new Date(2026, 6, 2, 10, 0, 0), amount: 90_000 }),
      ],
      [
        { legacyAppointmentId: 1, method: "efectivo", courtesy: false },
        { legacyAppointmentId: 2, method: "transferencia", courtesy: true },
      ],
    );
    const courtesy = entries.find((entry) => entry.id === "legacy-AP-2");
    expect(courtesy).toMatchObject({ courtesy: true, paymentMethods: [], amountCharged: 90_000 });
    expect(summary).toMatchObject({ visits: 2, totalSpent: 50_000, totalIsPartial: false });
  });
});
