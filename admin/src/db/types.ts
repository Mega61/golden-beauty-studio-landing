/**
 * Tipos de Kysely del esquema `gbs_admin`.
 *
 * Esto es el espejo en TypeScript de `src/db/migrations/**`. Cuando cambia una
 * migración cambia este archivo, y no al revés: la base es la que manda. El
 * test de integración compara ambas cosas contra un MySQL real, que es la única
 * forma de que no se separen en silencio.
 *
 * Tres convenciones que valen para todo el archivo:
 *
 * 1. **El dinero son pesos enteros.** Colombia no tiene centavos. Cada columna
 *    de plata es `INT`/`BIGINT` y el tipo acá es `Cop`. Nunca `FLOAT`, nunca
 *    `DECIMAL` con escala — un `DECIMAL(10,2)` invita a que alguien meta 0.5
 *    pesos y a que el total del día no cuadre por un redondeo que nadie pidió.
 *    El día que haga falta escala será una migración explícita, no una
 *    suposición.
 * 2. **Las tasas son puntos básicos (`_bp`), no porcentajes.** 1250 = 12,5 %.
 *    El plan las describe como "percent (0–100)", pero un entero 0–100 no puede
 *    expresar 12,5 % y una tasa fraccionaria es perfectamente posible; guardarla
 *    en `bp` no pierde nada y sigue siendo entero. Ver el reporte de A2.
 * 3. **`DATE` viaja como `"YYYY-MM-DD"`, `DATETIME` como `Date`.** El driver
 *    está configurado con `dateStrings: ["DATE"]` (ver `client.ts`) justamente
 *    para esto: un `DATE` convertido a `Date` queda a medianoche *local*, y en
 *    America/Bogota eso corre el día entero cinco horas cuando algo lo
 *    serializa a UTC. Los cortes de quincena y la fecha de cierre son
 *    calendario, no instantes; se tratan como texto.
 */

import type {
  ColumnType,
  Generated,
  Insertable,
  JSONColumnType,
  Selectable,
  Updateable,
} from "kysely";

// ── Alias de columna ────────────────────────────────────────────────────────

/** Pesos colombianos, enteros. Ver la convención 1 arriba. */
export type Cop = number;

/** Puntos básicos: 10000 = 100 %. Ver la convención 2 arriba. */
export type BasisPoints = number;

/** Fecha de calendario `"YYYY-MM-DD"`. Ver la convención 3 arriba. */
export type SqlDate = ColumnType<string, string, string>;

/** Instante. Se lee como `Date` en la zona del proceso (America/Bogota). */
export type SqlDateTime = ColumnType<Date, Date | string, Date | string>;

/**
 * `DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`: opcional al insertar,
 * inmutable después. Que no se pueda actualizar es a propósito — reescribir un
 * `created_at` es reescribir historia.
 */
export type CreatedAt = ColumnType<Date, Date | string | undefined, never>;

/** `DATETIME ... ON UPDATE CURRENT_TIMESTAMP`: MySQL lo mantiene solo. */
export type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string | undefined>;

/** Id de Better Auth. Cadena, no autoincremental: la genera la librería. */
export type AuthId = string;

// ── Enums ───────────────────────────────────────────────────────────────────

export type UserRole = "owner" | "admin" | "staff";

/** Igual al enum `Payment.method` de Strapi. No inventar valores nuevos acá. */
export type PaymentMethod = "efectivo" | "transferencia" | "otro";

/**
 * De dónde salió el snapshot de precio.
 *
 * `fallback` **es** la marca de "esta cita se valoró al precio de lista de hoy
 * porque no había snapshot". Sin ella, un cero silencioso es indistinguible de
 * un cero correcto — es el mismo principio que la comisión sin regla aplicable.
 */
export type SnapshotSource = "webhook" | "reconcile" | "fallback";

export type FinanceItemKind = "servicio" | "adicional" | "manual";

/** Lista corta del flujo de "Cerrar servicio". Texto libre aparte. */
export type VarianceReasonCode =
  | "cambio_servicio"
  | "adicionales"
  | "cortesia"
  | "correccion"
  | "otro";

export type CommissionAppliesTo = "principal" | "adicionales" | "ambos";

