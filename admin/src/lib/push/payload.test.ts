import { describe, expect, it } from "vitest";

import {
  buildCancelPayload,
  buildChangePayload,
  buildNewBookingPayload,
  buildOwnBookingPayload,
  buildPanelBookingPayload,
  diffAppointment,
  type AppointmentState,
  type ChangeNotice,
  relativeDayLabel,
  shortCustomerName,
  type NewBookingNotice,
} from "./payload";

const BASE: NewBookingNotice = {
  appointmentId: 812,
  serviceName: "Semipermanente manos",
  customerFirstName: "Laura",
  customerLastName: "Martínez",
  start: "2026-10-17 15:30:00",
  providerName: "Lina",
};

describe("buildNewBookingPayload", () => {
  it("arma título, cuerpo y enlace a la cita en la agenda", () => {
    const p = buildNewBookingPayload(BASE, "2026-10-15", "/admin");
    expect(p).toEqual({
      title: "Nueva reserva ✨",
      body: "Semipermanente manos\nLaura M. · sáb 17 oct 3:30 p. m. con Lina",
      url: "/admin/agenda?dia=2026-10-17&cita=812",
      tag: "reserva-812",
      confirmUrl: "/admin/confirmar/812",
    });
  });

  it("dice «hoy» y «mañana» cuando aplica", () => {
    expect(buildNewBookingPayload(BASE, "2026-10-17", "/admin").body).toBe(
      "Semipermanente manos\nLaura M. · hoy 3:30 p. m. con Lina",
    );
    expect(buildNewBookingPayload(BASE, "2026-10-16", "/admin").body).toBe(
      "Semipermanente manos\nLaura M. · mañana 3:30 p. m. con Lina",
    );
  });

  it("nunca lleva el teléfono, aunque alguien se lo pase de contrabando", () => {
    // El tipo no tiene dónde recibirlo; esto prueba que un objeto más ancho
    // (la petición entera de la reserva, por ejemplo) tampoco lo filtra.
    const conTelefono = { ...BASE, phone: "+573001234567", customerPhone: "300 123 4567" };
    const json = JSON.stringify(buildNewBookingPayload(conTelefono, "2026-10-15", "/admin"));
    expect(json).not.toMatch(/3001234567|300 123 4567|\+57/);
    expect(json).not.toMatch(/\d{7,}/);
  });

  it("sin nombre de servicio sale igual, con «servicio»", () => {
    const p = buildNewBookingPayload({ ...BASE, serviceName: null }, "2026-10-15", "/admin");
    expect(p.body.split("\n")[0]).toBe("Servicio");
  });

  it("limpia saltos de línea y recorta lo largo", () => {
    const p = buildNewBookingPayload(
      {
        ...BASE,
        customerFirstName: "Ana\nMaría",
        serviceName: "x".repeat(300),
        providerName: "Lina\t\tPérez",
      },
      "2026-10-15",
      "/admin",
    );
    const [what, detail] = p.body.split("\n");
    expect(p.body.split("\n")).toHaveLength(2);
    expect(what.length).toBeLessThanOrEqual(60);
    expect(what.endsWith("…")).toBe(true);
    expect(detail).not.toMatch(/[\n\t]/);
    expect(p.body).toContain("Ana María M.");
    expect(p.body).toContain("con Lina Pérez");
  });

  it("con una fecha ilegible, el enlace va a la agenda sin día", () => {
    const p = buildNewBookingPayload({ ...BASE, start: "basura" }, "2026-10-15", "/admin");
    expect(p.url).toBe("/admin/agenda");
    expect(p.body).toBe("Semipermanente manos\nLaura M. con Lina");
  });

  it("el basePath con barra final no duplica la barra", () => {
    expect(buildNewBookingPayload(BASE, "2026-10-15", "/admin/").url).toBe(
      "/admin/agenda?dia=2026-10-17&cita=812",
    );
  });

  it("la hora en punto no lleva «:00», como en el resto del panel", () => {
    const p = buildNewBookingPayload({ ...BASE, start: "2026-10-15 09:00:00" }, "2026-10-15", "/admin");
    expect(p.body).toBe("Semipermanente manos\nLaura M. · hoy 9 a. m. con Lina");
  });
});

