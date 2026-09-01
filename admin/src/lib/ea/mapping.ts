/**
 * El mapeo de Easy!Appointments, en un solo lugar y en los tres sentidos.
 *
 * ```text
 *   camelCase de la API  ⇄  dominio  ⇄  snake_case de la fila cruda
 *        (REST v1)                        (payload del webhook)
 * ```
 *
 * **Por qué una tabla y no tres funciones por recurso.** Las tres direcciones
 * tienen que estar de acuerdo o el panel escribe en un campo y lee otro. Con
 * funciones separadas el desacuerdo aparece cuando alguien agrega un campo a
 * dos de las tres. Acá cada recurso declara **una** tabla de campos —
 * `dominio → { api, row, kind }` — y los cuatro codecs (`fromApi`, `toApi`,
 * `fromRow`, `toRow`) se derivan de ella. Agregar un campo es una línea, y es
 * imposible agregarlo "solo de ida".
 *
 * El tipo de la tabla es `{ [K in keyof Dominio]-?: FieldSpec }`, así que si
 * alguien agrega un campo al tipo de dominio y olvida la fila de la tabla, el
 * compilador lo para.
 *
 * ---
 *
 * ## Lo que el spec promete y el código no da
 *
 * El `openapi.yml` de EA y sus `api_encode()` **no coinciden**. Verificado
 * contra la fuente, no contra la documentación:
 *
 * - **`service.color` es de solo escritura.** `Services_model::api_decode()` lo
 *   acepta; `Services_model::api_encode()` no lo emite. `GET /services` nunca
 *   devuelve el color, aunque el spec lo declare y `api_resource` lo mapee. El
 *   tinte del bloque en el calendario hay que sacarlo de MySQL, o del `color`
 *   por cita, que ese sí viaja. Consecuencia práctica en este módulo: `toApi()`
 *   **omite** un `color` en `null` para que un leer-modificar-guardar no borre
 *   el color que la dueña puso desde EA.
 * - **`unavailability.color` y `unavailability.status` tampoco se emiten**,
 *   aunque estén en `api_resource`. No se modelan.
 * - **`webhook.secretHeader` no existe en la API.** La columna sí (migración
 *   `060`), y `Webhooks_client` la lee para armar el header; pero ni
 *   `api_encode()` ni `api_decode()` la tocan. Solo se configura desde la
 *   interfaz de EA.
 * - **`provider.settings.workingPlan` llega como objeto ya parseado**, no como
 *   string: `api_encode()` le hace `json_decode()`. El spec dice
 *   `type: string`. En la fila cruda sí es un string JSON — de ahí que el
 *   `kind` sea `json` y no `string`.
 *
 * ## Lo que este módulo deja caer a propósito
 *
 * `settings.password`, `settings.salt` y `settings.caldavPassword`. EA emite el
 * último; nosotros no lo guardamos en ningún tipo. Un secreto que no tiene
 * dónde aterrizar no se filtra por un `console.log` de depuración ni por un
 * payload serializado hacia un componente cliente. Consecuencia: un
 * leer-modificar-guardar de una técnica **no reenvía** la contraseña de CalDAV,
 * y EA la conserva porque su `api_decode()` solo pisa las claves presentes.
 */

import {
  EaDateTimeError,
  parseEaLocalDate,
  parseEaLocalDateTime,
  type EaLocalDate,
  type EaLocalDateTime,
} from "./datetime";
import type {
  Admin,
  ApiShape,
  Appointment,
  Availability,
  BlockedPeriod,
  Customer,
  EaWebhookEnvelope,
  Provider,
  ProviderSettings,
  RowShape,
  Secretary,
  Service,
  ServiceCategory,
  Setting,
  StaffSettings,
  Unavailability,
  UnknownRecord,
  Webhook,
  WorkingPlan,
  WorkingPlanException,
} from "./types";
import { isEaWebhookAction } from "./types";

/** Falló la traducción de un registro de EA. Es data mala, no red caída. */
export class EaMappingError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "EaMappingError";
    this.field = field;
  }
}

type FieldKind =
  | "int"
  | "float"
  | "bool"
  | "string"
  | "datetime"
  | "date"
  | "time"
  | "intList"
  | "json"
  | "nested";

