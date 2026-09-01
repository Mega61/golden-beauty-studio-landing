import { describe, expect, it } from "vitest";

import { EaApiError } from "./errors";
import {
  buildListParams,
  createEaClient,
  decodeAppointmentWithRelations,
  eaConfigFromEnv,
  eaDateParam,
  type EaClientConfig,
} from "./client";

const TOKEN = "un-token-de-ea-larguisimo-y-secreto";
const BASE = "http://ea.internal/index.php/api/v1";

type Call = { url: URL; init: RequestInit };

/**
 * `fetch` de mentira que registra lo que se le pidió.
 *
 * Se le pasa una función que decide la respuesta por llamada, así los tests de
 * paginación pueden simular las páginas sucesivas sin montar un servidor.
 */
function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];

  const impl = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const call = { url, init: init ?? {} };
    calls.push(call);
    return handler(call, calls.length - 1);
  }) as typeof fetch;

  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function client(handler: (call: Call, index: number) => Response | Promise<Response>, extra: Partial<EaClientConfig> = {}) {
  const { impl, calls } = fakeFetch(handler);
  return {
    ea: createEaClient({ baseUrl: BASE, token: TOKEN, fetch: impl, pageLength: 100, ...extra }),
    calls,
  };
}

const appointment = (id: number) => ({
  id,
  book: "2026-08-20 09:12:33",
  start: "2026-08-31 14:00:00",
  end: "2026-08-31 15:30:00",
  hash: `h${id}`,
  color: null,
  status: "Booked",
  location: null,
  notes: null,
  customerId: 5,
  providerId: 2,
  serviceId: 6,
  meetingLink: null,
  googleCalendarId: null,
  caldavCalendarId: null,
});

