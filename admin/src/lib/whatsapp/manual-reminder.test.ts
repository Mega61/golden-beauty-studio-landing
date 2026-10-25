import { describe, expect, it } from "vitest";

import { parseEaLocalDate, parseEaLocalDateTime } from "@/lib/ea";

import {
  buildConfirmationText,
  KIND_FOR_DAY,
  MANUAL_TEMPLATE,
  STUDIO_ADDRESS,
  buildReminderText,
  clockTime,
  planManualReminders,
  presentableFirstName,
  reminderDayOf,
  spokenTime,
  waMeLink,
  type ExistingReminder,
  type ManualReminderAppointment,
} from "./manual-reminder";

/**
 * Hoy es jueves 15 de octubre de 2026 y son las 9:00 a. m. en Bogotá
 * (14:00 UTC). Mañana es viernes 16.
 */
const NOW = new Date("2026-10-15T14:00:00Z");
const TODAY = parseEaLocalDate("2026-10-15");
const TOMORROW = parseEaLocalDate("2026-10-16");

const wall = (value: string) => parseEaLocalDateTime(value);

function cita(overrides: Partial<ManualReminderAppointment> = {}): ManualReminderAppointment {
  return {
    eaAppointmentId: 1,
    start: wall("2026-10-16 10:00:00"),
    status: "Reservada",
    phoneE164: "+573001234567",
    customerFirstName: "Laura",
    customerName: "Laura Gómez",
    serviceName: "Semipermanente manos",
    ...overrides,
  };
}

function plan(
  appointments: ManualReminderAppointment[],
  options: { existing?: ExistingReminder[]; optedOut?: string[]; now?: Date } = {},
) {
  return planManualReminders({
    appointments,
    existing: options.existing ?? [],
    optedOut: new Set(options.optedOut ?? []),
    now: options.now ?? NOW,
    today: TODAY,
    tomorrow: TOMORROW,
  });
}

// ── A qué día pertenece ─────────────────────────────────────────────────────

describe("reminderDayOf", () => {
  it("mañana a cualquier hora es el aviso de 24 h", () => {
    for (const h of ["00:00:00", "07:30:00", "23:59:59"]) {
      expect(reminderDayOf(wall(`2026-10-16 ${h}`), NOW, TODAY, TOMORROW)).toBe("manana");
    }
  });

  it("hoy, solo lo que todavía no empezó", () => {
    expect(reminderDayOf(wall("2026-10-15 09:00:01"), NOW, TODAY, TOMORROW)).toBe("hoy");
    expect(reminderDayOf(wall("2026-10-15 18:00:00"), NOW, TODAY, TOMORROW)).toBe("hoy");
    // Empieza justo ahora: ya no lleva aviso.
    expect(reminderDayOf(wall("2026-10-15 09:00:00"), NOW, TODAY, TOMORROW)).toBeNull();
    expect(reminderDayOf(wall("2026-10-15 08:00:00"), NOW, TODAY, TOMORROW)).toBeNull();
  });

  it("ayer y pasado mañana no entran", () => {
    expect(reminderDayOf(wall("2026-10-14 10:00:00"), NOW, TODAY, TOMORROW)).toBeNull();
    expect(reminderDayOf(wall("2026-10-17 10:00:00"), NOW, TODAY, TOMORROW)).toBeNull();
  });

  it("compara en hora de Bogotá, no en la del proceso", () => {
    // 23:30 UTC del 15 son las 6:30 p. m. del 15 en Bogotá: una cita a las
    // 7 p. m. de hoy todavía no empezó, aunque en UTC ya sea el 16.
    const lateNow = new Date("2026-10-15T23:30:00Z");
    expect(reminderDayOf(wall("2026-10-15 19:00:00"), lateNow, TODAY, TOMORROW)).toBe("hoy");
    expect(reminderDayOf(wall("2026-10-15 18:00:00"), lateNow, TODAY, TOMORROW)).toBeNull();
  });
});

// ── La lista ────────────────────────────────────────────────────────────────

