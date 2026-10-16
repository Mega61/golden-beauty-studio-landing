import { describe, expect, it } from "vitest";

import { buildDayGrid, type GridProvider } from "@/lib/calendar-layout";
import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea/datetime";
import type { WorkingPlan } from "@/lib/ea/types";

import {
  buildLegacyAgendaItems,
  isLegacyAgendaId,
  isWritableAgendaTarget,
  LEGACY_LANE_ID,
  legacyAgendaId,
  legacyHistoryIndex,
  legacyLayerForDay,
  legacyMeta,
  type LegacyAgendaRow,
  type LegacyContext,
} from "./legacy";

const at = (value: string) => parseEaLocalDateTime(value);
const DAY = parseEaLocalDate("2026-09-10");

function row(id: number, overrides: Partial<LegacyAgendaRow> = {}): LegacyAgendaRow {
  return {
    id,
    sourceId: `AP-${id}`,
    start: at("2026-09-10 10:00:00"),
    clientName: `Cliente ${id}`,
    phone: `+57300000${String(id).padStart(4, "0")}`,
    serviceName: "Semipermanente manos",
    providerName: "Mariana",
    status: "Asiste",
    ...overrides,
  };
}

const context: LegacyContext = {
  providers: [
    { id: 4, firstName: "Mariana" },
    { id: 5, firstName: "Daniela" },
  ],
  services: [
    { name: "Semipermanente manos", duration: 60 },
    { name: "Esculpidas en acrílico", duration: 150 },
  ],
  ea: [],
  ownProviderId: null,
  dates: [DAY],
};

const plan: WorkingPlan = {
  sunday: null,
  monday: { start: "08:00", end: "18:00", breaks: [] },
  tuesday: { start: "08:00", end: "18:00", breaks: [] },
  wednesday: { start: "08:00", end: "18:00", breaks: [] },
  thursday: { start: "08:00", end: "18:00", breaks: [] },
  friday: { start: "08:00", end: "18:00", breaks: [] },
  saturday: { start: "08:00", end: "18:00", breaks: [] },
};

const gridProviders: GridProvider[] = [
  { id: 4, name: "Mariana Ruiz", workingPlan: plan },
  { id: 5, name: "Daniela Cano", workingPlan: plan },
];

describe("buildLegacyAgendaItems", () => {
  it("ubica cada fila en la profesional actual por nombre de pila, o en el carril", () => {
    const items = buildLegacyAgendaItems(
      [row(1), row(2, { providerName: "Kati" }), row(3, { providerName: "daniela" })],
      context,
    );
    expect(items.map((item) => item.providerId)).toEqual([4, null, 5]);
  });

  it("deriva el fin de la duración del servicio de EA con el mismo nombre, o una hora", () => {
    const [known, unknown] = buildLegacyAgendaItems(
      [
        row(1, { serviceName: "ESCULPIDAS EN ACRILICO" }),
        row(2, { serviceName: "Uñas en gel" }),
      ],
      context,
    );
    expect(known.end).toBe("2026-09-10 12:30:00");
    expect(known.durationDerived).toBe(true);
    expect(unknown.end).toBe("2026-09-10 11:00:00");
    expect(unknown.durationDerived).toBe(false);
  });

  it("descarta lo que ya existe en EA: mismo cliente, misma hora", () => {
    const items = buildLegacyAgendaItems([row(1), row(2, { start: at("2026-09-10 15:00:00") })], {
      ...context,
      ea: [{ start: "2026-09-10 10:00:00", phone: "3000000001", customerName: "Otra forma" }],
    });
    expect(items.map((item) => item.sourceId)).toEqual(["AP-2"]);
  });

  it("descarta lo que cae fuera de los días pedidos", () => {
    const items = buildLegacyAgendaItems(
      [row(1), row(2, { start: at("2026-09-11 10:00:00") })],
      context,
    );
    expect(items).toHaveLength(1);
  });

  it("una técnica ve solo lo suyo, y nunca el carril de historial", () => {
    const items = buildLegacyAgendaItems(
      [row(1), row(2, { providerName: "Kati" }), row(3, { providerName: "Daniela" })],
      { ...context, ownProviderId: 5 },
    );
    expect(items.map((item) => item.sourceId)).toEqual(["AP-3"]);
  });

  it("los ids son negativos y nunca chocan con uno de EA", () => {
    const items = buildLegacyAgendaItems([row(1), row(2)], context);
    expect(items.every((item) => item.id < 0)).toBe(true);
    expect(legacyAgendaId(0)).toBe(-1);
    expect(isLegacyAgendaId(legacyAgendaId(7))).toBe(true);
    expect(isLegacyAgendaId(7)).toBe(false);
  });

  it("lee el estado de Agenda Pro, incluida la reserva", () => {
    const items = buildLegacyAgendaItems(
      [
        row(1, { status: "Asiste" }),
        row(2, { status: "No Asiste" }),
        row(3, { status: "Cancelado" }),
        row(4, { status: "Reservado" }),
      ],
      context,
    );
    expect(items.map((item) => item.kind)).toEqual([
      "atendida",
      "no-asistio",
      "cancelada",
      "reservada",
    ]);
    const index = legacyHistoryIndex(items);
    expect(index[items[0].id]).toEqual({
      source: "Agenda Pro",
      statusLabel: "Atendida",
      statusToken: "completada",
    });
  });
});

