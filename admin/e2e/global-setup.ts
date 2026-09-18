import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Comprueba el entorno **antes** de correr un solo test, y explica qué falta.
 *
 * Sin esto, una suite contra un stack apagado falla con veinte errores de red
 * idénticos y ninguno dice "levanta Docker". Un fallo que no dice qué hacer
 * cuesta más que no tener el test.
 *
 * Cada comprobación imprime qué arreglar, en el orden en que hay que
 * arreglarlo.
 */

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3001";

function fail(titulo: string, comoArreglar: string): never {
  throw new Error(`\n✗ ${titulo}\n\n  ${comoArreglar}\n`);
}

export default async function globalSetup(): Promise<void> {
  // 1. El bundle que la suite usa para sembrar la cuenta.
  if (!existsSync(".next/dev-seed.js")) {
    try {
      execFileSync("npx", [
        "esbuild", "src/jobs/dev-seed-cli.ts",
        "--bundle", "--platform=node", "--target=node22", "--format=cjs",
        "--outfile=.next/dev-seed.js",
        "--alias:server-only=next/dist/compiled/server-only/empty.js",
        "--log-level=warning",
      ], { stdio: "inherit" });
    } catch {
      fail("No se pudo construir el sembrador de la cuenta.", "Revisa que `npx esbuild` corra en admin/.");
    }
  }

  // 2. `.env.local`, sin el cual no hay ni base ni EA.
  if (!existsSync(".env.local")) {
    fail(
      "Falta admin/.env.local.",
      "Está documentado en docs/PROBAR-EL-PANEL.md § 3.",
    );
  }

  // 3. MySQL del stack de desarrollo.
  try {
    execFileSync("docker", ["exec", "gbs-dev-mysql", "mysqladmin", "ping", "-psecret"], {
      stdio: "ignore",
    });
  } catch {
    fail(
      "El MySQL de desarrollo no responde.",
      "docker compose -f ../deploy/compose/dev-stack.yml up -d\n  (o levanta el stack gbs-dev desde Portainer)",
    );
  }

  // 4. Las migraciones. Una tabla que falta se manifiesta como un 500 a mitad
  //    de un test, y encontrarlo desde ahí cuesta una hora.
  const tablas = execFileSync(
    "docker",
    ["exec", "gbs-dev-mysql", "mysql", "-uroot", "-psecret", "-N", "-B", "-e",
     "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='gbs_admin' AND table_name IN ('appointment_payment','wa_message')"],
    { encoding: "utf8" },
  ).trim();

  if (tablas !== "2") {
    fail(
      "A la base le faltan migraciones.",
      "npm run build:migrator && node --env-file=.env.local .next/standalone/scripts/migrate.js",
    );
  }

  // 5. El panel.
  let health: Response;
  try {
    health = await fetch(`${BASE}/admin/api/health`);
  } catch {
    fail(
      `El panel no responde en ${BASE}.`,
      "npm run dev\n  Si el puerto está ocupado, usa otro y pásalo en E2E_BASE_URL — y cambia\n  BETTER_AUTH_URL en .env.local al mismo, o el login redirige al puerto equivocado.",
    );
  }

  if (!health.ok) fail(`El panel respondió ${health.status} en /admin/api/health.`, "Mira el log de `npm run dev`.");

  // 6. EA. Es la que más se olvida: el panel arranca sin ella y las pantallas
  //    entran en solo lectura, así que media suite fallaría por "no encuentro
  //    el botón" cuando lo que pasa es que EA está apagada.
  const eaUrl = /EA_API_URL="?([^"\n]+)"?/.exec(
    execFileSync("cat", [".env.local"], { encoding: "utf8" }),
  )?.[1];

  if (!eaUrl) fail("No hay EA_API_URL en .env.local.", "Ver docs/PROBAR-EL-PANEL.md § 3.");

  const token = /EA_API_TOKEN="?([^"\n]+)"?/.exec(
    execFileSync("cat", [".env.local"], { encoding: "utf8" }),
  )?.[1];

  try {
    const r = await fetch(`${eaUrl}/services`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!r.ok) {
      fail(
        `Easy!Appointments respondió ${r.status} en ${eaUrl}/services.`,
        "Si es 401, el EA_API_TOKEN no es el de esta instalación.\n  Si es 404, EA está sin instalar: abre su URL y completa el asistente.",
      );
    }
  } catch {
    fail(
      `No se pudo alcanzar Easy!Appointments en ${eaUrl}.`,
      "Levanta el stack gbs-dev. Si cambiaste EA_PORT, EA_API_URL tiene que llevar el mismo puerto.",
    );
  }

  console.log("✓ entorno listo: base migrada, panel arriba, EA respondiendo.");
}
