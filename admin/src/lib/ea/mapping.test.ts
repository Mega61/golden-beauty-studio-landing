import { afterEach, describe, expect, it } from "vitest";

import type { EaLocalDate } from "./datetime";
import {
  EA_CODECS,
  EA_FIELD_TABLES,
  EaMappingError,
  appointmentCodec,
  availabilityFromApi,
  blockedPeriodCodec,
  customerCodec,
  parseWebhookEnvelope,
  providerCodec,
  requiredApiFields,
  serviceCodec,
  unavailabilityCodec,
  webhookCodec,
  workingPlanExceptionCodec,
} from "./mapping";
import type { Appointment } from "./types";

/**
 * Fixtures copiados de la forma real de EA, no inventados.
 *
 * `API_APPOINTMENT` es lo que emite `Appointments_model::api_encode()`, campo
 * por campo y en su orden. `ROW_APPOINTMENT` es la fila cruda que llega en el
 * webhook — la misma cita, la otra forma. Que las dos decodifiquen al **mismo**
 * objeto de dominio es la invariante que sostiene todo el paquete: el reconcile
 * lee por API y el webhook llega por fila, y tienen que producir lo mismo o el
 * panel duplica citas creyendo que son distintas.
 */
const API_APPOINTMENT = {
  id: 42,
  book: "2026-08-20 09:12:33",
  start: "2026-08-31 14:00:00",
  end: "2026-08-31 15:30:00",
  hash: "apTWVbSvBJXR",
  color: "#123456",
  status: "Booked",
  location: "Estudio",
  notes: "Forrado con diseño",
  customerId: 5,
  providerId: 2,
  serviceId: 6,
  meetingLink: null,
  googleCalendarId: null,
  caldavCalendarId: null,
} as const;

const ROW_APPOINTMENT = {
  id: 42,
  book_datetime: "2026-08-20 09:12:33",
  start_datetime: "2026-08-31 14:00:00",
  end_datetime: "2026-08-31 15:30:00",
  hash: "apTWVbSvBJXR",
  color: "#123456",
  status: "Booked",
  location: "Estudio",
  notes: "Forrado con diseño",
  id_users_customer: 5,
  id_users_provider: 2,
  id_services: 6,
  meeting_link: null,
  id_google_calendar: null,
  id_caldav_calendar: null,
  // La fila trae esta columna y el dominio no la modela: el webhook ya separa
  // citas de huecos por la acción (`appointment_save` vs `unavailability_save`).
  is_unavailability: 0,
} as const;

const API_UNAVAILABILITY = {
  id: 7,
  book: "2026-08-20 09:12:33",
  start: "2026-08-31 12:00:00",
  end: "2026-08-31 13:00:00",
  hash: "zzz",
  location: null,
  notes: "Almuerzo",
  providerId: 2,
  googleCalendarId: null,
  caldavCalendarId: null,
} as const;

const originalTZ = process.env.TZ;

afterEach(() => {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
});

describe("citas — los tres sentidos", () => {
  it("la API y la fila cruda decodifican al mismo dominio", () => {
    expect(appointmentCodec.fromRow(ROW_APPOINTMENT)).toEqual(
      appointmentCodec.fromApi(API_APPOINTMENT),
    );
  });

  it("dominio → API → dominio es identidad", () => {
    const domain = appointmentCodec.fromApi(API_APPOINTMENT);

    expect(appointmentCodec.fromApi(appointmentCodec.toApi(domain))).toEqual(domain);
  });

  it("API → dominio → API es identidad", () => {
    expect(appointmentCodec.toApi(appointmentCodec.fromApi(API_APPOINTMENT))).toEqual(
      API_APPOINTMENT,
    );
  });

  it("fila → dominio → fila es identidad sobre las columnas mapeadas", () => {
    const domain = appointmentCodec.fromRow(ROW_APPOINTMENT);
    const back = appointmentCodec.toRow(domain);

    const mapped = Object.fromEntries(
      Object.entries(ROW_APPOINTMENT).filter(([key]) => appointmentCodec.rowKeys().includes(key)),
    );

    expect(back).toEqual(mapped);
  });

  it("las columnas que el dominio no modela se caen, y eso está declarado", () => {
    const back = appointmentCodec.toRow(appointmentCodec.fromRow(ROW_APPOINTMENT));

    expect(back).not.toHaveProperty("is_unavailability");
    expect(appointmentCodec.rowKeys()).not.toContain("is_unavailability");
  });

  it("el puente API ⇄ fila pasa por el dominio sin perder nada mapeado", () => {
    const viaApi = appointmentCodec.toRow(appointmentCodec.fromApi(API_APPOINTMENT));
    const viaRow = appointmentCodec.toRow(appointmentCodec.fromRow(ROW_APPOINTMENT));

    expect(viaApi).toEqual(viaRow);
  });

  it.each(["UTC", "America/Bogota", "Pacific/Kiritimati"])(
    "decodifica igual con TZ=%s",
    (timeZone) => {
      process.env.TZ = timeZone;

      const domain = appointmentCodec.fromApi(API_APPOINTMENT);

      // Hora de pared, tal cual EA la guardó. Ninguna zona la mueve porque
      // nunca se construye un `Date` en el camino.
      expect(domain.start).toBe("2026-08-31 14:00:00");
      expect(domain.end).toBe("2026-08-31 15:30:00");
    },
  );
});

