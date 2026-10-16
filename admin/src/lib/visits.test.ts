import { describe, expect, it } from "vitest";

import { continuationIds, groupVisits, visitServiceName, type VisitPart } from "./visits";

const part = (id: number, start: string, end: string, over: Partial<VisitPart> = {}): VisitPart => ({
  id,
  customerId: 7,
  providerId: 4,
  start: `2026-10-16 ${start}:00`,
  end: `2026-10-16 ${end}:00`,
  serviceName: `S${id}`,
  ...over,
});

describe("groupVisits", () => {
  it("dos citas pegadas, misma persona y profesional, son una visita", () => {
    const visits = groupVisits([part(2, "11:00", "12:15"), part(1, "10:00", "11:00")]);
    expect([...visits.keys()]).toEqual([1]);
    expect(visits.get(1)?.map((p) => p.id)).toEqual([1, 2]);
  });

  it("un hueco entre las dos las separa", () => {
    expect(groupVisits([part(1, "10:00", "11:00"), part(2, "11:15", "12:00")]).size).toBe(2);
  });

  it("otra profesional u otra persona las separa", () => {
    expect(groupVisits([part(1, "10:00", "11:00"), part(2, "11:00", "12:00", { providerId: 5 })]).size).toBe(2);
    expect(groupVisits([part(1, "10:00", "11:00"), part(2, "11:00", "12:00", { customerId: 8 })]).size).toBe(2);
  });

  it("sin cliente no se encadena nada", () => {
    expect(
      groupVisits([part(1, "10:00", "11:00", { customerId: null }), part(2, "11:00", "12:00", { customerId: null })])
        .size,
    ).toBe(2);
  });

  it("tres seguidas son una sola visita", () => {
    const parts = [part(1, "09:00", "10:00"), part(2, "10:00", "11:00"), part(3, "11:00", "11:30")];
    expect(continuationIds(parts)).toEqual(new Set([2, 3]));
  });
});

describe("visitServiceName", () => {
  it("une con «y» y salta los vacíos", () => {
    expect(visitServiceName(["Semipermanente manos", "Semipermanente pies"])).toBe(
      "Semipermanente manos y Semipermanente pies",
    );
    expect(visitServiceName(["A", null, "B", "C"])).toBe("A, B y C");
    expect(visitServiceName([null])).toBeNull();
    expect(visitServiceName(["Solo"])).toBe("Solo");
  });
});
