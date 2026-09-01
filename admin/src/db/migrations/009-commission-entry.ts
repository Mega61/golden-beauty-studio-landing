import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * La comisión de **un renglón** de cuenta, congelada.
 *
 * Se evalúa por renglón y no por cita: un montaje con tres diseños puede pagar
 * dos tasas distintas. Y la base es el **renglón realizado**, no el servicio
 * agendado — una cita reservada como press-on y cerrada como forrado paga
 * forrado.
 *
 * Se guardan la regla aplicada, la base y la tasa, no solo el monto. Recalcular
 * una comisión vieja con las reglas de hoy da un número distinto y equivocado,
 * por la misma razón por la que no se revalora una cita vieja al precio de hoy.
 *
 * `commission_rule_id = NULL` significa **cero marcado**, no cero calculado.
 * Sin regla aplicable el motor no adivina: deja la marca para que se vea en
 * revisión. Un cero silencioso es indistinguible de un cero correcto.
 *
 * ## La UNIQUE incluye el provider
 *
 * `(appointment_finance_item_id, ea_provider_id)` y no solo el renglón: un
 * combo trabajado por dos técnicas reparte ese mismo renglón entre las dos por
 * `allocation_hands_bp`. Con la clave así, recalcular un periodo en borrador
 * sigue siendo un upsert idempotente y el reparto sigue siendo posible.
 *
 * ## Los ON DELETE
 *
 * Hacia el renglón, **RESTRICT**, no CASCADE: un renglón con comisión ya
 * calculada no se borra. Después del cierre diario la cuenta se congela y las
 * correcciones son renglones nuevos, así que un borrado ahí sería un error, y
 * uno que se llevaría plata liquidada por delante.
 *
 * Hacia la regla, **RESTRICT**: una regla que ya se aplicó alguna vez es parte
 * del rastro y no se puede borrar, solo cerrar con `valid_to`.
 *
 * Hacia la liquidación, **SET NULL**: descartar una liquidación en borrador
 * suelta sus entradas para que vuelvan a la siguiente, sin borrarlas.
 */
export const migration: Migration = {
  id: "009-commission-entry",
  description: "Comisión congelada por renglón de cuenta",
  statements: [
    `CREATE TABLE IF NOT EXISTS commission_entry (
       id                          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
       appointment_finance_item_id BIGINT UNSIGNED NOT NULL,
       ea_provider_id              INT UNSIGNED NOT NULL,
       commission_rule_id          INT UNSIGNED NULL,
       base_amount                 INT NOT NULL,
       rate_bp                     SMALLINT UNSIGNED NULL,
       amount                      INT NOT NULL,
       period_start                DATE NOT NULL,
       period_end                  DATE NOT NULL,
       status                      ENUM('pending','paid') NOT NULL DEFAULT 'pending',
       commission_run_id           INT UNSIGNED NULL,
       created_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at                  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       UNIQUE KEY uq_ce_item_provider (appointment_finance_item_id, ea_provider_id),
       -- Liquidación por periodo y técnica: es la consulta que corre cada quincena.
       KEY idx_ce_provider_period (ea_provider_id, period_start, period_end),
       KEY idx_ce_run (commission_run_id),
       -- Diagnóstico: los renglones que quedaron sin regla aplicable.
       KEY idx_ce_rule (commission_rule_id),

       CONSTRAINT fk_ce_item FOREIGN KEY (appointment_finance_item_id)
         REFERENCES appointment_finance_item (id) ON DELETE RESTRICT ON UPDATE CASCADE,
       -- \`ON UPDATE RESTRICT\`: MySQL 8 no admite un CHECK sobre una columna
       -- que participe de una acción referencial, y \`ck_ce_zero_without_rule\`
       -- vale más que un CASCADE sobre una PK autoincremental que nunca cambia.
       CONSTRAINT fk_ce_rule FOREIGN KEY (commission_rule_id)
         REFERENCES commission_rule (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
       CONSTRAINT fk_ce_run FOREIGN KEY (commission_run_id)
         REFERENCES commission_run (id) ON DELETE SET NULL ON UPDATE CASCADE,

       CONSTRAINT ck_ce_period_order CHECK (period_end >= period_start),
       CONSTRAINT ck_ce_rate_range CHECK (rate_bp IS NULL OR rate_bp <= 10000),
       -- Sin regla no hay monto. Es la marca hecha constraint: si alguien
       -- escribe una comisión "de la nada", la base la rechaza.
       CONSTRAINT ck_ce_zero_without_rule CHECK (
         commission_rule_id IS NOT NULL OR amount = 0
       )
     ) ${TABLE_OPTIONS}`,
  ],
};