/** Copia el fixture sin una clave, sin dejar variables sueltas de por medio. */
function sin(source: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([k]) => k !== key));
}

describe("citas — bordes", () => {
  it("un id ausente falla nombrando el campo y sugiriendo la causa", () => {
    const sinId = sin(API_APPOINTMENT, "id");

    expect(() => appointmentCodec.fromApi(sinId)).toThrow(EaMappingError);
    expect(() => appointmentCodec.fromApi(sinId)).toThrow(/id:[\s\S]*fields=/);
  });

  it("un start vacío falla en vez de producir una cita sin hora", () => {
    expect(() => appointmentCodec.fromApi({ ...API_APPOINTMENT, start: null })).toThrow(
      /start.*obligatorio/,
    );
  });

  it("el estado ausente cae a cadena vacía, no rompe la agenda", () => {
    expect(appointmentCodec.fromApi(sin(API_APPOINTMENT, "status")).status).toBe("");
  });

  it("un estado que EA no siembra pasa igual: la columna es texto libre", () => {
    expect(appointmentCodec.fromApi({ ...API_APPOINTMENT, status: "Completada" }).status).toBe(
      "Completada",
    );
  });

  it("los ceros de MySQL son null, no una fecha inválida", () => {
    const domain = appointmentCodec.fromRow({
      ...ROW_APPOINTMENT,
      book_datetime: "0000-00-00 00:00:00",
    });

    expect(domain.bookedAt).toBeNull();
  });

  it("los ids llegan como string desde algunos drivers y se normalizan", () => {
    const domain = appointmentCodec.fromRow({
      ...ROW_APPOINTMENT,
      id: "42",
      id_services: "6",
    });

    expect(domain.id).toBe(42);
    expect(domain.serviceId).toBe(6);
  });

  it("el id de Google llega entero en un recurso y string en otro: se unifica a texto", () => {
    // `Unavailabilities_model` le hace `(int)` y `Appointments_model` no. El
    // dominio no puede tener dos tipos para el mismo concepto.
    expect(unavailabilityCodec.fromApi({ ...API_UNAVAILABILITY, googleCalendarId: 1234 })
      .googleCalendarId).toBe("1234");
  });

  it("un datetime con basura adentro falla nombrando el campo", () => {
    expect(() => appointmentCodec.fromApi({ ...API_APPOINTMENT, end: "ayer" })).toThrow(
      /end.*inválido/,
    );
  });

  it("un input parcial manda solo lo que cambió", () => {
    const parche: Partial<Appointment> = { status: "Cancelled" };

    expect(appointmentCodec.toApi(parche)).toEqual({ status: "Cancelled" });
  });

  it("un null explícito sí viaja: es cómo se borran las notas", () => {
    expect(appointmentCodec.toApi({ notes: null })).toEqual({ notes: null });
  });
});

describe("huecos no disponibles", () => {
  it("ida y vuelta por la API", () => {
    expect(unavailabilityCodec.toApi(unavailabilityCodec.fromApi(API_UNAVAILABILITY))).toEqual(
      API_UNAVAILABILITY,
    );
  });

  it("no modela color ni estado, porque el api_encode de EA no los emite", () => {
    expect(unavailabilityCodec.apiKeys()).not.toContain("color");
    expect(unavailabilityCodec.apiKeys()).not.toContain("status");
  });
});

describe("bloqueos de estudio", () => {
  const API_BLOCKED = {
    id: 3,
    name: "Festivo",
    start: "2026-01-01 00:00:00",
    end: "2026-01-01 23:59:59",
    notes: null,
  } as const;

  it("ida y vuelta", () => {
    expect(blockedPeriodCodec.toApi(blockedPeriodCodec.fromApi(API_BLOCKED))).toEqual(API_BLOCKED);
  });

  it("no tiene técnica, y eso es la funcionalidad: tapa a todas", () => {
    expect(blockedPeriodCodec.apiKeys()).not.toContain("providerId");
    expect(blockedPeriodCodec.rowKeys()).not.toContain("id_users_provider");
  });
});

