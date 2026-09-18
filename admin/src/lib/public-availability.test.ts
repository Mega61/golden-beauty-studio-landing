import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "./ea/datetime";
import { pickProvider, publicSlots, type ProviderOffer } from "./public-availability";
import type { StationSlot } from "./conflict";
import type { Appointment, BlockedPeriod } from "./ea/types";

const DIA = parseEaLocalDate("2026-03-10");

/** Los dos puestos del estudio. Hoy los dos aceptan cualquier categoría. */
const DOS_PUESTOS: StationSlot[] = [
  { id: 1, name: "Puesto 1", allows: null },
  { id: 2, name: "Puesto 2", allows: null },
];

/** Semipermanente manos: 60 minutos. */
const SERVICIO = { id: 10, attendantsNumber: 1, category: "sencillos", durationMin: 60 };

/** Plan de 9 a 18 sin descansos, para que el plan no sea lo que filtra. */
const PLAN = {
  workingPlan: {
    monday: { start: "09:00", end: "18:00", breaks: [] },
    tuesday: { start: "09:00", end: "18:00", breaks: [] },
    wednesday: { start: "09:00", end: "18:00", breaks: [] },
    thursday: { start: "09:00", end: "18:00", breaks: [] },
    friday: { start: "09:00", end: "18:00", breaks: [] },
    saturday: { start: "09:00", end: "18:00", breaks: [] },
    sunday: { start: "09:00", end: "18:00", breaks: [] },
  },
  workingPlanExceptions: [],
};

const offer = (providerId: number, hours: string[]): ProviderOffer => ({
  providerId,
  hours,
  plan: PLAN,
});

const cita = (
  id: number,
  providerId: number,
  start: string,
  end: string,
  status = "Reservada",
): Appointment => ({
  id,
  bookedAt: null,
  start: parseEaLocalDateTime(`${DIA} ${start}:00`),
  end: parseEaLocalDateTime(`${DIA} ${end}:00`),
  hash: null,
  location: null,
  meetingLink: null,
  color: null,
  status,
  notes: null,
  customerId: null,
  providerId,
  serviceId: 10,
  googleCalendarId: null,
  caldavCalendarId: null,
});

const base = (offers: ProviderOffer[]) => ({
  date: DIA,
  service: SERVICIO,
  offers,
  stations: DOS_PUESTOS,
  services: [SERVICIO],
});

