import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import mysql from "mysql2/promise";

/**
 * Un MySQL de verdad, efímero, para los tests de integración.
 *
 * **No es un mock del driver.** Lo que se está verificando acá es lo que MySQL
 * hace y no lo que nosotros creemos que hace: que un índice único con `NULL`
 * admita varias filas, que un `CHECK` rechace lo que tiene que rechazar, que un
 * `ON DELETE RESTRICT` frene un borrado, que `CREATE TABLE IF NOT EXISTS`
 * aplicado dos veces no falle. Un doble del driver contestaría lo que le
 * enseñamos, que es exactamente el error que este test existe para no cometer.
 *
 * ## Puerto y aislamiento
 *
 * **Puerto efímero**: el contenedor se publica con `0:3306` y el kernel elige
 * uno libre, que después se le pregunta a Docker. Nunca el 3307 del stack de
 * desarrollo — correr los tests no puede tocar la base con la que alguien está
 * probando a mano — y nunca uno fijo, porque dos suites en paralelo (dos
 * worktrees, o `npm test` junto a `test:watch`) chocarían con "port is already
 * allocated" y la segunda fallaría por una razón ajena al código que prueba.
 * `GBS_TEST_MYSQL_PORT` fuerza uno concreto cuando hace falta. El contenedor se
 * crea con nombre aleatorio y se borra al terminar.
 *
 * ## La suite se salta sola sin Docker
 *
 * `npm test` tiene que seguir verde en una máquina sin Docker Desktop
 * levantado; si no, la gente deja de correrlo. Tres escapes, en orden:
 *
 * - `GBS_SKIP_DB_TESTS=1` — salta siempre, sin preguntar.
 * - `GBS_TEST_MYSQL_URL` — usá *ese* MySQL en vez de levantar uno. Es cómo se
 *   corre en CI, donde el runner ya da un servicio `mysql` y arrancar Docker
 *   adentro de Docker es innecesario.
 * - Detección: si `docker info` no contesta, se salta.
 *
 * Saltarse no es lo mismo que pasar, y por eso el `describe` saltado se ve en
 * la salida de Vitest. Un test que no corrió no prueba nada, y quien lo lea
 * tiene que saberlo.
 */

const DEFAULT_IMAGE = process.env.GBS_TEST_MYSQL_IMAGE ?? "mysql:8.0";
const DATABASE = "gbs_admin_test";
const ROOT_PASSWORD = "test";

/** Cuánto esperar a que MySQL termine de inicializarse. La primera vez baja la imagen. */
const READY_TIMEOUT_MS = 180_000;
const READY_POLL_MS = 750;

export type EphemeralMysql = {
  /** URL lista para `createPool`. */
  url: string;
  /** Borra el contenedor. Idempotente. */
  stop: () => Promise<void>;
};

let dockerProbe: boolean | undefined;

/** ¿Hay un demonio de Docker que conteste? Se pregunta una sola vez por proceso. */
export function dockerAvailable(): boolean {
  if (dockerProbe !== undefined) return dockerProbe;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    dockerProbe = true;
  } catch {
    dockerProbe = false;
  }
  return dockerProbe;
}

/**
 * ¿Se pueden correr los tests de integración?
 *
 * Se usa como `describe.skipIf(!canRunDbTests())`, no como un `if` adentro del
 * test: un test que se salta tiene que verse saltado.
 */
export function canRunDbTests(): boolean {
  if (process.env.GBS_SKIP_DB_TESTS === "1") return false;
  if (process.env.GBS_TEST_MYSQL_URL) return true;
  return dockerAvailable();
}

/**
 * Explica en una línea por qué se saltó, para que salga en el reporte.
 *
 * Cadena vacía = no se saltó. El `describe` la interpola en su nombre, así que
 * devolver un motivo cuando la suite sí va a correr sería una etiqueta que
 * miente en la salida de los tests — y a la larga nadie leería la etiqueta.
 */
export function skipReason(): string {
  if (canRunDbTests()) return "";
  if (process.env.GBS_SKIP_DB_TESTS === "1") return "GBS_SKIP_DB_TESTS=1";
  return "Docker no está disponible (levantá Docker Desktop o usá GBS_TEST_MYSQL_URL)";
}

