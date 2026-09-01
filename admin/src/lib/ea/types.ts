/**
 * Tipos de dominio de Easy!Appointments.
 *
 * Los campos salen del `openapi.yml` del repo de EA **y** de los `api_encode()`
 * de sus modelos, que es donde está la verdad: el spec y el encoder no siempre
 * coinciden (ver `mapping.ts`, § "Lo que el spec promete y el código no da").
 *
 * Tres representaciones de la misma cosa, y este archivo nombra las tres:
 *
 * | Forma | Dónde vive | Ejemplo |
 * | --- | --- | --- |
 * | `Api*` | payload de la API REST v1 | `{ "serviceId": 6, "start": "…" }` |
 * | dominio | acá adentro, todo el panel | `{ serviceId: 6, start: … }` |
 * | `Row*` | fila cruda de MySQL, la que llega en el webhook | `{ "id_services": 6, "start_datetime": "…" }` |
 *
 * La forma de dominio se parece a la de la API a propósito — es la que ya está
 * en camelCase y la que la mayoría del panel va a leer. Lo que cambia respecto
 * de la API es la **disciplina**: los datetimes son `EaLocalDateTime` marcados
 * (nunca `string` suelto), los ids son `number | null` explícitos, y los campos
 * que EA a veces omite son `null`, nunca `undefined`, para que un `??` no
 * cambie de sentido según por qué camino llegó el dato.
 *
 * `Api*` y `Row*` se declaran con `unknown` en los valores porque son datos que
 * vienen de afuera: nadie garantiza el tipo hasta que el codec lo valida. Los
 * tipos "de verdad" son los de dominio.
 */

import type { EaLocalDate, EaLocalDateTime } from "./datetime";

/** Los trece recursos de la API v1. */
export const EA_RESOURCES = [
  "appointments",
  "availabilities",
  "unavailabilities",
  "customers",
  "services",
  "service_categories",
  "providers",
  "secretaries",
  "admins",
  "settings",
  "webhooks",
  "blocked_periods",
  "working_plan_exceptions",
] as const;

export type EaResource = (typeof EA_RESOURCES)[number];

/** Un objeto que llegó de afuera y todavía no fue validado. */
export type UnknownRecord = Readonly<Record<string, unknown>>;

/** Forma cruda camelCase de la API. */
export type ApiShape = UnknownRecord;

/** Forma cruda snake_case de la fila de MySQL (payload del webhook). */
export type RowShape = UnknownRecord;

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

/**
 * Cita.
 *
 * `status` es **texto libre**: la migración `043` de EA siembra
 * `["Booked", "Confirmed", "Rescheduled", "Cancelled", "Draft"]` y nada impide
 * guardar otra cosa. No se modela como unión de literales a propósito — un tipo
 * cerrado convertiría "alguien renombró un estado en EA" en un crash del panel
 * en vez de en un aviso de Diagnóstico, que es donde tiene que verse.
 *
 * No hay campo de dinero, y eso es deliberado de EA, no un olvido nuestro: el
 * precio vive en el servicio y se re-tarifa cada año. El congelado de precio es
 * de A2/B4, no de acá.
 */
export type Appointment = {
  id: number;
  /** `book_datetime`: cuándo se agendó, no cuándo es la cita. */
  bookedAt: EaLocalDateTime | null;
  start: EaLocalDateTime;
  end: EaLocalDateTime;
  /** Token público de la cita, el de los links de cancelar / reagendar. */
  hash: string | null;
  location: string | null;
  /** Jitsi, nuevo en 1.6. Irrelevante para un estudio presencial, pero viaja. */
  meetingLink: string | null;
  /** Color por cita, independiente del color del servicio. */
  color: string | null;
  status: string;
  notes: string | null;
  customerId: number | null;
  providerId: number | null;
  serviceId: number | null;
  googleCalendarId: string | null;
  caldavCalendarId: string | null;
};

/** Lo que se puede mandar al crear o actualizar una cita. */
export type AppointmentInput = Partial<Omit<Appointment, "id">>;

// ---------------------------------------------------------------------------
// Unavailabilities
// ---------------------------------------------------------------------------

/**
 * Hueco no disponible **de una técnica**. Es el mecanismo de "esta tarde no
 * estoy": una cita interna con `is_unavailability = 1` en la misma tabla.
 */
export type Unavailability = {
  id: number;
  bookedAt: EaLocalDateTime | null;
  start: EaLocalDateTime;
  end: EaLocalDateTime;
  hash: string | null;
  location: string | null;
  notes: string | null;
  providerId: number | null;
  googleCalendarId: string | null;
  caldavCalendarId: string | null;
};

