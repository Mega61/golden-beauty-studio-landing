/**
 * La forma de una migración de `gbs_admin`.
 *
 * Son módulos de TypeScript con el SQL adentro, no archivos `.sql` sueltos, por
 * una razón concreta: la imagen del panel se construye con
 * `output: "standalone"`, que copia solo lo que el grafo de módulos alcanza. Un
 * `.sql` leído con `fs` en tiempo de ejecución no está en ese grafo y el
 * contenedor de migración arrancaría sin sus migraciones. Un `string` importado
 * sí viaja.
 *
 * ## Reglas del set
 *
 * - **Forward-only.** Nada de `DROP`, nada de migraciones destructivas. Una
 *   migración aplicada no se edita: se corrige con una nueva. El runner verifica
 *   el checksum y falla si alguien edita una vieja.
 * - **Cada sentencia es idempotente por sí sola** (`CREATE TABLE IF NOT
 *   EXISTS`, `INSERT ... ON DUPLICATE KEY UPDATE`). No es un lujo: MySQL hace
 *   commit implícito en cada DDL, así que una migración que falla a la mitad
 *   deja la mitad aplicada y sin registrar. La siguiente corrida la retoma
 *   desde el principio, y solo funciona si repetir lo hecho no rompe nada.
 * - **Los índices se declaran dentro del `CREATE TABLE`.** MySQL 8 no tiene
 *   `CREATE INDEX IF NOT EXISTS`; declararlos afuera haría fallar la segunda
 *   corrida.
 * - **Nada fuera de `gbs_admin`.** El esquema vive en `mysql-transversal`, un
 *   servidor MySQL 8 **compartido con otras aplicaciones**, así que los grants
 *   son por esquema y jamás globales. En particular, el usuario de solo lectura
 *   sobre `easyappointments` es un paso de operación documentado, no algo que
 *   la app ejecute: crearlo requiere privilegios sobre otro esquema y sobre
 *   `mysql.user`, que esta conexión no tiene ni debe tener.
 */

export type Migration = {
  /** `001-better-auth`. Ordena el set y es la llave en `schema_migration`. */
  id: string;
  /** Qué hace y por qué, en una línea. Se imprime al aplicarla. */
  description: string;
  /**
   * Sentencias en orden. Una por elemento: el driver de MySQL no ejecuta
   * múltiples sentencias en un solo `query` salvo que se habilite
   * `multipleStatements`, que es una vía de inyección y queda apagada.
   */
  statements: readonly string[];
};

/**
 * Cláusula común. InnoDB por las FKs; utf8mb4 porque los nombres llevan tildes.
 *
 * **`utf8mb4_unicode_ci` y no `utf8mb4_0900_ai_ci`, que es el moderno.** El
 * esquema `easyappointments` del mismo servidor usa `unicode_ci` (verificado en
 * la VM el 2026-08-31), y una sola colación en todo el servidor elimina de raíz
 * el "Illegal mix of collations": hoy no puede pasar —cada esquema se lee con un
 * usuario distinto y una consulta no puede cruzarlos— pero el día que alguien
 * le dé permiso sobre ambos a un mismo usuario y escriba un JOIN, con dos
 * colaciones eso revienta.
 *
 * Lo que se cede es real y medible: `0900_ai_ci` implementa una versión más
 * nueva del algoritmo Unicode y es algo más rápido. A 0,4 MB de datos, esa
 * ventaja no existe; el foot-gun sí.
 */
export const TABLE_OPTIONS =
  "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
