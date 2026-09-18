import { readFile } from "node:fs/promises";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import { createEaClient } from "@/lib/ea/client";

import { looksLikeXlsx, parseXlsx } from "./xlsx";
import {
  applyColumns,
  detectColumns,
  parseAgendaproDate,
  parseDelimited,
  planCustomers,
  planLegacy,
  type ColumnMap,
  type ImportField,
} from "./import-agendapro";

/**
 * Importa el export de Agenda Pro. **Se corre a mano, mirando la salida.**
 *
 * ```
 *   node scripts/importar.js citas.csv                  ← plan, no escribe nada
 *   node scripts/importar.js citas.csv --aplicar        ← escribe
 *   node scripts/importar.js citas.csv --col-phone=4    ← anula una columna
 *   node scripts/importar.js citas.csv --solo-clientas  ← sin histórico
 * ```
 *
 * ## Qué escribe y dónde
 *
 * - **Clientas → EA**, por su API, una por teléfono normalizado.
 * - **Historia → `gbs_admin.legacy_appointment`**, idempotente por `source_id`.
 *
 * ⚠ **Nada de esto se empuja a ingest.** La plata del histórico ya está en
 * Actual Budget, metida por el scraper nocturno. Ver la nota de
 * `import-agendapro.ts`.
 *
 * ## Por qué imprime tanto antes de escribir
 *
 * Porque el mapeo de columnas se adivina. Una detección equivocada que se ve es
 * un ajuste de treinta segundos; una que no se ve es una base de clientas
 * importada al revés, y del otro lado hay gente a la que hay que llamar para
 * pedirle otra vez el número.
 */

