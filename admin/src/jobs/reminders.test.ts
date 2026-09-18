import { describe, expect, it } from "vitest";

import {
  REMINDER_RULES,
  planReminders,
  scheduledFor,
  toleranceCoversInterval,
  type ExistingMessage,
  type ReminderAppointment,
} from "./reminders";

const AHORA = new Date("2026-09-17T15:00:00Z");

/** Una cita que cae exactamente en la ventana de 24 h desde `AHORA`. */
function cita(over: Partial<ReminderAppointment> = {}): ReminderAppointment {
  return {
    eaAppointmentId: 1,
    startAt: new Date(AHORA.getTime() + 24 * 60 * 60_000),
    phoneE164: "+573001234567",
    status: "Confirmada",
    ...over,
  };
}

function plan(input: {
  appointments?: ReminderAppointment[];
  existing?: ExistingMessage[];
  optedOut?: string[];
  now?: Date;
}) {
  return planReminders({
    appointments: input.appointments ?? [cita()],
    existing: input.existing ?? [],
    optedOut: new Set(input.optedOut ?? []),
    now: input.now ?? AHORA,
  });
}

describe("planReminders", () => {
  it("manda el de 24 h cuando la cita cae en su ventana", () => {
    expect(plan({})).toEqual([
      { action: "enviar", appointment: cita(), rule: REMINDER_RULES[0] },
    ]);
  });

  it("manda el de 2 h cuando toca ése", () => {
    const decisions = plan({
      appointments: [cita({ startAt: new Date(AHORA.getTime() + 2 * 60 * 60_000) })],
    });

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ action: "enviar", rule: { kind: "recordatorio_2h" } });
  });

  it("no dice nada de las citas fuera de ventana", () => {
    // Son casi todas, en casi toda corrida. Registrarlas sería registrar ruido
    // y llenar la tabla de filas que no significan nada.
    const decisions = plan({
      appointments: [cita({ startAt: new Date(AHORA.getTime() + 10 * 24 * 60 * 60_000) })],
    });

    expect(decisions).toEqual([]);
  });

  it("cubre el hueco entre dos corridas del cron: la ventana es un rango", () => {
    // "24 horas antes" suena a instante y no lo es. Con una ventana de cero,
    // una cita cuyo momento exacto cayó entre dos corridas no se mandaría nunca
    // — y nadie se enteraría, porque no hay error.
    const veinteMinutosTarde = new Date(AHORA.getTime() + 20 * 60_000);
    const decisions = plan({ now: veinteMinutosTarde });

    expect(decisions[0]).toMatchObject({ action: "enviar" });
  });

  it("y el borde de la ventana se respeta", () => {
    const muyTarde = new Date(AHORA.getTime() + 40 * 60_000);
    expect(plan({ now: muyTarde })).toEqual([]);
  });

  it("no manda dos veces el mismo tipo para la misma cita", () => {
    // La UNIQUE de la tabla también lo impediría, pero llegar hasta el INSERT
    // para chocar convertiría cada corrida en una ráfaga de errores esperados.
    const decisions = plan({
      existing: [{ eaAppointmentId: 1, kind: "recordatorio_24h" }],
    });

    expect(decisions).toEqual([
      { action: "omitir", appointment: cita(), rule: REMINDER_RULES[0], reason: "ya-existe" },
    ]);
  });

  it("el de 2 h no bloquea al de 24 h ni al revés", () => {
    const decisions = plan({
      appointments: [cita({ startAt: new Date(AHORA.getTime() + 2 * 60 * 60_000) })],
      existing: [{ eaAppointmentId: 1, kind: "recordatorio_24h" }],
    });

    expect(decisions).toEqual([
      { action: "enviar", appointment: expect.anything(), rule: REMINDER_RULES[1] },
    ]);
  });

  it("no manda a una clienta sin teléfono, y lo registra", () => {
    // "No recibió aviso" tiene que ser un dato con motivo, no un hueco: sin la
    // fila, una clienta sin número y una que se dio de baja se ven igual.
    const decisions = plan({ appointments: [cita({ phoneE164: null })] });

    expect(decisions[0]).toMatchObject({ action: "omitir", reason: "sin-telefono" });
  });

  it("no manda a quien pidió no recibir", () => {
    const decisions = plan({ optedOut: ["+573001234567"] });
    expect(decisions[0]).toMatchObject({ action: "omitir", reason: "opt-out" });
  });

  it("no manda a una cita cancelada", () => {
    const decisions = plan({ appointments: [cita({ status: "Cancelada" })] });
    expect(decisions[0]).toMatchObject({ action: "omitir", reason: "estado-no-aplica" });
  });

  it("ni a una que ya se completó o que no asistió", () => {
    for (const status of ["Completada", "No asistió"]) {
      const decisions = plan({ appointments: [cita({ status })] });
      expect(decisions[0], status).toMatchObject({
        action: "omitir",
        reason: "estado-no-aplica",
      });
    }
  });

  it("acepta los estados de EA en inglés, que conviven con los nuestros", () => {
    // La lista de estados es texto libre y EA no migra las filas viejas al
    // renombrarla: los dos vocabularios conviven mientras haya citas anteriores.
    for (const status of ["Booked", "Confirmed", "Rescheduled"]) {
      expect(plan({ appointments: [cita({ status })] })[0], status).toMatchObject({
        action: "enviar",
      });
    }
  });

  it("compara los estados sin tildes ni mayúsculas", () => {
    expect(plan({ appointments: [cita({ status: "CONFIRMADA" })] })[0]).toMatchObject({
      action: "enviar",
    });
  });

  it("nunca manda un recordatorio de una cita que ya empezó", () => {
    // Llegar tarde sirve; llegar después de la cita es ruido, y para la clienta
    // una molestia. Gana sobre la ventana aunque la ventana lo permitiera.
    const decisions = planReminders({
      appointments: [cita({ startAt: new Date(AHORA.getTime() - 5 * 60_000) })],
      existing: [],
      optedOut: new Set(),
      now: AHORA,
      rules: [{ kind: "recordatorio_2h", leadMinutes: 0, toleranceMinutes: 60 }],
    });

    expect(decisions[0]).toMatchObject({ action: "omitir", reason: "cita-ya-empezo" });
  });

  it("decide cita por cita: una mala no tapa a las buenas", () => {
    const decisions = plan({
      appointments: [
        cita({ eaAppointmentId: 1, phoneE164: null }),
        cita({ eaAppointmentId: 2 }),
      ],
    });

    expect(decisions).toHaveLength(2);
    expect(decisions.filter((d) => d.action === "enviar")).toHaveLength(1);
  });
});

describe("scheduledFor", () => {
  it("es el momento objetivo, no el de envío", () => {
    // Guardar el de envío en las dos columnas haría imposible notar que el cron
    // se está atrasando.
    const c = cita();
    expect(scheduledFor(c, REMINDER_RULES[0]).toISOString()).toBe(AHORA.toISOString());
  });
});

describe("toleranceCoversInterval", () => {
  it("las reglas de hoy aguantan un cron cada 30 minutos", () => {
    expect(toleranceCoversInterval(REMINDER_RULES, 30)).toBe(true);
  });

  it("y no aguantarían uno cada dos horas", () => {
    // Si alguien baja la frecuencia sin subir la tolerancia, las citas empiezan
    // a caer entre dos corridas y **nadie se entera**: no hay error, solo
    // recordatorios que no llegan.
    expect(toleranceCoversInterval(REMINDER_RULES, 120)).toBe(false);
  });
});
