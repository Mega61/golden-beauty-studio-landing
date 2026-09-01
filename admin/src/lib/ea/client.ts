/**
 * Cliente HTTP tipado de la API v1 de Easy!Appointments.
 *
 * `server-only` es la guarda: este módulo lee `EA_API_TOKEN`, y un token de
 * administración de EA en el bundle del navegador es la cuenta entera regalada.
 * El import hace que cualquier intento de importarlo desde un componente
 * cliente falle en el build, no en producción. Bajo Vitest está aliaseado al
 * stub de `test/stubs/`.
 *
 * ---
 *
 * ## Lo que este cliente existe para evitar
 *
 * **1. Truncar un listado en silencio.** `Api::$default_length` de EA vale
 * **20**. Un `GET /appointments?from=…&till=…` de una semana con tres técnicas
 * pasa de 20 sin esfuerzo, y EA devuelve las primeras veinte con un `200` y
 * sin ninguna señal de que hay más: la respuesta es un arreglo pelado, sin
 * total, sin `next`, sin `Link`. La agenda se vería completa y le faltaría una
 * cita. Por eso acá hay exactamente dos formas de listar, y ninguna puede
 * mentir:
 *
 * - `list()` **pagina hasta agotar**. Si el tope de seguridad se alcanza,
 *   lanza `pagination_overflow` en vez de devolver lo que alcanzó.
 * - `listPage()` **exige `length` explícito** y devuelve `hasMore`.
 *
 * No hay un tercer método que devuelva "los primeros N" sin decirlo.
 *
 * **2. Mezclar `q` con filtros.** En `Appointments_api_v1::index()` el
 * `$where` (from / till / providerId / serviceId / customerId) se arma siempre,
 * pero se **ignora** si vino `q`: el modelo llama a `search()` en vez de
 * `get()`. Buscar "Ana" dentro de una semana devuelve todas las "Ana" de la
 * historia, sin error. El cliente rechaza esa combinación antes de salir.
 *
 * **3. Filtrar por hora.** `from` y `till` comparan `DATE(start_datetime) >=` y
 * `DATE(end_datetime) <=`: **granularidad de día, inclusivos los dos extremos**,
 * y el extremo derecho mira la hora de *fin*. Pasar `"2026-08-31 09:00:00"`
 * no filtra desde las nueve — filtra desde ese día completo. El cliente
 * normaliza a `YYYY-MM-DD` para que nadie crea lo contrario, y el recorte fino
 * por hora se hace acá con los datos ya traídos.
 *
 * **4. Filtrar el turno de la noche.** Como `till` compara contra
 * `end_datetime`, una cita que empieza el último día del rango y termina
 * después de medianoche **queda fuera**. Para una jornada que cierra a las
 * 20:00 da igual; está escrito para el día que no.
 */

import "server-only";

import { eaDatePart, instantToEaDate, type EaLocalDate, type EaLocalDateTime } from "./datetime";
import { EaApiError, kindForStatus, kindForThrown, safeBody, scrubSecret } from "./errors";
import {
  EA_CODECS,
  availabilityFromApi,
  requiredApiFields,
  type EaCodec,
  type EaMappedResource,
} from "./mapping";
import type {
  Admin,
  AdminInput,
  ApiShape,
  Appointment,
  AppointmentInput,
  Availability,
  BlockedPeriod,
  BlockedPeriodInput,
  Customer,
  CustomerInput,
  Provider,
  ProviderInput,
  Secretary,
  SecretaryInput,
  Service,
  ServiceCategory,
  ServiceCategoryInput,
  ServiceInput,
  Setting,
  Unavailability,
  UnavailabilityInput,
  Webhook,
  WebhookInput,
  WorkingPlanException,
  WorkingPlanExceptionInput,
} from "./types";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

