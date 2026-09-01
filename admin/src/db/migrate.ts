import { createHash } from "node:crypto";

import { sql, type Kysely } from "kysely";

import { MIGRATIONS, type Migration } from "./migrations";
import { TABLE_OPTIONS } from "./migrations/migration";
import type { Database } from "./types";

/**
 * El runner de migraciones de `gbs_admin`.
 *
 * Es deliberadamente tonto: aplica en orden lo que no está en el libro, y
 * registra lo que aplicó. No hay `down`, no hay reversión, no hay `DROP`. El
 * esquema es forward-only porque contiene el libro de caja del estudio y una
 * migración destructiva sobre una base que no se puede reconstruir desde
 * ninguna otra fuente no es un riesgo que valga la pena tener disponible.
 *
 * No se usa el `Migrator` de Kysely por dos razones prácticas: su
 * `FileMigrationProvider` lee del disco, y con `output: "standalone"` los
 * archivos sueltos no viajan a la imagen; y su libro no guarda checksum, que es
 * la parte que convierte "forward-only" en algo verificable en vez de una
 * intención.
 *
 * ## Por qué no hay transacción alrededor de una migración
 *
 * MySQL hace **commit implícito** en cada DDL. Envolver un `CREATE TABLE` en
 * una transacción da una falsa sensación de atomicidad: si la tercera sentencia
 * falla, las dos primeras ya están aplicadas y no hay rollback que valga. La
 * respuesta no es fingir la transacción sino que cada sentencia sea idempotente
 * por sí sola, y que la corrida siguiente pueda retomar desde el principio de
 * la migración sin romper nada. Eso es lo que hace este set.
 */

/** Nombre del libro. Se crea solo, y también con `CREATE TABLE IF NOT EXISTS`. */
const LEDGER = "schema_migration";

/**
 * Huella de una migración: su id más sus sentencias, normalizando espacios.
 *
 * Normalizar es a propósito: reindentar el SQL no cambia lo que hace, y hacer
 * fallar el arranque de producción por un `prettier` sería un falso positivo
 * caro. Cambiar una palabra sí cambia el hash.
 */
export function migrationChecksum(migration: Migration): string {
  const normalized = migration.statements
    .map((s) => s.replace(/\s+/g, " ").trim())
    .join(";");
  return createHash("sha256")
    .update(`${migration.id}\n${normalized}`)
    .digest("hex");
}

export type AppliedMigration = {
  id: string;
  checksum: string;
};

export type MigrateResult = {
  /** Las que esta corrida aplicó. Vacío en la segunda corrida seguida. */
  applied: string[];
  /** Las que ya estaban. */
  skipped: string[];
};

/** Crea el libro si no existe. Es la única migración que no está en el set. */
async function ensureLedger(db: Kysely<Database>): Promise<void> {
  await sql
    .raw(
      `CREATE TABLE IF NOT EXISTS ${LEDGER} (
         id         VARCHAR(64) NOT NULL,
         checksum   CHAR(64) NOT NULL,
         applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (id)
       ) ${TABLE_OPTIONS}`,
    )
    .execute(db);
}

/**
 * Falla si una migración ya aplicada cambió de contenido.
 *
 * Es la mitad que hace real el "forward-only". Sin esto, alguien edita `004`
 * para agregar una columna, la corrida no hace nada porque el id ya está en el
 * libro, y la base y el archivo dicen cosas distintas para siempre — con el
 * síntoma apareciendo semanas después como "esa columna no existe en
 * producción". Se corrige con una migración nueva, nunca editando una vieja.
 */
function assertUnchanged(
  migration: Migration,
  applied: AppliedMigration,
): void {
  const checksum = migrationChecksum(migration);
  if (applied.checksum !== checksum) {
    throw new Error(
      `La migración ${migration.id} ya está aplicada pero su contenido cambió ` +
        `(libro: ${applied.checksum.slice(0, 12)}…, archivo: ${checksum.slice(0, 12)}…). ` +
        "El esquema es forward-only: una migración aplicada no se edita. " +
        "Revertí el archivo y agregá una migración nueva con el cambio.",
    );
  }
}

/**
 * Aplica lo que falte. Correrlo dos veces seguidas no falla ni duplica.
 *
 * @param log dónde reportar el avance. `console` en el CLI, un no-op en tests.
 */
export async function runMigrations(
  db: Kysely<Database>,
  log: (message: string) => void = () => {},
): Promise<MigrateResult> {
  await ensureLedger(db);

  const appliedRows = await db
    .selectFrom("schema_migration")
    .select(["id", "checksum"])
    .execute();
  const already = new Map(appliedRows.map((r) => [r.id, r]));

  const result: MigrateResult = { applied: [], skipped: [] };

  for (const migration of MIGRATIONS) {
    const seen = already.get(migration.id);
    if (seen) {
      assertUnchanged(migration, seen);
      result.skipped.push(migration.id);
      continue;
    }

    log(`▸ ${migration.id} — ${migration.description}`);
    for (const statement of migration.statements) {
      await sql.raw(statement).execute(db);
    }

    // El registro va después de las sentencias. Si algo falla a la mitad, la
    // migración no queda anotada y la corrida siguiente la reintenta entera —
    // que es exactamente por qué cada sentencia tiene que ser idempotente.
    await db
      .insertInto("schema_migration")
      .values({ id: migration.id, checksum: migrationChecksum(migration) })
      .onDuplicateKeyUpdate({ checksum: migrationChecksum(migration) })
      .execute();

    result.applied.push(migration.id);
  }

  return result;
}

/**
 * Punto de entrada del servicio `admin-migrate` del stack.
 *
 * Corre las migraciones y sale. No arranca el panel: el compose lo levanta como
 * un contenedor aparte que termina antes de que `admin` empiece a servir, para
 * que nunca haya dos réplicas migrando a la vez.
 */
export async function main(): Promise<void> {
  const { createDb, createPool, requireDatabaseUrl } = await import("./client");
  const pool = createPool(requireDatabaseUrl());
  const db = createDb(pool);

  try {
    const { applied, skipped } = await runMigrations(db, (m) =>
      console.log(m),
    );
    console.log(
      applied.length === 0
        ? `gbs_admin al día: ${skipped.length} migraciones ya aplicadas.`
        : `gbs_admin actualizado: ${applied.length} aplicadas, ${skipped.length} ya estaban.`,
    );
  } finally {
    await db.destroy();
  }
}