type FieldSpec = {
  /** Clave en el payload camelCase. `null` = el campo no existe en la API. */
  readonly api: string | null;
  /** Clave en la fila cruda. `null` = el campo no existe en la fila. */
  readonly row: string | null;
  readonly kind: FieldKind;
  /** Si falta o viene `null`, el decode falla en vez de inventar. */
  readonly required?: true;
  /**
   * Valor cuando la fuente trae `null` o no trae la clave. Se distingue de
   * "no declarado" por presencia de la propiedad, no por `undefined`, para que
   * un fallback de `null` explícito siga siendo posible.
   */
  readonly fallback?: unknown;
  /**
   * EA lo acepta al escribir pero su `api_encode()` no lo devuelve. `toApi()`
   * omite estos campos cuando valen `null`: un `null` acá solo puede significar
   * "nunca lo pudimos leer", nunca "la usuaria lo borró".
   */
  readonly apiWriteOnly?: true;
  /** Sub-tabla, para `kind: "nested"`. */
  readonly nested?: FieldTable;
};

type FieldTable = Readonly<Record<string, FieldSpec>>;

/**
 * Declara la tabla de un recurso exigiendo una fila por campo del dominio.
 * El `-?` es lo que convierte un campo olvidado en un error de compilación.
 */
function table<D>(spec: { readonly [K in keyof D]-?: FieldSpec }): FieldTable {
  return spec as FieldTable;
}

// ---------------------------------------------------------------------------
// Coerción de valores
// ---------------------------------------------------------------------------

/**
 * MySQL guarda fechas imposibles como ceros, y EA arrastra filas viejas con
 * ellas. Un `0000-00-00` no es una fecha: es un `null` disfrazado, y tratarlo
 * como fecha produce un `Invalid Date` que se propaga sin ruido.
 */
const ZERO_DATES = new Set(["0000-00-00 00:00:00", "0000-00-00", "", "0"]);

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function toInt(field: string, value: unknown): number | null {
  if (isBlank(value)) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EaMappingError(field, `entero inválido: ${value}`);
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new EaMappingError(field, `entero inválido: ${value}`);
    return Math.trunc(n);
  }
  throw new EaMappingError(field, `se esperaba un entero y llegó ${typeof value}`);
}

function toFloat(field: string, value: unknown): number | null {
  if (isBlank(value)) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value !== "number" && typeof value !== "string") {
    throw new EaMappingError(field, `se esperaba un número y llegó ${typeof value}`);
  }
  if (!Number.isFinite(n)) throw new EaMappingError(field, `número inválido: ${String(value)}`);
  return n;
}

/**
 * EA devuelve booleanos de tres formas según por dónde salgan: `true` desde
 * `api_encode()`, `1` desde la fila cruda, `"1"` desde algunos drivers.
 */
function toBool(field: string, value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  throw new EaMappingError(field, `booleano inválido: ${JSON.stringify(value)}`);
}

function toStr(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  // `id_google_calendar` sale como entero para unavailabilities y como string
  // para appointments, en el mismo EA. Se normaliza a string.
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new EaMappingError(field, `se esperaba texto y llegó ${typeof value}`);
}

function toDateTime(field: string, value: unknown): EaLocalDateTime | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && ZERO_DATES.has(value)) return null;
  try {
    return parseEaLocalDateTime(value);
  } catch (error) {
    throw new EaMappingError(field, error instanceof EaDateTimeError ? error.message : String(error));
  }
}

function toDate(field: string, value: unknown): EaLocalDate | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && ZERO_DATES.has(value)) return null;
  try {
    return parseEaLocalDate(value);
  } catch (error) {
    throw new EaMappingError(field, error instanceof EaDateTimeError ? error.message : String(error));
  }
}

/** `"09:00"` o `"09:00:00"` → `"09:00"`. EA emite las dos formas. */
function toTime(field: string, value: unknown): string | null {
  if (isBlank(value)) return null;
  if (typeof value !== "string") {
    throw new EaMappingError(field, `se esperaba una hora y llegó ${typeof value}`);
  }
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) throw new EaMappingError(field, `hora inválida: ${value}`);
  return `${m[1]}:${m[2]}`;
}

