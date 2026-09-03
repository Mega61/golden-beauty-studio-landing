import type { Migration } from "./migration";

/**
 * `account.issuer`, que Better Auth 1.7 exige y la migración 001 no creó.
 *
 * El síntoma era el login muerto con
 * `Unknown column 'account.issuer' in 'where clause'`: la librería resuelve la
 * cuenta con `where issuer = 'https://accounts.google.com' and accountId = …`.
 * En 1.7 **la identidad de una cuenta está scopeada por el `issuer` del
 * proveedor OIDC**, no por el `providerId` — los dos conviven, y el par único
 * pasó a ser `(issuer, accountId)`.
 *
 * `providerId` se queda: la librería sigue filtrando por él en el camino de
 * credenciales locales.
 *
 * ## Por qué el `ALTER` va envuelto en SQL dinámico
 *
 * MySQL 8 no tiene `ADD COLUMN IF NOT EXISTS` ni `ADD INDEX IF NOT EXISTS`, y
 * el contrato del set exige que **cada sentencia sea idempotente por sí sola**:
 * el DDL hace commit implícito, así que una migración que falla a la mitad deja
 * la mitad aplicada y la corrida siguiente la retoma desde el principio. Se
 * consulta `information_schema` y se prepara un `ALTER` o un `SELECT 1` inocuo.
 *
 * La columna entra `NOT NULL` sin default: hoy la tabla está vacía —nadie
 * alcanzó a iniciar sesión— así que no hay filas que rellenar. Si en el futuro
 * hubiera, este `ALTER` fallaría ruidosamente en vez de inventarle un `issuer`
 * a una cuenta existente, que es el comportamiento correcto: un `issuer`
 * equivocado enlazaría la cuenta de Google de una persona con la fila de otra.
 */
export const migration: Migration = {
  id: "016-account-issuer",
  description:
    "account.issuer + par único (issuer, accountId), que Better Auth 1.7 necesita",
  statements: [
    `SET @add_issuer := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE account ADD COLUMN issuer VARCHAR(255) NOT NULL AFTER accountId',
         'SELECT 1'
       )
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'account'
         AND COLUMN_NAME = 'issuer'
     )`,
    `PREPARE stmt_add_issuer FROM @add_issuer`,
    `EXECUTE stmt_add_issuer`,
    `DEALLOCATE PREPARE stmt_add_issuer`,

    // El par único de la identidad. `(providerId, accountId)` de la 001 se
    // queda: no estorba y sigue siendo cierto para el camino de credenciales.
    `SET @add_uq := (
       SELECT IF(
         COUNT(*) = 0,
         'ALTER TABLE account ADD UNIQUE KEY uq_account_issuer (issuer, accountId)',
         'SELECT 1'
       )
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'account'
         AND INDEX_NAME = 'uq_account_issuer'
     )`,
    `PREPARE stmt_add_uq FROM @add_uq`,
    `EXECUTE stmt_add_uq`,
    `DEALLOCATE PREPARE stmt_add_uq`,
  ],
};