export type CommissionRuleKind = "percent" | "fixed";

export type CommissionEntryStatus = "pending" | "paid";

/** Una vez `pagada`, la liquidación es inmutable. Lo cuida el repositorio. */
export type CommissionRunStatus = "borrador" | "revisada" | "pagada";

// ── Better Auth ─────────────────────────────────────────────────────────────
//
// Los nombres de columna son camelCase porque los fija Better Auth, no
// nosotros: su adaptador de Kysely mapea el nombre del campo directo a la
// columna. Renombrarlos a snake_case obligaría a un mapa de campos en
// `lib/auth.ts` y a mantenerlo sincronizado con cada versión de la librería.
// El resto del esquema sí es snake_case.

export interface UserTable {
  id: AuthId;
  name: string;
  email: string;
  emailVerified: ColumnType<number, number | undefined, number>;
  image: string | null;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export interface SessionTable {
  id: AuthId;
  userId: AuthId;
  token: string;
  expiresAt: SqlDateTime;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export interface AccountTable {
  id: AuthId;
  userId: AuthId;
  accountId: string;
  providerId: string;
  accessToken: string | null;
  refreshToken: string | null;
  idToken: string | null;
  accessTokenExpiresAt: SqlDateTime | null;
  refreshTokenExpiresAt: SqlDateTime | null;
  scope: string | null;
  password: string | null;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export interface VerificationTable {
  id: AuthId;
  identifier: string;
  value: string;
  expiresAt: SqlDateTime;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

// ── Dominio ─────────────────────────────────────────────────────────────────

/**
 * La allowlist: correo → rol → provider de EA opcional.
 *
 * Existe **antes** que la fila de `user`: la dueña autoriza un correo y la fila
 * de Better Auth aparece recién cuando esa persona entra por primera vez. Por
 * eso no hay FK hacia `user` — la tendría al revés de como se puebla.
 *
 * `ea_provider_id` es el puente entre las dos identidades que conviven a
 * propósito: la cuenta de Workspace con la que la persona entra al panel, y la
 * cuenta de EA que usa el sync de Google Calendar. Nadie necesita saber su
 * contraseña de EA para trabajar.
 */
export interface AllowedUserTable {
  id: Generated<number>;
  email: string;
  role: UserRole;
  ea_provider_id: number | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * Una fila por cita de EA. Es el encabezado de la cuenta y **es** el libro de
 * caja: EA no guarda dinero.
 *
 * `ea_appointment_id` es UNIQUE y esa unicidad es la llave de idempotencia del
 * webhook. El handler inserta ignorando el duplicado; si EA reenvía el mismo
 * evento, o el reconcile pasa por una cita que el webhook ya trajo, no aparece
 * una segunda fila. La invariante vive en el esquema y no en el handler porque
 * el handler tiene dos caminos de entrada (webhook y reconcile) y el esquema
 * uno solo.
 */
export interface AppointmentFinanceTable {
  id: Generated<number>;
  ea_appointment_id: number;

  /**
   * Copia local del provider y del inicio de la cita.
   *
   * No es cache por comodidad: `gbs_admin` y `easyappointments` se leen con
   * **usuarios distintos** (RW sobre el nuestro, solo lectura sobre el de EA),
   * así que un JOIN cross-schema no está disponible desde esta conexión. Sin
   * estas dos columnas, "la liquidación de la quincena de Fulana" o "la agenda
   * de esta semana" no se pueden indexar.
   */
  ea_provider_id: number | null;
  secondary_ea_provider_id: number | null;
  appointment_start_at: SqlDateTime | null;

  /**
   * Agendado y realizado son campos distintos y los dos se guardan: la
   * diferencia entre ambos *es* un dato de negocio. Si la mitad de los press-on
   * terminan en forrado, eso no es un error de la técnica, es el menú pidiendo
   * un ajuste.
   */
  booked_service_id: number | null;
  performed_service_id: number | null;

  /** Precio de lista congelado al agendar. `null` ⇒ ver `snapshot_source`. */
  service_price_snapshot: Cop | null;
  snapshot_source: SnapshotSource;

  discount: Generated<Cop>;
  /** `null` hasta que la técnica cierra la cuenta. */
  amount_charged: Cop | null;
  /** Va aparte y **nunca** entra a la base de comisión ni al ingreso. */
  tip: Generated<Cop>;

  payment_method: PaymentMethod | null;
  /** Se cobra siempre el mismo día: cae en la fecha de la cita. */
  paid_at: SqlDateTime | null;

  /** Observaciones internas. **No** viajan a las notas de la cita en EA. */
  service_notes: string | null;

  variance_reason_code: VarianceReasonCode | null;
  variance_reason: string | null;

  closed_by: AuthId | null;
  closed_at: SqlDateTime | null;

  day_close_id: number | null;
  pushed_to_ingest_at: SqlDateTime | null;

  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * Los renglones de la cuenta. Una cita no tiene *un* precio: tiene una cuenta.
 *
 * `qty` y `line_total` son **con signo** a propósito. Un renglón `manual` en
 * cero cubre el retoque de garantía (queda contado en ocupación y en la ficha
 * de la clienta sin cobrar), y una corrección posterior al cierre entra como
 * renglón nuevo — que puede ser negativo — nunca como edición en sitio.
 */
export interface AppointmentFinanceItemTable {
  id: Generated<number>;
  appointment_finance_id: number;
  kind: FinanceItemKind;
  ea_service_id: number | null;
  /** Id de `src/data/pricing.ts`. Los adicionales salen de la categoría `extras`. */
  pricing_id: string | null;
  qty: Generated<number>;
  unit_price_snapshot: Cop;
  line_total: Cop;
  /** Obligatoria para `kind = 'manual'`: lo valida `lib/ticket.ts`. */
  note: string | null;
  created_at: CreatedAt;
}

/**
 * El cierre diario. Congela las cuentas del día y es **la unidad de push** a
 * ingest — no la cita.
 *
 * Los totales por método son tres columnas y no una tabla hija porque
 * `PaymentMethod` tiene exactamente tres valores fijados por el enum de Strapi:
 * una tabla hija agregaría un join a la consulta más frecuente del panel para
 * ganar una flexibilidad que el contrato aguas abajo no permite usar.
 */
export interface DayCloseTable {
  id: Generated<number>;
  close_date: SqlDate;
  total_efectivo: Generated<Cop>;
  total_transferencia: Generated<Cop>;
  total_otro: Generated<Cop>;
  total_tips: Generated<Cop>;
  appointment_count: Generated<number>;
  closed_by: AuthId;
  closed_at: SqlDateTime;
  pushed_to_ingest_at: SqlDateTime | null;
  created_at: CreatedAt;
}

/**
 * Cada POST recibido de EA.
 *
 * EA **no reintenta**: un panel caído diez minutos pierde los eventos de esos
 * diez minutos. Esta tabla no es para deduplicar los reintentos de EA (no
 * existen) sino los **nuestros** — el reconcile nocturno y el reproceso manual.
 * Y es el rastro con el que se depura un evento perdido, que con un webhook sin
 * reintentos es el modo de falla esperado, no el raro.
 *
 * `(action, ea_entity_id, body_hash)` es UNIQUE. Un cuerpo malformado deja
 * `ea_entity_id` en `null`, y como MySQL admite varios `NULL` en un índice
 * único, esos nunca se deduplican entre sí: cada cuerpo roto merece su propia
 * fila de rastro.
 */
export interface WebhookEventTable {
  id: Generated<number>;
  action: string;
  ea_entity_id: number | null;
  /** sha256 hex del cuerpo crudo. El cuerpo no se guarda: ver el reporte de A2. */
  body_hash: string;
  received_at: SqlDateTime;
  processed_at: SqlDateTime | null;
  error: string | null;
}

/**
 * Una regla de comisión: a quién aplica, sobre qué, cuánto, y desde cuándo.
 *
 * `null` en `ea_provider_id` / `category_id` / `ea_service_id` significa
 * "todas". La precedencia (provider+service ▶ provider+category ▶ provider ▶
 * service ▶ category ▶ global) se resuelve en `lib/commission.ts`, no acá: es
 * una función pura sobre las reglas vigentes, y como tal se testea.
 *
 * El solape de reglas se valida **al guardar**, en el editor, no al liquidar.
 * No hay constraint que lo exprese: MySQL no tiene exclusión por rango.
 *
 * `valid_to` es **inclusivo**: una regla que termina el 15 aplica al día 15
 * completo.
 */
export interface CommissionRuleTable {
  id: Generated<number>;
  ea_provider_id: number | null;
  /** Categoría de `pricing.ts`: montajes, retoques, forrados, sencillos, combos, extras. */
  category_id: string | null;
  ea_service_id: number | null;
  applies_to: CommissionAppliesTo;
  kind: CommissionRuleKind;
  /** Exactamente uno de los dos según `kind`. Lo garantiza un CHECK. */
  percent_bp: BasisPoints | null;
  fixed_amount: Cop | null;
  valid_from: SqlDate;
  valid_to: SqlDate | null;
  created_by: AuthId | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * La liquidación de una quincena para una técnica.
 *
 * Una vez `pagada` es inmutable — así se trabaja hoy y el sistema lo respalda
 * en vez de pelearlo. Lo hace cumplir `CommissionRunRepository`, no un trigger:
 * un trigger sería invisible desde el código y no se puede crear de forma
 * idempotente en MySQL (`CREATE TRIGGER IF NOT EXISTS` no existe).
 */
export interface CommissionRunTable {
  id: Generated<number>;
  ea_provider_id: number;
  period_start: SqlDate;
  period_end: SqlDate;
  total: Generated<Cop>;
  status: Generated<CommissionRunStatus>;
  reviewed_by: AuthId | null;
  reviewed_at: SqlDateTime | null;
  paid_by: AuthId | null;
  paid_at: SqlDateTime | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * La comisión de **un renglón** de cuenta, congelada.
 *
 * Se guarda la regla aplicada, la base y la tasa, no solo el monto: recalcular
 * una comisión vieja con las reglas de hoy da un número distinto y equivocado,
 * igual que revalorar una cita vieja al precio de hoy.
 *
 * `commission_rule_id = null` significa **cero marcado**, no cero calculado.
 * Sin regla aplicable el motor no adivina; deja la marca para que se vea en
 * revisión. Un cero silencioso es indistinguible de un cero correcto.
 *
 * La UNIQUE es `(appointment_finance_item_id, ea_provider_id)` y no solo el
 * renglón: un combo trabajado por dos técnicas reparte ese mismo renglón entre
 * las dos por `allocation_hands_bp`. La clave hace idempotente el recálculo de
 * un periodo en borrador sin impedir el reparto.
 */
export interface CommissionEntryTable {
  id: Generated<number>;
  appointment_finance_item_id: number;
  ea_provider_id: number;
  commission_rule_id: number | null;
  /** Lo cobrado en ese renglón, con el descuento del ticket ya prorrateado. */
  base_amount: Cop;
  /** Tasa congelada, si la regla era `percent`. */
  rate_bp: BasisPoints | null;
  amount: Cop;
  period_start: SqlDate;
  period_end: SqlDate;
  status: Generated<CommissionEntryStatus>;
  commission_run_id: number | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * Un combo es **un servicio de EA**, no dos citas enlazadas.
 *
 * Precio y duración son criterio de la dueña, *menores* que la suma de las
 * partes, y nunca se auto-calculan. Esta fila registra la composición para que
 * los reportes puedan seguir atribuyendo ingreso a los servicios de manos y
 * pies subyacentes, y el reparto de comisión cuando lo trabajan dos técnicas.
 */
export interface ComboTable {
  id: Generated<number>;
  /** El servicio de EA publicado en la categoría "Combos". */
  ea_service_id: number;
  hands_ea_service_id: number;
  feet_ea_service_id: number;
  price: Cop;
  duration_min: number;
  /** Qué parte del combo cuenta como manos. El resto es pies. */
  allocation_hands_bp: BasisPoints;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * `pricing_id` (la vitrina) ↔ `ea_service_id` (lo que se cobra).
 *
 * Sin esto, la vitrina y el catálogo operativo son dos listas que se separan en
 * silencio. Ambas columnas son NOT NULL y únicas: esta tabla es *el mapeo*, no
 * un inventario. Un servicio "solo vitrina" simplemente no tiene fila acá — la
 * marca de que eso es deliberado vive en `src/data/pricing.ts`, que es la
 * fuente de verdad de la vitrina, y es donde `scripts/check-pricing.mjs` la
 * puede leer sin conectarse a la base.
 */
export interface ServiceMapTable {
  pricing_id: string;
  ea_service_id: number;
  /** Último `PUT /services/{id}` exitoso. Alimenta la pantalla de diff. */
  last_published_at: SqlDateTime | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * Los puestos físicos del estudio. Se siembra con dos filas.
 *
 * EA no tiene ningún concepto de sala, puesto o equipo — `attendantsNumber` es
 * capacidad por servicio, no por local. Con tres técnicas en agenda, tres citas
 * simultáneas siguen siendo físicamente imposibles, y esa es la restricción que
 * produce el peor error posible: vender por la web una hora en la que no hay
 * silla.
 *
 * `allows` es un array JSON de categorías de `pricing.ts`, o `null` = cualquiera.
 * Queda por confirmar si las dos estaciones son intercambiables o si una es de
 * manos y otra de pies; el modelo aguanta las dos respuestas — cambian las
 * filas, no el código.
 */
export interface StationTable {
  id: Generated<number>;
  name: string;
  allows: JSONColumnType<string[] | null, string | null, string | null>;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * Segundo camino de login, para las técnicas: usan correo personal, así que la
 * compuerta de Workspace las deja afuera por diseño.
 *
 * `secret_encrypted` es VARBINARY porque el secreto va cifrado con
 * `TOTP_ENC_KEY` y **nunca** en claro. `last_used_step` es la anti-repetición
 * obligatoria: un código vive 30 segundos y alguien que lo vea por encima del
 * hombro podría reusarlo dentro de la ventana.
 *
 * `first_failed_at` no está en el plan y hace falta: "5 fallos en 15 minutos"
 * es una ventana, y un contador solo no puede expresar una ventana — sin la
 * marca de cuándo empezó la racha, cinco fallos repartidos en un mes bloquean
 * la cuenta.
 */
export interface StaffTotpTable {
  user_id: AuthId;
  secret_encrypted: Buffer;
  confirmed_at: SqlDateTime | null;
  last_used_step: number | null;
  failed_attempts: Generated<number>;
  first_failed_at: SqlDateTime | null;
  locked_until: SqlDateTime | null;
  created_at: CreatedAt;
  updated_at: UpdatedAt;
}

/**
 * Histórico de Agenda Pro, para continuidad de reportes sin ensuciar el
 * calendario de EA.
 *
 * **Forma provisional.** El plan no especifica sus campos y depende de una
 * decisión pendiente: qué trae realmente el export de Agenda Pro, y si hay
 * dinero por cita. `amount_charged` es nullable justamente por eso — `null`
 * significa "el export no traía la plata", no "la cita fue gratis". Ver el
 * reporte de A2.
 *
 * `source_id` es UNIQUE: el import se puede correr dos veces sin duplicar.
 * Los servicios y las técnicas se guardan por **nombre**, no por id: Agenda Pro
 * no comparte identificadores con EA y fabricar una correspondencia sería
 * inventar datos.
 */
export interface LegacyAppointmentTable {
  id: Generated<number>;
  source_id: string;
  started_at: SqlDateTime;
  ended_at: SqlDateTime | null;
  /** La identidad de la clienta es el teléfono, nunca un correo inventado. */
  client_phone_e164: string | null;
  client_name: string | null;
  service_name: string;
  provider_name: string | null;
  amount_charged: Cop | null;
  status: string | null;
  imported_at: CreatedAt;
}

/**
 * Quién cambió qué desde el panel.
 *
 * **Sin llaves foráneas, a propósito.** Es un log append-only: una FK hacia
 * `user` podría bloquear un borrado legítimo, o peor, borrar en cascada el
 * rastro de lo que esa persona hizo. `actor_user_id` en `null` significa "el
 * sistema" — el webhook, el reconcile, el cron de cierre.
 *
 * La cuenta se puede corregir; lo que no se puede es corregirla sin dejar
 * huella.
 */
export interface AuditLogTable {
  id: Generated<number>;
  actor_user_id: AuthId | null;
  action: string;
  entity: string;
  entity_id: string;
  /**
   * `ColumnType` a mano y no `JSONColumnType`: el helper de Kysely exige que
   * el tipo leído sea `object | null`, y acá el documento puede ser cualquier
   * cosa que quepa en un JSON. mysql2 lo parsea al leer y espera un string al
   * escribir, que es exactamente esta forma.
   */
  before_json: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  after_json: ColumnType<Record<string, unknown> | null, string | null, string | null>;
  reason: string | null;
  created_at: CreatedAt;
}

/**
 * El libro de migraciones aplicadas.
 *
 * `checksum` existe porque el esquema es forward-only: editar una migración ya
 * aplicada deja la base y el archivo diciendo cosas distintas, y el runner
 * prefiere gritar a seguir. Corregir se hace con una migración nueva.
 */
export interface SchemaMigrationTable {
  id: string;
  checksum: string;
  applied_at: CreatedAt;
}

// ── El esquema completo ─────────────────────────────────────────────────────

export interface Database {
  // Better Auth
  user: UserTable;
  session: SessionTable;
  account: AccountTable;
  verification: VerificationTable;

  // Dominio
  allowed_user: AllowedUserTable;
  appointment_finance: AppointmentFinanceTable;
  appointment_finance_item: AppointmentFinanceItemTable;
  day_close: DayCloseTable;
  webhook_event: WebhookEventTable;
  commission_rule: CommissionRuleTable;
  commission_run: CommissionRunTable;
  commission_entry: CommissionEntryTable;
  combo: ComboTable;
  service_map: ServiceMapTable;
  station: StationTable;
  staff_totp: StaffTotpTable;
  legacy_appointment: LegacyAppointmentTable;
  audit_log: AuditLogTable;

  // Infraestructura
  schema_migration: SchemaMigrationTable;
}

// ── Filas listas para usar ──────────────────────────────────────────────────
//
// Los paquetes siguientes consumen estos, no `Database` directo: `Selectable`
// resuelve los `Generated`/`ColumnType` a lo que realmente vuelve de la base.

export type AllowedUser = Selectable<AllowedUserTable>;
export type NewAllowedUser = Insertable<AllowedUserTable>;
export type AllowedUserUpdate = Updateable<AllowedUserTable>;

export type AppointmentFinance = Selectable<AppointmentFinanceTable>;
export type NewAppointmentFinance = Insertable<AppointmentFinanceTable>;
export type AppointmentFinanceUpdate = Updateable<AppointmentFinanceTable>;

export type AppointmentFinanceItem = Selectable<AppointmentFinanceItemTable>;
export type NewAppointmentFinanceItem = Insertable<AppointmentFinanceItemTable>;

export type DayClose = Selectable<DayCloseTable>;
export type NewDayClose = Insertable<DayCloseTable>;

export type WebhookEvent = Selectable<WebhookEventTable>;
export type NewWebhookEvent = Insertable<WebhookEventTable>;

export type CommissionRule = Selectable<CommissionRuleTable>;
export type NewCommissionRule = Insertable<CommissionRuleTable>;

export type CommissionRun = Selectable<CommissionRunTable>;
export type NewCommissionRun = Insertable<CommissionRunTable>;

export type CommissionEntry = Selectable<CommissionEntryTable>;
export type NewCommissionEntry = Insertable<CommissionEntryTable>;

export type Combo = Selectable<ComboTable>;
export type NewCombo = Insertable<ComboTable>;

export type ServiceMap = Selectable<ServiceMapTable>;
export type NewServiceMap = Insertable<ServiceMapTable>;

export type Station = Selectable<StationTable>;

export type StaffTotp = Selectable<StaffTotpTable>;
export type NewStaffTotp = Insertable<StaffTotpTable>;

export type LegacyAppointment = Selectable<LegacyAppointmentTable>;
export type NewLegacyAppointment = Insertable<LegacyAppointmentTable>;

export type AuditLogRow = Selectable<AuditLogTable>;
export type NewAuditLog = Insertable<AuditLogTable>;