export type EaClientConfig = {
  /** Base de la API, p. ej. `http://ea/index.php/api/v1/`. */
  baseUrl: string;
  /** Token Bearer de Ajustes de EA. No se registra en ningún lado. */
  token: string;
  /** Inyectable para los tests. Por defecto el `fetch` del runtime. */
  fetch?: typeof fetch;
  /** Corta la espera. EA sin límite bloquea un render de servidor entero. */
  timeoutMs?: number;
  /**
   * Cuántos registros pide cada página al paginar. **No es el default de EA**:
   * 20 son demasiadas idas y vueltas para una semana de agenda.
   */
  pageLength?: number;
  /** Tope de páginas de `list()`. Al superarlo lanza, nunca trunca. */
  maxPages?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PAGE_LENGTH = 100;
const DEFAULT_MAX_PAGES = 200;

type Env = Record<string, string | undefined>;

/**
 * Lee la configuración del entorno.
 *
 * Falla ruidosamente si falta algo: un cliente a medio configurar que devuelve
 * 401 en cada llamada es más difícil de diagnosticar que uno que dice "falta
 * EA_API_TOKEN" al arrancar.
 */
export function eaConfigFromEnv(env: Env = process.env): EaClientConfig {
  const baseUrl = env.EA_API_URL?.trim();
  const token = env.EA_API_TOKEN?.trim();

  if (!baseUrl) {
    throw new EaApiError("Falta EA_API_URL", { kind: "config" });
  }

  if (!token) {
    // El mensaje nombra la variable, nunca el valor de la que sí está.
    throw new EaApiError("Falta EA_API_TOKEN", { kind: "config" });
  }

  try {
    new URL(baseUrl);
  } catch {
    throw new EaApiError(`EA_API_URL no es una URL válida: ${baseUrl}`, { kind: "config" });
  }

  return {
    baseUrl,
    token,
    timeoutMs: numberFromEnv(env.EA_API_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS,
    pageLength: numberFromEnv(env.EA_API_PAGE_LENGTH) ?? DEFAULT_PAGE_LENGTH,
  };
}

function numberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// Parámetros de consulta
// ---------------------------------------------------------------------------

/** Lo que se puede pasar donde EA espera una fecha. */
export type DateInput = Date | EaLocalDateTime | EaLocalDate | string;

export type SelectQuery = {
  /**
   * Campos camelCase a devolver. EA recorta **después** de codificar, así que
   * omitir un campo obligatorio deja la respuesta indecodificable; el cliente
   * lo verifica antes de salir a la red.
   */
  fields?: readonly string[];
  /**
   * Relaciones a adjuntar (`service`, `provider`, `customer`).
   *
   * Ojo: EA las adjunta como **fila cruda en snake_case**
   * (`Appointments_model::load()` hace un `get_where(...)->row_array()` sin
   * pasar por `api_encode()`). Por eso se decodifican con `fromRow`, el mismo
   * codec del webhook — y por eso el mapeo de tres sentidos no era un lujo.
   */
  with?: readonly string[];
};

export type ListQuery = SelectQuery & {
  /** Campos de orden, con `-` para descendente: `["-start", "id"]`. */
  sort?: readonly string[];
  /**
   * Búsqueda por palabra clave. **Excluyente con cualquier filtro** — ver la
   * cabecera del archivo.
   */
  q?: string;
};

export type AppointmentQuery = ListQuery & {
  /** Un día exacto. */
  date?: DateInput;
  /** Desde (inclusive, por día, contra `start_datetime`). */
  from?: DateInput;
  /** Hasta (inclusive, por día, contra **`end_datetime`**). */
  till?: DateInput;
  serviceId?: number;
  providerId?: number;
  customerId?: number;
};

/**
 * Normaliza cualquier forma de fecha al `YYYY-MM-DD` que EA compara.
 *
 * Un `Date` se resuelve en la zona del estudio, no en la del proceso: el "hoy"
 * de la agenda es el del estudio, y en un contenedor en UTC después de las 19:00
 * de Bogotá esos dos días son distintos.
 */
export function eaDateParam(value: DateInput): EaLocalDate {
  if (value instanceof Date) return instantToEaDate(value);
  if (typeof value === "string" && value.length >= 10) return eaDatePart(value as EaLocalDateTime);
  throw new EaApiError(`Fecha inválida para un parámetro de EA: ${String(value)}`, {
    kind: "bad_request",
  });
}

/** Arma el `URLSearchParams` de un listado. Exportado para tests y para D2. */
export function buildListParams(query: ListQuery = {}): URLSearchParams {
  const params = new URLSearchParams();

  if (query.q !== undefined) params.set("q", query.q);
  if (query.sort?.length) params.set("sort", query.sort.join(","));
  if (query.fields?.length) params.set("fields", query.fields.join(","));
  if (query.with?.length) params.set("with", query.with.join(","));

  return params;
}

function applyAppointmentFilters(params: URLSearchParams, query: AppointmentQuery): void {
  if (query.date !== undefined) params.set("date", eaDateParam(query.date));
  if (query.from !== undefined) params.set("from", eaDateParam(query.from));
  if (query.till !== undefined) params.set("till", eaDateParam(query.till));
  if (query.serviceId !== undefined) params.set("serviceId", String(query.serviceId));
  if (query.providerId !== undefined) params.set("providerId", String(query.providerId));
  if (query.customerId !== undefined) params.set("customerId", String(query.customerId));
}

const APPOINTMENT_FILTER_KEYS = [
  "date",
  "from",
  "till",
  "serviceId",
  "providerId",
  "customerId",
] as const;

/**
 * `q` gana sobre todos los filtros dentro de EA, sin avisar. Se rechaza acá.
 */
function assertKeywordIsAlone(query: AppointmentQuery): void {
  if (query.q === undefined) return;

  const conflicting = APPOINTMENT_FILTER_KEYS.filter((key) => query[key] !== undefined);

  if (conflicting.length > 0) {
    throw new EaApiError(
      `EA ignora los filtros cuando se manda "q": ${conflicting.join(", ")} no tendrían efecto. ` +
        "Buscá sin filtros y recortá acá, o filtrá sin q.",
      { kind: "bad_request" },
    );
  }
}

function assertFieldsAreDecodable(resource: EaMappedResource, fields?: readonly string[]): void {
  if (!fields?.length) return;

  const missing = requiredApiFields(resource).filter((name) => !fields.includes(name));

  if (missing.length > 0) {
    throw new EaApiError(
      `Un "fields=" de ${resource} sin ${missing.join(", ")} devuelve registros que no se pueden ` +
        "decodificar. Agregalos, o usá el acceso crudo.",
      { kind: "bad_request" },
    );
  }
}

// ---------------------------------------------------------------------------
// Paginación
// ---------------------------------------------------------------------------

export type PagedQuery = ListQuery & {
  /** Página, 1-based, como la cuenta EA (`offset = (page - 1) * length`). */
  page?: number;
  /** Obligatorio: sin esto EA usaría 20 y nadie se enteraría. */
  length: number;
};

export type Page<T> = {
  items: T[];
  page: number;
  length: number;
  /**
   * Si hay más registros después de esta página.
   *
   * Se deduce de `items.length === length`, que es todo lo que se puede saber:
   * EA devuelve un arreglo pelado, sin total. Cuando el total es múltiplo
   * exacto de `length`, la última página llena reporta `hasMore: true` y hace
   * falta una consulta más que vuelve vacía. Ese pedido de más es el precio de
   * no poder truncar por error, y se paga contento.
   */
  hasMore: boolean;
};

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export type RequestOptions = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  params?: URLSearchParams;
  body?: unknown;
};

export type EaResourceClient<D, I, Q extends ListQuery> = {
  /** Pagina hasta agotar. Nunca devuelve una página parcial como si fuera todo. */
  list(query?: Q): Promise<D[]>;
  /** Una página, con `length` explícito y `hasMore`. */
  listPage(query: Q & PagedQuery): Promise<Page<D>>;
  get(id: number, query?: SelectQuery): Promise<D>;
  create(input: I): Promise<D>;
  update(id: number, input: I): Promise<D>;
  remove(id: number): Promise<void>;
};

export type EaClient = {
  appointments: EaResourceClient<Appointment, AppointmentInput, AppointmentQuery>;
  unavailabilities: EaResourceClient<Unavailability, UnavailabilityInput, ListQuery>;
  customers: EaResourceClient<Customer, CustomerInput, ListQuery>;
  services: EaResourceClient<Service, ServiceInput, ListQuery>;
  serviceCategories: EaResourceClient<ServiceCategory, ServiceCategoryInput, ListQuery>;
  providers: EaResourceClient<Provider, ProviderInput, ListQuery>;
  secretaries: EaResourceClient<Secretary, SecretaryInput, ListQuery>;
  admins: EaResourceClient<Admin, AdminInput, ListQuery>;
  blockedPeriods: EaResourceClient<BlockedPeriod, BlockedPeriodInput, ListQuery>;
  webhooks: EaResourceClient<Webhook, WebhookInput, ListQuery>;
  workingPlanExceptions: EaResourceClient<
    WorkingPlanException,
    WorkingPlanExceptionInput,
    ListQuery
  >;

  /** Ajustes globales. No son un recurso con id: la clave es el nombre. */
  settings: {
    list(): Promise<Setting[]>;
    get(name: string): Promise<Setting>;
    update(name: string, value: string): Promise<Setting>;
  };

  /**
   * Horas libres de una técnica para un servicio y un día.
   *
   * Una llamada por técnica: **no existe "cualquiera"** en la API de EA. El
   * abanico y el cruce contra la ocupación de puestos son de D2.
   */
  availabilities(query: {
    providerId: number;
    serviceId: number;
    date: DateInput;
  }): Promise<Availability>;

  /**
   * Escotilla sin tipar, para lo que el dominio no cubre — `with=` con
   * relaciones nuevas, `aggregates`, o un recurso que EA agregue mañana.
   * Devuelve el JSON tal cual. Quien la use se hace cargo de validarlo.
   */
  raw(options: RequestOptions): Promise<unknown>;
};

export function createEaClient(config: EaClientConfig = eaConfigFromEnv()): EaClient {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pageLength = config.pageLength ?? DEFAULT_PAGE_LENGTH;
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;
  // Una sola barra final: `new URL("appointments", base)` descarta el último
  // segmento del path si la base no termina en "/", y `…/api/v1` sin barra
  // resolvería a `…/api/appointments`.
  const base = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;

  async function request({ method, path, params, body }: RequestOptions): Promise<unknown> {
    const url = new URL(path, base);
    if (params) url.search = params.toString();

    // Ni el token ni el header van al error: la URL se guarda solo como ruta
    // relativa y los headers no se adjuntan nunca.
    const context = { method, path };

    let response: Response;

    try {
      response = await doFetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        // El panel siempre quiere el estado de ahora; una agenda cacheada es
        // una agenda equivocada.
        cache: "no-store",
      });
    } catch (error) {
      const kind = kindForThrown(error);
      throw new EaApiError(
        kind === "timeout"
          ? `EA no respondió en ${timeoutMs} ms (${method} ${path})`
          : `No se pudo alcanzar EA (${method} ${path})`,
        { ...context, kind, cause: error },
      );
    }

    if (!response.ok) {
      // El 401 de EA responde texto plano ("You are not authorized…") y el 500
      // imprime la excepción con debug info. Se guardan tachados y recortados.
      const text = await response.text().catch(() => "");
      throw new EaApiError(
        `EA respondió ${response.status} a ${method} ${path}`,
        {
          ...context,
          kind: kindForStatus(response.status),
          status: response.status,
          body: safeBody(text, config.token),
        },
      );
    }

    if (response.status === 204) return null;

    const text = await response.text();

    if (text.trim() === "") return null;

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new EaApiError(`EA devolvió algo que no es JSON en ${method} ${path}`, {
        ...context,
        kind: "malformed",
        status: response.status,
        body: safeBody(text, config.token),
        cause: error,
      });
    }
  }

  function expectArray(value: unknown, path: string): ApiShape[] {
    if (!Array.isArray(value)) {
      throw new EaApiError(`Se esperaba una lista en ${path} y llegó ${typeof value}`, {
        kind: "malformed",
        path,
      });
    }
    return value as ApiShape[];
  }

  function expectObject(value: unknown, path: string): ApiShape {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new EaApiError(`Se esperaba un registro en ${path} y llegó ${typeof value}`, {
        kind: "malformed",
        path,
      });
    }
    return value as ApiShape;
  }

  function resource<D, I, Q extends ListQuery>(
    path: string,
    key: EaMappedResource,
    applyFilters: (params: URLSearchParams, query: Q) => void = () => {},
    guard: (query: Q) => void = () => {},
  ): EaResourceClient<D, I, Q> {
    const itemCodec = EA_CODECS[key] as unknown as EaCodec<D>;

    function paramsFor(query: Q): URLSearchParams {
      guard(query);
      assertFieldsAreDecodable(key, query.fields);
      const params = buildListParams(query);
      applyFilters(params, query);
      return params;
    }

    async function fetchPage(query: Q, page: number, length: number): Promise<D[]> {
      const params = paramsFor(query);
      params.set("page", String(page));
      params.set("length", String(length));

      const payload = await request({ method: "GET", path, params });

      return expectArray(payload, path).map((item) => itemCodec.fromApi(item));
    }

    return {
      async list(query = {} as Q) {
        const items: D[] = [];

        for (let page = 1; page <= maxPages; page += 1) {
          const batch = await fetchPage(query, page, pageLength);
          items.push(...batch);

          // Página incompleta = se acabó. Es la única señal que EA da.
          if (batch.length < pageLength) return items;
        }

        throw new EaApiError(
          `El listado de ${path} superó ${maxPages} páginas de ${pageLength}. Se aborta en vez de ` +
            "devolver un resultado incompleto: acotá el rango o subí maxPages a conciencia.",
          { kind: "pagination_overflow", path, method: "GET" },
        );
      },

      async listPage(query) {
        const { page = 1, length } = query;

        if (!Number.isInteger(length) || length < 1) {
          throw new EaApiError(
            "listPage() exige un length entero y positivo: sin él EA usa 20 y el resultado " +
              "parecería completo.",
            { kind: "bad_request", path },
          );
        }

        const items = await fetchPage(query, page, length);

        return { items, page, length, hasMore: items.length === length };
      },

      async get(id, query = {}) {
        assertFieldsAreDecodable(key, query.fields);
        const params = buildListParams(query);
        const payload = await request({ method: "GET", path: `${path}/${id}`, params });
        return itemCodec.fromApi(expectObject(payload, `${path}/${id}`));
      },

      async create(input) {
        const payload = await request({
          method: "POST",
          path,
          body: itemCodec.toApi(input as Partial<D>),
        });
        return itemCodec.fromApi(expectObject(payload, path));
      },

      async update(id, input) {
        const payload = await request({
          method: "PUT",
          path: `${path}/${id}`,
          body: itemCodec.toApi(input as Partial<D>),
        });
        return itemCodec.fromApi(expectObject(payload, `${path}/${id}`));
      },

      async remove(id) {
        await request({ method: "DELETE", path: `${path}/${id}` });
      },
    };
  }

  return {
    appointments: resource<Appointment, AppointmentInput, AppointmentQuery>(
      "appointments",
      "appointments",
      applyAppointmentFilters,
      assertKeywordIsAlone,
    ),
    // `unavailabilities` comparte tabla y forma con `appointments` salvo que no
    // tiene servicio ni clienta; el recurso propio de EA no acepta from/till.
    unavailabilities: resource<Unavailability, UnavailabilityInput, ListQuery>(
      "unavailabilities",
      "unavailabilities",
    ),
    customers: resource<Customer, CustomerInput, ListQuery>("customers", "customers"),
    services: resource<Service, ServiceInput, ListQuery>("services", "services"),
    serviceCategories: resource<ServiceCategory, ServiceCategoryInput, ListQuery>(
      "service_categories",
      "service_categories",
    ),
    providers: resource<Provider, ProviderInput, ListQuery>("providers", "providers"),
    secretaries: resource<Secretary, SecretaryInput, ListQuery>("secretaries", "secretaries"),
    admins: resource<Admin, AdminInput, ListQuery>("admins", "admins"),
    blockedPeriods: resource<BlockedPeriod, BlockedPeriodInput, ListQuery>(
      "blocked_periods",
      "blocked_periods",
    ),
    webhooks: resource<Webhook, WebhookInput, ListQuery>("webhooks", "webhooks"),
    workingPlanExceptions: resource<
      WorkingPlanException,
      WorkingPlanExceptionInput,
      ListQuery
    >("working_plan_exceptions", "working_plan_exceptions"),

    settings: {
      async list() {
        const payload = await request({ method: "GET", path: "settings" });
        return expectArray(payload, "settings").map((item) => EA_CODECS.settings.fromApi(item));
      },
      async get(name) {
        const payload = await request({ method: "GET", path: `settings/${name}` });
        return EA_CODECS.settings.fromApi(expectObject(payload, `settings/${name}`));
      },
      async update(name, value) {
        const payload = await request({
          method: "PUT",
          path: `settings/${name}`,
          body: { value },
        });
        return EA_CODECS.settings.fromApi(expectObject(payload, `settings/${name}`));
      },
    },

    async availabilities({ providerId, serviceId, date }) {
      const day = eaDateParam(date);

      const params = new URLSearchParams({
        providerId: String(providerId),
        serviceId: String(serviceId),
        date: day,
      });

      const payload = await request({ method: "GET", path: "availabilities", params });

      return availabilityFromApi({ providerId, serviceId, date: day }, payload);
    },

    raw: request,
  };
}

