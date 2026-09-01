import { TABLE_OPTIONS, type Migration } from "./migration";

/**
 * Las reglas de comisión: a quién aplica, sobre qué, cuánto, y desde cuándo.
 *
 * `NULL` significa "todas" en las tres dimensiones. La precedencia
 * (provider+service ▶ provider+category ▶ provider ▶ service ▶ category ▶
 * global) se resuelve en `lib/commission.ts` sobre las reglas vigentes: es una
 * función pura y como tal se testea. La base guarda reglas; no las interpreta.
 *
 * ## `percent_bp` y `fixed_amount` en vez de `kind` + `value`
 *
 * El plan describe el par como "`kind` / `value` — percent (0–100) · fixed
 * (pesos)". Una sola columna `value` con dos unidades según una columna
 * hermana es exactamente el tipo de ambigüedad que se paga: el día que alguien
 * lea `value = 15` sin mirar `kind` va a interpretar quince pesos o quince por
 * ciento, y una de las dos lecturas está mal por cuatro órdenes de magnitud.
 * Además un entero 0–100 no puede expresar 12,5 %, y las tasas reales todavía
 * son una decisión pendiente — fijar la representación ahora en algo que pierde
 * información sería decidir por la dueña.
 *
 * Así que dos columnas, cada una con su unidad, y un CHECK que obliga a que
 * haya exactamente la que corresponde al `kind`. `percent_bp` son puntos
 * básicos: 1250 = 12,5 %, entero, sin coma flotante en ningún lado.
 *
 * ## Lo que no está en el esquema
 *
 * El solape de reglas se valida **al guardar**, en el editor, no al liquidar, y
 * no hay constraint que lo exprese: MySQL no tiene exclusión por rango. Es una
 * decisión del plan, no una omisión — validar al liquidar sería descubrir el
 * conflicto con la quincena ya corrida.
 *
 * `valid_to` es **inclusivo**: una regla que termina el 15 aplica al día 15
 * completo.
 */
export const migration: Migration = {
  id: "007-commission-rule",
  description: "Reglas de comisión por provider, categoría y servicio",
  statements: [
    `CREATE TABLE IF NOT EXISTS commission_rule (
       id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
       ea_provider_id INT UNSIGNED NULL,
       category_id    VARCHAR(32) NULL,
       ea_service_id  INT UNSIGNED NULL,
       applies_to     ENUM('principal','adicionales','ambos') NOT NULL,
       kind           ENUM('percent','fixed') NOT NULL,
       percent_bp     SMALLINT UNSIGNED NULL,
       fixed_amount   INT UNSIGNED NULL,
       valid_from     DATE NOT NULL,
       valid_to       DATE NULL,
       created_by     VARCHAR(36) NULL,
       created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

       PRIMARY KEY (id),
       -- El motor carga todas las reglas vigentes en una fecha y resuelve la
       -- precedencia en memoria: son decenas de filas, no millones.
       KEY idx_cr_validity (valid_from, valid_to),
       KEY idx_cr_provider (ea_provider_id, valid_from),
       KEY idx_cr_service (ea_service_id, valid_from),
       KEY idx_cr_category (category_id, valid_from),

       CONSTRAINT ck_cr_value_matches_kind CHECK (
         (kind = 'percent' AND percent_bp IS NOT NULL AND fixed_amount IS NULL)
         OR (kind = 'fixed' AND fixed_amount IS NOT NULL AND percent_bp IS NULL)
       ),
       CONSTRAINT ck_cr_percent_range CHECK (percent_bp IS NULL OR percent_bp <= 10000),
       CONSTRAINT ck_cr_validity_order CHECK (valid_to IS NULL OR valid_to >= valid_from)
     ) ${TABLE_OPTIONS}`,
  ],
};