describe('"cualquiera" une los horarios de todas', () => {
  it("junta lo que ofreció cada técnica, ordenado y sin repetidos", () => {
    const slots = publicSlots(base([offer(1, ["10:00", "11:00"]), offer(2, ["11:00", "09:00"])]));

    expect(slots.map((s) => s.time)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("una hora que las dos pueden tomar sale una sola vez, con las dos", () => {
    const slots = publicSlots(base([offer(1, ["11:00"]), offer(2, ["11:00"])]));

    expect(slots).toHaveLength(1);
    expect(slots[0].providerIds).toEqual([1, 2]);
  });

  it("el tramo se calcula con la duración del servicio, no con el paso de EA", () => {
    const [slot] = publicSlots(base([offer(1, ["10:00"])]));

    expect(slot.start).toBe("2026-03-10 10:00:00");
    expect(slot.end).toBe("2026-03-10 11:00:00");
  });

  it("horas con basura o imposibles se ignoran en vez de romper el listado", () => {
    const slots = publicSlots(base([offer(1, ["10:00", "", "25:00", "ayer", "10:70"])]));

    expect(slots.map((s) => s.time)).toEqual(["10:00"]);
  });

  it("`9:5` y `09:05:00` son la misma hora, y no se duplican", () => {
    const slots = publicSlots(base([offer(1, ["09:05"]), offer(2, ["09:05:00"])]));

    expect(slots).toHaveLength(1);
    expect(slots[0].time).toBe("09:05");
  });

  it("una duración imposible no ofrece nada, en vez de ofrecer todo", () => {
    // Un tramo de cero minutos no choca con nada y pasaría siempre.
    const slots = publicSlots({ ...base([offer(1, ["10:00"])]), service: { ...SERVICIO, durationMin: 0 } });

    expect(slots).toEqual([]);
  });
});

/**
 * El cruce que justifica el módulo entero. EA responde por técnica y **no sabe
 * contar puestos**: sin esto la landing vende una silla que no existe.
 */
describe("descuenta las estaciones ocupadas", () => {
  it("con los dos puestos llenos, la hora no se ofrece aunque la técnica esté libre", () => {
    // EA dice que la 3 está libre a las 10 — y es cierto, ella no tiene cita.
    // Pero las otras dos ya están ocupando las dos sillas.
    const slots = publicSlots({
      ...base([offer(3, ["10:00"])]),
      appointments: [cita(1, 1, "10:00", "11:00"), cita(2, 2, "10:00", "11:00")],
    });

    expect(slots).toEqual([]);
  });

  it("con un tercer puesto la misma hora sí se ofrece", () => {
    // El control del test de arriba: lo que esconde la hora es la cuenta de
    // sillas y nada más. Si esto fallara, el caso anterior estaría pasando por
    // el motivo equivocado.
    const slots = publicSlots({
      ...base([offer(3, ["10:00"])]),
      stations: [...DOS_PUESTOS, { id: 3, name: "Puesto 3", allows: null }],
      appointments: [cita(1, 1, "10:00", "11:00"), cita(2, 2, "10:00", "11:00")],
    });

    expect(slots.map((s) => s.time)).toEqual(["10:00"]);
  });

  it("con un solo puesto ocupado sí queda silla, y la hora se ofrece", () => {
    const slots = publicSlots({
      ...base([offer(3, ["10:00"])]),
      appointments: [cita(1, 1, "10:00", "11:00")],
    });

    expect(slots.map((s) => s.time)).toEqual(["10:00"]);
  });

  it("una cancelada libera la silla: para EA sigue ocupando, para el estudio no", () => {
    const slots = publicSlots({
      ...base([offer(3, ["10:00"])]),
      appointments: [
        cita(1, 1, "10:00", "11:00"),
        cita(2, 2, "10:00", "11:00", "Cancelada"),
      ],
    });

    expect(slots.map((s) => s.time)).toEqual(["10:00"]);
  });

  it("el choque se mide sobre el tramo completo, no sobre la hora de inicio", () => {
    // Las 10:30 arrancan con una silla libre, pero el servicio dura hasta las
    // 11:30 y a las 11:00 entran dos citas más.
    const slots = publicSlots({
      ...base([offer(3, ["10:30"])]),
      appointments: [cita(1, 1, "11:00", "12:00"), cita(2, 2, "11:00", "12:00")],
    });

    expect(slots).toEqual([]);
  });

  it("sin puestos no se ofrece nada: un `[]` accidental tiene que verse", () => {
    const slots = publicSlots({ ...base([offer(1, ["10:00"])]), stations: [] });

    expect(slots).toEqual([]);
  });
});

describe("la técnica misma sigue mandando", () => {
  it("no se ofrece una hora donde ella ya tiene clienta", () => {
    const slots = publicSlots({
      ...base([offer(1, ["10:00", "12:00"])]),
      appointments: [cita(1, 1, "10:00", "11:00")],
    });

    expect(slots.map((s) => s.time)).toEqual(["12:00"]);
  });

  it("fuera del plan de trabajo no se ofrece, aunque EA lo haya mandado", () => {
    const slots = publicSlots(base([offer(1, ["08:00", "10:00"])]));

    expect(slots.map((s) => s.time)).toEqual(["10:00"]);
  });
});

/**
 * `ok`, no `!hard`. Un motivo `soft` le sirve a la recepción para decidir con
 * los ojos abiertos; a una clienta que no puede evaluarlo, no.
 */
describe("los motivos soft también esconden la hora", () => {
  it("con el estudio cerrado no se ofrece nada, y eso es solo un soft", () => {
    const cerrado: BlockedPeriod = {
      id: 1,
      name: "Festivo",
      start: parseEaLocalDateTime(`${DIA} 00:00:00`),
      end: parseEaLocalDateTime(`${DIA} 23:59:59`),
      notes: null,
    };

    const slots = publicSlots({ ...base([offer(1, ["10:00"])]), blockedPeriods: [cerrado] });

    expect(slots).toEqual([]);
  });
});

describe("a quién le toca una reserva de «cualquiera»", () => {
  it("la de menos minutos agendados, no la de menos citas", () => {
    // La 1 tiene dos citas cortas (90 min); la 2, una larga (150 min).
    const agenda = [
      cita(1, 1, "09:00", "09:45"),
      cita(2, 1, "10:00", "10:45"),
      cita(3, 2, "09:00", "11:30"),
    ];

    expect(pickProvider([1, 2], agenda)).toBe(1);
  });

  it("una cancelada no cuenta como carga", () => {
    const agenda = [
      cita(1, 1, "09:00", "11:30"),
      cita(2, 2, "09:00", "11:30", "Cancelada"),
    ];

    expect(pickProvider([1, 2], agenda)).toBe(2);
  });

  it("el empate se rompe por id, para que la elección sea determinista", () => {
    expect(pickProvider([2, 1], [])).toBe(1);
  });

  it("las citas de quien no es candidata no la hacen elegible", () => {
    const agenda = [cita(1, 9, "09:00", "18:00")];

    expect(pickProvider([1], agenda)).toBe(1);
  });

  it("sin candidatas devuelve null en vez de inventar una técnica", () => {
    expect(pickProvider([], [])).toBeNull();
  });
});