export type UnavailabilityInput = Partial<Omit<Unavailability, "id">>;

// ---------------------------------------------------------------------------
// Blocked periods
// ---------------------------------------------------------------------------

/**
 * Bloqueo **de todo el estudio**. No tiene `providerId`, y eso es la
 * funcionalidad: un festivo o unas vacaciones tapan a todas las técnicas de una.
 */
export type BlockedPeriod = {
  id: number;
  name: string | null;
  start: EaLocalDateTime;
  end: EaLocalDateTime;
  notes: string | null;
};

export type BlockedPeriodInput = Partial<Omit<BlockedPeriod, "id">>;

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

/**
 * Clienta.
 *
 * `phone` mapea a la columna `phone_number`. La identidad de la clienta en este
 * proyecto es el teléfono en E.164 (§ La identidad de la clienta), no el
 * correo: EA no exige correo único y el flujo viejo inventaba direcciones.
 */
export type Customer = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  timezone: string | null;
  language: string | null;
  customField1: string | null;
  customField2: string | null;
  customField3: string | null;
  customField4: string | null;
  customField5: string | null;
  ldapDn: string | null;
  notes: string | null;
};

export type CustomerInput = Partial<Omit<Customer, "id">>;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

/**
 * Servicio.
 *
 * `price` es la fuente del snapshot de precio, y **cambia con el tiempo**: leer
 * el precio de hoy para una cita del mes pasado es el bug que el plan llama la
 * decisión más importante del diseño.
 *
 * `color` es `null` **siempre** cuando el objeto viene de la API: EA lo acepta
 * al escribir pero su `api_encode()` no lo devuelve. Ver `mapping.ts`.
 */
export type Service = {
  id: number;
  name: string | null;
  /** Minutos. */
  duration: number | null;
  price: number | null;
  currency: string | null;
  location: string | null;
  description: string | null;
  /** Escribible, pero **no legible** por la API v1. */
  color: string | null;
  /** Grilla de horarios ofrecidos. Reemplazó a `availabilitiesType` en 1.6. */
  slotInterval: number | null;
  /** Capacidad simultánea. Entra en la detección de choques de B3. */
  attendantsNumber: number | null;
  isPrivate: boolean | null;
  serviceCategoryId: number | null;
};

export type ServiceInput = Partial<Omit<Service, "id">>;

// ---------------------------------------------------------------------------
// Service categories
// ---------------------------------------------------------------------------

export type ServiceCategory = {
  id: number;
  name: string | null;
  description: string | null;
};

export type ServiceCategoryInput = Partial<Omit<ServiceCategory, "id">>;

// ---------------------------------------------------------------------------
// Providers, secretaries, admins
// ---------------------------------------------------------------------------

/** Un tramo de trabajo de un día del plan semanal. `null` = día libre. */
export type WorkingPlanDay = {
  start: string;
  end: string;
  breaks: ReadonlyArray<{ start: string; end: string }>;
} | null;

export type WorkingPlan = {
  sunday: WorkingPlanDay;
  monday: WorkingPlanDay;
  tuesday: WorkingPlanDay;
  wednesday: WorkingPlanDay;
  thursday: WorkingPlanDay;
  friday: WorkingPlanDay;
  saturday: WorkingPlanDay;
};

/**
 * Ajustes de una técnica.
 *
 * **No incluye `password` ni `salt` a propósito.** Las columnas existen en
 * `user_settings` y el `api_encode()` de EA tampoco las emite; que no tengan
 * lugar donde aterrizar en el dominio es la garantía de que un hash no termine
 * en un log, en un dump de estado o en un payload de React.
 */
export type ProviderSettings = {
  username: string | null;
  notifications: boolean | null;
  calendarView: string | null;
  googleSync: boolean | null;
  googleToken: string | null;
  googleCalendar: string | null;
  caldavSync: boolean | null;
  caldavUrl: string | null;
  caldavUsername: string | null;
  syncFutureDays: number | null;
  syncPastDays: number | null;
  workingPlan: WorkingPlan | null;
  workingPlanExceptions: ReadonlyArray<UnknownRecord> | null;
};

/** Datos de persona comunes a técnicas, secretarias y administradoras. */
export type EaPerson = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  mobile: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  notes: string | null;
  timezone: string | null;
  language: string | null;
  ldapDn: string | null;
};

/** Técnica. `services` son los ids de servicio que puede prestar. */
export type Provider = EaPerson & {
  isPrivate: boolean | null;
  services: readonly number[] | null;
  settings: ProviderSettings | null;
};

export type ProviderInput = Partial<Omit<Provider, "id">>;

