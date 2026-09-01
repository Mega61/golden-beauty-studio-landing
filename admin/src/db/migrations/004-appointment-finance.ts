import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * El encabezado de la cuenta: **una fila por cita de EA**.
 *
 * EA no guarda dinero, así que esta tabla *es* el libro de caja. Una
 * `gbs_admin` perdida no se puede reconstruir desde ninguna otra fuente — de
 * ahí que los respaldos entren en la Fase 0 y no "más adelante".
 *
 * ## `ea_appointment_id` UNIQUE
 *
 * Es la llave de idempotencia del webhook, y está en el esquema y no en el
 * handler a propósito: hay **dos** caminos de escritura (el webhook y el
 * reconcile nocturno) y un solo esquema. Que el reconcile no duplique lo que el
 * webhook ya trajo no depende de que los dos recuerden chequear.
 *
 * ## Las columnas que el plan no enumera y por qué están
 *
 * `ea_provider_id` y `appointment_start_at` son copia local de datos que viven
 * en `easyappointments`. No es cache por comodidad: los dos esquemas se leen
 * con **usuarios distintos** — RW sobre `gbs_admin`, solo lectura sobre
 * `easyappointments` — así que desde esta conexión no hay JOIN cross-schema.
 * Sin ellas, "la agenda de esta semana" y "la liquidación de la quincena de
 * Fulana" no se pueden indexar, y son las dos consultas más frecuentes del
 * panel.
 *
 * `secondary_ea_provider_id` sale de Combos: dos técnicas trabajando un combo
 * se resuelve con `allocation_hands_bp` más un provider secundario acá, no
 * partiendo la cita.
 *
 * ## Lo que NO está
 *
 * No hay columna "snapshot faltante". `snapshot_source = 'fallback'` **es** esa
 * marca, y tenerla dos veces es tenerla mal una de las dos.
 *
 * No hay `CHECK` para `Σ line_total − discount == amount_charged`: cruza dos
 * tablas y MySQL no lo puede expresar. Vive en `lib/ticket.ts`, función pura,
 * con cobertura de ramas al 100 %.
 */
export const migration: Migration = {
  id: "004-appointment-finance",
  description: "Encabezado de la cuenta de servicio, una fila por cita de EA",
  statements: [
    `CREATE TABLE IF NOT EXISTS appointment_finance (
       id                       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       ea_appointment_id        INT UNSIGNED NOT NULL,

       ea_provider_id           INT UNSIGNED NULL,
       secondary_ea_provider_id INT UNSIGNED NULL,
       appointment_start_at     DATETIME NULL,

       booked_service_id        INT UNSIGNED NULL,
       performed_service_id     INT UNSIGNED NULL,

       service_price_snapshot   INT NULL,
       snapshot_source          ENUM('webhook','reconcile','fallback') NOT NULL,

       discount                 INT NOT NULL DEFAULT 0,
       amount_charged           INT NULL,
       tip                      INT NOT NULL DEFAULT 0,

       payment_method           ENUM('efectivo','transferencia','otro') NULL,
       paid_at                  DATETIME NULL,

       service_notes            TEXT NULL,

       variance_reason_code     ENUM('cambio_servicio','adicionales','cortesia','correccion','otro') NULL,
       variance_reason          VARCHAR(500) NULL,

       closed_by                VARCHAR(36) NULL,
       closed_at                DATETIME NULL,

       day_close_id             INT UNSIGNED NULL,
       pushed_to_ingest_at      DATETIME NULL,

       created_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at               DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       UNIQUE KEY uq_af_ea_appointment (ea_appointment_id),

       -- Agenda por rango de fechas, y "cuentas sin cerrar de hoy" con el mismo
       -- índice: la segunda columna filtra por closed_at IS NULL sin tocar la tabla.
       KEY idx_af_start_closed (appointment_start_at, closed_at),
       -- Liquidación y agenda por técnica.
       KEY idx_af_provider_start (ea_provider_id, appointment_start_at),
       -- Reportes por servicio realizado (y la tasa de cambio contra el agendado).
       KEY idx_af_performed_start (performed_service_id, appointment_start_at),
       KEY idx_af_booked (booked_service_id),
       -- Base caja. Se cobra siempre el mismo día, así que ordena igual que la cita.
       KEY idx_af_paid_at (paid_at),
       KEY idx_af_day_close (day_close_id),

       CONSTRAINT fk_af_day_close FOREIGN KEY (day_close_id)
         REFERENCES day_close (id) ON DELETE RESTRICT ON UPDATE CASCADE,
       CONSTRAINT fk_af_closed_by FOREIGN KEY (closed_by)
         REFERENCES \`user\` (id) ON DELETE RESTRICT ON UPDATE CASCADE,

       -- El descuento y la propina no pueden ser negativos: un "descuento
       -- negativo" es un recargo, y si algún día existe será un renglón, no un
       -- signo escondido. El total sí admite negativo (una nota de ajuste).
       CONSTRAINT ck_af_discount CHECK (discount >= 0),
       CONSTRAINT ck_af_tip CHECK (tip >= 0),
       -- Texto de motivo sin código es un motivo huérfano: no se puede agrupar
       -- en el reporte de variación por técnica, que es para lo que existe.
       --
       -- La regla fuerte de verdad — "si el total difiere del calculado se pide
       -- motivo" — NO está acá: el total calculado sale de los renglones, que
       -- viven en otra tabla, y MySQL no puede expresar un CHECK cruzado. Vive
       -- en \`lib/ticket.ts\`. Poner acá una versión aproximada de esa regla
       -- daría la falsa sensación de que la base la está cuidando.
       CONSTRAINT ck_af_variance_text_needs_code CHECK (
         variance_reason IS NULL OR variance_reason_code IS NOT NULL
       )
     ) ${TABLE_OPTIONS}`,
  ],
};