// ---------------------------------------------------------------------------
// Relaciones adjuntas con `with=`
// ---------------------------------------------------------------------------

/** Una cita con lo que `with=service,provider,customer` haya adjuntado. */
export type AppointmentWithRelations = {
  appointment: Appointment;
  service: Service | null;
  provider: Provider | null;
  customer: Customer | null;
};

/**
 * Decodifica una cita que vino con relaciones adjuntas.
 *
 * Existe porque las relaciones **no** están en camelCase: `load()` de EA hace
 * `get_where(...)->row_array()` y pega la fila cruda tal cual, así que dentro
 * de una respuesta camelCase viajan objetos en snake_case. Se decodifican con
 * `fromRow`, el mismo codec del webhook.
 *
 * Es lo que evita el N+1 de la agenda: un `GET /appointments?with=…` en vez de
 * una llamada por cita para saber de quién es.
 */
export function decodeAppointmentWithRelations(raw: ApiShape): AppointmentWithRelations {
  const row = (key: string): ApiShape | null => {
    const value = raw[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as ApiShape;
  };

  const service = row("service");
  const provider = row("provider");
  const customer = row("customer");

  return {
    appointment: EA_CODECS.appointments.fromApi(raw),
    service: service ? EA_CODECS.services.fromRow(service) : null,
    provider: provider ? EA_CODECS.providers.fromRow(provider) : null,
    customer: customer ? EA_CODECS.customers.fromRow(customer) : null,
  };
}

/** Reexportado para que quien registre un log pueda tachar el token. */
export { scrubSecret };
