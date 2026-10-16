import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * El historial de Agenda Pro **no puede llegar** a ningún camino de plata.
 *
 * La regla (gbs-money-auditor): las filas de `legacy_appointment` —y las de
 * `legacy_payment` (migración `025`), cómo se pagó cada venta— se leen para
 * pantalla —agenda de días pasados, ficha, reportes— y nunca entran a
 * `appointment_finance`, la caja / cierre del día, el ingest a Strapi/Actual,
 * las comisiones ni los recordatorios por WhatsApp. Esa plata ya está en Actual
 * Budget por el scraper de Agenda Pro (`agendapro-tx:<id>`); empujarla otra vez
 * la duplicaría en silencio, y comisionarla pagaría dos veces lo ya pagado.
 *
 * Un test de comportamiento no alcanza a probar un "nunca": habría que
 * imaginar cada forma de colarla. Así que esto lee el código. Desde cada punto
 * de entrada de esos caminos recorre el grafo de imports (relativos y `@/`) y
 * exige dos cosas de **todo** lo alcanzable:
 *
 * 1. que no importe ninguno de los módulos que traducen el historial para
 *    pantalla (`lib/legacy-history`, `agenda/legacy`, `reportes/legacy-blend`,
 *    `reportes/legacy-payments`, `clientes/history`) ni el importador de pagos
 *    (`jobs/legacy-payments`);
 * 2. que no nombre las tablas ni sus repositorios (`legacy_appointment`,
 *    `legacy_payment`, `legacyAppointment…`, `legacyPayment…`), salvo los
 *    archivos que las *declaran* —el agregador de repositorios, los
 *    repositorios mismos, los tipos y las migraciones—, que cualquier camino
 *    alcanza al importar `@/db` y que no las leen.
 *
 * Si este test se pone rojo, no se "arregla" el test: se saca el historial del
 * camino de plata.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Puntos de entrada de los caminos de plata y de mensajes. */
const MONEY_ENTRIES = [
  // Caja / cierre del día y el ingest a Strapi → Actual Budget.
  "jobs/day-close.ts",
  "lib/ingest-payload.ts",
  "lib/ingest-client.ts",
  "lib/ingest-id.ts",
  "app/(panel)/caja",
  // La cuenta de servicio (lo único que escribe `appointment_finance`).
  "lib/ticket.ts",
  "lib/price-snapshot.ts",
  "components/ticket",
  // Comisiones.
  "lib/commission.ts",
  "jobs/commission-run.ts",
  "app/(panel)/comisiones",
  // Recordatorios y WhatsApp.
  "jobs/reminders.ts",
  "jobs/reminders-run.ts",
  "lib/whatsapp",
  "app/(panel)/recordatorios",
];

/** Los traductores del historial para pantalla. Ninguno puede ser alcanzable. */
const LEGACY_READERS = [
  "lib/legacy-history.ts",
  "app/(panel)/agenda/legacy.ts",
  "app/(panel)/reportes/legacy-blend.ts",
  "app/(panel)/reportes/legacy-payments.ts",
  "app/(panel)/clientes/history.ts",
  // El importador de los pagos: lee los reportes de plata de Agenda Pro, y por
  // eso mismo es lo último que un camino de plata puede alcanzar.
  "jobs/legacy-payments.ts",
];

/** Los que declaran la tabla sin leerla. Cualquier import de `@/db` los alcanza. */
const DECLARES_TABLE = [
  /^db\/repositories\/index\.ts$/,
  /^db\/repositories\/legacy-appointment\.ts$/,
  /^db\/repositories\/legacy-payment\.ts$/,
  /^db\/types\.ts$/,
  /^db\/migrations\//,
];

const MENTIONS_TABLE = /legacy_appointment|legacyAppointment|legacy_payment|legacyPayment/;

function listSources(path: string): string[] {
  const absolute = join(SRC, path);
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .map((entry) => join(absolute, entry))
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.ts$/.test(file));
}

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null; // paquete de node_modules: no es código del panel.

  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT = /(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function reachable(entries: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.flatMap(listSources);
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT)) {
      const target = resolveImport(file, match[1] ?? match[2] ?? match[3]);
      if (target !== null && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

describe("el historial de Agenda Pro no alcanza ningún camino de plata", () => {
  const graph = reachable(MONEY_ENTRIES);
  const rel = (file: string) => relative(SRC, file).split("\\").join("/");

  it("el recorrido de verdad ve los caminos (no es un grafo vacío)", () => {
    const files = [...graph].map(rel);
    expect(files).toContain("jobs/day-close.ts");
    expect(files).toContain("jobs/commission-run.ts");
    expect(files).toContain("lib/ingest-payload.ts");
    expect(files).toContain("jobs/reminders-run.ts");
    // `@/db` se alcanza: lo que prueba que la lista blanca de abajo hace falta.
    expect(files).toContain("db/repositories/index.ts");
    expect(graph.size).toBeGreaterThan(40);
  });

  it("ningún módulo que traduce el historial es alcanzable", () => {
    const reached = [...graph].map(rel).filter((file) => LEGACY_READERS.includes(file));
    expect(reached).toEqual([]);
  });

  it("ningún archivo alcanzable lee la tabla o su repositorio", () => {
    const offenders = [...graph]
      .filter((file) => !DECLARES_TABLE.some((pattern) => pattern.test(rel(file))))
      .filter((file) => MENTIONS_TABLE.test(readFileSync(file, "utf8")))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("el guardián detecta una violación (prueba del detector)", () => {
    // Los reportes **sí** leen el historial: si el detector no lo viera ahí,
    // tampoco lo vería en un camino de plata.
    const reports = [...reachable(["app/(panel)/reportes/data.ts"])].map(rel);
    expect(reports).toContain("app/(panel)/reportes/legacy-blend.ts");
    expect(reports).toContain("app/(panel)/reportes/legacy-payments.ts");
    // Y el patrón de la tabla nueva de verdad ve a quien la lee.
    expect(MENTIONS_TABLE.test(readFileSync(join(SRC, "app/(panel)/reportes/data.ts"), "utf8"))).toBe(true);
    const agenda = [...reachable(["app/(panel)/agenda/data.ts"])].map(rel);
    expect(agenda).toContain("app/(panel)/agenda/legacy.ts");
  });
});