function toIntList(field: string, value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new EaMappingError(field, `se esperaba una lista y llegó ${typeof value}`);
  }
  return value.map((item, i) => {
    const n = toInt(`${field}[${i}]`, item);
    if (n === null) throw new EaMappingError(`${field}[${i}]`, "id nulo dentro de una lista de ids");
    return n;
  });
}

/**
 * JSON que viaja parseado por la API y como string en la fila cruda
 * (`working_plan`, `working_plan_exceptions`, `breaks`).
 */
function toJson(field: string, value: unknown): unknown {
  if (isBlank(value)) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new EaMappingError(field, "JSON inválido");
  }
}

// ---------------------------------------------------------------------------
// Codecs genéricos
// ---------------------------------------------------------------------------

type Side = "api" | "row";

function keyFor(spec: FieldSpec, side: Side): string | null {
  return side === "api" ? spec.api : spec.row;
}

function decodeValue(field: string, spec: FieldSpec, raw: unknown, side: Side): unknown {
  switch (spec.kind) {
    case "int":
      return toInt(field, raw);
    case "float":
      return toFloat(field, raw);
    case "bool":
      return toBool(field, raw);
    case "string":
      return toStr(field, raw);
    case "datetime":
      return toDateTime(field, raw);
    case "date":
      return toDate(field, raw);
    case "time":
      return toTime(field, raw);
    case "intList":
      return toIntList(field, raw);
    case "json":
      return toJson(field, raw);
    case "nested": {
      if (raw === null || raw === undefined) return null;
      if (typeof raw !== "object" || Array.isArray(raw)) {
        throw new EaMappingError(field, `se esperaba un objeto y llegó ${typeof raw}`);
      }
      if (!spec.nested) throw new EaMappingError(field, "tabla anidada sin declarar");
      return decodeTable(spec.nested, raw as UnknownRecord, side, field);
    }
  }
}

function fallbackOf(spec: FieldSpec): unknown {
  return Object.prototype.hasOwnProperty.call(spec, "fallback") ? spec.fallback : null;
}

function decodeTable(
  fields: FieldTable,
  source: UnknownRecord,
  side: Side,
  prefix = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [domainKey, spec] of Object.entries(fields)) {
    const sourceKey = keyFor(spec, side);
    const field = prefix ? `${prefix}.${domainKey}` : domainKey;

    if (sourceKey === null) {
      out[domainKey] = fallbackOf(spec);
      continue;
    }

    const present = Object.prototype.hasOwnProperty.call(source, sourceKey);
    const decoded = present ? decodeValue(field, spec, source[sourceKey], side) : null;

    if (decoded === null || decoded === undefined) {
      if (spec.required) {
        throw new EaMappingError(
          field,
          present
            ? "es obligatorio y llegó vacío"
            : `es obligatorio y la respuesta no trae "${sourceKey}" (¿un "fields=" que lo recortó?)`,
        );
      }
      out[domainKey] = fallbackOf(spec);
      continue;
    }

    out[domainKey] = decoded;
  }

  return out;
}

function encodeValue(spec: FieldSpec, value: unknown, side: Side): unknown {
  if (value === null || value === undefined) return null;

  switch (spec.kind) {
    case "bool":
      // La fila cruda es MySQL: `tinyint`, no `true`.
      return side === "row" ? (value ? 1 : 0) : Boolean(value);
    case "json":
      return side === "row" ? JSON.stringify(value) : value;
    case "nested":
      return spec.nested ? encodeTable(spec.nested, value as UnknownRecord, side) : null;
    default:
      return value;
  }
}