describe("shortCustomerName", () => {
  it("nombre + inicial del apellido", () => {
    expect(shortCustomerName("Laura", "martínez")).toBe("Laura M.");
  });
  it("sin apellido, solo el nombre; sin nada, un texto que no rompe", () => {
    expect(shortCustomerName("Laura", "")).toBe("Laura");
    expect(shortCustomerName("", "")).toBe("Sin nombre");
    expect(shortCustomerName("  ", "Ruiz")).toBe("R.");
  });
});

describe("relativeDayLabel", () => {
  it("cruza fin de mes y de año por calendario", () => {
    expect(relativeDayLabel("2026-11-01", "2026-10-31")).toBe("mañana");
    expect(relativeDayLabel("2027-01-01", "2026-12-31")).toBe("mañana");
  });
  it("un día pasado no es «hoy» ni «mañana»", () => {
    expect(relativeDayLabel("2026-10-14", "2026-10-15")).toBe("mié 14 oct");
  });
});

describe("buildOwnBookingPayload", () => {
  const notice = {
    appointmentId: 144,
    serviceName: "Esculpidas en acrílico y Semipermanente pies",
    customerFirstName: "Laura María",
    customerLastName: "Martínez",
    start: "2026-10-25 10:00:00",
    // De contrabando: el tipo no lo admite, y el aviso no puede llevarlo.
    phone: "+573001234567",
  } as Parameters<typeof buildOwnBookingPayload>[0];

  it("dice qué, quién y cuándo, y abre la agenda en ese día", () => {
    const payload = buildOwnBookingPayload(notice, "2026-10-24", "/admin");
    expect(payload.title).toBe("Nueva cita en tu agenda ✨");
    expect(payload.body).toBe("Esculpidas en acrílico y Semipermanente pies\nLaura María M. · mañana 10 a. m.");
    expect(payload.url).toBe("/admin/agenda?dia=2026-10-25&cita=144");
    expect(payload.tag).toBe("reserva-144");
  });

  it("sin teléfono, sin precio, y sin el botón de WhatsApp del estudio", () => {
    const payload = buildOwnBookingPayload(notice, "2026-10-24", "/admin");
    const all = JSON.stringify(payload);
    expect(all).not.toContain("3001234567");
    expect(all).not.toMatch(/\$\s?\d/);
    expect(payload.confirmUrl).toBeUndefined();
  });
});

describe("buildPanelBookingPayload", () => {
  it("dice con quién y quién la agendó, sin el botón de WhatsApp", () => {
    const p = buildPanelBookingPayload({ ...BASE, actorName: "Paula Gómez" }, "2026-10-17", "/admin");
    expect(p.title).toBe("Nueva cita ✨");
    expect(p.body).toBe("Semipermanente manos\nLaura M. · hoy 3:30 p. m. con Lina · por Paula");
    expect(p.url).toBe("/admin/agenda?dia=2026-10-17&cita=812");
    expect(p.confirmUrl).toBeUndefined();
  });

  it("sin nombre de quien la agendó, no inventa un «por»", () => {
    const p = buildPanelBookingPayload({ ...BASE, actorName: null }, "2026-10-17", "/admin");
    expect(p.body).not.toContain("por");
  });
});

const STATE: AppointmentState = {
  start: "2026-10-23 10:00:00",
  end: "2026-10-23 11:00:00",
  providerId: 5,
  serviceId: 12,
  customerId: 90,
  extraServiceIds: [31],
  cancelled: false,
};

describe("diffAppointment", () => {
  it("nada que avisar si quedó igual (mover y deshacer)", () => {
    expect(diffAppointment(STATE, { ...STATE, extraServiceIds: [31] })).toBeNull();
  });

  it("los adicionales en otro orden no son un cambio", () => {
    const a = { ...STATE, extraServiceIds: [31, 32] };
    expect(diffAppointment(a, { ...STATE, extraServiceIds: [32, 31] })).toBeNull();
  });

  it("distingue mover, reasignar y editar", () => {
    expect(diffAppointment(STATE, { ...STATE, start: "2026-10-24 15:00:00", end: "2026-10-24 16:00:00" })).toEqual({
      moved: true,
      reassigned: false,
      edited: true,
    });
    expect(diffAppointment(STATE, { ...STATE, providerId: 6 })).toEqual({
      moved: false,
      reassigned: true,
      edited: false,
    });
    expect(diffAppointment(STATE, { ...STATE, extraServiceIds: [] })).toEqual({
      moved: false,
      reassigned: false,
      edited: true,
    });
  });

  it("sin el antes, avisa como cambio genérico en vez de callar", () => {
    expect(diffAppointment(null, STATE)).toEqual({ moved: false, reassigned: false, edited: true });
  });
});

