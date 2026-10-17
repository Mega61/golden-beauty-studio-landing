import { describe, expect, it } from "vitest";

import type { LegacyAppointment } from "@/db/types";
import type { Appointment, EaLocalDateTime } from "@/lib/ea";
import type { SuggestionCatalog } from "@/lib/service-suggestion";

import { buildUnifiedHistory, type EaHistoryInput } from "../clientes/history";
import { buildClientContext } from "./client-context";

const NOW = "2026-10-16 10:00:00" as EaLocalDateTime;

// Servicios de EA de juguete: 10 = esculpidas polygel, 11 = retoque polygel,
// 12 = semipermanente manos, 13 = press on.
const CATALOG: SuggestionCatalog = {
  services: [
    { id: 10, name: "Esculpidas en polygel" },
    { id: 11, name: "Retoque polygel" },
    { id: 12, name: "Semipermanente manos" },
    { id: 13, name: "Press on" },
  ],
  eaIdOfPricing: new Map([
    ["polygel-sculpted", 10],
    ["polygel-refill", 11],
    ["semi-permanent-hands", 12],
    ["press-on", 13],
  ]),
};

function ea(patch: {
  id: number;
  start: string;
  status: string;
  serviceId?: number;
  serviceName?: string;
  performedServiceId?: number | null;
  amountCharged?: number | null;
}): EaHistoryInput {
  const appointment: Appointment = {
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
    serviceId: patch.serviceId ?? 12,
    googleCalendarId: null,
    caldavCalendarId: null,
  };
  return {
    appointment,
    serviceName: patch.serviceName ?? "Semipermanente manos",
    performedServiceId: patch.performedServiceId ?? null,
    providerName: "Mariana",
    amountCharged: patch.amountCharged ?? null,
  };
}

function legacy(patch: { sourceId: string; started: Date; service: string; status?: string | null }): LegacyAppointment {
  return {
    id: 1,
    source_id: patch.sourceId,
    started_at: patch.started,
    client_name: "Ana",
    client_phone_e164: "+573001234567",
    service_name: patch.service,
    provider_name: "Lina",
    status: patch.status ?? null,
    amount_charged: 90000,
  } as LegacyAppointment;
}

function build(eaRows: EaHistoryInput[], legacyRows: LegacyAppointment[] = [], excludeAppointmentId?: number) {
  const history = buildUnifiedHistory(eaRows, legacyRows);
  return buildClientContext(history.entries, {
    asOf: NOW,
    excludeAppointmentId,
    partial: false,
    catalog: CATALOG,
  });
}

describe("buildClientContext", () => {
  it("sin historia: clienta nueva, sin filas, sin sugerencia", () => {
    expect(build([])).toEqual({
      recent: [],
      noShows: 0,
      cancellations: 0,
      isFirstVisit: true,
      suggestion: null,
      partial: false,
      asOf: NOW,
    });
  });

  it("muestra hasta tres citas resueltas, de la más reciente a la más vieja", () => {
    const ctx = build([
      ea({ id: 1, start: "2026-06-01 10:00:00", status: "Completada" }),
      ea({ id: 2, start: "2026-07-01 10:00:00", status: "Completada" }),
      ea({ id: 3, start: "2026-08-01 10:00:00", status: "No asistió" }),
      ea({ id: 4, start: "2026-09-01 10:00:00", status: "Cancelada" }),
    ]);
    expect(ctx.recent.map((r) => [r.id, r.outcome])).toEqual([
      ["ea-4", "cancelada"],
      ["ea-3", "no-asistio"],
      ["ea-2", "atendida"],
    ]);
    expect(ctx.noShows).toBe(1);
    expect(ctx.cancellations).toBe(1);
    expect(ctx.isFirstVisit).toBe(false);
  });

  it("lo futuro y lo pasado sin resolver no es historia", () => {
    const ctx = build([
      ea({ id: 1, start: "2026-10-20 10:00:00", status: "Confirmada" }),
      ea({ id: 2, start: "2026-10-01 10:00:00", status: "Reservada" }),
    ]);
    expect(ctx.recent).toEqual([]);
    expect(ctx.isFirstVisit).toBe(true);
  });

  it("una cita con la cuenta cerrada cuenta como atendida aunque EA no lo diga", () => {
    const ctx = build([ea({ id: 2, start: "2026-10-01 10:00:00", status: "Reservada", amountCharged: 50000 })]);
    expect(ctx.recent).toHaveLength(1);
    expect(ctx.recent[0].outcome).toBe("atendida");
    expect(ctx.isFirstVisit).toBe(false);
  });

  it("solo inasistencias: sigue siendo nueva, y se cuentan", () => {
    const ctx = build([
      ea({ id: 1, start: "2026-09-01 10:00:00", status: "No asistió" }),
      ea({ id: 2, start: "2026-09-08 10:00:00", status: "No asistió" }),
    ]);
    expect(ctx.isFirstVisit).toBe(true);
    expect(ctx.noShows).toBe(2);
    expect(ctx.suggestion).toBeNull();
  });

  it("la cita que se edita no es historia de sí misma", () => {
    const ctx = build(
      [
        ea({ id: 1, start: "2026-09-01 10:00:00", status: "Completada" }),
        ea({ id: 2, start: "2026-10-16 08:00:00", status: "Completada", amountCharged: 50000 }),
      ],
      [],
      2,
    );
    expect(ctx.recent.map((r) => r.id)).toEqual(["ea-1"]);
  });

  it("lo realizado manda sobre lo agendado", () => {
    // Se agendó semipermanente y se hizo un montaje en polygel: toca retoque.
    const ctx = build([
      ea({
        id: 1,
        start: "2026-10-01 10:00:00",
        status: "Completada",
        serviceId: 12,
        serviceName: "Esculpidas en polygel",
        performedServiceId: 10,
        amountCharged: 120000,
      }),
    ]);
    expect(ctx.suggestion).toMatchObject({ serviceId: 11, kind: "retoque" });
  });

  it("la sugerencia sale de la última visita atendida, no de una inasistencia", () => {
    const ctx = build([
      ea({ id: 1, start: "2026-09-01 10:00:00", status: "Completada", serviceId: 10, serviceName: "Esculpidas en polygel" }),
      ea({ id: 2, start: "2026-10-01 10:00:00", status: "No asistió", serviceId: 13, serviceName: "Press on" }),
    ]);
    expect(ctx.suggestion).toMatchObject({ serviceId: 11, label: "Agendar retoque de Polygel" });
  });

  it("une Agenda Pro: una visita vieja la hace no nueva y sugiere por nombre", () => {
    const ctx = build([], [legacy({ sourceId: "AP-1", started: new Date(2026, 4, 3, 15, 0), service: "Polygel esculpido" })]);
    expect(ctx.isFirstVisit).toBe(false);
    expect(ctx.recent[0]).toMatchObject({ serviceName: "Polygel esculpido", providerName: "Lina", outcome: "atendida" });
    expect(ctx.suggestion?.serviceId).toBe(11);
  });

  it("no expone plata", () => {
    const ctx = build([ea({ id: 1, start: "2026-09-01 10:00:00", status: "Completada", amountCharged: 50000 })]);
    expect(JSON.stringify(ctx)).not.toContain("50000");
  });
});