describe("legacyLayerForDay + buildDayGrid", () => {
  const items = buildLegacyAgendaItems(
    [row(1), row(2, { providerName: "Kati", start: at("2026-09-10 11:00:00") })],
    context,
  );

  it("agrega el carril solo el día que hay alguien que ya no está", () => {
    const withLane = legacyLayerForDay(items, gridProviders, DAY);
    expect(withLane.providers.map((p) => p.id)).toEqual([4, 5, LEGACY_LANE_ID]);

    const onlyMariana = legacyLayerForDay(items.slice(0, 1), gridProviders, DAY);
    expect(onlyMariana.providers.map((p) => p.id)).toEqual([4, 5]);

    const otherDay = legacyLayerForDay(items, gridProviders, parseEaLocalDate("2026-09-11"));
    expect(otherDay.providers.map((p) => p.id)).toEqual([4, 5]);
    expect(otherDay.appointments).toEqual([]);
  });

  it("la grilla dibuja cada una en su columna, sin huérfanas", () => {
    const layer = legacyLayerForDay(items, gridProviders, DAY);
    const grid = buildDayGrid({
      range: { date: DAY, startMinute: 8 * 60, endMinute: 18 * 60, slotMinutes: 15 },
      providers: layer.providers,
      appointments: layer.appointments,
    });

    expect(grid.orphanAppointments).toEqual([]);
    const byColumn = Object.fromEntries(
      grid.columns.map((column) => [column.providerId, column.events.map((e) => e.appointment.id)]),
    );
    expect(byColumn[4]).toEqual([items[0].id]);
    expect(byColumn[5]).toEqual([]);
    expect(byColumn[LEGACY_LANE_ID]).toEqual([items[1].id]);
    expect(grid.columns.find((c) => c.providerId === LEGACY_LANE_ID)?.providerName).toBe(
      "Historial Agenda Pro",
    );
  });

  it("si la técnica casada no está en la lista visible, cae al carril en vez de quedar huérfana", () => {
    const layer = legacyLayerForDay(items.slice(0, 1), gridProviders.slice(1), DAY);
    expect(layer.providers.map((p) => p.id)).toEqual([5, LEGACY_LANE_ID]);
    expect(layer.appointments[0].providerId).toBe(LEGACY_LANE_ID);
  });

  it("los nombres viajan por la misma forma de metadatos que las citas de EA", () => {
    const meta = legacyMeta(items);
    expect(meta[items[0].id]).toMatchObject({ customer: "Cliente 1", service: "Semipermanente manos" });
  });
});

describe("isWritableAgendaTarget: la red de las Server Actions", () => {
  it("ids y columnas de EA pasan", () => {
    expect(isWritableAgendaTarget(undefined, 4)).toBe(true);
    expect(isWritableAgendaTarget(120, 4)).toBe(true);
  });

  it("un id de historial o el carril de historial no llegan a EA", () => {
    expect(isWritableAgendaTarget(-3, 4)).toBe(false);
    expect(isWritableAgendaTarget(0, 4)).toBe(false);
    expect(isWritableAgendaTarget(1.5, 4)).toBe(false);
    expect(isWritableAgendaTarget(undefined, LEGACY_LANE_ID)).toBe(false);
    expect(isWritableAgendaTarget(120, LEGACY_LANE_ID)).toBe(false);
  });
});