describe("planManualReminders", () => {
  it("una cita de mañana, con todo en orden, queda pendiente con el tipo de 24 h", () => {
    const [row, ...rest] = plan([cita()]);
    expect(rest).toEqual([]);
    expect(row.state).toBe("pendiente");
    expect(row.day).toBe("manana");
    expect(row.kind).toBe("recordatorio_24h");
    expect(row.existing).toBeNull();
  });

  it("una cita de hoy más tarde lleva el tipo de 2 h", () => {
    const [row] = plan([cita({ start: wall("2026-10-15 15:00:00") })]);
    expect(row.day).toBe("hoy");
    expect(row.kind).toBe("recordatorio_2h");
  });

  it("los dos tipos coinciden con los del emisor automático", () => {
    // Si el manual escribiera otro `kind`, la UNIQUE no cruzaría los dos
    // caminos y el día que arranque el cron la clienta recibiría dos avisos.
    expect(KIND_FOR_DAY).toEqual({ hoy: "recordatorio_2h", manana: "recordatorio_24h" });
  });

  it("deja afuera lo que ya empezó, lo de ayer y lo de pasado mañana", () => {
    const rows = plan([
      cita({ eaAppointmentId: 1, start: wall("2026-10-15 08:00:00") }),
      cita({ eaAppointmentId: 2, start: wall("2026-10-14 15:00:00") }),
      cita({ eaAppointmentId: 3, start: wall("2026-10-17 10:00:00") }),
    ]);
    expect(rows).toEqual([]);
  });

  it("estado que no aplica: cancelada, completada, no asistió", () => {
    for (const status of ["Cancelada", "Completada", "No asistió", "cancelled", ""]) {
      const [row] = plan([cita({ status })]);
      expect(row.state, status).toBe("estado-no-aplica");
    }
  });

  it("los estados que sí aplican, en los dos vocabularios y con tildes o sin", () => {
    for (const status of ["Reservada", "confirmada", "Reprogramada", "booked", "Confirmed"]) {
      const [row] = plan([cita({ status })]);
      expect(row.state, status).toBe("pendiente");
    }
  });

  it("sin teléfono", () => {
    const [row] = plan([cita({ phoneE164: null })]);
    expect(row.state).toBe("sin-telefono");
  });

  it("con la baja registrada", () => {
    const [row] = plan([cita()], { optedOut: ["+573001234567"] });
    expect(row.state).toBe("opt-out");
  });

  it("la baja es del número: otra clienta con otro número sigue pendiente", () => {
    const [row] = plan([cita()], { optedOut: ["+573009999999"] });
    expect(row.state).toBe("pendiente");
  });

  it("ya recordada, por cualquiera de los dos canales, con quién y cuándo", () => {
    const sentAt = new Date("2026-10-15T13:10:00Z");
    for (const status of ["pendiente", "enviado", "entregado", "leido"] as const) {
      const existing: ExistingReminder = {
        eaAppointmentId: 1,
        kind: "recordatorio_24h",
        status,
        channel: status === "enviado" ? "manual" : "cloud_api",
        sentAt,
        sentByName: "Recepción",
      };
      const [row] = plan([cita()], { existing: [existing] });
      expect(row.state, status).toBe("recordada");
      expect(row.existing).toEqual(existing);
    }
  });

  it("una fila omitida se muestra como tal, sin botón", () => {
    const [row] = plan([cita()], {
      existing: [
        {
          eaAppointmentId: 1,
          kind: "recordatorio_24h",
          status: "omitido",
          channel: "cloud_api",
          sentAt: null,
          sentByName: null,
        },
      ],
    });
    expect(row.state).toBe("no-enviada");
  });

  it("un fallo del envío automático se puede mandar a mano", () => {
    const fallo = {
      eaAppointmentId: 1,
      kind: "recordatorio_24h" as const,
      status: "fallido" as const,
      channel: "cloud_api" as const,
      sentAt: null,
      sentByName: null,
    };
    const [row] = plan([cita()], { existing: [fallo] });
    expect(row.state).toBe("fallo-automatico");
    expect(row.existing).toEqual(fallo);
  });

  it("pero un fallo del automático sigue respetando la baja y el teléfono", () => {
    const fallo = {
      eaAppointmentId: 1,
      kind: "recordatorio_24h" as const,
      status: "fallido" as const,
      channel: "cloud_api" as const,
      sentAt: null,
      sentByName: null,
    };
    expect(plan([cita()], { existing: [fallo], optedOut: ["+573001234567"] })[0].state).toBe("opt-out");
    expect(plan([cita({ phoneE164: null })], { existing: [fallo] })[0].state).toBe("sin-telefono");
  });

  it("lo ya mandado gana sobre la baja, el teléfono y el estado", () => {
    // Una clienta que se dio de baja después de recibir el aviso sigue
    // habiéndolo recibido. Lo que pasó es un hecho, no una decisión.
    const [row] = plan([cita({ status: "Cancelada", phoneE164: null })], {
      existing: [
        {
          eaAppointmentId: 1,
          kind: "recordatorio_24h",
          status: "enviado",
          channel: "manual",
          sentAt: NOW,
          sentByName: "Dueña",
        },
      ],
      optedOut: ["+573001234567"],
    });
    expect(row.state).toBe("recordada");
  });

  it("una fila de 24 h no marca como recordado el aviso de hoy, ni al revés", () => {
    const [row] = plan([cita({ start: wall("2026-10-15 15:00:00") })], {
      existing: [
        {
          eaAppointmentId: 1,
          kind: "recordatorio_24h",
          status: "enviado",
          channel: "manual",
          sentAt: NOW,
          sentByName: "Recepción",
        },
      ],
    });
    expect(row.kind).toBe("recordatorio_2h");
    expect(row.state).toBe("pendiente");
  });

  it("una fila de otra cita no se cruza", () => {
    const [row] = plan([cita({ eaAppointmentId: 2 })], {
      existing: [
        {
          eaAppointmentId: 1,
          kind: "recordatorio_24h",
          status: "enviado",
          channel: "manual",
          sentAt: NOW,
          sentByName: "Recepción",
        },
      ],
    });
    expect(row.state).toBe("pendiente");
  });

  it("estado antes que teléfono, teléfono antes que baja", () => {
    expect(plan([cita({ status: "Cancelada", phoneE164: null })])[0].state).toBe(
      "estado-no-aplica",
    );
    expect(
      plan([cita({ phoneE164: null })], { optedOut: ["+573001234567"] })[0].state,
    ).toBe("sin-telefono");
  });

  it("ordena hoy antes que mañana, y por hora dentro de cada día", () => {
    const rows = plan([
      cita({ eaAppointmentId: 10, start: wall("2026-10-16 08:00:00") }),
      cita({ eaAppointmentId: 11, start: wall("2026-10-15 17:00:00") }),
      cita({ eaAppointmentId: 12, start: wall("2026-10-15 11:00:00") }),
      cita({ eaAppointmentId: 14, start: wall("2026-10-16 08:00:00") }),
      cita({ eaAppointmentId: 13, start: wall("2026-10-16 07:00:00") }),
    ]);
    expect(rows.map((r) => r.appointment.eaAppointmentId)).toEqual([12, 11, 13, 10, 14]);
  });

  it("no muta la entrada", () => {
    const input = [
      cita({ eaAppointmentId: 2, start: wall("2026-10-16 12:00:00") }),
      cita({ eaAppointmentId: 1, start: wall("2026-10-16 08:00:00") }),
    ];
    const copy = structuredClone(input);
    plan(input);
    expect(input).toEqual(copy);
  });
});