function encodeTable(
  fields: FieldTable,
  value: UnknownRecord,
  side: Side,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [domainKey, spec] of Object.entries(fields)) {
    const targetKey = keyFor(spec, side);
    if (targetKey === null) continue;

    // `undefined` = "no lo estoy tocando". Es lo que hace que un `*Input`
    // parcial mande solo lo que cambió, que es lo que EA espera: su
    // `api_decode()` pisa únicamente las claves presentes.
    if (!Object.prototype.hasOwnProperty.call(value, domainKey)) continue;

    const raw = value[domainKey];
    if (raw === undefined) continue;

    // Ver el comentario de `apiWriteOnly` arriba: no se puede distinguir "está
    // en null porque EA no lo devuelve" de "la usuaria lo borró", así que se
    // omite. Nunca borrar un dato que no pudimos leer.
    if (raw === null && spec.apiWriteOnly && side === "api") continue;

    out[targetKey] = encodeValue(spec, raw, side);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Tablas por recurso
// ---------------------------------------------------------------------------

const APPOINTMENT = table<Appointment>({
  id: { api: "id", row: "id", kind: "int", required: true },
  bookedAt: { api: "book", row: "book_datetime", kind: "datetime" },
  start: { api: "start", row: "start_datetime", kind: "datetime", required: true },
  end: { api: "end", row: "end_datetime", kind: "datetime", required: true },
  hash: { api: "hash", row: "hash", kind: "string" },
  location: { api: "location", row: "location", kind: "string" },
  meetingLink: { api: "meetingLink", row: "meeting_link", kind: "string" },
  color: { api: "color", row: "color", kind: "string" },
  // El estado es texto libre y la lista de EA no trae "Completada" ni
  // "No asistió". Cae a "" en vez de reventar: una cita sin estado se ve en
  // Diagnóstico, no tumba la agenda.
  status: { api: "status", row: "status", kind: "string", fallback: "" },
  notes: { api: "notes", row: "notes", kind: "string" },
  customerId: { api: "customerId", row: "id_users_customer", kind: "int" },
  providerId: { api: "providerId", row: "id_users_provider", kind: "int" },
  serviceId: { api: "serviceId", row: "id_services", kind: "int" },
  googleCalendarId: { api: "googleCalendarId", row: "id_google_calendar", kind: "string" },
  caldavCalendarId: { api: "caldavCalendarId", row: "id_caldav_calendar", kind: "string" },
});

const UNAVAILABILITY = table<Unavailability>({
  id: { api: "id", row: "id", kind: "int", required: true },
  bookedAt: { api: "book", row: "book_datetime", kind: "datetime" },
  start: { api: "start", row: "start_datetime", kind: "datetime", required: true },
  end: { api: "end", row: "end_datetime", kind: "datetime", required: true },
  hash: { api: "hash", row: "hash", kind: "string" },
  location: { api: "location", row: "location", kind: "string" },
  notes: { api: "notes", row: "notes", kind: "string" },
  providerId: { api: "providerId", row: "id_users_provider", kind: "int" },
  googleCalendarId: { api: "googleCalendarId", row: "id_google_calendar", kind: "string" },
  caldavCalendarId: { api: "caldavCalendarId", row: "id_caldav_calendar", kind: "string" },
});

const BLOCKED_PERIOD = table<BlockedPeriod>({
  id: { api: "id", row: "id", kind: "int", required: true },
  name: { api: "name", row: "name", kind: "string" },
  start: { api: "start", row: "start_datetime", kind: "datetime", required: true },
  end: { api: "end", row: "end_datetime", kind: "datetime", required: true },
  notes: { api: "notes", row: "notes", kind: "string" },
});

const CUSTOMER = table<Customer>({
  id: { api: "id", row: "id", kind: "int", required: true },
  firstName: { api: "firstName", row: "first_name", kind: "string" },
  lastName: { api: "lastName", row: "last_name", kind: "string" },
  email: { api: "email", row: "email", kind: "string" },
  phone: { api: "phone", row: "phone_number", kind: "string" },
  address: { api: "address", row: "address", kind: "string" },
  city: { api: "city", row: "city", kind: "string" },
  zip: { api: "zip", row: "zip_code", kind: "string" },
  timezone: { api: "timezone", row: "timezone", kind: "string" },
  language: { api: "language", row: "language", kind: "string" },
  customField1: { api: "customField1", row: "custom_field_1", kind: "string" },
  customField2: { api: "customField2", row: "custom_field_2", kind: "string" },
  customField3: { api: "customField3", row: "custom_field_3", kind: "string" },
  customField4: { api: "customField4", row: "custom_field_4", kind: "string" },
  customField5: { api: "customField5", row: "custom_field_5", kind: "string" },
  ldapDn: { api: "ldapDn", row: "ldap_dn", kind: "string" },
  notes: { api: "notes", row: "notes", kind: "string" },
});

const SERVICE = table<Service>({
  id: { api: "id", row: "id", kind: "int", required: true },
  name: { api: "name", row: "name", kind: "string" },
  duration: { api: "duration", row: "duration", kind: "int" },
  price: { api: "price", row: "price", kind: "float" },
  currency: { api: "currency", row: "currency", kind: "string" },
  location: { api: "location", row: "location", kind: "string" },
  description: { api: "description", row: "description", kind: "string" },
  color: { api: "color", row: "color", kind: "string", apiWriteOnly: true },
  slotInterval: { api: "slotInterval", row: "slot_interval", kind: "int" },
  attendantsNumber: { api: "attendantsNumber", row: "attendants_number", kind: "int" },
  isPrivate: { api: "isPrivate", row: "is_private", kind: "bool" },
  serviceCategoryId: { api: "serviceCategoryId", row: "id_service_categories", kind: "int" },
});

const SERVICE_CATEGORY = table<ServiceCategory>({
  id: { api: "id", row: "id", kind: "int", required: true },
  name: { api: "name", row: "name", kind: "string" },
  description: { api: "description", row: "description", kind: "string" },
});

/** Las columnas de `users` que comparten técnicas, secretarias y admins. */
const PERSON_FIELDS = {
  id: { api: "id", row: "id", kind: "int", required: true },
  firstName: { api: "firstName", row: "first_name", kind: "string" },
  lastName: { api: "lastName", row: "last_name", kind: "string" },
  email: { api: "email", row: "email", kind: "string" },
  mobile: { api: "mobile", row: "mobile_number", kind: "string" },
  phone: { api: "phone", row: "phone_number", kind: "string" },
  address: { api: "address", row: "address", kind: "string" },
  city: { api: "city", row: "city", kind: "string" },
  state: { api: "state", row: "state", kind: "string" },
  zip: { api: "zip", row: "zip_code", kind: "string" },
  notes: { api: "notes", row: "notes", kind: "string" },
  timezone: { api: "timezone", row: "timezone", kind: "string" },
  language: { api: "language", row: "language", kind: "string" },
  ldapDn: { api: "ldapDn", row: "ldap_dn", kind: "string" },
} as const satisfies FieldTable;

const STAFF_SETTINGS = table<StaffSettings>({
  username: { api: "username", row: "username", kind: "string" },
  notifications: { api: "notifications", row: "notifications", kind: "bool" },
  calendarView: { api: "calendarView", row: "calendar_view", kind: "string" },
});

const PROVIDER_SETTINGS = table<ProviderSettings>({
  username: { api: "username", row: "username", kind: "string" },
  notifications: { api: "notifications", row: "notifications", kind: "bool" },
  calendarView: { api: "calendarView", row: "calendar_view", kind: "string" },
  googleSync: { api: "googleSync", row: "google_sync", kind: "bool" },
  googleToken: { api: "googleToken", row: "google_token", kind: "string" },
  googleCalendar: { api: "googleCalendar", row: "google_calendar", kind: "string" },
  caldavSync: { api: "caldavSync", row: "caldav_sync", kind: "bool" },
  caldavUrl: { api: "caldavUrl", row: "caldav_url", kind: "string" },
  caldavUsername: { api: "caldavUsername", row: "caldav_username", kind: "string" },
  syncFutureDays: { api: "syncFutureDays", row: "sync_future_days", kind: "int" },
  syncPastDays: { api: "syncPastDays", row: "sync_past_days", kind: "int" },
  // Objeto por la API, string JSON en la fila. El `kind: "json"` es lo que
  // absorbe esa diferencia sin que el resto del panel se entere.
  workingPlan: { api: "workingPlan", row: "working_plan", kind: "json" },
  workingPlanExceptions: {
    api: "workingPlanExceptions",
    row: "working_plan_exceptions",
    kind: "json",
  },
});

const PROVIDER = table<Provider>({
  ...PERSON_FIELDS,
  isPrivate: { api: "isPrivate", row: "is_private", kind: "bool" },
  services: { api: "services", row: "services", kind: "intList" },
  settings: { api: "settings", row: "settings", kind: "nested", nested: PROVIDER_SETTINGS },
});

const SECRETARY = table<Secretary>({
  ...PERSON_FIELDS,
  providers: { api: "providers", row: "providers", kind: "intList" },
  settings: { api: "settings", row: "settings", kind: "nested", nested: STAFF_SETTINGS },
});

const ADMIN = table<Admin>({
  ...PERSON_FIELDS,
  settings: { api: "settings", row: "settings", kind: "nested", nested: STAFF_SETTINGS },
});

const SETTING = table<Setting>({
  name: { api: "name", row: "name", kind: "string", required: true },
  value: { api: "value", row: "value", kind: "string" },
});

const WEBHOOK = table<Webhook>({
  id: { api: "id", row: "id", kind: "int", required: true },
  name: { api: "name", row: "name", kind: "string" },
  actions: { api: "actions", row: "actions", kind: "string" },
  url: { api: "url", row: "url", kind: "string" },
  secretToken: { api: "secretToken", row: "secret_token", kind: "string" },
  isSslVerified: { api: "isSslVerified", row: "is_ssl_verified", kind: "bool" },
  notes: { api: "notes", row: "notes", kind: "string" },
});

const WORKING_PLAN_EXCEPTION = table<WorkingPlanException>({
  id: { api: "id", row: "id", kind: "int", required: true },
  startDate: { api: "startDate", row: "start_date", kind: "date" },
  endDate: { api: "endDate", row: "end_date", kind: "date" },
  startTime: { api: "startTime", row: "start_time", kind: "time" },
  endTime: { api: "endTime", row: "end_time", kind: "time" },
  // Sin excepción de descansos EA manda `[]`, no `null`. El fallback congelado
  // evita que dos registros decodificados compartan el mismo arreglo.
  breaks: { api: "breaks", row: "breaks", kind: "json", fallback: Object.freeze([]) },
  providerId: { api: "providerId", row: "id_users_provider", kind: "int" },
});

/** Todas las tablas, por recurso. La usan los tests y el chequeo de `fields`. */
export const EA_FIELD_TABLES = {
  appointments: APPOINTMENT,
  unavailabilities: UNAVAILABILITY,
  blocked_periods: BLOCKED_PERIOD,
  customers: CUSTOMER,
  services: SERVICE,
  service_categories: SERVICE_CATEGORY,
  providers: PROVIDER,
  secretaries: SECRETARY,
  admins: ADMIN,
  settings: SETTING,
  webhooks: WEBHOOK,
  working_plan_exceptions: WORKING_PLAN_EXCEPTION,
} as const satisfies Readonly<Record<string, FieldTable>>;

export type EaMappedResource = keyof typeof EA_FIELD_TABLES;

/**
 * Los nombres camelCase que un `fields=` **tiene** que incluir para que la
 * respuesta se pueda decodificar. `fields` recorta la respuesta después del
 * `api_encode()`, así que pedir `fields=id,start` deja fuera `end` y el decode
 * falla — mejor fallar antes de salir a la red, con el nombre del campo.
 */
export function requiredApiFields(resource: EaMappedResource): readonly string[] {
  return Object.values(EA_FIELD_TABLES[resource])
    .filter((spec) => spec.required && spec.api !== null)
    .map((spec) => spec.api as string);
}

// ---------------------------------------------------------------------------
// Codecs por recurso
// ---------------------------------------------------------------------------

/**
 * Un codec por recurso: las cuatro direcciones derivadas de la misma tabla.
 *
 * `fromApi` / `fromRow` devuelven el tipo de dominio con **una** aserción, que
 * es el único punto del módulo donde el compilador tiene que confiar. Está
 * acotada a esta función a propósito: la exhaustividad de la tabla la garantiza
 * `table<D>()`, y los valores los garantiza `decodeTable`.
 */
export type EaCodec<D> = {
  fromApi(source: ApiShape): D;
  toApi(value: Partial<D>): Record<string, unknown>;
  fromRow(source: RowShape): D;
  toRow(value: Partial<D>): Record<string, unknown>;
  /** Las claves de la fila cruda que la tabla cubre. Lo usan los tests. */
  rowKeys(): readonly string[];
  /** Las claves camelCase que la tabla cubre. */
  apiKeys(): readonly string[];
};

function codec<D>(fields: FieldTable): EaCodec<D> {
  return {
    fromApi: (source) => decodeTable(fields, source, "api") as unknown as D,
    toApi: (value) => encodeTable(fields, value as unknown as UnknownRecord, "api"),
    fromRow: (source) => decodeTable(fields, source, "row") as unknown as D,
    toRow: (value) => encodeTable(fields, value as unknown as UnknownRecord, "row"),
    rowKeys: () =>
      Object.values(fields)
        .map((spec) => spec.row)
        .filter((key): key is string => key !== null),
    apiKeys: () =>
      Object.values(fields)
        .map((spec) => spec.api)
        .filter((key): key is string => key !== null),
  };
}

export const appointmentCodec = codec<Appointment>(APPOINTMENT);
export const unavailabilityCodec = codec<Unavailability>(UNAVAILABILITY);
export const blockedPeriodCodec = codec<BlockedPeriod>(BLOCKED_PERIOD);
export const customerCodec = codec<Customer>(CUSTOMER);
export const serviceCodec = codec<Service>(SERVICE);
export const serviceCategoryCodec = codec<ServiceCategory>(SERVICE_CATEGORY);
export const providerCodec = codec<Provider>(PROVIDER);
export const secretaryCodec = codec<Secretary>(SECRETARY);
export const adminCodec = codec<Admin>(ADMIN);
export const settingCodec = codec<Setting>(SETTING);
export const webhookCodec = codec<Webhook>(WEBHOOK);
export const workingPlanExceptionCodec = codec<WorkingPlanException>(WORKING_PLAN_EXCEPTION);

/** Codecs indexados por recurso, para el reconcile y los tests genéricos. */
export const EA_CODECS = {
  appointments: appointmentCodec,
  unavailabilities: unavailabilityCodec,
  blocked_periods: blockedPeriodCodec,
  customers: customerCodec,
  services: serviceCodec,
  service_categories: serviceCategoryCodec,
  providers: providerCodec,
  secretaries: secretaryCodec,
  admins: adminCodec,
  settings: settingCodec,
  webhooks: webhookCodec,
  working_plan_exceptions: workingPlanExceptionCodec,
} as const;

// ---------------------------------------------------------------------------
// Availabilities y webhook
// ---------------------------------------------------------------------------

/**
 * `GET /availabilities` devuelve un arreglo plano de `"HH:MM"` sin decir de
 * qué técnica, servicio ni día son. El contexto lo pone quien llamó — por eso
 * este mapeo recibe la consulta y no solo la respuesta.
 */
export function availabilityFromApi(
  query: { providerId: number; serviceId: number; date: EaLocalDate },
  source: unknown,
): Availability {
  if (!Array.isArray(source)) {
    throw new EaMappingError("availabilities", `se esperaba una lista y llegó ${typeof source}`);
  }

  return {
    ...query,
    hours: source.map((value, i) => {
      const time = toTime(`availabilities[${i}]`, value);
      if (time === null) throw new EaMappingError(`availabilities[${i}]`, "hora vacía");
      return time;
    }),
  };
}

/**
 * Valida el sobre `{action, payload}` que EA hace POST.
 *
 * Solo verifica la forma del sobre; el payload lo decodifica el codec del
 * recurso que corresponda a la acción. La verificación del header estático es
 * de B4 (`lib/webhook-verify.ts`), no de acá.
 */
export function parseWebhookEnvelope(body: unknown): EaWebhookEnvelope {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EaMappingError("webhook", "el cuerpo no es un objeto");
  }

  const envelope = body as UnknownRecord;
  const action = envelope.action;

  if (!isEaWebhookAction(action)) {
    throw new EaMappingError("webhook.action", `acción desconocida: ${JSON.stringify(action)}`);
  }

  const payload = envelope.payload;

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new EaMappingError("webhook.payload", "el payload no es una fila");
  }

  return { action, payload: payload as RowShape };
}

/** Type guard de conveniencia para el plan semanal ya decodificado. */
export function isWorkingPlan(value: unknown): value is WorkingPlan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return days.every((day) => Object.prototype.hasOwnProperty.call(value, day));
}
