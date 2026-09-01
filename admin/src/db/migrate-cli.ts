import { main } from "./migrate";

/**
 * Punto de entrada del servicio `admin-migrate`, con reintentos.
 *
 * ## Por qué existe este archivo y no se ejecuta `migrate.ts` directo
 *
 * El loader nativo de TypeScript de Node **no resuelve imports de directorio**:
 * `import { MIGRATIONS } from "./migrations"` funciona bajo Vitest y bajo el
 * bundler de Next, y explota con `ERR_UNSUPPORTED_DIR_IMPORT` al correr el
 * archivo suelto con `node`. Por eso este módulo se empaqueta con esbuild a un
 * único `.js` en el layer de build de la imagen (`npm run build:migrator`), y
 * el contenedor ejecuta ese archivo — no el `.ts`.
 *
 * El bundle también resuelve la otra trampa: `db/client.ts` importa
 * `server-only`, que **lanza al importarse fuera de un React Server Component**.
 * Es la guarda correcta para el runtime del panel y una piedra para un script
 * suelto, así que el build lo aliasea a un módulo vacío (ver el script en
 * `package.json`). La guarda sigue viva en el bundle de Next, que es donde
 * importa.
 *
 * ## Por qué reintenta
 *
 * `mysql-transversal` **vive fuera del stack** — es un servidor compartido en la
 * red externa `data` — así que el compose no tiene un `depends_on` que esperar:
 * cuando Portainer recrea el stack, `admin-migrate` puede arrancar mientras el
 * MySQL compartido todavía está atendiendo un reinicio ajeno. Rendirse en el
 * primer `ECONNREFUSED` dejaría el servicio `admin` sin arrancar (su
 * `depends_on` exige que el migrador termine bien) por una carrera de segundos.
 *
 * Se reintenta **solo lo transitorio**. Una contraseña mala o un grant que falta
 * no mejoran esperando: fallan de una, con el código del driver en el mensaje,
 * que es lo que se va a leer en los logs de Portainer.
 */

/** Cuántos intentos antes de rendirse. Con el backoff de abajo, ~1 minuto. */
const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

/**
 * Códigos del driver que significan "el servidor todavía no está".
 *
 * `ER_ACCESS_DENIED_ERROR` y `ER_BAD_DB_ERROR` quedan fuera a propósito: son
 * errores de configuración, y reintentarlos solo retrasa un minuto el momento
 * en que alguien lee el error de verdad.
 */
const TRANSIENT_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNRESET",
  "EPIPE",
  "PROTOCOL_CONNECTION_LOST",
  "ER_CON_COUNT_ERROR",
  "ER_LOCK_DEADLOCK",
]);

function isTransient(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_CODES.has(code);
}

/** Espera exponencial con techo. Sin jitter: hay un solo migrador, no una flota. */
function delayFor(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run(): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await main();
      return;
    } catch (error) {
      if (!isTransient(error) || attempt === MAX_ATTEMPTS) throw error;
      const wait = delayFor(attempt);
      console.warn(
        `MySQL no contesta todavía (${String((error as { code?: unknown }).code)}). ` +
          `Reintento ${attempt}/${MAX_ATTEMPTS - 1} en ${wait} ms.`,
      );
      await sleep(wait);
    }
  }
}

/**
 * `process.exit(1)` explícito, y no dejar que la promesa rechazada mate el
 * proceso sola: el compose distingue "terminó bien" de "terminó mal" por el
 * código de salida, y de eso depende que `admin` arranque o no
 * (`service_completed_successfully`). Un migrador que falla y sale 0 levantaría
 * el panel contra un esquema a medias, que es la peor de las dos fallas.
 */
run().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error("Las migraciones de gbs_admin fallaron:", error);
    process.exit(1);
  },
);