function parseOverrides(argv: readonly string[]): ColumnMap {
  const map: ColumnMap = {};
  for (const arg of argv) {
    const match = /^--col-([a-zA-Z]+)=(\d+)$/.exec(arg);
    if (!match) continue;
    map[match[1] as ImportField] = Number(match[2]);
  }
  return map;
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const file = argv.find((arg) => !arg.startsWith("--"));
  const aplicar = argv.includes("--aplicar");
  const soloClientas = argv.includes("--solo-clientas");
  const soloHistoria = argv.includes("--solo-historia");

  if (file === undefined) {
    console.error("importar: falta el archivo. Uso: node scripts/importar.js <archivo.csv>");
    process.exitCode = 1;
    return;
  }

  try {
    // El `.xlsx` se lee directo. La alternativa —"guárdalo como CSV"— es donde
    // Excel estropea justo las dos columnas que importan: convierte
    // `+573187050207` en notación científica y reescribe las fechas según la
    // configuración regional de quien lo abrió, que es el error de día-por-mes
    // que corre el histórico entero.
    const raw = await readFile(file);
    const table = looksLikeXlsx(raw) ? parseXlsx(raw) : parseDelimited(raw.toString("utf8"));

    if (table.length < 2) {
      console.error(`importar: "${file}" no tiene filas debajo del encabezado.`);
      process.exitCode = 1;
      return;
    }

    const [header, ...body] = table;
    const columns = { ...detectColumns(header), ...parseOverrides(argv) };

    console.log(
      `importar: ${body.length} fila(s) en "${file}" ` +
        `(${looksLikeXlsx(raw) ? "xlsx" : "texto delimitado"}).`,
    );
    console.log("importar: columnas detectadas —");
    for (const [field, index] of Object.entries(columns) as [ImportField, number][]) {
      console.log(`  ${field.padEnd(12)} → [${index}] ${header[index] ?? "(fuera de rango)"}`);
    }

    // El teléfono es la llave de todo: sin él no hay clienta que crear ni
    // historia que atar. Que falte no es un aviso, es un fin de ejecución.
    if (columns.phone === undefined) {
      console.error(
        "importar: no se encontró la columna de teléfono. Es la llave de la identidad de la " +
          "clienta y sin ella no se puede importar nada.\n" +
          `         Columnas del archivo: ${header.map((h, i) => `[${i}] ${h}`).join(" · ")}\n` +
          "         Se puede indicar a mano con --col-phone=<número de columna>.",
      );
      process.exitCode = 1;
      return;
    }

    const rows = body.map((row) => applyColumns(row, columns));

    // --- Clientas ----------------------------------------------------------
    if (!soloHistoria) {
      const ea = createEaClient();
      const existing = await ea.customers.list({});

      const plan = planCustomers({
        rows,
        existing: existing.map((customer) => ({
          id: customer.id,
          phone: customer.phone,
          name: [customer.firstName, customer.lastName].filter(Boolean).join(" "),
        })),
      });

      console.log(
        `\nimportar: clientas — ${plan.create.length} a crear · ` +
          `${plan.existing.length} ya en la agenda · ${plan.unusable.length} sin teléfono usable.`,
      );

      if (plan.unusable.length > 0) {
        // No son un detalle: son las clientas que se pierden si nadie las mira.
        console.log("importar: filas sin teléfono utilizable (hay que conseguir el número):");
        for (const bad of plan.unusable.slice(0, 40)) {
          console.log(`  ${String(bad.rows).padStart(3)}×  ${bad.name || "(sin nombre)"}  ← ${JSON.stringify(bad.raw)}`);
        }
        if (plan.unusable.length > 40) {
          console.log(`  … y ${plan.unusable.length - 40} más.`);
        }
      }

      if (aplicar) {
        let creadas = 0;
        const fallidas: string[] = [];

        for (const entry of plan.create) {
          try {
            await ea.customers.create({
              firstName: entry.firstName,
              lastName: entry.lastName,
              phone: entry.phone,
              // Sin correo en el export, sin correo en EA. Inventar uno es el
              // error que `identity.ts` existe para no repetir.
              ...(entry.email === null ? {} : { email: entry.email }),
            });
            creadas += 1;
          } catch (error) {
            // Se sigue: crear 180 de 200 y decir cuáles fallaron es mejor que
            // abortar en la tercera y dejar la base a medias sin lista.
            fallidas.push(`${entry.phone} (${error instanceof Error ? error.message : error})`);
          }
        }

        console.log(`importar: ✓ ${creadas} clienta(s) creada(s) en la agenda.`);
        if (fallidas.length > 0) {
          console.error(`importar: ⚠ ${fallidas.length} fallaron:\n  ${fallidas.join("\n  ")}`);
          process.exitCode = 1;
        }
      }
    }

    // --- Historia ----------------------------------------------------------
    if (!soloClientas) {
      const plan = planLegacy({ rows, parseDate: (raw) => parseAgendaproDate(raw) });

      console.log(
        `\nimportar: historia — ${plan.rows.length} cita(s) utilizables · ` +
          `${plan.skipped.length} saltada(s).`,
      );

      const conMonto = plan.rows.filter((row) => row.amount_charged !== null).length;
      console.log(
        `importar: ${conMonto} de ${plan.rows.length} traen monto. ` +
          "Las demás quedan en null, que significa «el export no traía la plata», no «fue gratis».",
      );

      if (plan.rows.length > 0) {
        // Quién atendió, y cuántas. Es el dato con el que se decide si la regla
        // de comisión global sigue siendo correcta: una técnica nueva en esta
        // lista es una técnica a la que el motor le va a liquidar 40 % sin que
        // nadie lo haya decidido.
        const porTecnica = new Map<string, number>();
        for (const row of plan.rows) {
          const who = row.provider_name ?? "(sin prestador)";
          porTecnica.set(who, (porTecnica.get(who) ?? 0) + 1);
        }
        console.log(
          `importar: prestadores — ${[...porTecnica]
            .sort((a, b) => b[1] - a[1])
            .map(([who, n]) => `${who}: ${n}`)
            .join(" · ")}`,
        );

        const first = plan.rows.reduce((a, b) => (a.started_at < b.started_at ? a : b));
        const last = plan.rows.reduce((a, b) => (a.started_at > b.started_at ? a : b));
        console.log(
          `importar: rango ${first.started_at.toISOString().slice(0, 10)} → ` +
            `${last.started_at.toISOString().slice(0, 10)}.`,
        );
        // Mirar estas dos fechas es lo que delata un mes leído como día: un
        // rango que arranca en 2025 cuando el estudio abrió en 2024, o al revés.
        console.log("importar: ⚠ revisar que ese rango sea el que se espera antes de aplicar.");
      }

      if (plan.skipped.length > 0) {
        const byReason = new Map<string, number>();
        for (const skip of plan.skipped) {
          byReason.set(skip.reason, (byReason.get(skip.reason) ?? 0) + 1);
        }
        console.log(
          `importar: saltadas — ${[...byReason].map(([r, n]) => `${r}: ${n}`).join(" · ")}. ` +
            `Líneas: ${plan.skipped.slice(0, 20).map((s) => s.line).join(", ")}` +
            (plan.skipped.length > 20 ? " …" : ""),
        );
      }

      if (aplicar && plan.rows.length > 0) {
        const inserted = await repositories(getDb()).legacyAppointments.insertIfAbsent(plan.rows);
        console.log(
          `importar: ✓ ${inserted} fila(s) nuevas en legacy_appointment ` +
            `(de ${plan.rows.length}; el resto ya estaban, por source_id).`,
        );
      }
    }

    if (!aplicar) {
      console.log("\nimportar: ejecución en seco. Volver a correr con --aplicar para escribir.");
    }
  } catch (error) {
    console.error("importar: no se pudo completar.", error);
    process.exitCode = 1;
  }
}

void run();