// ── El texto ────────────────────────────────────────────────────────────────

describe("presentableFirstName", () => {
  it.each([
    ["Laura", "Laura"],
    ["LAURA MARCELA", "Laura"],
    ["laura", "Laura"],
    ["  ana   maría ", "Ana"],
    ["MARÍA-JOSÉ", "María-José"],
    ["ÁNGELA", "Ángela"],
    ["MaríaJosé", "MaríaJosé"],
  ])("%j → %j", (raw, expected) => {
    expect(presentableFirstName(raw)).toBe(expected);
  });

  it("vacío o ausente es null", () => {
    for (const raw of ["", "   ", null, undefined]) {
      expect(presentableFirstName(raw)).toBeNull();
    }
  });
});

describe("spokenTime", () => {
  it.each([
    ["2026-10-16 10:00:00", "a las 10:00 a. m."],
    ["2026-10-16 09:05:00", "a las 9:05 a. m."],
    ["2026-10-16 12:00:00", "a las 12:00 p. m."],
    ["2026-10-16 12:30:00", "a las 12:30 p. m."],
    ["2026-10-16 13:00:00", "a la 1:00 p. m."],
    ["2026-10-16 01:15:00", "a la 1:15 a. m."],
    ["2026-10-16 00:00:00", "a las 12:00 a. m."],
    ["2026-10-16 18:45:00", "a las 6:45 p. m."],
  ])("%s → %s", (start, expected) => {
    expect(spokenTime(wall(start))).toBe(expected);
  });
});