describe("servicios — el color es de solo escritura en EA", () => {
  /** Lo que EA realmente devuelve: sin `color`, aunque el spec lo prometa. */
  const API_SERVICE = {
    id: 6,
    name: "Acrílicas esculpidas",
    duration: 120,
    price: 180000,
    currency: "COP",
    location: "",
    description: "",
    slotInterval: 30,
    attendantsNumber: 1,
    isPrivate: false,
    serviceCategoryId: null,
  } as const;

  it("una respuesta real de EA no trae color, y el dominio lo refleja", () => {
    expect(serviceCodec.fromApi(API_SERVICE).color).toBeNull();
  });

  it("un leer-modificar-guardar NO borra el color que la dueña puso en EA", () => {
    // Éste es el test que importa. Sin la regla de `apiWriteOnly`, subir el
    // precio de un servicio le borraría el color de rebote, y nadie sabría por
    // qué se despintó el calendario.
    const domain = serviceCodec.fromApi(API_SERVICE);
    const payload = serviceCodec.toApi({ ...domain, price: 195000 });

    expect(payload).not.toHaveProperty("color");
    expect(payload.price).toBe(195000);
  });

  it("un color puesto a mano sí se manda", () => {
    expect(serviceCodec.toApi({ color: "#d4af37" })).toEqual({ color: "#d4af37" });
  });

  it("la fila cruda sí trae el color: por ahí se lee de verdad", () => {
    const domain = serviceCodec.fromRow({
      id: 6,
      name: "Acrílicas esculpidas",
      duration: 120,
      price: "180000.00",
      currency: "COP",
      color: "#d4af37",
      slot_interval: 30,
      attendants_number: 1,
      is_private: 0,
      id_service_categories: null,
    });

    expect(domain.color).toBe("#d4af37");
    expect(domain.price).toBe(180000);
    expect(domain.isPrivate).toBe(false);
  });

  it("el precio decimal de MySQL llega como string y se numera", () => {
    expect(serviceCodec.fromRow({ id: 1, price: "180000.50" }).price).toBe(180000.5);
  });
});

describe("clientas", () => {
  it("phone mapea a phone_number en la fila y a phone en la API", () => {
    const domain = customerCodec.fromRow({ id: 9, phone_number: "+573001112233" });

    expect(domain.phone).toBe("+573001112233");
    expect(customerCodec.toApi(domain).phone).toBe("+573001112233");
  });
});

describe("técnicas — ajustes anidados y secretos que no aterrizan", () => {
  const API_PROVIDER = {
    id: 2,
    firstName: "Ana",
    lastName: "Díaz",
    email: "ana@example.org",
    mobile: "+573001112233",
    phone: null,
    address: null,
    city: null,
    state: null,
    zip: null,
    notes: null,
    timezone: "UTC",
    language: "spanish",
    isPrivate: false,
    ldapDn: null,
    services: [6, 7],
    settings: {
      username: "ana",
      notifications: true,
      calendarView: "default",
      googleSync: true,
      googleToken: "tok",
      googleCalendar: "cal-id",
      caldavSync: false,
      caldavUrl: null,
      caldavUsername: null,
      caldavPassword: "no debería sobrevivir",
      syncFutureDays: 90,
      syncPastDays: 30,
      workingPlan: {
        monday: { start: "09:00", end: "18:00", breaks: [] },
        sunday: null,
      },
      workingPlanExceptions: [],
    },
  } as const;

  it("la contraseña de CalDAV no tiene dónde aterrizar, así que no sobrevive", () => {
    const domain = providerCodec.fromApi(API_PROVIDER);

    expect(JSON.stringify(domain)).not.toContain("no debería sobrevivir");
    expect(providerCodec.toApi(domain).settings).not.toHaveProperty("caldavPassword");
  });

  it("workingPlan llega como objeto por la API y como string JSON en la fila", () => {
    const desdeApi = providerCodec.fromApi(API_PROVIDER);
    const desdeFila = providerCodec.fromRow({
      id: 2,
      first_name: "Ana",
      settings: {
        working_plan: JSON.stringify(API_PROVIDER.settings.workingPlan),
      },
    });

    expect(desdeApi.settings?.workingPlan).toEqual(API_PROVIDER.settings.workingPlan);
    expect(desdeFila.settings?.workingPlan).toEqual(API_PROVIDER.settings.workingPlan);
  });

  it("al escribir la fila, el plan vuelve a ser un string JSON", () => {
    const domain = providerCodec.fromApi(API_PROVIDER);
    const row = providerCodec.toRow(domain);
    const settings = row.settings as Record<string, unknown>;

    expect(typeof settings.working_plan).toBe("string");
    expect(JSON.parse(settings.working_plan as string)).toEqual(API_PROVIDER.settings.workingPlan);
  });

  it("los booleanos de la fila son 1/0", () => {
    const domain = providerCodec.fromRow({ id: 2, is_private: 1 });

    expect(domain.isPrivate).toBe(true);
    expect(providerCodec.toRow(domain).is_private).toBe(1);
  });
});

