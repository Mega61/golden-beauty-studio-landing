import "server-only";

/**
 * Las sondas de Diagnóstico.
 *
 * Cada una hace **una** pregunta y devuelve un hecho o un motivo. La
 * evaluación —qué es verde, qué es rojo, qué es "no se puede saber"— vive en
 * `checks.ts`, pura y testeada. La separación no es ceremonia: "rojo a las 48
 * horas" es una regla de negocio, y una regla se fija con un test, no con un
 * `if` en medio de un `await`.
 *
 * ## Ninguna sonda puede tumbar la pantalla
 *
 * Es el único tablero que sirve **cuando algo está roto**, así que cada sonda
 * atrapa su propio error y lo devuelve como dato. Una pantalla de Diagnóstico
 * que se cae porque EA no responde es una pantalla inútil justo el día que se
 * necesita.
 *
 * ## Dos lecturas que no pasan por un repositorio, y por qué
 *
 * `snapshot_source` y las cuentas huérfanas necesitan agregados que ningún
 * repositorio de A2 expone (`MAX(updated_at) WHERE snapshot_source = …`, un
 * conteo por `snapshot_source`). Se escriben en Kysely acá en vez de agregar
 * métodos a `src/db/repositories/**`, que es de A2. Lo natural es que vivan
 * allá; está pedido. Son `SELECT`.
 */

import { sql } from "kysely";

import { getDb } from "@/db/client";
import { JOB_RECONCILE, repositories } from "@/db/repositories";
import type { JobRunRow } from "@/db/types";
import { createEaClient, eaConfigFromEnv } from "@/lib/ea/client";
import { instantToEaDate, type EaLocalDate } from "@/lib/ea";
import { mapEaStatus, unmappedStatuses } from "@/components/calendar";

import { addDays } from "../reportes/period";
import {
  loadExistingAppointmentIds,
  loadSetting,
  loadStatusStrings,
  loadUnmirrored,
  pingEaDatabase,
} from "../reportes/ea-sql";
import {
  backupCheck,
  eaApiCheck,
  eaDatabaseCheck,
  googleMirrorCheck,
  ingestPushCheck,
  orphanCheck,
  parseBackupStamp,
  parseBackupStatus,
  reconcileCheck,
  snapshotCheck,
  statusOptionsCheck,
  webhookCheck,
  webhookTrafficCheck,
  worstLevel,
  type Check,
  type CheckLevel,
  type JobRunFact,
  type RegisteredWebhook,
} from "./checks";

/** Ventana que se vigila. Un mes cubre el ciclo completo de una quincena. */
const WINDOW_DAYS = 30;

/** La ruta del webhook, tal como la sirve este contenedor. */
const WEBHOOK_PATH = "/admin/api/webhooks/ea";

/** La acción que el handler procesa. De las 18 de EA, es la única. */
const REQUIRED_ACTION = "appointment_save";

/**
 * Dónde escribe sus marcas el servicio `db-backup`.
 *
 * `BACKUP_STATUS_DIR` existe para que el día que el stack monte el volumen se
 * pueda apuntar a otra ruta sin recompilar. Hoy el servicio `admin` **no monta**
 * `gbs_backups`, así que lo normal es que estos archivos no existan y el check
 * salga `unknown` diciendo exactamente eso.
 */
function backupDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.BACKUP_STATUS_DIR ?? "/backups";
}

