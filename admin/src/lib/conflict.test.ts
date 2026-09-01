import { describe, expect, it } from "vitest";

import {
  checkConflicts,
  DEFAULT_FREE_STATUSES,
  normalizeStatus,
  overlaps,
  seatCount,
  type ConflictInput,
  type ConflictReason,
  type ServiceCapacity,
  type StationSlot,
} from "./conflict";
import { parseEaLocalDate, parseEaLocalDateTime } from "./ea/datetime";
import type {
  Appointment,
  BlockedPeriod,
  Unavailability,
  WorkingPlan,
  WorkingPlanException,
} from "./ea/types";

const dt = parseEaLocalDateTime;
const d = parseEaLocalDate;

/** `2026-08-31` es lunes. Todo el archivo trabaja ese día. */
const MONDAY = d("2026-08-31");

let nextId = 1;

function appointment(
  start: string,
  end: string,
  extra: Partial<Appointment> = {},
): Appointment {
  return {
    id: nextId++,
    bookedAt: null,
    start: dt(start),
    end: dt(end),
    hash: null,
    location: null,
    meetingLink: null,
    color: null,
    status: "Booked",
    notes: null,
    customerId: null,
    providerId: 1,
    serviceId: 10,
    googleCalendarId: null,
    caldavCalendarId: null,
    ...extra,
  };
}

function unavailability(
  start: string,
  end: string,
  extra: Partial<Unavailability> = {},
): Unavailability {
  return {
    id: nextId++,
    bookedAt: null,
    start: dt(start),
    end: dt(end),
    hash: null,
    location: null,
    notes: null,
    providerId: 1,
    googleCalendarId: null,
    caldavCalendarId: null,
    ...extra,
  };
}

function blockedPeriod(start: string, end: string, name: string | null = null): BlockedPeriod {
  return { id: nextId++, name, start: dt(start), end: dt(end), notes: null };
}

const NINE_TO_SIX = { start: "09:00", end: "18:00", breaks: [] };

function plan(overrides: Partial<WorkingPlan> = {}): WorkingPlan {
  return {
    sunday: null,
    monday: NINE_TO_SIX,
    tuesday: NINE_TO_SIX,
    wednesday: NINE_TO_SIX,
    thursday: NINE_TO_SIX,
    friday: NINE_TO_SIX,
    saturday: NINE_TO_SIX,
    ...overrides,
  };
}

/** Los dos puestos de la siembra de la migración `012`: intercambiables. */
const TWO_OPEN_STATIONS: StationSlot[] = [
  { id: 1, name: "Puesto 1", allows: null },
  { id: 2, name: "Puesto 2", allows: null },
];

function check(input: Partial<ConflictInput> = {}) {
  return checkConflicts({
    candidate: {
      providerId: 1,
      serviceId: 10,
      start: dt("2026-08-31 10:00:00"),
      end: dt("2026-08-31 11:00:00"),
    },
    ...input,
  });
}

const reasons = (report: { conflicts: readonly { reason: ConflictReason }[] }) =>
  report.conflicts.map((c) => c.reason);

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

describe("overlaps", () => {
  const span = (a: string, b: string) => ({ start: dt(a), end: dt(b) });

  it("solape estricto: tocar el borde NO es solape", () => {
    const first = span("2026-08-31 10:00:00", "2026-08-31 11:00:00");
    expect(overlaps(first, span("2026-08-31 11:00:00", "2026-08-31 12:00:00"))).toBe(false);
    expect(overlaps(first, span("2026-08-31 09:00:00", "2026-08-31 10:00:00"))).toBe(false);
  });

  it("un minuto de encimada ya es solape, por los dos lados", () => {
    const first = span("2026-08-31 10:00:00", "2026-08-31 11:00:00");
    expect(overlaps(first, span("2026-08-31 10:59:00", "2026-08-31 12:00:00"))).toBe(true);
    expect(overlaps(first, span("2026-08-31 09:00:00", "2026-08-31 10:01:00"))).toBe(true);
  });

  it("contenida y contenedora también se solapan", () => {
    const first = span("2026-08-31 10:00:00", "2026-08-31 11:00:00");
    expect(overlaps(first, span("2026-08-31 10:15:00", "2026-08-31 10:30:00"))).toBe(true);
    expect(overlaps(first, span("2026-08-31 08:00:00", "2026-08-31 20:00:00"))).toBe(true);
  });

  it("es simétrico y cruza la medianoche sin ayuda", () => {
    const night = span("2026-08-31 23:00:00", "2026-09-01 01:00:00");
    const dawn = span("2026-09-01 00:30:00", "2026-09-01 02:00:00");
    expect(overlaps(night, dawn)).toBe(true);
    expect(overlaps(dawn, night)).toBe(true);
  });
});