describe("webhooks registrados en EA", () => {
  it("secretHeader no existe en la API aunque la columna sí exista", () => {
    expect(webhookCodec.apiKeys()).not.toContain("secretHeader");
  });

  it("ida y vuelta de lo que sí expone", () => {
    const api = {
      id: 1,
      name: "Panel",
      url: "http://admin:3000/api/webhooks/ea",
      actions: "appointment_save,appointment_delete",
      secretToken: "s3cr3t",
      isSslVerified: false,
      notes: null,
    } as const;

    expect(webhookCodec.toApi(webhookCodec.fromApi(api))).toEqual(api);
  });
});

describe("excepciones al plan de trabajo", () => {
  it("sin descansos, breaks es una lista vacía y no null", () => {
    const domain = workingPlanExceptionCodec.fromApi({
      id: 1,
      startDate: "2026-01-15",
      endDate: "2026-01-20",
      startTime: "09:00",
      endTime: "17:00",
      providerId: 1,
    });

    expect(domain.breaks).toEqual([]);
  });

  it("un día libre es startTime y endTime en null, y eso es información", () => {
    const domain = workingPlanExceptionCodec.fromApi({
      id: 1,
      startDate: "2026-01-15",
      endDate: "2026-01-15",
      startTime: null,
      endTime: null,
      providerId: 1,
    });

    expect(domain.startTime).toBeNull();
    expect(domain.endTime).toBeNull();
  });

  it("las horas con segundos se normalizan a HH:MM", () => {
    const domain = workingPlanExceptionCodec.fromRow({
      id: 1,
      start_date: "2026-01-15",
      start_time: "09:00:00",
      breaks: '[{"start":"12:00","end":"13:00"}]',
      id_users_provider: 1,
    });

    expect(domain.startTime).toBe("09:00");
    expect(domain.breaks).toEqual([{ start: "12:00", end: "13:00" }]);
  });
});

describe("availabilities", () => {
  it("le pega el contexto que EA no devuelve", () => {
    const availability = availabilityFromApi(
      { providerId: 2, serviceId: 6, date: "2026-08-31" as EaLocalDate },
      ["09:00", "09:30", "10:00"],
    );

    expect(availability).toEqual({
      providerId: 2,
      serviceId: 6,
      date: "2026-08-31",
      hours: ["09:00", "09:30", "10:00"],
    });
  });

  it("rechaza una respuesta que no es una lista", () => {
    expect(() =>
      availabilityFromApi({ providerId: 1, serviceId: 1, date: "2026-08-31" as EaLocalDate }, {}),
    ).toThrow(EaMappingError);
  });
});

describe("sobre del webhook", () => {
  it("acepta la forma que EA hace POST", () => {
    const envelope = parseWebhookEnvelope({
      action: "appointment_save",
      payload: ROW_APPOINTMENT,
    });

    expect(envelope.action).toBe("appointment_save");
    expect(appointmentCodec.fromRow(envelope.payload).id).toBe(42);
  });

  it("rechaza las acciones que el openapi.yml de EA inventa en su ejemplo", () => {
    // El spec de EA da como ejemplo `appointment_create,appointment_update,…`,
    // que no son constantes reales. Un webhook registrado con esos nombres
    // queda mudo sin error, así que el nombre se valida acá.
    expect(() =>
      parseWebhookEnvelope({ action: "appointment_create", payload: {} }),
    ).toThrow(/acción desconocida/);
  });

  it("rechaza un cuerpo sin payload", () => {
    expect(() => parseWebhookEnvelope({ action: "appointment_save" })).toThrow(EaMappingError);
    expect(() => parseWebhookEnvelope("nada")).toThrow(EaMappingError);
  });
});

describe("integridad de las tablas", () => {
  it("ningún recurso mapea dos campos de dominio a la misma clave", () => {
    for (const [resource, codec] of Object.entries(EA_CODECS)) {
      const apiKeys = codec.apiKeys();
      const rowKeys = codec.rowKeys();

      expect(new Set(apiKeys).size, `${resource}: claves camelCase repetidas`).toBe(apiKeys.length);
      expect(new Set(rowKeys).size, `${resource}: columnas repetidas`).toBe(rowKeys.length);
    }
  });

  it("los doce recursos con tabla tienen codec", () => {
    expect(Object.keys(EA_CODECS).sort()).toEqual(Object.keys(EA_FIELD_TABLES).sort());
  });

  it("requiredApiFields dice qué no se puede recortar con fields=", () => {
    expect(requiredApiFields("appointments")).toEqual(["id", "start", "end"]);
    expect(requiredApiFields("customers")).toEqual(["id"]);
  });
});