async function waitUntilReady(url: string, deadline: number): Promise<void> {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const conn = await mysql.createConnection(url);
      await conn.query("SELECT 1");
      await conn.end();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, READY_POLL_MS));
    }
  }
  throw new Error(
    `El MySQL efímero no respondió en ${READY_TIMEOUT_MS / 1000}s. Último error: ${String(lastError)}`,
  );
}

/** Le pregunta a Docker qué puerto del host quedó publicado para el 3306. */
function readPublishedPort(container: string): number {
  const out = execFileSync("docker", ["port", container, "3306/tcp"], {
    encoding: "utf8",
    timeout: 30_000,
  });

  const match = out.match(/:(\d+)\s*$/m);
  if (!match) {
    throw new Error(
      `No se pudo leer el puerto publicado del contenedor ${container}. ` +
        `\`docker port\` devolvió: ${JSON.stringify(out)}`,
    );
  }

  return Number(match[1]);
}

/**
 * Levanta el contenedor y devuelve su URL.
 *
 * Con `GBS_TEST_MYSQL_URL` no levanta nada: usa esa base y su `stop()` es un
 * no-op. En ese caso la base tiene que estar vacía o ser desechable — las
 * migraciones son `IF NOT EXISTS` y no borran nada, pero los tests sí insertan
 * filas.
 */
export async function startEphemeralMysql(): Promise<EphemeralMysql> {
  const external = process.env.GBS_TEST_MYSQL_URL;
  if (external) {
    return { url: external, stop: async () => {} };
  }

  const name = `gbs-admin-test-${randomBytes(4).toString("hex")}`;

  // Puerto **efímero**, no fijo: con `--publish 0:3306` el kernel asigna uno
  // libre y después se lo preguntamos a Docker. Con un puerto fijo, dos suites
  // corriendo a la vez —dos worktrees de agentes, o `npm test` y `test:watch`
  // en paralelo— chocan con "Bind for 0.0.0.0:3399 failed: port is already
  // allocated" y la segunda falla por una razón que no tiene nada que ver con
  // el código que se está probando. `GBS_TEST_MYSQL_PORT` sigue funcionando
  // para cuando se quiera fijar uno a mano.
  const requestedPort = process.env.GBS_TEST_MYSQL_PORT
    ? Number(process.env.GBS_TEST_MYSQL_PORT)
    : 0;

  execFileSync(
    "docker",
    [
      "run",
      "--detach",
      "--name",
      name,
      "--env",
      `MYSQL_ROOT_PASSWORD=${ROOT_PASSWORD}`,
      "--env",
      `MYSQL_DATABASE=${DATABASE}`,
      // Bogotá también acá. Los DATETIME se convierten con la zona del cliente,
      // así que en teoría da igual — pero un contenedor en UTC es justo la
      // diferencia que después nadie encuentra.
      "--env",
      "TZ=America/Bogota",
      "--publish",
      `${requestedPort}:3306`,
      DEFAULT_IMAGE,
    ],
    { stdio: "pipe", timeout: 120_000 },
  );

  // Con `--publish 0:3306` el puerto real lo eligió el kernel, así que hay que
  // preguntárselo a Docker en vez de suponerlo. `docker port` devuelve líneas
  // como `3306/tcp -> 0.0.0.0:49158`; puede haber una por familia (IPv4 e
  // IPv6), y nos sirve cualquiera porque el puerto es el mismo.
  const port = requestedPort || readPublishedPort(name);

  const url = `mysql://root:${ROOT_PASSWORD}@127.0.0.1:${port}/${DATABASE}`;
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try {
      execFileSync("docker", ["rm", "--force", "--volumes", name], {
        stdio: "ignore",
        timeout: 60_000,
      });
    } catch {
      // Si el contenedor ya no está, no hay nada que limpiar. Fallar acá
      // convertiría una suite verde en roja por el orden de apagado.
    }
  };

  try {
    await waitUntilReady(url, Date.now() + READY_TIMEOUT_MS);
  } catch (error) {
    await stop();
    throw error;
  }

  return { url, stop };
}
