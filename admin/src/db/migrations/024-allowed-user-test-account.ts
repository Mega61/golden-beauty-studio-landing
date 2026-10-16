import type { Migration } from "./migration";

/**
 * `allowed_user.is_test_account`: las cuentas de prueba, marcadas.
 *
 * "Dev" y "E2E" aparecían en Equipo como si trabajaran en el estudio, y nada
 * en la fila las distinguía de una persona — usan el dominio real porque la
 * allowlist lo exige. La marca la ponen quienes las crean (`dev:seed`, la
 * entrada de desarrollo, y por ellos la suite E2E), y las reglas que la leen
 * viven en `lib/test-accounts.ts`.
 *
 * El backfill marca las que ya existen por su correo. Es el único lugar donde
 * se decide por correo, y solo porque antes de esta columna no había otra cosa
 * que mirar. Idempotente como todas: la columna se agrega solo si falta.
 */
export const migration: Migration = {
  id: "024-allowed-user-test-account",
  description: "allowed_user.is_test_account: cuentas de prueba fuera de Equipo y de producción",
  statements: [
    `SET @add_test := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE allowed_user ADD COLUMN is_test_account TINYINT(1) NOT NULL DEFAULT 0 AFTER ea_provider_id',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'allowed_user'
         AND COLUMN_NAME = 'is_test_account'
     )`,
    `PREPARE stmt_add_test FROM @add_test`,
    `EXECUTE stmt_add_test`,
    `DEALLOCATE PREPARE stmt_add_test`,
    `UPDATE allowed_user SET is_test_account = 1
       WHERE email IN (
         -- El correo por defecto de \`dev:seed\` antes de exigir dominio con punto.
         'dev@local',
         'dev@goldenbeautystudio.com.co',
         'e2e@goldenbeautystudio.com.co',
         'dev-recepcion@goldenbeautystudio.com.co',
         'dev-tecnica@goldenbeautystudio.com.co'
       )`,
  ],
};
