import { describe, expect, it } from "vitest";

import type { ComboComposition } from "@/lib/combos";
import { parseEaLocalDateTime } from "@/lib/ea/datetime";
import type { Appointment } from "@/lib/ea/types";

import { planVisitMerges } from "./merge-visits";

const at = (time: string) => parseEaLocalDateTime(`2026-10-29 ${time}:00`);

let nextId = 1;
function cita(start: string, end: string, extra: Partial<Appointment> = {}): Appointment {
  return {
    id: nextId++,
    bookedAt: null,
    start: at(start),
    end: at(end),
    hash: null,
    location: null,
    meetingLink: null,
    color: null,
    status: "Reservada",
    notes: null,
    customerId: 7,
    providerId: 4,
    serviceId: 3,
    googleCalendarId: null,
    caldavCalendarId: null,
    ...extra,
  };
}

// 17 semi manos + 15 semi pies = combo 25.
const COMBOS: ComboComposition[] = [{ eaServiceId: 25, handsEaServiceId: 17, feetEaServiceId: 15 }];

const plan = (appointments: Appointment[], opts: { finance?: number[]; planned?: [number, number[]][] } = {}) =>
  planVisitMerges({
    appointments,
    planned: new Map(opts.planned ?? []),
    withFinance: new Set(opts.finance ?? []),
    combos: COMBOS,
  });

describe("planVisitMerges", () => {
  it("esculpidas + pies en dos citas pegadas → una cita con los pies de adicional", () => {
    const manos = cita("09:00", "11:30", { serviceId: 3 });
    const pies = cita("11:30", "12:45", { serviceId: 15 });
    expect(plan([pies, manos]).merges).toEqual([
      {
        keepId: manos.id,
        removeIds: [pies.id],
        serviceId: 3,
        fromServiceId: 3,
        start: at("09:00"),
        end: at("12:45"),
        extras: [15],
      },
    ]);
  });

  it("un par que es combo se vuelve el combo, con la hora que ya tenía", () => {
    const manos = cita("14:00", "15:00", { serviceId: 17 });
    const pies = cita("15:00", "16:15", { serviceId: 15 });
    const [merge] = plan([manos, pies]).merges;
    expect(merge).toMatchObject({ serviceId: 25, fromServiceId: 17, extras: [], end: at("16:15") });
  });

  it("no toca una visita que ya tiene cuenta", () => {
    const manos = cita("09:00", "11:30");
    const pies = cita("11:30", "12:45", { serviceId: 15 });
    const result = plan([manos, pies], { finance: [pies.id] });
    expect(result.merges).toEqual([]);
    expect(result.skipped).toEqual([{ ids: [manos.id, pies.id], start: at("09:00"), reason: "cuenta-abierta" }]);
  });

  it("no junta una cancelada con una que sigue en pie", () => {
    const manos = cita("09:00", "11:30");
    const pies = cita("11:30", "12:45", { serviceId: 15, status: "Cancelada" });
    expect(plan([manos, pies]).skipped[0]?.reason).toBe("estados-distintos");
  });

  it("deja en paz lo que no es una visita: otra clienta, otra técnica, o un hueco en medio", () => {
    const a = cita("09:00", "10:00");
    const otraClienta = cita("10:00", "11:00", { customerId: 8 });
    const otraTecnica = cita("10:00", "11:00", { providerId: 5 });
    const conHueco = cita("10:15", "11:00");
    expect(plan([a, otraClienta, otraTecnica, conHueco]).merges).toEqual([]);
  });

  it("conserva los adicionales que ya tenía cada parte", () => {
    const manos = cita("09:00", "11:30", { serviceId: 3 });
    const pies = cita("11:30", "12:45", { serviceId: 15 });
    const [merge] = plan([manos, pies], { planned: [[manos.id, [28]], [pies.id, [31]]] }).merges;
    expect(merge.extras).toEqual([28, 15, 31]);
  });
});
