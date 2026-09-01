import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * El cierre diario.
 *
 * Va **antes** que `appointment_finance` porque esa tabla la referencia
 * (`day_close_id`), y una FK no puede apuntar a una tabla que todavía no
 * existe.
 *
 * Es la unidad de push a ingest, no la cita. Actual Budget deduplica por
 * `imported_id` y **no actualiza** el monto de una transacción ya importada: si
 * se empujara al cerrar cada cuenta, corregir un ticket a las 3 p. m. dejaría a
 * Actual con la cifra vieja para siempre, sin error visible. Empujando al
 * cierre del día las correcciones intradía salen gratis.
 *
 * `close_date` es UNIQUE: un día se cierra una sola vez.
 *
 * Los totales son `BIGINT` y no `INT` porque son agregados. Un renglón de
 * cuenta no llega a 2.147.483.647 pesos ni de lejos, pero una columna de
 * acumulado no es el lugar para andar contando cuánto le falta al techo.
 */
export const migration: Migration = {
  id: "003-day-close",
  description: "Cierre diario: totales por método, quién cerró y push a ingest",
  statements: [
    `CREATE TABLE IF NOT EXISTS day_close (
       id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
       close_date           DATE   NOT NULL,
       total_efectivo       BIGINT NOT NULL DEFAULT 0,
       total_transferencia  BIGINT NOT NULL DEFAULT 0,
       total_otro           BIGINT NOT NULL DEFAULT 0,
       total_tips           BIGINT NOT NULL DEFAULT 0,
       appointment_count    INT UNSIGNED NOT NULL DEFAULT 0,
       closed_by            VARCHAR(36) NOT NULL,
       closed_at            DATETIME NOT NULL,
       pushed_to_ingest_at  DATETIME NULL,
       created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (id),
       UNIQUE KEY uq_day_close_date (close_date),
       KEY idx_day_close_pushed (pushed_to_ingest_at),
       -- RESTRICT y no CASCADE: borrar a una persona no puede llevarse por
       -- delante el cierre de caja que firmó.
       CONSTRAINT fk_day_close_closed_by FOREIGN KEY (closed_by)
         REFERENCES \`user\` (id) ON DELETE RESTRICT ON UPDATE CASCADE,
       CONSTRAINT ck_day_close_totals CHECK (
         total_efectivo >= 0 AND total_transferencia >= 0
         AND total_otro >= 0 AND total_tips >= 0
       )
     ) ${TABLE_OPTIONS}`,
  ],
};
