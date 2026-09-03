/**
 * Errores del driver que el código de repositorio necesita distinguir.
 *
 * Kysely no envuelve los errores de mysql2: los deja pasar tal cual. Así que
 * reconocerlos es mirar el `code`/`errno` del driver, y hacerlo en un solo
 * lugar en vez de en cada `catch`.
 */

/** `ER_DUP_ENTRY`. Es el número, no el texto: el texto cambia con el locale. */
const ER_DUP_ENTRY = 1062;

type MysqlishError = { errno?: unknown; code?: unknown };

/**
 * ¿Chocó contra un índice único?
 *
 * Se usa para el patrón "inserta y si ya estaba, leelo" — que es cómo el
 * webhook y el reconcile compiten por la misma cita sin pisarse. Un `SELECT`
 * previo seguido de un `INSERT` tiene una ventana entre los dos; dejar que la
 * base decida no la tiene.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as MysqlishError;
  return e.errno === ER_DUP_ENTRY || e.code === "ER_DUP_ENTRY";
}
