import { afterEach, describe, expect, it } from "vitest";

import {
  createEaReadOnlyPool,
  getEaReadOnlyPool,
  requireDatabaseUrl,
} from "./client";

/**
 * Lo que se puede afirmar del cliente **sin** una base de datos.
 *
 * mysql2 abre conexiones de forma perezosa: `createPool()` construye el objeto
 * y no toca la red hasta la primera consulta. Eso deja testear lo que importa
 * de este archivo —que las variables de entorno se exigen con un mensaje que
 * dice qué falta, y que el pool de EA es **uno por proceso**— sin Docker y sin
 * red. Que las consultas de verdad funcionen es la suite de integración.
 */

/** Una URL con la forma correcta y un host que no existe. Nunca se conecta. */
const FAKE_EA_URL = "mysql://gbs_ea_ro:secreto@no-existe.invalid:3306/easyappointments";

const env = (over: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv =>
  ({ NODE_ENV: "test", ...over }) as NodeJS.ProcessEnv;

const openPools: { end: (callback?: (error?: unknown) => void) => void }[] = [];

afterEach(async () => {
  // Un pool sin conexiones se cierra al instante; dejarlo abierto colgaría el
  // runner al final de la corrida.
  await Promise.all(
    openPools.splice(0).map(
      (pool) =>
        new Promise<void>((resolve) => {
          pool.end(() => resolve());
        }),
    ),
  );
});

describe("requireDatabaseUrl", () => {
  it("falla nombrando la variable, y dice para qué es", () => {
    // Sin `DATABASE_URL` el panel no arranca, y eso es correcto: toda la plata
    // vive ahí. Lo que no puede pasar es que falle sin decir qué falta.
    expect(() => requireDatabaseUrl(env({}))).toThrow(/DATABASE_URL/);
    expect(() => requireDatabaseUrl(env({ DATABASE_URL: "" }))).toThrow(/gbs_admin/);
  });

  it("devuelve la URL cuando está", () => {
    expect(requireDatabaseUrl(env({ DATABASE_URL: "mysql://u:p@h:3306/gbs_admin" }))).toBe(
      "mysql://u:p@h:3306/gbs_admin",
    );
  });
});

describe("createEaReadOnlyPool", () => {
  it("exige `DATABASE_URL_EA_RO` y explica que es de SOLO LECTURA", () => {
    // El mensaje lleva la advertencia a propósito: si a ese usuario se le dan
    // permisos de escritura, alguien terminará escribiendo en las tablas de EA
    // y las notificaciones y el sync de Google dejarán de dispararse sin error
    // visible.
    expect(() => createEaReadOnlyPool(env({}))).toThrow(/DATABASE_URL_EA_RO/);
    expect(() => createEaReadOnlyPool(env({}))).toThrow(/SOLO LECTURA/);
  });

  it("es una fábrica: dos llamadas son dos pools distintos", () => {
    // Es lo que la vuelve usable desde un job de consola, que abre y cierra lo
    // suyo. Los que corren dentro del servidor web usan `getEaReadOnlyPool()`.
    const vars = env({ DATABASE_URL_EA_RO: FAKE_EA_URL });
    const first = createEaReadOnlyPool(vars);
    const second = createEaReadOnlyPool(vars);
    openPools.push(first, second);

    expect(first).not.toBe(second);
  });
});

describe("getEaReadOnlyPool", () => {
  it("**memoiza**: un solo pool por proceso", async () => {
    // Cada pool abre hasta cinco conexiones y `mysql-transversal` es un
    // servidor compartido con otras aplicaciones. Uno por request agotaría
    // `max_connections` a fuerza de refrescar Reportes, y el síntoma le
    // aparecería primero a las otras aplicaciones del servidor.
    const previous = process.env.DATABASE_URL_EA_RO;
    process.env.DATABASE_URL_EA_RO = FAKE_EA_URL;

    try {
      const pool = getEaReadOnlyPool();
      openPools.push(pool);

      expect(getEaReadOnlyPool()).toBe(pool);
      expect(getEaReadOnlyPool()).toBe(pool);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL_EA_RO;
      else process.env.DATABASE_URL_EA_RO = previous;
    }
  });
});