describe("clockTime", () => {
  it.each([
    ["2026-10-16 10:00:00", "10:00 a. m."],
    ["2026-10-16 13:00:00", "1:00 p. m."],
    ["2026-10-16 00:00:00", "12:00 a. m."],
    ["2026-10-16 12:30:00", "12:30 p. m."],
  ])("%s → %s", (start, expected) => {
    expect(clockTime(wall(start))).toBe(expected);
  });
});

describe("buildReminderText", () => {
  it("mañana: saludo, servicio, día con fecha, hora, dirección y cómo cambiarla", () => {
    const text = buildReminderText({
      customerFirstName: "LAURA MARCELA",
      serviceName: "Semipermanente manos",
      start: wall("2026-10-16 10:00:00"),
      day: "manana",
    });
    expect(text).toBe(
      [
        "¡Hola, Laura! ✨",
        "",
        "Te recordamos tu cita de Semipermanente manos 💅",
        "📅 Mañana, viernes 16 de octubre",
        "🕒 10:00 a. m.",
        "📍 Golden Beauty Studio — Calle 69 Sur #43a - 41, primer piso, Sabaneta",
        "",
        "¿Nos confirmas tu asistencia? Responde *SÍ* para confirmar, o escríbenos si necesitas cambiarla. 🤍",
      ].join("\n"),
    );
  });

  it("hoy: también con el día de la semana y la fecha, no solo \"hoy\"", () => {
    const text = buildReminderText({
      customerFirstName: "Ana",
      serviceName: "Pedicure",
      start: wall("2026-10-15 13:30:00"),
      day: "hoy",
    });
    const lines = text.split("\n");
    expect(lines[2]).toBe("Te recordamos tu cita de Pedicure 💅");
    expect(lines[3]).toBe("📅 Hoy, jueves 15 de octubre");
    expect(lines[4]).toBe("🕒 1:30 p. m.");
  });

  it("sin nombre ni servicio sigue siendo un mensaje completo", () => {
    const text = buildReminderText({
      customerFirstName: "  ",
      serviceName: null,
      start: wall("2026-10-16 15:00:00"),
      day: "manana",
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("¡Hola! ✨");
    expect(lines[2]).toBe("Te recordamos tu cita 💅");
    expect(lines[3]).toBe("📅 Mañana, viernes 16 de octubre");
    expect(lines[4]).toBe("🕒 3:00 p. m.");
  });

  it("nunca lleva precio ni nada con forma de plata", () => {
    const text = buildReminderText({
      customerFirstName: "Laura",
      serviceName: "Acrílicas esculpidas",
      start: wall("2026-10-16 10:00:00"),
      day: "manana",
    });
    expect(text).not.toMatch(/\$|COP|\d{2,3}\.\d{3}|precio|valor/i);
  });

  it("lleva la dirección exacta y pide que confirme la asistencia respondiendo", () => {
    const text = buildReminderText({
      customerFirstName: "Laura",
      serviceName: "x",
      start: wall("2026-10-16 10:00:00"),
      day: "hoy",
    });
    expect(STUDIO_ADDRESS).toBe("Calle 69 Sur #43a - 41, primer piso, Sabaneta");
    expect(text).toContain(STUDIO_ADDRESS);
    expect(text.endsWith("¿Nos confirmas tu asistencia? Responde *SÍ* para confirmar, o escríbenos si necesitas cambiarla. 🤍")).toBe(true);
  });

  it("la fecha se lee de la hora de pared, sin pasar por la zona del proceso", () => {
    // 11 p. m. del viernes en Bogotá ya es sábado en UTC. El mensaje tiene que
    // decir viernes.
    const text = buildReminderText({
      customerFirstName: "Laura",
      serviceName: null,
      start: wall("2026-10-16 23:00:00"),
      day: "manana",
    });
    expect(text).toContain("📅 Mañana, viernes 16 de octubre\n🕒 11:00 p. m.");
  });
});

// ── El enlace ───────────────────────────────────────────────────────────────

describe("waMeLink", () => {
  it("los dígitos sin el +, y el texto codificado entero", () => {
    const link = waMeLink("+573001234567", "Hola, Ana!\nCalle 69 Sur #43a - 41 & más?");
    expect(link).toBe(
      "https://api.whatsapp.com/send?phone=573001234567&text=Hola%2C%20Ana!%0ACalle%2069%20Sur%20%2343a%20-%2041%20%26%20m%C3%A1s%3F",
    );
  });

  it("el # de la dirección no corta el mensaje", () => {
    const text = buildReminderText({
      customerFirstName: "Laura",
      serviceName: "Pedicure",
      start: wall("2026-10-16 10:00:00"),
      day: "manana",
    });
    const link = waMeLink("+573001234567", text) as string;
    const url = new URL(link);
    expect(url.hash).toBe("");
    expect(url.host).toBe("api.whatsapp.com");
    expect(url.searchParams.get("phone")).toBe("573001234567");
    expect(url.searchParams.get("text")).toBe(text);
  });

  it("funciona con números de otros países", () => {
    expect(waMeLink("+14155550123", "x")).toBe("https://api.whatsapp.com/send?phone=14155550123&text=x");
  });

  it.each([
    "573001234567",
    "+0573001234567",
    "+57 300 123 4567",
    "+57-300-1234567",
    "+",
    "+123456",
    "+1234567890123456",
    "",
    "+57300123456a",
  ])("rechaza lo que no es E.164: %j", (phone) => {
    expect(waMeLink(phone, "x")).toBeNull();
  });
});

describe("MANUAL_TEMPLATE", () => {
  it("cabe en template_name y se distingue de una plantilla de Meta", () => {
    expect(MANUAL_TEMPLATE.length).toBeLessThanOrEqual(120);
    expect(MANUAL_TEMPLATE.startsWith("manual-")).toBe(true);
  });
});

describe("buildConfirmationText", () => {
  it("confirma con el nombre, el servicio, el día y la hora, sin precio", () => {
    const text = buildConfirmationText({
      customerFirstName: "LAURA",
      serviceName: "Semipermanente manos",
      start: "2026-10-16 10:00:00" as never,
    });
    expect(text).toBe(
      [
        "¡Hola, Laura! ✨",
        "",
        "Tu cita de Semipermanente manos quedó agendada 💅",
        "📅 Viernes 16 de octubre",
        "🕒 10:00 a. m.",
        "📍 Golden Beauty Studio — Calle 69 Sur #43a - 41, primer piso, Sabaneta",
        "",
        "Si necesitas cambiarla, respóndenos por aquí. ¡Te esperamos! 🤍",
      ].join("\n"),
    );
    expect(text).not.toMatch(/\$/);
  });

  it("sin nombre ni servicio sigue siendo un mensaje", () => {
    const text = buildConfirmationText({
      customerFirstName: null,
      serviceName: null,
      start: "2026-10-16 13:30:00" as never,
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("¡Hola! ✨");
    expect(lines[2]).toBe("Tu cita quedó agendada 💅");
    expect(lines[3]).toBe("📅 Viernes 16 de octubre");
    expect(lines[4]).toBe("🕒 1:30 p. m.");
  });
});
