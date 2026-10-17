import { createDb, createPool, requireDatabaseUrl } from "@/db";
import { createEaClient, eaConfigFromEnv } from "@/lib/ea/client";
import { instantToEaDate, parseEaLocalDate, type EaLocalDate } from "@/lib/ea/datetime";

import { runAttendanceBackfill, summarizeAttendanceBackfill } from "./attendance-backfill";

/**
 * Marca `Completada` en EA las citas con la cuenta cerrada que siguen
 * reservadas. **Se corre a mano, una vez, en la puesta en marcha de la
 * asistencia** (y cuando haga falta: es idempotente).
 *
 * ```
 *   node scripts/asistencia.js                                ← plan del último año, no escribe
 *   node scripts/asistencia.js --desde=2026-01-01             ← desde esa fecha
 *   node scripts/asistencia.js --desde=2026-01-01 --aplicar   ← escribe
 *   node scripts/asistencia.js --aplicar --max=100            ← a lo sumo 100 en esta corrida
 * ```
 *
 * Las escrituras van de a una con 1,5 s de pausa —EA corta a 100 peticiones
 * cada 120 s por IP, y el panel en servicio comparte esa IP— así que 300 citas
 * son unos ocho minutos. Lo que el tope deja afuera se hace en la próxima
 * corrida. El reconcile nocturno corre lo mismo sobre la última semana.
 *
 * Antes de `--aplicar` mira el ajuste `customer_notifications` de EA: con él
 * prendido, cada clienta **con correo** recibe "los detalles de tu cita
 * cambiaron" por cada cita que se marque. Casi ninguna tiene correo, pero si
 * eso preocupa, apagarlo en EA mientras corre y prenderlo después.
 *
 * Código de salida 1 si alguna escritura falló.
 */

function flag(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

function daysAgo(days: number): EaLocalDate {
  return instantToEaDate(new Date(Date.now() - days * 86_400_000));
}

async function run(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--aplicar");

  let from: EaLocalDate;
  let till: EaLocalDate;
  let maxWrites: number | undefined;
  try {
    from = parseEaLocalDate(flag(argv, "desde") ?? daysAgo(365));
    till = parseEaLocalDate(flag(argv, "hasta") ?? daysAgo(0));
    const max = flag(argv, "max");
    maxWrites = max === null ? undefined : Number(max);
    if (maxWrites !== undefined && (!Number.isInteger(maxWrites) || maxWrites < 1)) {
      throw new Error("--max tiene que ser un entero positivo");
    }
  } catch (error) {
    console.error(
      `asistencia: argumentos inválidos (${error instanceof Error ? error.message : String(error)}). ` +
        "Uso: --desde=AAAA-MM-DD --hasta=AAAA-MM-DD --max=N --aplicar",
    );
    process.exitCode = 1;
    return;
  }

  const pool = createPool(requireDatabaseUrl(process.env));
  const db = createDb(pool);
  const ea = createEaClient(eaConfigFromEnv(process.env));

  try {
    if (apply) {
      // La advertencia va antes de escribir, no después: es para decidir.
      try {
        const setting = await ea.settings.get("customer_notifications");
        if (["1", "true", "yes", "on"].includes(String(setting.value).trim().toLowerCase())) {
          console.warn(
            "asistencia: ⚠ customer_notifications está prendido en EA: las clientas con correo " +
              "van a recibir «los detalles de tu cita cambiaron» por cada cita marcada.",
          );
        }
      } catch {
        console.warn("asistencia: no se pudo leer customer_notifications de EA. Se sigue.");
      }
      // Y a la técnica: EA le escribe "Se han modificado los detalles de la
      // cita" por cada PUT si tiene las notificaciones prendidas (verificado en
      // el entorno de desarrollo: sale aunque el estado no cambie).
      try {
        const noisy = (await ea.providers.list())
          .filter((provider) => provider.settings?.notifications === true)
          .map((provider) => provider.firstName ?? `#${provider.id}`);
        if (noisy.length > 0) {
          console.warn(
            `asistencia: ⚠ ${noisy.join(", ")} tiene(n) las notificaciones de EA prendidas: ` +
              "recibe(n) un correo por cada cita suya que se marque. Apagarlas en EA " +
              "(Usuarios → Proveedores → Notificaciones) antes de --aplicar si son muchas.",
          );
        }
      } catch {
        console.warn("asistencia: no se pudo leer las técnicas de EA. Se sigue.");
      }
    }

    const report = await runAttendanceBackfill({
      db,
      ea,
      from,
      till,
      apply,
      maxWrites,
      log: (line) => console.log(line),
    });

    if (!apply) {
      for (const candidate of report.plan.toComplete) {
        console.log(`  · ${candidate.id} (${candidate.start}): «${candidate.from}» → «Completada»`);
      }
    }
    for (const skipped of report.plan.skipped) {
      console.log(`  ! ${skipped.id}: cuenta cerrada con estado «${skipped.status}». No se toca.`);
    }

    console.log(summarizeAttendanceBackfill(report));
    if (!apply && report.plan.toComplete.length > 0) {
      console.log("asistencia: ejecución en seco. Volver a correr con --aplicar para escribir.");
    }
    if (report.failed.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error("asistencia: la corrida no pudo completarse.", error);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
}

void run();