export type Diagnostics = {
  level: CheckLevel;
  checks: Check[];
  window: { from: EaLocalDate; to: EaLocalDate; days: number };
  at: Date;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fila de `job_run` → el hecho que `checks.ts` evalúa.
 *
 * `undefined` (no hay ninguna corrida) se traduce a `null`, que en el check
 * significa **nunca corrió**. `ok` viaja como `TINYINT(1)` y se traduce acá:
 * este esquema no usa BOOLEAN, y comparar un `1` en la función pura sería
 * meterle el detalle del driver a la lógica.
 */
function toJobRunFact(row: JobRunRow | undefined): JobRunFact | null {
  if (row === undefined) return null;
  return {
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ok: row.ok !== 0,
    summary: row.summary,
  };
}

/** `T` o el motivo por el que no se pudo. Nunca lanza hacia la pantalla. */
type Probe<T> = { ok: true; value: T } | { ok: false; error: string };

async function probe<T>(run: () => Promise<T>): Promise<Probe<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/**
 * Lee un archivo de texto del volumen de respaldos.
 *
 * `fs/promises` se importa dinámicamente para que el módulo se pueda analizar
 * en el build sin arrastrar Node al grafo del cliente. `ENOENT` es la respuesta
 * normal hoy, no un error: el volumen no está montado.
 */
async function readStamp(file: string): Promise<string | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * El tablero completo.
 *
 * `now` entra por parámetro por la misma razón que en `lib/metrics.ts`: las
 * antigüedades y el umbral de 48 horas del respaldo se tienen que poder fijar
 * en un test.
 */
export async function loadDiagnostics(now: Date = new Date()): Promise<Diagnostics> {
  const to = instantToEaDate(now);
  const from = addDays(to, -WINDOW_DAYS);

  // --- EA, por sus dos caminos --------------------------------------------
  //
  // Se preguntan los dos porque fallan por separado y significan cosas
  // distintas: sin API no se puede escribir, sin base no hay reportes.
  const [apiPing, dbPing, webhooks, statusRaw] = await Promise.all([
    probe(async () => {
      const ea = createEaClient(eaConfigFromEnv());
      // `GET /settings/company_name` es lo más liviano que ejerce el token de
      // verdad: un endpoint que exista y que exija autorización.
      await ea.settings.get("company_name");
      return true;
    }),
    probe(async () => {
      await pingEaDatabase();
      return true;
    }),
    probe(async () => {
      const ea = createEaClient(eaConfigFromEnv());
      const list = await ea.webhooks.list();
      return list.map(
        (hook): RegisteredWebhook => ({
          id: hook.id,
          name: hook.name,
          url: hook.url,
          actions: hook.actions,
          isSslVerified: hook.isSslVerified,
        }),
      );
    }),
    probe(() => loadSetting("appointment_status_options")),
  ]);

  // --- Estados que el panel no supo traducir ------------------------------
  //
  // La otra mitad del check de la lista de estados, y la que dice si el cambio
  // **ya produjo daño**: EA no migra el `status` de las citas viejas al
  // renombrar un estado, así que después de un cambio conviven filas con la
  // cadena vieja y filas con la nueva. Se leen las cadenas que existen de
  // verdad en la ventana, no las que la lista promete.
  const unmapped = await probe(async () => {
    const rows = await loadStatusStrings(from, to);
    return unmappedStatuses(rows);
  });

  // --- Plata sin congelar, y huérfanas ------------------------------------
  const financeFacts = await probe(async () => {
    const db = getDb();
    const repos = repositories(db);
    const bounds = {
      start: new Date(now.getTime() - WINDOW_DAYS * 86_400_000),
      end: new Date(now.getTime() + 86_400_000),
    };

    const rows = await repos.appointmentFinance.listByStartRange(bounds.start, bounds.end);

    // `MAX(updated_at)` de las filas que escribió el reconcile. **Ya no es el
    // proxy del "último reconcile"** —eso lo contesta `job_run`— sino contexto:
    // la última vez que el barrido encontró algo que reparar.
    const lastReconcile = await sql<{ at: Date | null }>`
      SELECT MAX(updated_at) AS at
        FROM ${sql.table("appointment_finance")}
       WHERE snapshot_source = 'reconcile'
    `.execute(db);

    return {
      rows,
      withoutSnapshot: rows.filter((row) => row.service_price_snapshot === null).length,
      fallback: rows.filter((row) => row.snapshot_source === "fallback").length,
      lastReconcile: lastReconcile.rows[0]?.at ?? null,
    };
  });

  const orphanFacts = await probe(async () => {
    if (!financeFacts.ok) throw new Error("no se pudo leer gbs_admin");
    const ids = financeFacts.value.rows.map((row) => row.ea_appointment_id);
    const existing = await loadExistingAppointmentIds(ids);
    return {
      checked: ids.length,
      orphans: ids.filter((id) => !existing.has(id)).length,
    };
  });

  // --- Espejo de Google ---------------------------------------------------
  const mirror = await probe(() => loadUnmirrored(from, to));

  // --- Trabajos -----------------------------------------------------------
  const jobs = await probe(async () => {
    const db = getDb();
    const repos = repositories(db);
    const [lastEvent, closes, pending, lastReconcileRun] = await Promise.all([
      repos.webhookEvents.lastReceivedAt(),
      repos.dayCloses.listByDateRange(from, to),
      repos.dayCloses.listPendingPush(),
      // La respuesta exacta a "¿el reconcile corrió?". Una corrida que no
      // encontró nada que reparar también deja fila, que es justo lo que el
      // proxy anterior no podía ver.
      repos.jobRuns.lastRun(JOB_RECONCILE),
    ]);

    const pushes = closes
      .map((close) => close.pushed_to_ingest_at)
      .filter((at): at is Date => at !== null)
      .sort((a, b) => b.getTime() - a.getTime());

    return {
      lastEvent: lastEvent ?? null,
      lastPush: pushes[0] ?? null,
      pending: pending.length,
      // `undefined` (no hay filas) se traduce a `null` = **nunca corrió**, que
      // es una afirmación y no un "no se sabe": si la consulta no se pudo
      // hacer, la sonda entera falla y el check se degrada a `unknown` más
      // abajo.
      lastReconcileRun: toJobRunFact(lastReconcileRun),
    };
  });

  // --- Respaldo -----------------------------------------------------------
  const dir = backupDir();
  const [stampRaw, statusFile] = await Promise.all([
    readStamp(`${dir}/last-run.txt`),
    readStamp(`${dir}/last-status.txt`),
  ]);

  // --- A semáforos --------------------------------------------------------
  const checks: Check[] = [
    eaApiCheck({
      ok: apiPing.ok,
      error: apiPing.ok ? undefined : apiPing.error,
      at: now,
      now,
    }),
    eaDatabaseCheck({
      ok: dbPing.ok,
      error: dbPing.ok ? undefined : dbPing.error,
      at: now,
      now,
    }),
    ...webhookCheck({
      webhooks: webhooks.ok ? webhooks.value : null,
      error: webhooks.ok ? undefined : webhooks.error,
      expectedPath: WEBHOOK_PATH,
      requiredAction: REQUIRED_ACTION,
      at: now,
      now,
    }),
    statusOptionsCheck({
      raw: statusRaw.ok ? statusRaw.value : null,
      // La tabla de traducción es la de C1: acá no se escribe una segunda.
      recognized: (value) => mapEaStatus(value) !== "desconocido",
      unmapped: unmapped.ok ? unmapped.value : [],
      at: now,
      now,
    }),
    snapshotCheck({
      withoutSnapshot: financeFacts.ok ? financeFacts.value.withoutSnapshot : 0,
      fallback: financeFacts.ok ? financeFacts.value.fallback : 0,
      total: financeFacts.ok ? financeFacts.value.rows.length : 0,
      at: now,
      now,
    }),
    googleMirrorCheck({
      unmirrored: mirror.ok ? mirror.value.length : null,
      windowDays: WINDOW_DAYS,
      error: mirror.ok ? undefined : mirror.error,
      at: now,
      now,
    }),
    orphanCheck({
      orphans: orphanFacts.ok ? orphanFacts.value.orphans : null,
      checked: orphanFacts.ok ? orphanFacts.value.checked : 0,
      at: now,
      now,
    }),
    webhookTrafficCheck({ lastEvent: jobs.ok ? jobs.value.lastEvent : null, now }),
    reconcileCheck({
      lastRun: jobs.ok ? jobs.value.lastReconcileRun : null,
      lastTouch: financeFacts.ok ? financeFacts.value.lastReconcile : null,
      now,
    }),
    ingestPushCheck({
      lastPush: jobs.ok ? jobs.value.lastPush : null,
      pending: jobs.ok ? jobs.value.pending : 0,
      now,
    }),
    backupCheck({
      lastRun: parseBackupStamp(stampRaw),
      status: parseBackupStatus(statusFile),
      error:
        stampRaw === null
          ? `no se pudo leer ${dir}/last-run.txt`
          : undefined,
      now,
    }),
  ];

  // Si `gbs_admin` no contestó, los tres checks que dependen de ella dirían
  // "cero problemas" con cero datos, que es la mentira más peligrosa de esta
  // pantalla. Se degradan a `unknown` con el motivo.
  const degrade = (ids: readonly string[], reason: string): void => {
    for (const id of ids) {
      const check = checks.find((entry) => entry.id === id);
      if (check === undefined) continue;
      check.level = "unknown";
      check.detail = `No se pudo leer gbs_admin: ${reason}. Sin la base del panel esta comprobación no dice nada, y un verde acá sería falso.`;
      check.figure = undefined;
    }
  };

  if (!financeFacts.ok) {
    degrade(["snapshot", "reconcile", "ingest", "webhook-traffic"], financeFacts.error);
  }

  // Y si lo que falló fue la sonda de trabajos, el renglón del reconcile no
  // puede quedar en rojo: **"no corrió" es una afirmación**, y ahora se pinta
  // rojo, así que hay que poder distinguirla de "no se pudo preguntar". Un rojo
  // falso en el renglón del reconcile es exactamente lo que hace que un tablero
  // deje de servir.
  if (!jobs.ok) {
    degrade(["reconcile"], jobs.error);
  }

  return {
    level: worstLevel(checks),
    checks,
    window: { from, to, days: WINDOW_DAYS },
    at: now,
  };
}
