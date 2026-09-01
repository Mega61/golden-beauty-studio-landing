import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * La liquidación de una quincena para una técnica.
 *
 * Va antes que `commission_entry` porque la entrada la referencia.
 *
 * `borrador → revisada → pagada`, y **una vez `pagada` es inmutable**: nada se
 * ajusta después de pagar. Así se trabaja hoy y el sistema lo respalda en vez
 * de pelearlo. Lo que hace que eso funcione es que la revisión previa sea real,
 * y por eso la liquidación no se puede marcar como revisada mientras queden
 * cuentas sin cerrar o días sin cerrar en el periodo — el bloqueo es la
 * funcionalidad, y vive en el repositorio y en `lib/`.
 *
 * **La inmutabilidad no se implementa con un trigger.** Sería magia invisible
 * desde el código, y MySQL no tiene `CREATE TRIGGER IF NOT EXISTS`, así que un
 * trigger rompería la idempotencia del set de migraciones. La cuida
 * `CommissionRunRepository.setStatus()`, que se testea.
 *
 * `reviewed_by` / `reviewed_at` no están en el plan y se agregan por simetría
 * con `paid_by` / `paid_at`: si "revisada" es un estado que habilita el pago,
 * quién revisó es parte del rastro. Son dos columnas nullable; la alternativa
 * era buscarlo en `audit_log` por texto.
 *
 * Los periodos quincenales (1–15 y 16–fin de mes) **no** están codificados acá:
 * la tabla guarda `period_start` / `period_end` explícitos porque los cortes
 * reales todavía son una decisión pendiente, y no se pueden mover después de la
 * primera liquidación.
 */
export const migration: Migration = {
  id: "008-commission-run",
  description: "Liquidación quincenal por técnica, con estados y pago",
  statements: [
    `CREATE TABLE IF NOT EXISTS commission_run (
       id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
       ea_provider_id INT UNSIGNED NOT NULL,
       period_start   DATE NOT NULL,
       period_end     DATE NOT NULL,
       total          BIGINT NOT NULL DEFAULT 0,
       status         ENUM('borrador','revisada','pagada') NOT NULL DEFAULT 'borrador',
       reviewed_by    VARCHAR(36) NULL,
       reviewed_at    DATETIME NULL,
       paid_by        VARCHAR(36) NULL,
       paid_at        DATETIME NULL,
       created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       -- Una liquidación por técnica y periodo. Es lo que hace que recalcular
       -- un borrador sea un UPDATE y no una segunda liquidación fantasma.
       UNIQUE KEY uq_run_provider_period (ea_provider_id, period_start, period_end),
       KEY idx_run_period (period_start, period_end),
       KEY idx_run_status (status),

       -- \`ON UPDATE RESTRICT\` y no CASCADE, a diferencia del resto del esquema:
       -- MySQL 8 no admite un CHECK sobre una columna que participe de una
       -- acción referencial, y acá el CHECK de abajo vale más. El CASCADE no se
       -- pierde de nada — los ids de Better Auth son cadenas inmutables que la
       -- librería genera una vez y nunca reescribe.
       CONSTRAINT fk_run_reviewed_by FOREIGN KEY (reviewed_by)
         REFERENCES \`user\` (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
       CONSTRAINT fk_run_paid_by FOREIGN KEY (paid_by)
         REFERENCES \`user\` (id) ON DELETE RESTRICT ON UPDATE RESTRICT,

       CONSTRAINT ck_run_period_order CHECK (period_end >= period_start),
       CONSTRAINT ck_run_paid_pair CHECK (
         (paid_by IS NULL AND paid_at IS NULL) OR (paid_by IS NOT NULL AND paid_at IS NOT NULL)
       )
     ) ${TABLE_OPTIONS}`,
  ],
};