export type Secretary = EaPerson & {
  /** Ids de las técnicas que administra. */
  providers: readonly number[] | null;
  settings: StaffSettings | null;
};

export type SecretaryInput = Partial<Omit<Secretary, "id">>;

export type Admin = EaPerson & {
  settings: StaffSettings | null;
};

export type AdminInput = Partial<Omit<Admin, "id">>;

/** Ajustes de secretaria / administradora: el subconjunto sin calendario. */
export type StaffSettings = {
  username: string | null;
  notifications: boolean | null;
  calendarView: string | null;
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Ajuste global. Clave-valor sin tipar: `company_name`, `api_token`,
 * `appointment_status_options`, …
 */
export type Setting = {
  name: string;
  value: string | null;
};

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Webhook registrado en EA.
 *
 * `secretHeader` **no existe acá** aunque sí exista en la tabla: el
 * `api_encode()` de EA no lo emite y su `api_decode()` no lo acepta. El nombre
 * del header solo se configura desde la interfaz de EA o por SQL. El
 * Diagnóstico de D4 puede verificar url y acciones, no el header.
 */
export type Webhook = {
  id: number;
  name: string | null;
  /** Lista separada por comas de acciones. Ver `EA_WEBHOOK_ACTIONS`. */
  actions: string | null;
  url: string | null;
  secretToken: string | null;
  isSslVerified: boolean | null;
  notes: string | null;
};

export type WebhookInput = Partial<Omit<Webhook, "id">>;

/**
 * Las dieciocho acciones que EA puede disparar
 * (`application/config/constants.php`).
 *
 * Ojo con el `openapi.yml`: su ejemplo dice
 * `appointment_create,appointment_update,customer_delete,category_create`, que
 * **no son acciones válidas**. Registrar un webhook con esos valores lo deja
 * mudo, sin error. Los nombres buenos son estos.
 */
export const EA_WEBHOOK_ACTIONS = [
  "appointment_save",
  "appointment_delete",
  "unavailability_save",
  "unavailability_delete",
  "customer_save",
  "customer_delete",
  "service_save",
  "service_delete",
  "service_category_save",
  "service_category_delete",
  "provider_save",
  "provider_delete",
  "secretary_save",
  "secretary_delete",
  "admin_save",
  "admin_delete",
  "blocked_period_save",
  "blocked_period_delete",
] as const;

export type EaWebhookAction = (typeof EA_WEBHOOK_ACTIONS)[number];

export function isEaWebhookAction(value: unknown): value is EaWebhookAction {
  return typeof value === "string" && (EA_WEBHOOK_ACTIONS as readonly string[]).includes(value);
}

/**
 * El cuerpo que EA hace POST al panel.
 *
 * `payload` es la **fila cruda en snake_case**, no la forma camelCase de la
 * API: el trigger corre dentro de `notify_and_sync_appointment()`, es decir
 * antes de `api_encode()`. La ruta del calendario de EA dispara exactamente la
 * misma forma.
 */
export type EaWebhookEnvelope = {
  action: EaWebhookAction;
  payload: RowShape;
};

// ---------------------------------------------------------------------------
// Working plan exceptions
// ---------------------------------------------------------------------------

/**
 * Excepción al plan de trabajo de una técnica.
 *
 * Fechas `YYYY-MM-DD` y horas `HH:MM` — no datetimes. `startTime` y `endTime`
 * en `null` significan día libre, y ese `null` es información, no un dato
 * faltante.
 */
export type WorkingPlanException = {
  id: number;
  startDate: EaLocalDate | null;
  endDate: EaLocalDate | null;
  startTime: string | null;
  endTime: string | null;
  breaks: ReadonlyArray<{ start: string; end: string }>;
  providerId: number | null;
};

export type WorkingPlanExceptionInput = Partial<Omit<WorkingPlanException, "id">>;

// ---------------------------------------------------------------------------
// Availabilities
// ---------------------------------------------------------------------------

/**
 * Horas libres para una técnica, un servicio y un día.
 *
 * EA devuelve un arreglo plano de `"HH:MM"` **en la zona de la técnica**, no en
 * la del estudio ni en UTC. Con una sola sede y todas las técnicas en Bogotá da
 * lo mismo; el día que no, esto es lo que hay que mirar.
 *
 * No existe "cualquier técnica" en la API: hay que abanicar una llamada por
 * técnica y unir los resultados (§ Reserva pública).
 */
export type Availability = {
  providerId: number;
  serviceId: number;
  date: EaLocalDate;
  /** `"09:00"`, `"09:30"`, … */
  hours: readonly string[];
};