describe("normalizeStatus", () => {
  it("mete tildes, mayúsculas y separadores en el mismo lugar", () => {
    expect(normalizeStatus("No asistió")).toBe("no-asistio");
    expect(normalizeStatus("NO ASISTIO")).toBe("no-asistio");
    expect(normalizeStatus("no_asistio")).toBe("no-asistio");
    expect(normalizeStatus("  Cancelled ")).toBe("cancelled");
  });

  it("null y vacío dan cadena vacía, no revientan", () => {
    expect(normalizeStatus(null)).toBe("");
    expect(normalizeStatus(undefined)).toBe("");
    expect(normalizeStatus("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Emparejamiento de puestos
// ---------------------------------------------------------------------------

describe("seatCount", () => {
  it("con puestos abiertos sienta hasta agotar", () => {
    expect(seatCount([null, null], TWO_OPEN_STATIONS)).toBe(2);
    expect(seatCount([null, null, null], TWO_OPEN_STATIONS)).toBe(2);
    expect(seatCount([], TWO_OPEN_STATIONS)).toBe(0);
  });

  it("sin puestos no se sienta nadie", () => {
    expect(seatCount([null], [])).toBe(0);
  });

  it("con puestos especializados contar no alcanza — hay que emparejar", () => {
    // Dos citas de pies y un solo puesto de pies: son "dos citas, dos puestos"
    // y sin embargo una se queda parada.
    const specialized: StationSlot[] = [
      { id: 1, name: "Manos", allows: ["manos"] },
      { id: 2, name: "Pies", allows: ["pies"] },
    ];
    expect(seatCount(["pies", "pies"], specialized)).toBe(1);
    expect(seatCount(["manos", "pies"], specialized)).toBe(2);
    expect(seatCount(["manos", "manos"], specialized)).toBe(1);
  });

  it("reasigna por camino de aumento cuando la avara se equivocaría", () => {
    // La primera cita acepta los dos puestos y la segunda solo el de pies. Una
    // heurística avara sentaría a la primera en "Pies" y dejaría a la segunda
    // afuera; el camino de aumento la corre a "Manos" y entran las dos.
    const stations: StationSlot[] = [
      { id: 1, name: "Manos", allows: ["manos"] },
      { id: 2, name: "Pies", allows: ["pies"] },
    ];
    expect(seatCount([null, "pies"], stations)).toBe(2);
  });

  it("una categoría desconocida entra en cualquier puesto — la lectura permisiva", () => {
    const stations: StationSlot[] = [{ id: 1, name: "Pies", allows: ["pies"] }];
    expect(seatCount([null], stations)).toBe(1);
    expect(seatCount(["manos"], stations)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Ventana del candidato
// ---------------------------------------------------------------------------

describe("checkConflicts · el candidato tiene que ser posible", () => {
  it("duración cero es choque duro y corta la evaluación", () => {
    const report = check({
      candidate: {
        providerId: 1,
        serviceId: 10,
        start: dt("2026-08-31 10:00:00"),
        end: dt("2026-08-31 10:00:00"),
      },
      appointments: [appointment("2026-08-31 09:00:00", "2026-08-31 12:00:00")],
      stations: TWO_OPEN_STATIONS,
    });

    // Un solo motivo: seguir evaluando con un intervalo vacío daría "no hay
    // choques" — la peor respuesta posible frente a un dato corrupto.
    expect(reasons(report)).toEqual(["invalid-window"]);
    expect(report.hard).toBe(true);
    expect(report.conflicts[0].message).toContain("cero minutos");
  });

  it("fin antes del inicio también, con su propio mensaje", () => {
    const report = check({
      candidate: {
        providerId: 1,
        serviceId: 10,
        start: dt("2026-08-31 11:00:00"),
        end: dt("2026-08-31 10:00:00"),
      },
    });
    expect(reasons(report)).toEqual(["invalid-window"]);
    expect(report.conflicts[0].message).toContain("antes de empezar");
  });

  it("una agenda vacía no tiene choques", () => {
    const report = check({ provider: { workingPlan: plan() }, stations: TWO_OPEN_STATIONS });
    expect(report.ok).toBe(true);
    expect(report.hard).toBe(false);
    expect(report.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1. Profesional ocupada
// ---------------------------------------------------------------------------

describe("checkConflicts · profesional ocupada", () => {
  it("una técnica atiende a una clienta a la vez: el solape es choque DURO", () => {
    const otra = appointment("2026-08-31 10:30:00", "2026-08-31 11:30:00");
    const report = check({ appointments: [otra] });

    expect(reasons(report)).toEqual(["provider-busy"]);
    expect(report.hard).toBe(true);
    expect(report.conflicts[0].severity).toBe("hard");
    expect(report.conflicts[0].with).toEqual([
      {
        kind: "appointment",
        id: otra.id,
        providerId: 1,
        serviceId: 10,
        status: "Booked",
        start: dt("2026-08-31 10:30:00"),
        end: dt("2026-08-31 11:30:00"),
      },
    ]);
  });

  it("dice CON QUÉ choca, no un booleano", () => {
    const report = check({
      appointments: [
        appointment("2026-08-31 10:15:00", "2026-08-31 10:30:00"),
        appointment("2026-08-31 10:30:00", "2026-08-31 10:45:00"),
      ],
    });
    expect(report.conflicts[0].with).toHaveLength(2);
    expect(report.conflicts[0].message).toContain("2 citas");
    expect(report.conflicts[0].window).toEqual({
      start: dt("2026-08-31 10:00:00"),
      end: dt("2026-08-31 11:00:00"),
    });
  });

  it("una cita que termina justo cuando empieza otra NO choca", () => {
    const report = check({
      appointments: [
        appointment("2026-08-31 09:00:00", "2026-08-31 10:00:00"),
        appointment("2026-08-31 11:00:00", "2026-08-31 12:00:00"),
      ],
    });
    expect(report.ok).toBe(true);
  });

  it("la cita de otra técnica no ocupa esta columna", () => {
    const report = check({
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", { providerId: 2 })],
    });
    expect(reasons(report)).toEqual([]);
  });

  it("mover una cita no la hace chocar contra sí misma", () => {
    const cita = appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00");

    const sinId = check({ appointments: [cita] });
    expect(reasons(sinId)).toEqual(["provider-busy"]);

    const conId = check({
      candidate: {
        id: cita.id,
        providerId: 1,
        serviceId: 10,
        start: dt("2026-08-31 10:05:00"),
        end: dt("2026-08-31 11:05:00"),
      },
      appointments: [cita],
    });
    expect(conId.ok).toBe(true);
  });

  it("una cita cancelada libera la silla — EA no hace esto y nosotros sí", () => {
    for (const status of ["Cancelled", "cancelada", "No asistió", "NO-SHOW"]) {
      const report = check({
        appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", { status })],
      });
      expect(reasons(report), status).toEqual([]);
    }
  });

  it("la lista de estados que liberan es parámetro", () => {
    const report = check({
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", { status: "Draft" }),
      ],
      freeStatuses: ["Draft"],
    });
    expect(report.ok).toBe(true);
  });

  it("con la lista por defecto, un borrador sí ocupa", () => {
    expect(DEFAULT_FREE_STATUSES).not.toContain("draft");
    const report = check({
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", { status: "Draft" }),
      ],
    });
    expect(reasons(report)).toEqual(["provider-busy"]);
  });
});

// ---------------------------------------------------------------------------
// 2. attendantsNumber
// ---------------------------------------------------------------------------

describe("checkConflicts · capacidad del servicio", () => {
  const service = (attendantsNumber: number | null): ServiceCapacity[] => [
    { id: 10, attendantsNumber, category: null },
  ];

  it("attendantsNumber = 1 (el caso de hoy) degenera en 'una técnica, una clienta'", () => {
    for (const n of [null, 0, 1]) {
      const report = check({
        appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00")],
        services: service(n),
      });
      expect(reasons(report), String(n)).toEqual(["provider-busy"]);
    }
  });

  it("con attendantsNumber = 2 la segunda clienta del mismo servicio pasa", () => {
    const report = check({
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00")],
      services: service(2),
    });
    expect(report.ok).toBe(true);
  });

  it("y la tercera no", () => {
    const report = check({
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00"),
        appointment("2026-08-31 10:15:00", "2026-08-31 11:15:00"),
      ],
      services: service(2),
    });

    expect(reasons(report)).toEqual(["service-capacity"]);
    expect(report.conflicts[0].message).toContain("admite 2 clientas");
    expect(report.conflicts[0].with).toHaveLength(2);
  });

  it("una cita de OTRO servicio encima bloquea igual, como en EA", () => {
    // `Availability::consider_multiple_attendants()` descarta el slot en cuanto
    // hay una cita de otro servicio para esa técnica, sin mirar la capacidad.
    const report = check({
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", { serviceId: 99 }),
      ],
      services: service(3),
    });
    expect(reasons(report)).toEqual(["provider-busy"]);
    expect(report.conflicts[0].message).toContain("otro servicio");
  });

  it("dos citas de otros servicios encima lo dicen en plural", () => {
    const report = check({
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 10:30:00", { serviceId: 98 }),
        appointment("2026-08-31 10:30:00", "2026-08-31 11:00:00", { serviceId: 99 }),
      ],
      services: service(3),
    });
    expect(reasons(report)).toEqual(["provider-busy"]);
    expect(report.conflicts[0].message).toContain("2 citas de otros servicios");
  });

  it("acepta el catálogo como Map además de como arreglo", () => {
    const report = check({
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00")],
      services: new Map(service(2).map((s) => [s.id, s])),
    });
    expect(report.ok).toBe(true);
  });

  it("un servicio que no está en el catálogo se lee como capacidad 1", () => {
    const report = check({
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00")],
      services: [],
    });
    expect(reasons(report)).toEqual(["provider-busy"]);
  });

  it("un candidato sin servicio también se lee como capacidad 1", () => {
    const report = check({
      candidate: {
        providerId: 1,
        serviceId: null,
        start: dt("2026-08-31 10:00:00"),
        end: dt("2026-08-31 11:00:00"),
      },
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00")],
      services: service(5),
    });
    expect(reasons(report)).toEqual(["provider-busy"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Plan, excepciones y descansos
// ---------------------------------------------------------------------------

describe("checkConflicts · plan de trabajo", () => {
  const at = (start: string, end: string) => ({
    candidate: {
      providerId: 1,
      serviceId: 10,
      start: dt(start),
      end: dt(end),
    },
  });

  it("dentro del horario no dice nada", () => {
    const report = check({ provider: { workingPlan: plan() } });
    expect(report.ok).toBe(true);
  });

  it("sin plan en la entrada, el chequeo se salta", () => {
    const report = check({ ...at("2026-08-31 06:00:00", "2026-08-31 07:00:00") });
    expect(report.ok).toBe(true);
  });

  it("antes de entrar es advertencia, no choque duro", () => {
    const report = check({
      ...at("2026-08-31 08:00:00", "2026-08-31 09:30:00"),
      provider: { workingPlan: plan() },
    });

    expect(reasons(report)).toEqual(["outside-working-plan"]);
    expect(report.hard).toBe(false);
    expect(report.conflicts[0].window).toEqual({
      start: dt("2026-08-31 08:00:00"),
      end: dt("2026-08-31 09:00:00"),
    });
  });

  it("después de salir también, y reporta solo el tramo que se sale", () => {
    const report = check({
      ...at("2026-08-31 17:30:00", "2026-08-31 19:00:00"),
      provider: { workingPlan: plan() },
    });
    expect(reasons(report)).toEqual(["outside-working-plan"]);
    expect(report.conflicts[0].window).toEqual({
      start: dt("2026-08-31 18:00:00"),
      end: dt("2026-08-31 19:00:00"),
    });
  });

  it("un día libre lo dice con esas palabras", () => {
    const report = check({
      ...at("2026-09-06 10:00:00", "2026-09-06 11:00:00"),
      provider: { workingPlan: plan() },
    });
    expect(reasons(report)).toEqual(["outside-working-plan"]);
    expect(report.conflicts[0].message).toContain("no trabaja ese día");
    expect(report.conflicts[0].with[0]).toEqual({
      kind: "working-plan",
      date: d("2026-09-06"),
      source: "plan",
      exceptionId: null,
      startMinute: null,
      endMinute: null,
    });
  });

  it("un descanso es su propio motivo, con el tramo exacto", () => {
    const report = check({
      ...at("2026-08-31 12:30:00", "2026-08-31 14:00:00"),
      provider: {
        workingPlan: plan({
          monday: { start: "09:00", end: "18:00", breaks: [{ start: "12:00", end: "13:00" }] },
        }),
      },
    });

    expect(reasons(report)).toEqual(["during-break"]);
    expect(report.conflicts[0].window).toEqual({
      start: dt("2026-08-31 12:30:00"),
      end: dt("2026-08-31 13:00:00"),
    });
  });

  it("pegado al borde del descanso no choca", () => {
    const provider = {
      workingPlan: plan({
        monday: { start: "09:00", end: "18:00", breaks: [{ start: "12:00", end: "13:00" }] },
      }),
    };

    expect(check({ ...at("2026-08-31 11:00:00", "2026-08-31 12:00:00"), provider }).ok).toBe(true);
    expect(check({ ...at("2026-08-31 13:00:00", "2026-08-31 14:00:00"), provider }).ok).toBe(true);
  });

  it("fuera de una EXCEPCIÓN es un motivo distinto de fuera del plan", () => {
    const exception: WorkingPlanException = {
      id: 5,
      startDate: MONDAY,
      endDate: null,
      startTime: "11:00",
      endTime: "15:00",
      breaks: [],
      providerId: 1,
    };

    const report = check({
      ...at("2026-08-31 10:00:00", "2026-08-31 12:00:00"),
      provider: { workingPlan: plan(), workingPlanExceptions: [exception] },
    });

    expect(reasons(report)).toEqual(["plan-exception"]);
    expect(report.conflicts[0].message).toContain("horario excepcional");
    expect(report.conflicts[0].with[0]).toMatchObject({
      kind: "working-plan",
      source: "plan-exception",
      exceptionId: 5,
      startMinute: 660,
    });
  });

  it("una excepción de día libre lo dice como tal", () => {
    const report = check({
      provider: {
        workingPlan: plan(),
        workingPlanExceptions: [
          {
            id: 6,
            startDate: MONDAY,
            endDate: null,
            startTime: null,
            endTime: null,
            breaks: [],
            providerId: 1,
          },
        ],
      },
    });
    expect(reasons(report)).toEqual(["plan-exception"]);
    expect(report.conflicts[0].message).toContain("día libre");
  });

  it("una cita que cruza la medianoche se evalúa contra el plan de LOS DOS días", () => {
    // Lunes 9–18 y domingo libre: una cita del domingo 23:00 al lunes 01:00
    // está fuera por los dos lados, y el motor tiene que mirar ambos.
    const report = check({
      ...at("2026-09-06 23:00:00", "2026-09-07 01:00:00"),
      provider: { workingPlan: plan() },
    });

    expect(reasons(report)).toEqual(["outside-working-plan"]);
    expect(report.conflicts[0].with).toHaveLength(2);
    expect(report.conflicts[0].with.map((s) => (s.kind === "working-plan" ? s.date : null))).toEqual([
      d("2026-09-06"),
      d("2026-09-07"),
    ]);
  });

  it("una cita que termina en la medianoche exacta no arrastra el día siguiente", () => {
    // El rango de fechas llega hasta el 1 de septiembre, pero el tramo de ese
    // día mide cero: el plan del martes no tiene nada que decir acá.
    const report = check({
      ...at("2026-08-31 23:00:00", "2026-09-01 00:00:00"),
      provider: { workingPlan: plan() },
    });

    expect(reasons(report)).toEqual(["outside-working-plan"]);
    expect(report.conflicts[0].with).toHaveLength(1);
    expect(report.conflicts[0].with[0]).toMatchObject({ date: MONDAY });
  });

  it("una cita que cruza la medianoche DENTRO del horario de los dos días no choca", () => {
    const nocturno = plan({
      monday: { start: "00:00", end: "24:00", breaks: [] },
      tuesday: { start: "00:00", end: "24:00", breaks: [] },
    });

    const report = check({
      ...at("2026-08-31 23:00:00", "2026-09-01 01:00:00"),
      provider: { workingPlan: nocturno },
    });
    expect(report.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4 y 5. Bloqueos e indisponibilidades
// ---------------------------------------------------------------------------

describe("checkConflicts · bloqueos e indisponibilidades", () => {
  it("un bloqueo del estudio es advertencia y trae su nombre", () => {
    const report = check({
      blockedPeriods: [blockedPeriod("2026-08-31 09:00:00", "2026-08-31 13:00:00", "Festivo")],
    });

    expect(reasons(report)).toEqual(["blocked-period"]);
    expect(report.hard).toBe(false);
    expect(report.conflicts[0].message).toContain("Festivo");
    expect(report.conflicts[0].with[0]).toMatchObject({ kind: "blocked-period", name: "Festivo" });
  });

  it("un bloqueo sin nombre igual se reporta", () => {
    const report = check({
      blockedPeriods: [blockedPeriod("2026-08-31 09:00:00", "2026-08-31 13:00:00")],
    });
    expect(report.conflicts[0].message).toContain("cerrado");
  });

  it("un bloqueo que termina cuando empieza la cita no choca", () => {
    const report = check({
      blockedPeriods: [blockedPeriod("2026-08-31 09:00:00", "2026-08-31 10:00:00")],
    });
    expect(report.ok).toBe(true);
  });

  it("el bloqueo tapa a todas las técnicas: no filtra por columna", () => {
    const report = check({
      candidate: {
        providerId: 7,
        serviceId: 10,
        start: dt("2026-08-31 10:00:00"),
        end: dt("2026-08-31 11:00:00"),
      },
      blockedPeriods: [blockedPeriod("2026-08-31 09:00:00", "2026-08-31 13:00:00")],
    });
    expect(reasons(report)).toEqual(["blocked-period"]);
  });

  it("una indisponibilidad es de SU técnica y de nadie más", () => {
    const propia = unavailability("2026-08-31 10:30:00", "2026-08-31 11:30:00", {
      notes: "Médico",
    });
    const ajena = unavailability("2026-08-31 10:30:00", "2026-08-31 11:30:00", { providerId: 2 });

    const report = check({ unavailabilities: [propia, ajena] });

    expect(reasons(report)).toEqual(["provider-unavailable"]);
    expect(report.conflicts[0].with).toEqual([
      {
        kind: "unavailability",
        id: propia.id,
        providerId: 1,
        notes: "Médico",
        start: dt("2026-08-31 10:30:00"),
        end: dt("2026-08-31 11:30:00"),
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. Estaciones a nivel de ESTUDIO
// ---------------------------------------------------------------------------

describe("checkConflicts · dos puestos, y EA no sabe contar puestos", () => {
  const otherProvider = (n: number, start: string, end: string) =>
    appointment(start, end, { providerId: n, serviceId: 10 });

  it("con tres técnicas en agenda, dos citas simultáneas pasan", () => {
    const report = check({
      appointments: [otherProvider(2, "2026-08-31 10:00:00", "2026-08-31 11:00:00")],
      stations: TWO_OPEN_STATIONS,
    });
    expect(report.ok).toBe(true);
  });

  it("y tres no, aunque las tres técnicas estén libres", () => {
    const report = check({
      appointments: [
        otherProvider(2, "2026-08-31 10:00:00", "2026-08-31 11:00:00"),
        otherProvider(3, "2026-08-31 10:00:00", "2026-08-31 11:00:00"),
      ],
      stations: TWO_OPEN_STATIONS,
    });

    // Ninguna técnica está ocupada: el único motivo es el puesto.
    expect(reasons(report)).toEqual(["no-station"]);
    expect(report.hard).toBe(true);
    expect(report.conflicts[0].with[0]).toEqual({
      kind: "station",
      at: dt("2026-08-31 10:00:00"),
      needed: 3,
      seated: 2,
      total: 2,
    });
    expect(report.conflicts[0].with).toHaveLength(3);
  });

  it("detecta el pico aunque no ocurra al inicio del candidato", () => {
    // El candidato va de 10 a 12. A las 10 hay una sola cita más; a las 11
    // entra la tercera. El barrido tiene que evaluar también ese instante.
    const report = check({
      candidate: {
        providerId: 1,
        serviceId: 10,
        start: dt("2026-08-31 10:00:00"),
        end: dt("2026-08-31 12:00:00"),
      },
      appointments: [
        otherProvider(2, "2026-08-31 09:00:00", "2026-08-31 12:00:00"),
        otherProvider(3, "2026-08-31 11:00:00", "2026-08-31 12:00:00"),
      ],
      stations: TWO_OPEN_STATIONS,
    });

    expect(reasons(report)).toEqual(["no-station"]);
    expect(report.conflicts[0].with[0]).toMatchObject({ at: dt("2026-08-31 11:00:00") });
  });

  it("una cita que termina cuando empieza el candidato deja el puesto libre", () => {
    const report = check({
      appointments: [
        otherProvider(2, "2026-08-31 09:00:00", "2026-08-31 10:00:00"),
        otherProvider(3, "2026-08-31 10:00:00", "2026-08-31 11:00:00"),
      ],
      stations: TWO_OPEN_STATIONS,
    });
    expect(report.ok).toBe(true);
  });

  it("una cita cancelada tampoco ocupa puesto", () => {
    const report = check({
      appointments: [
        otherProvider(2, "2026-08-31 10:00:00", "2026-08-31 11:00:00"),
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", {
          providerId: 3,
          status: "Cancelled",
        }),
      ],
      stations: TWO_OPEN_STATIONS,
    });
    expect(report.ok).toBe(true);
  });

  it("omitir stations salta el chequeo; pasar [] lo reporta", () => {
    const tresCitas = [
      otherProvider(2, "2026-08-31 10:00:00", "2026-08-31 11:00:00"),
      otherProvider(3, "2026-08-31 10:00:00", "2026-08-31 11:00:00"),
    ];

    expect(check({ appointments: tresCitas }).ok).toBe(true);

    const vacio = check({ appointments: tresCitas, stations: [] });
    expect(reasons(vacio)).toEqual(["no-station"]);
    expect(vacio.conflicts[0].message).toContain("No hay puestos configurados");
  });

  it("un solo puesto deja pasar una cita y ninguna más", () => {
    const one: StationSlot[] = [{ id: 1, name: "Único", allows: null }];
    expect(check({ stations: one }).ok).toBe(true);

    const report = check({
      appointments: [otherProvider(2, "2026-08-31 10:00:00", "2026-08-31 11:00:00")],
      stations: one,
    });
    expect(reasons(report)).toEqual(["no-station"]);
    expect(report.conflicts[0].message).toContain("1 puesto");
  });

  it("puestos especializados: la categoría sale del catálogo de servicios", () => {
    const stations: StationSlot[] = [
      { id: 1, name: "Manos", allows: ["manos"] },
      { id: 2, name: "Pies", allows: ["pies"] },
    ];
    const services: ServiceCapacity[] = [
      { id: 10, attendantsNumber: 1, category: "pies" },
      { id: 20, attendantsNumber: 1, category: "manos" },
    ];

    // Dos citas de pies y un solo puesto de pies: no caben, aunque haya dos
    // puestos y dos técnicas.
    const dosPies = check({
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", {
          providerId: 2,
          serviceId: 10,
        }),
      ],
      services,
      stations,
    });
    expect(reasons(dosPies)).toEqual(["no-station"]);

    // Una de pies y una de manos sí.
    const mixto = check({
      appointments: [
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", {
          providerId: 2,
          serviceId: 20,
        }),
      ],
      services,
      stations,
    });
    expect(mixto.ok).toBe(true);
  });

  it("una cita de un servicio que no está en el catálogo ocupa puesto igual", () => {
    // Categoría desconocida: se sienta en cualquier puesto. Lo contrario —
    // no contarla— inventaría capacidad.
    const report = check({
      appointments: [
        otherProvider(2, "2026-08-31 10:00:00", "2026-08-31 11:00:00"),
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", {
          providerId: 3,
          serviceId: 777,
        }),
      ],
      services: [{ id: 10, attendantsNumber: 1, category: null }],
      stations: TWO_OPEN_STATIONS,
    });
    expect(reasons(report)).toEqual(["no-station"]);
  });

  it("una cita sin servicio también ocupa puesto", () => {
    // `id_services` puede venir en null en filas viejas de EA. Sin servicio no
    // hay categoría, y sin categoría entra en cualquier puesto — pero ocupa.
    const report = check({
      candidate: {
        providerId: 1,
        serviceId: null,
        start: dt("2026-08-31 10:00:00"),
        end: dt("2026-08-31 11:00:00"),
      },
      appointments: [
        otherProvider(2, "2026-08-31 10:00:00", "2026-08-31 11:00:00"),
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", {
          providerId: 3,
          serviceId: null,
        }),
      ],
      stations: TWO_OPEN_STATIONS,
    });
    expect(reasons(report)).toEqual(["no-station"]);
  });

  it("la propia cita movida no se cuenta dos veces contra los puestos", () => {
    const cita = appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", { providerId: 3 });
    const report = check({
      candidate: {
        id: cita.id,
        providerId: 3,
        serviceId: 10,
        start: dt("2026-08-31 10:15:00"),
        end: dt("2026-08-31 11:15:00"),
      },
      appointments: [
        cita,
        appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00", { providerId: 2 }),
      ],
      stations: TWO_OPEN_STATIONS,
    });
    expect(report.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Forma del reporte
// ---------------------------------------------------------------------------

describe("checkConflicts · forma del reporte", () => {
  it("acumula todos los motivos y pone los duros primero", () => {
    const report = check({
      candidate: {
        providerId: 1,
        serviceId: 10,
        start: dt("2026-08-31 18:30:00"),
        end: dt("2026-08-31 19:30:00"),
      },
      appointments: [
        appointment("2026-08-31 18:45:00", "2026-08-31 19:15:00"),
        appointment("2026-08-31 18:45:00", "2026-08-31 19:15:00", { providerId: 2 }),
      ],
      unavailabilities: [unavailability("2026-08-31 19:00:00", "2026-08-31 20:00:00")],
      blockedPeriods: [blockedPeriod("2026-08-31 19:00:00", "2026-08-31 20:00:00", "Cierre")],
      provider: { workingPlan: plan() },
      stations: [{ id: 1, name: "Único", allows: null }],
    });

    expect(report.ok).toBe(false);
    expect(report.hard).toBe(true);

    const severities = report.conflicts.map((c) => c.severity);
    expect(severities).toEqual([...severities].sort());
    expect(new Set(reasons(report))).toEqual(
      new Set([
        "provider-busy",
        "no-station",
        "outside-working-plan",
        "provider-unavailable",
        "blocked-period",
      ]),
    );
  });

  it("todo motivo trae mensaje en español y ventana, para el diálogo", () => {
    const report = check({
      appointments: [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00")],
      blockedPeriods: [blockedPeriod("2026-08-31 09:00:00", "2026-08-31 13:00:00")],
      provider: { workingPlan: plan({ monday: null }) },
    });

    for (const conflict of report.conflicts) {
      expect(conflict.message.length).toBeGreaterThan(10);
      expect(conflict.window).not.toBeNull();
      expect(["hard", "soft"]).toContain(conflict.severity);
    }
  });

  it("un motivo `soft` solo no vuelve duro el reporte", () => {
    const report = check({
      blockedPeriods: [blockedPeriod("2026-08-31 09:00:00", "2026-08-31 13:00:00")],
    });
    expect(report.ok).toBe(false);
    expect(report.hard).toBe(false);
  });

  it("es una función pura: no toca la entrada", () => {
    const appointments = [appointment("2026-08-31 10:00:00", "2026-08-31 11:00:00")];
    const snapshot = JSON.stringify(appointments);
    check({ appointments, stations: TWO_OPEN_STATIONS, provider: { workingPlan: plan() } });
    expect(JSON.stringify(appointments)).toBe(snapshot);
  });

  it("no depende de la zona del proceso", () => {
    const original = process.env.TZ;
    // La cita se construye una sola vez: `nextId` avanza en cada llamada a la
    // fábrica y un id distinto haría fallar la comparación por la razón
    // equivocada.
    const vecina = appointment("2026-09-01 00:30:00", "2026-09-01 02:00:00");
    try {
      const run = () =>
        JSON.stringify(
          check({
            candidate: {
              providerId: 1,
              serviceId: 10,
              start: dt("2026-08-31 23:00:00"),
              end: dt("2026-09-01 01:00:00"),
            },
            appointments: [vecina],
            provider: { workingPlan: plan() },
            stations: TWO_OPEN_STATIONS,
          }),
        );

      process.env.TZ = "UTC";
      const reference = run();

      for (const tz of ["America/Bogota", "Pacific/Kiritimati", "Pacific/Niue"]) {
        process.env.TZ = tz;
        expect(run()).toBe(reference);
      }
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});
