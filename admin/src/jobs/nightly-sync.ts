import "server-only";

import { JOB_CASH_SYNC, repositories } from "@/db";
import { EA_TIME_ZONE, eaLocalToInstant, instantToEaDate, parseEaLocalDateTime, type EaLocalDate } from "@/lib/ea";
import { syncWindowFrom } from "@/lib/pending-charges";

import {
  ADJUST_ACTION,
  retryAdjustmentPush,
  syncDay,
  type DayCloseDeps,
  type PushOutcome,
  type SkippedAccount,
  type SyncDayResult,
} from "./day-close";

/**
 * **La sincronización nocturna de la caja.** Lo que antes dependía de que
 * alguien apretara "Cerrar el día".
 *
 * Corre dentro del reconcile de la noche (`jobs/reconcile.ts`, 03:45 en
 * Bogotá), antes de que el `actual-sync` del CRM pase los pagos a Actual
 * (06:30). Hace tres cosas, las tres idempotentes:
 *
 * 1. **Cada día anterior a hoy con cuentas cobradas sin sincronizar**, desde el
 *    corte de Agenda Pro: `syncDay()`. Un día con una sola cuenta tardía —la
 *    sesión que se olvidó y se cobró una semana después— entra igual que uno
 *    entero.
 * 2. **Cada cierre que quedó sin llegar al CRM** (el CRM estaba caído): se
 *    reintenta con el mismo lote y las mismas llaves.
 * 3. **Cada ajuste sin mandar**: las cuentas que se corrigieron desde Hoy
 *    después de haber llegado a Actual (`recordEditAdjustment()`), y los
 *    ajustes cuyo push falló.
 *
 * Hoy no se toca: el día no terminó, y hasta que la noche llegue una cuenta se
 * corrige sin que nada haya salido todavía.
 */

export type NightlySyncReport = {
  from: EaLocalDate;
  today: EaLocalDate;
  days: { date: EaLocalDate; result: SyncDayResult }[];
  adjustments: { eaAppointmentId: number; outcome: PushOutcome | { state: "sin-cuenta" } }[];
  /** Cuentas cobradas que no pudieron viajar, con el día y el motivo. */
  skipped: (SkippedAccount & { date: EaLocalDate })[];
};

const startOf = (date: EaLocalDate): Date =>
  eaLocalToInstant(parseEaLocalDateTime(`${date} 00:00:00`), EA_TIME_ZONE);

export async function runNightlySync(
  deps: DayCloseDeps,
  input: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<NightlySyncReport> {
  const now = input.now ?? new Date();
  const today = instantToEaDate(now);
  const from = syncWindowFrom(input.env ?? process.env, today);
  const repos = repositories(deps.db);

  const report: NightlySyncReport = { from, today, days: [], adjustments: [], skipped: [] };
  if (from >= today) return report;

  // Los días con algo que hacer: cuentas cobradas fuera de un cierre, o un
  // cierre que no llegó al CRM. Nada más: un día sin plata nueva no se toca.
  const [unsynced, pendingPush] = await Promise.all([
    repos.appointmentFinance.listClosedOutsideDayClose(startOf(from), startOf(today)),
    repos.dayCloses.listPendingPush(from),
  ]);
  const dates = new Set<EaLocalDate>();
  for (const row of unsynced) {
    if (row.appointment_start_at !== null) dates.add(instantToEaDate(row.appointment_start_at));
  }
  for (const row of pendingPush) {
    if (row.close_date < today) dates.add(row.close_date as EaLocalDate);
  }

  for (const date of [...dates].sort()) {
    const result = await syncDay(deps, { date, now });
    report.days.push({ date, result });
    for (const account of result.skipped) report.skipped.push({ ...account, date });
  }

  // Los ajustes van después de los días: un ajuste solo existe sobre una
  // cuenta que ya viajó, y así su original siempre sale antes que él.
  const financeIds = await repos.auditLog.listEntityIdsWithAction(
    "appointment_finance",
    ADJUST_ACTION,
    startOf(from),
  );
  for (const id of financeIds) {
    const row = await repos.appointmentFinance.findById(Number(id));
    if (row === undefined || row.day_close_id === null) continue;
    const outcome = await retryAdjustmentPush(deps, { eaAppointmentId: row.ea_appointment_id, now });
    if (outcome.state === "vacio") continue;
    report.adjustments.push({ eaAppointmentId: row.ea_appointment_id, outcome });
  }

  return report;
}

/** Una línea para el log y para `job_run.summary`. */
export function summarizeNightlySync(report: NightlySyncReport): string {
  const synced = report.days.filter((day) => day.result.state === "sincronizado");
  const failed = synced.filter(
    (day) => day.result.state === "sincronizado" && day.result.push.state === "fallo",
  );
  const accounts = synced.reduce(
    (sum, day) => sum + (day.result.state === "sincronizado" ? day.result.attached : 0),
    0,
  );
  const parts = [
    synced.length === 0
      ? "caja: nada nuevo que sincronizar"
      : `caja: ${accounts} cuenta(s) en ${synced.length} día(s) (${synced.map((d) => d.date).join(", ")})`,
  ];
  if (failed.length > 0) {
    parts.push(
      `push fallido: ${failed
        .map((day) =>
          day.result.state === "sincronizado" && day.result.push.state === "fallo"
            ? `${day.date} — ${day.result.push.message}`
            : day.date,
        )
        .join("; ")}`,
    );
  }
  if (report.adjustments.length > 0) {
    const ok = report.adjustments.filter((a) => a.outcome.state === "hecho").length;
    parts.push(`ajustes: ${ok}/${report.adjustments.length} enviados`);
  }
  if (report.skipped.length > 0) {
    parts.push(`sin poder viajar: ${report.skipped.map((s) => `#${s.eaAppointmentId} (${s.message})`).join(", ")}`);
  }
  return parts.join(" · ");
}

/** `true` si algo quedó sin llegar y hay que mirarlo. */
export function nightlySyncFailed(report: NightlySyncReport): boolean {
  return (
    report.days.some((day) => day.result.state === "sincronizado" && day.result.push.state === "fallo") ||
    report.adjustments.some((a) => a.outcome.state === "fallo")
  );
}

/**
 * Corre la sincronización y deja constancia en `job_run`. Nunca lanza: la
 * noche sigue con lo demás, y el fallo queda en el log y en Diagnóstico.
 */
export async function runAndRecordNightlySync(
  deps: DayCloseDeps,
  input: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<string> {
  const startedAt = new Date();
  let ok = true;
  let summary: string;
  try {
    const report = await runNightlySync(deps, input);
    ok = !nightlySyncFailed(report);
    summary = summarizeNightlySync(report);
  } catch (error) {
    ok = false;
    summary = `caja: la sincronización falló — ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    await repositories(deps.db).jobRuns.record({
      job: JOB_CASH_SYNC,
      startedAt,
      finishedAt: new Date(),
      ok,
      summary,
    });
  } catch (error) {
    console.error("[caja] no se pudo registrar la sincronización en job_run", error);
  }
  return ok ? summary : `⚠ ${summary}`;
}
