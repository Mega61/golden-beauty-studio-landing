import "server-only";

import { Kysely, MysqlDialect } from "kysely";
import mysql, { type Pool, type PoolOptions } from "mysql2";

import type { Database } from "./types";

/**
 * La conexión a `gbs_admin`.
 *
 * `gbs_admin` **no vive en una base nuestra**: vive en `mysql-transversal`, un
 * servidor MySQL 8.0.46 fuera del stack de la agenda. Hoy aloja **solo** el
 * esquema de EA (verificado en la VM el 2026-08-31), pero su nombre anticipa que
 * será compartido, así que se trata como tal desde el principio. De ahí tres
 * reglas que atraviesan todo este módulo:
 *
 * - Los grants son **por esquema**, nunca globales. El usuario de `DATABASE_URL`
 *   tiene RW sobre `gbs_admin` y nada más.
 * - Las migraciones no crean ni alteran nada fuera de `gbs_admin`.
 * - El usuario de solo lectura sobre `easyappointments` es un **paso de
 *   operación documentado**, no algo que la app ejecute. Crearlo requiere
 *   privilegios sobre otro esquema y sobre `mysql.user`, que esta conexión no
 *   tiene ni debe tener:
 *
 *   ```sql
 *   CREATE USER 'gbs_ea_ro'@'%' IDENTIFIED BY '<secreto>';
 *   GRANT SELECT ON easyappointments.* TO 'gbs_ea_ro'@'%';
 *   ```
 */

/**
 * Opciones del driver que no son gusto personal.
 *
 * **`dateStrings: ["DATE"]`** es la importante. Sin ella, mysql2 convierte una
 * columna `DATE` a un `Date` de JavaScript en la medianoche *local*; en
 * America/Bogota eso es `T05:00:00Z`, y cualquier cosa que después la serialice
 * a UTC y le corte los diez primeros caracteres devuelve el día correcto — pero
 * si el proceso corriera en una zona al este de Greenwich devolvería el día
 * siguiente. `close_date`, `valid_from`, `valid_to` y los cortes de quincena son
 * **calendario, no instantes**: viajan como `"YYYY-MM-DD"` y no se convierten
 * nunca.
 *
 * Los `DATETIME` sí vuelven como `Date`, y ahí la conversión es la correcta
 * *siempre que el proceso corra en America/Bogota* — EA guarda datetimes
 * locales sin zona. Es lo que el healthcheck vigila con `Intl`.
 *
 * `supportBigNumbers` hace que un `BIGINT` fuera del rango seguro de `Number`
 * vuelva como string en vez de como un número silenciosamente equivocado. En la
 * práctica ninguna columna de este esquema se acerca a 2^53 — ni los ids ni los
 * totales en pesos — pero "en la práctica" no es una garantía y el costo de la
 * bandera es cero.
 */
const DRIVER_DEFAULTS: PoolOptions = {
  dateStrings: ["DATE"],
  timezone: "local",
  supportBigNumbers: true,
  bigNumberStrings: false,
  // El panel lo usan tres personas más dos jobs. Diez conexiones sobran, y en
  // un servidor compartido pedir de más le quita cupo a las otras aplicaciones.
  connectionLimit: 10,
  // Sin esto, una consulta armada por concatenación podría ejecutar dos
  // sentencias. Kysely siempre parametriza, pero la bandera es la red debajo.
  multipleStatements: false,
};