describe("configuración", () => {
  it("falla nombrando la variable que falta, nunca mostrando la que está", () => {
    expect(() => eaConfigFromEnv({ EA_API_TOKEN: TOKEN })).toThrow("Falta EA_API_URL");
    expect(() => eaConfigFromEnv({ EA_API_URL: BASE })).toThrow("Falta EA_API_TOKEN");

    try {
      eaConfigFromEnv({ EA_API_URL: BASE });
    } catch (error) {
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  it("rechaza una URL que no es una URL", () => {
    expect(() => eaConfigFromEnv({ EA_API_URL: "ea.internal", EA_API_TOKEN: TOKEN })).toThrow(
      /no es una URL/,
    );
  });

  it("lee los valores y los defaults", () => {
    const config = eaConfigFromEnv({ EA_API_URL: BASE, EA_API_TOKEN: TOKEN });

    expect(config.baseUrl).toBe(BASE);
    expect(config.pageLength).toBeGreaterThan(20);
  });
});

describe("la petición", () => {
  it("manda el token como Bearer y no lo pone en la URL", async () => {
    const { ea, calls } = client(() => json([]));

    await ea.appointments.list();

    const headers = new Headers(calls[0].init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[0].url.toString()).not.toContain(TOKEN);
  });

  it("resuelve la ruta aunque la base venga sin barra final", async () => {
    const { ea, calls } = client(() => json([]));

    await ea.appointments.list();

    expect(calls[0].url.pathname).toBe("/index.php/api/v1/appointments");
  });

  it("no cachea: la agenda de hace un minuto es la agenda equivocada", async () => {
    const { ea, calls } = client(() => json([]));

    await ea.appointments.list();

    expect(calls[0].init.cache).toBe("no-store");
  });
});

describe("paginación — no puede truncar en silencio", () => {
  it("pagina hasta agotar y devuelve todo", async () => {
    // 250 citas: EA daría 20 por defecto. Con `length` explícito de 100 son
    // tres viajes, y el tercero viene corto, que es la única señal de fin.
    const pages = [
      Array.from({ length: 100 }, (_, i) => appointment(i + 1)),
      Array.from({ length: 100 }, (_, i) => appointment(i + 101)),
      Array.from({ length: 50 }, (_, i) => appointment(i + 201)),
    ];

    const { ea, calls } = client((_call, i) => json(pages[i]));

    const items = await ea.appointments.list({ from: "2026-08-31", till: "2026-09-06" });

    expect(items).toHaveLength(250);
    expect(items.at(-1)?.id).toBe(250);
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(calls.every((c) => c.url.searchParams.get("length") === "100")).toBe(true);
  });

  it("siempre manda length explícito: nunca deja que EA use su 20", async () => {
    const { ea, calls } = client(() => json([]));

    await ea.customers.list();

    expect(calls[0].url.searchParams.get("length")).toBe("100");
  });

  it("con un total múltiplo exacto hace un viaje de más antes de darse por cerrado", async () => {
    const full = Array.from({ length: 10 }, (_, i) => appointment(i + 1));
    const { ea, calls } = client((_call, i) => json(i === 0 ? full : []), { pageLength: 10 });

    const items = await ea.appointments.list();

    expect(items).toHaveLength(10);
    expect(calls).toHaveLength(2);
  });

  it("si el listado no se agota, lanza en vez de devolver una agenda incompleta", async () => {
    const full = Array.from({ length: 10 }, (_, i) => appointment(i + 1));
    const { ea } = client(() => json(full), { pageLength: 10, maxPages: 3 });

    await expect(ea.appointments.list()).rejects.toMatchObject({
      kind: "pagination_overflow",
    });
  });

  it("listPage exige length y expone que hay más", async () => {
    const full = Array.from({ length: 25 }, (_, i) => appointment(i + 1));
    const { ea, calls } = client(() => json(full));

    const page = await ea.appointments.listPage({ page: 2, length: 25 });

    expect(page).toMatchObject({ page: 2, length: 25, hasMore: true });
    expect(page.items).toHaveLength(25);
    expect(calls[0].url.searchParams.get("page")).toBe("2");
  });

  it("listPage sin registros suficientes reporta que no hay más", async () => {
    const { ea } = client(() => json([appointment(1)]));

    await expect(ea.appointments.listPage({ length: 25 })).resolves.toMatchObject({
      hasMore: false,
    });
  });

  it("listPage rechaza un length inválido antes de salir a la red", async () => {
    const { ea, calls } = client(() => json([]));

    await expect(ea.appointments.listPage({ length: 0 })).rejects.toBeInstanceOf(EaApiError);
    expect(calls).toHaveLength(0);
  });
});

describe("filtros y helpers", () => {
  it("from y till se normalizan a YYYY-MM-DD, que es lo que EA compara", async () => {
    const { ea, calls } = client(() => json([]));

    await ea.appointments.list({
      from: "2026-08-31 09:00:00",
      till: new Date("2026-09-07T02:00:00.000Z"),
    });

    expect(calls[0].url.searchParams.get("from")).toBe("2026-08-31");
    // 02:00 UTC del 7 todavía es 6 de septiembre en el estudio. Que la fecha se
    // resuelva en la zona del estudio y no en la del contenedor es el punto.
    expect(calls[0].url.searchParams.get("till")).toBe("2026-09-06");
  });

  it("rechaza q junto a un filtro, porque EA lo ignoraría sin avisar", async () => {
    const { ea, calls } = client(() => json([]));

    await expect(ea.appointments.list({ q: "Ana", from: "2026-08-31" })).rejects.toThrow(
      /ignora los filtros/,
    );
    expect(calls).toHaveLength(0);
  });

  it("q solo sí pasa", async () => {
    const { ea, calls } = client(() => json([]));

    await ea.appointments.list({ q: "Ana" });

    expect(calls[0].url.searchParams.get("q")).toBe("Ana");
  });

  it("rechaza un fields= que dejaría la respuesta indecodificable", async () => {
    const { ea, calls } = client(() => json([]));

    await expect(ea.appointments.list({ fields: ["id", "start"] })).rejects.toThrow(/end/);
    expect(calls).toHaveLength(0);
  });

  it("acepta un fields= que conserva los obligatorios", async () => {
    const { ea, calls } = client(() => json([]));

    await ea.appointments.list({ fields: ["id", "start", "end", "status"] });

    expect(calls[0].url.searchParams.get("fields")).toBe("id,start,end,status");
  });

  it("sort y with se serializan separados por coma", () => {
    const params = buildListParams({ sort: ["-start", "id"], with: ["customer", "service"] });

    expect(params.get("sort")).toBe("-start,id");
    expect(params.get("with")).toBe("customer,service");
  });

  it("eaDateParam recorta la hora de un datetime", () => {
    expect(eaDateParam("2026-08-31 23:59:59")).toBe("2026-08-31");
  });
});

describe("errores tipados", () => {
  it("401 es un problema de configuración, no de disponibilidad", async () => {
    const { ea } = client(
      () => new Response("You are not authorized to use the API.", { status: 401 }),
    );

    const error = await ea.appointments.list().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EaApiError);
    expect(error).toMatchObject({ kind: "unauthorized", status: 401 });
    expect((error as EaApiError).isConfiguration).toBe(true);
    expect((error as EaApiError).isTransient).toBe(false);
  });

  it("404 se distingue de todo lo demás", async () => {
    const { ea } = client(() => new Response("", { status: 404 }));

    await expect(ea.appointments.get(999)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("5xx es transitorio: es lo que dispara el modo solo-lectura", async () => {
    const { ea } = client(() => new Response("Fatal error", { status: 500 }));

    const error = (await ea.appointments.list().catch((e: unknown) => e)) as EaApiError;

    expect(error.kind).toBe("server");
    expect(error.isTransient).toBe(true);
  });

  it("una red caída no es un 500, y también es transitoria", async () => {
    const { ea } = client(() => {
      throw new TypeError("fetch failed");
    });

    const error = (await ea.appointments.list().catch((e: unknown) => e)) as EaApiError;

    expect(error.kind).toBe("network");
    expect(error.isTransient).toBe(true);
  });

  it("un timeout se separa de la red caída: EA vivo pero lento se diagnostica distinto", async () => {
    const { ea } = client(() => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    await expect(ea.appointments.list()).rejects.toMatchObject({ kind: "timeout" });
  });

  it("un 200 que no es JSON es malformado, no un éxito vacío", async () => {
    const { ea } = client(() => new Response("<html>error de PHP</html>", { status: 200 }));

    await expect(ea.appointments.list()).rejects.toMatchObject({ kind: "malformed" });
  });

  it("un 200 con un objeto donde va una lista es malformado", async () => {
    const { ea } = client(() => json({ success: false }));

    await expect(ea.appointments.list()).rejects.toMatchObject({ kind: "malformed" });
  });
});

describe("el token no se filtra por ningún lado", () => {
  it("no aparece en el mensaje, ni en el cuerpo guardado, ni en la ruta", async () => {
    // EA imprime la excepción con debug info en sus 500. Si algún día eso
    // incluyera el token configurado, el error del cliente sería una credencial
    // publicada en el log.
    const { ea } = client(
      () =>
        new Response(`Fatal: token ${TOKEN} rejected by settings`, {
          status: 500,
        }),
    );

    const error = (await ea.appointments.list().catch((e: unknown) => e)) as EaApiError;

    expect(error.message).not.toContain(TOKEN);
    expect(error.body).not.toContain(TOKEN);
    expect(error.body).toContain("«token»");
    expect(error.path).toBe("appointments");
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(TOKEN);
  });

  it("un cuerpo enorme se recorta antes de guardarse", async () => {
    const { ea } = client(() => new Response("x".repeat(5000), { status: 500 }));

    const error = (await ea.appointments.list().catch((e: unknown) => e)) as EaApiError;

    expect(error.body?.length).toBeLessThan(600);
  });
});

describe("escrituras", () => {
  it("crear manda camelCase y devuelve dominio", async () => {
    const { ea, calls } = client(() => json(appointment(99), 201));

    const created = await ea.appointments.create({
      start: "2026-08-31 14:00:00" as never,
      end: "2026-08-31 15:30:00" as never,
      providerId: 2,
      serviceId: 6,
      customerId: 5,
      status: "Booked",
    });

    expect(created.id).toBe(99);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      start: "2026-08-31 14:00:00",
      end: "2026-08-31 15:30:00",
      providerId: 2,
      serviceId: 6,
      customerId: 5,
      status: "Booked",
    });
  });

  it("actualizar manda solo lo que cambió", async () => {
    const { ea, calls } = client(() => json(appointment(42)));

    await ea.appointments.update(42, { status: "Cancelled" });

    expect(calls[0].url.pathname.endsWith("/appointments/42")).toBe(true);
    expect(calls[0].init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ status: "Cancelled" });
  });

  it("borrar acepta el 204 sin cuerpo", async () => {
    const { ea } = client(() => new Response(null, { status: 204 }));

    await expect(ea.appointments.remove(42)).resolves.toBeUndefined();
  });
});

describe("availabilities", () => {
  it("pide una técnica y un servicio, y le pega el contexto a la respuesta", async () => {
    const { ea, calls } = client(() => json(["09:00", "09:30"]));

    const availability = await ea.availabilities({
      providerId: 2,
      serviceId: 6,
      date: "2026-08-31",
    });

    expect(availability.hours).toEqual(["09:00", "09:30"]);
    expect(calls[0].url.searchParams.get("providerId")).toBe("2");
    expect(calls[0].url.searchParams.get("date")).toBe("2026-08-31");
  });
});

describe("settings", () => {
  it("lee y escribe por nombre, no por id", async () => {
    const { ea, calls } = client(() => json({ name: "company_name", value: "Golden Beauty" }));

    await ea.settings.update("company_name", "Golden Beauty");

    expect(calls[0].url.pathname.endsWith("/settings/company_name")).toBe(true);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ value: "Golden Beauty" });
  });
});

describe("relaciones adjuntas con with=", () => {
  it("decodifica la mezcla: cita en camelCase, relaciones en snake_case", () => {
    // Es la forma real: `Appointments_model::load()` pega la fila cruda tal
    // cual, sin `api_encode()`. Un mapeo que solo supiera camelCase leería
    // `undefined` en todos los campos de la clienta y no fallaría.
    const decoded = decodeAppointmentWithRelations({
      ...appointment(42),
      customer: { id: 5, first_name: "Ana", phone_number: "+573001112233" },
      service: { id: 6, name: "Acrílicas", price: "180000.00", color: "#d4af37" },
      provider: { id: 2, first_name: "Luisa" },
    });

    expect(decoded.appointment.id).toBe(42);
    expect(decoded.customer?.firstName).toBe("Ana");
    expect(decoded.customer?.phone).toBe("+573001112233");
    expect(decoded.service?.price).toBe(180000);
    // Y por acá sí se lee el color, que la API nunca devuelve.
    expect(decoded.service?.color).toBe("#d4af37");
    expect(decoded.provider?.firstName).toBe("Luisa");
  });

  it("sin relaciones adjuntas, quedan en null sin romper", () => {
    const decoded = decodeAppointmentWithRelations(appointment(42));

    expect(decoded.customer).toBeNull();
    expect(decoded.service).toBeNull();
    expect(decoded.provider).toBeNull();
  });
});
