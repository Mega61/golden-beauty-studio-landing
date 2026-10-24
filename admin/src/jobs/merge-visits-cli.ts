import { createDb, createPool, requireDatabaseUrl } from "@/db";
import { createEaClient, eaConfigFromEnv } from "@/lib/ea/client";
import { instantToEaDate, parseEaLocalDate, type EaLocalDate } from "@/lib/ea/datetime";

import { runVisitMerges, summarizeVisitMerges } from "./merge-visits";

/**
 * Junta en **una** cita las visitas de manos + pies que quedaron como dos
 * citas pegadas (antes de la migración `028`). Ver `merge-visits.ts`.
 *
 * ```
 *   node scripts/juntar-visitas.js                          ← plan de hoy a 6 meses, no escribe
 *   node scripts/juntar-visitas.js --aplicar                ← escribe
 *   node scripts/juntar-visitas.js --desde=2026-10-01       ← desde esa fecha
 * ```
 *
 * Por defecto **desde hoy**: lo pasado ya se atendió y casi siempre tiene su
 * cuenta, y una visita con cuenta no se toca de todas formas.
 *
 * Cada visita son unas tres escrituras a EA con 1,5 s de pausa entre una y
 * otra. Antes de `--aplicar` mira si EA va a mandar correos: estirar la cita
 * es "los detalles de tu cita cambiaron" y borrar la segunda puede ser "tu cita
 * fue cancelada", para la clienta con correo y para la técnica con
 * notificaciones prendidas.
 *
 * Código de salida 1 si alguna visita falló. Correr de nuevo termina lo que quedó.
 */

function flag(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

function daysFromNow(days: number): EaLocalDate {
  return instantToEaDate(new Date(Date.now() + days * 86_400_000));
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--aplicar");

  let from: EaLocalDate;
  let till: EaLocalDate;
  try {
    from = parseEaLocalDate(flag(argv, "desde") ?? daysFromNow(0));
    till = parseEaLocalDate(flag(argv, "hasta") ?? daysFromNow(183));
  } catch (error) {
    console.error(
      `juntar-visitas: argumentos inválidos (${error instanceof Error ? error.message : String(error)}). ` +
        "Uso: --desde=AAAA-MM-DD --hasta=AAAA-MM-DD --aplicar",
    );
    process.exitCode = 1;
    return;
  }

  const pool = createPool(requireDatabaseUrl(process.env));
  const db = createDb(pool);
  const ea = createEaClient(eaConfigFromEnv(process.env));

  try {
    if (apply) {
      try {
        const setting = await ea.settings.get("customer_notifications");
        if (["1", "true", "yes", "on"].includes(String(setting.value).trim().toLowerCase())) {
          console.warn(
            "juntar-visitas: ⚠ customer_notifications está prendido en EA: las clientas con correo " +
              "van a recibir un correo por cada cita que se estire o se borre.",
          );
        }
      } catch {
        console.warn("juntar-visitas: no se pudo leer customer_notifications de EA. Se sigue.");
      }
    }

    const report = await runVisitMerges({ db, ea, from, till, apply, log: (l) => console.log(l) });

    if (!apply) {
      for (const m of report.plan.merges) {
        const combo = m.serviceId !== m.fromServiceId ? ` · pasa a ser el combo ${m.serviceId}` : "";
        console.log(
          `  · ${m.keepId} (${m.start} → ${m.end})${combo} · adicionales [${m.extras.join(", ")}] · se borran ${m.removeIds.join(", ")}`,
        );
      }
    }
    for (const s of report.plan.skipped) {
      const why = {
        "cuenta-abierta": "ya tiene cuenta",
        "estados-distintos": "las citas tienen estados distintos",
        "sin-servicio": "la primera cita no tiene servicio",
      }[s.reason];
      console.log(`  ! ${s.ids.join(" + ")} (${s.start}): ${why}. No se toca.`);
    }

    console.log(summarizeVisitMerges(report, apply));
    if (!apply && report.plan.merges.length > 0) {
      console.log("juntar-visitas: ejecución en seco. Volver a correr con --aplicar para escribir.");
    }
    if (report.failed.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error("juntar-visitas: la corrida no pudo completarse.", error);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

void run();