describe("buildChangePayload", () => {
  const notice: ChangeNotice = {
    appointmentId: 812,
    serviceName: "Semipermanente manos",
    customerFirstName: "Laura",
    customerLastName: "Martínez",
    start: "2026-10-24 15:00:00",
    providerName: "Lina",
    previousProviderName: "Daniela",
    previousStart: "2026-10-23 10:00:00",
    actorName: "Paula Gómez",
  };
  const moved = { moved: true, reassigned: false, edited: false };
  const today = "2026-10-22";

  it("equipo: la hora de antes y la de ahora, con quién y quién la movió", () => {
    const p = buildChangePayload("team", moved, notice, today, "/admin");
    expect(p.title).toBe("Cita movida");
    expect(p.body).toBe(
      "Semipermanente manos\nLaura M. · mañana 10 a. m. → sáb 24 oct 3 p. m. · con Lina · por Paula",
    );
    expect(p.url).toBe("/admin/agenda?dia=2026-10-24&cita=812");
    expect(p.tag).toBe("reserva-812");
  });

  it("dentro del mismo día no repite el día", () => {
    const p = buildChangePayload(
      "own",
      moved,
      { ...notice, start: "2026-10-23 15:00:00" },
      today,
      "/admin",
    );
    expect(p.title).toBe("Se movió una cita tuya");
    expect(p.body).toBe("Semipermanente manos\nLaura M. · mañana 10 a. m. → 3 p. m.");
  });

  it("reasignada: el equipo ve de quién a quién", () => {
    const p = buildChangePayload("team", { moved: false, reassigned: true, edited: false }, notice, today, "/admin");
    expect(p.title).toBe("Cita reasignada");
    expect(p.body).toContain("ahora con Lina (antes Daniela)");
  });

  it("reasignada: para la que la recibe es una cita nueva", () => {
    const p = buildChangePayload("own", { moved: false, reassigned: true, edited: false }, notice, today, "/admin");
    expect(p.title).toBe("Nueva cita en tu agenda ✨");
    expect(p.body).not.toContain("Daniela");
  });

  it("la que la pierde: ni a quién pasó ni el enlace a la cita, que ya no ve", () => {
    const p = buildChangePayload("left", { moved: true, reassigned: true, edited: false }, notice, today, "/admin");
    expect(p.title).toBe("Una cita salió de tu agenda");
    expect(p.body).toBe("Semipermanente manos\nLaura M. · mañana 10 a. m.");
    expect(p.body).not.toContain("Lina");
    expect(p.url).toBe("/admin/agenda?dia=2026-10-23");
  });

  it("solo editada (servicio, duración): «Cita modificada» con la hora de ahora", () => {
    const p = buildChangePayload("team", { moved: false, reassigned: false, edited: true }, notice, today, "/admin");
    expect(p.title).toBe("Cita modificada");
    expect(p.body).toContain("sáb 24 oct 3 p. m.");
    expect(p.body).not.toContain("→");
  });

  it("nunca lleva teléfono ni precio", () => {
    const smuggled = { ...notice, phone: "+573001234567", price: "$45.000" } as ChangeNotice;
    for (const audience of ["team", "own", "left"] as const) {
      const all = JSON.stringify(buildChangePayload(audience, moved, smuggled, today, "/admin"));
      expect(all).not.toContain("3001234567");
      expect(all).not.toMatch(/\$\s?\d/);
    }
  });
});

describe("buildCancelPayload", () => {
  const notice = { ...BASE, actorName: "Andrea" };

  it("equipo: con quién era y quién la canceló", () => {
    const p = buildCancelPayload("team", notice, "2026-10-16", "/admin");
    expect(p.title).toBe("Cita cancelada");
    expect(p.body).toBe("Semipermanente manos\nLaura M. · mañana 3:30 p. m. con Lina · por Andrea");
    expect(p.tag).toBe("reserva-812");
  });

  it("técnica: sin con quién ni quién", () => {
    const p = buildCancelPayload("own", notice, "2026-10-16", "/admin");
    expect(p.title).toBe("Se canceló una cita tuya");
    expect(p.body).toBe("Semipermanente manos\nLaura M. · mañana 3:30 p. m.");
  });
});