/**
 * Zona de sesión de MySQL, fijada en cada conexión del pool.
 *
 * **`mysql-transversal` corre en UTC** (verificado en la VM el 2026-08-31:
 * `@@system_time_zone = UTC`, `@@global.time_zone = SYSTEM`). Sin esta línea, las
 * ~20 columnas del esquema con `DEFAULT CURRENT_TIMESTAMP` se escribirían con la
 * hora de pared **UTC**, mientras que `timezone: "local"` hace que mysql2
 * interprete al leer esa misma hora como si fuera de Bogotá: cada `created_at`
 * quedaría **cinco horas en el futuro**, sin error y sin nada que lo delate hasta
 * que un reporte no cuadre.
 *
 * Y hay una segunda razón, más de fondo: EA escribe sus `DATETIME` en hora local
 * de Bogotá. `appointment_finance.appointment_start_at` es una copia de la hora
 * de la cita de EA, y tiene que ser comparable con `created_at` y con
 * `day_close.close_date`. Con la sesión en `-05:00`, **todo el esquema guarda la
 * misma hora de pared que EA**, que es la única forma de que un join lógico entre
 * los dos mundos signifique algo.
 *
 * Offset fijo y no `America/Bogota` a propósito: Colombia no tiene horario de
 * verano, y un offset numérico no depende de que el contenedor de MySQL tenga
 * instaladas las tablas de zonas (`mysql_tzinfo_to_sql`), que no siempre están.
 */
const SESSION_TIME_ZONE = "-05:00";

/** Crea el pool de mysql2 a partir de una URL `mysql://user:pass@host:port/db`. */
export function createPool(url: string, overrides: PoolOptions = {}): Pool {
  const pool = mysql.createPool({
    uri: url,
    ...DRIVER_DEFAULTS,
    ...overrides,
  });

  // Cada conexión nueva del pool arranca con la zona correcta. Va en el evento
  // `connection` y no en una consulta suelta porque el pool abre conexiones de
  // forma perezosa: fijarlo una sola vez al inicio dejaría las siguientes en UTC.
  pool.on("connection", (connection) => {
    connection.query(`SET time_zone = '${SESSION_TIME_ZONE}'`);
  });

  return pool;
}

/**
 * Un `Kysely<Database>` sobre el pool que se le pase.
 *
 * Recibe el pool en vez de crearlo para que los tests de integración puedan
 * apuntar a su MySQL efímero sin tocar variables de entorno del proceso.
 */
export function createDb(pool: Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new MysqlDialect({ pool }),
  });
}

/** Lee `DATABASE_URL` o falla con un mensaje que dice qué falta. */
export function requireDatabaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL no está definida. Es el usuario RW sobre gbs_admin " +
        "(ver docs/DEV-LOCAL.md, paso 4). Sin ella el panel no arranca, y eso " +
        "es correcto: toda la plata vive ahí.",
    );
  }
  return url;
}

let singleton: Kysely<Database> | null = null;

/**
 * La instancia compartida del proceso.
 *
 * Perezosa a propósito: importar este módulo no puede exigir que
 * `DATABASE_URL` exista, porque el build de Next importa módulos para
 * analizarlos y `next build` corre sin las variables del stack.
 */
export function getDb(): Kysely<Database> {
  if (!singleton) {
    singleton = createDb(createPool(requireDatabaseUrl()));
  }
  return singleton;
}

/**
 * Conexión de **solo lectura** a `easyappointments`, para los reportes.
 *
 * Se lee directo y no por la API REST porque el camino caliente — agenda, caja,
 * comisiones, reportes — hace agregación SQL sobre las citas, y la API de EA no
 * agrega. Al revés, **las escrituras van siempre por la API REST**, nunca a
 * estas tablas: es lo que dispara las notificaciones y el sync de Google
 * Calendar.
 *
 * Devuelve un pool crudo de mysql2 y no un `Kysely`: tipar el esquema de EA
 * acá sería inventar un contrato sobre una base que no es nuestra y que puede
 * cambiar en un upgrade. Los reportes que la usen escriben su SQL y lo cubre la
 * suite de contrato (capa 3).
 */
export function createEaReadOnlyPool(
  env: NodeJS.ProcessEnv = process.env,
): Pool {
  const url = env.DATABASE_URL_EA_RO;
  if (!url) {
    throw new Error(
      "DATABASE_URL_EA_RO no está definida. Es el usuario de SOLO LECTURA " +
        "sobre easyappointments; si se le dan permisos de escritura, alguien " +
        "terminará escribiendo por ahí y las notificaciones y el sync de " +
        "Google Calendar dejarán de dispararse sin error visible.",
    );
  }
  return createPool(url, { connectionLimit: 5 });
}
