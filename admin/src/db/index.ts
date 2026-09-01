/**
 * La capa de datos del panel: esquema `gbs_admin`, tipos y repositorios.
 *
 * Lo que hay que saber antes de usarla:
 *
 * - **El dinero son pesos enteros.** Ver la cabecera de `types.ts`.
 * - **`DATE` viaja como `"YYYY-MM-DD"`; `DATETIME` como `Date`.** Ver `client.ts`.
 * - **Los repositorios leen y escriben filas.** Ningún cálculo de plata acá:
 *   eso es `lib/` (paquete B1), funciones puras con 100 % de cobertura de ramas.
 * - **Las escrituras a Easy!Appointments van siempre por su API REST**, nunca a
 *   sus tablas: es lo que dispara las notificaciones y el sync de Google
 *   Calendar. `createEaReadOnlyPool()` existe solo para los reportes, que
 *   necesitan agregación SQL que la API de EA no ofrece.
 * - **Ninguna migración toca nada fuera de `gbs_admin`.** El esquema vive en un
 *   servidor MySQL compartido con otras aplicaciones.
 */

export {
  createDb,
  createEaReadOnlyPool,
  createPool,
  getDb,
  requireDatabaseUrl,
} from "./client";
export { isDuplicateKeyError } from "./errors";
export { main as migrateMain, migrationChecksum, runMigrations } from "./migrate";
export type { AppliedMigration, MigrateResult } from "./migrate";
export { EXPECTED_TABLES, MIGRATIONS } from "./migrations";
export type { Migration } from "./migrations";
export * from "./repositories";
export type * from "./types";
