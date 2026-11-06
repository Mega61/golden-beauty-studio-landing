import "server-only";

import { JOB_UNCLOSED_DAYS, repositories, type Db } from "@/db";
import { EA_TIME_ZONE, eaLocalToInstant, instantToEaDate, parseEaLocalDateTime, type EaLocalDate } from "@/lib/ea";
import { PANEL_BASE_PATH, parseVapidEnv } from "@/lib/push/config";
import { notifyCashClosers } from "@/lib/push/send";
import {
  buildUnclosedDaysPayload,
  findUnclosedDays,
  summarizeUnclosedDays,
  unclosedDaysFrom,
  type UnclosedDay,
} from "@/lib/unclosed-days";

/**
 * Los días de caja sin cerrar: la lectura (para Hoy) y el aviso nocturno (para
 * el reconcile). Las reglas viven en `lib/unclosed-days.ts`.
 */

const startOf = (date: EaLocalDate): Date =>
  eaLocalToInstant(parseEaLocalDateTime(`${date} 00:00:00`), EA_TIME_ZONE);

/**
 * Los días anteriores a hoy con cuentas cerradas fuera de un cierre, desde el
 * corte de Agenda Pro. Dos consultas a `gbs_admin`, ninguna a EA.
 */
export async function loadUnclosedDays(input: {
  db: Db;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<UnclosedDay[]> {
  const today = instantToEaDate(input.now ?? new Date());
  const from = unclosedDaysFrom(input.env ?? process.env, today);
  if (from >= today) return [];
  const repos = repositories(input.db);
  const [accounts, closes] = await Promise.all([
    repos.appointmentFinance.listClosedOutsideDayClose(startOf(from), startOf(today)),
    repos.dayCloses.listByDateRange(from, today),
  ]);
  const closedDates = new Set<string>(closes.map((close) => close.close_date));
  return findUnclosedDays({ accounts, closedDates, from, today });
}

export type UnclosedDaysPushResult =
  | { state: "ya"; reason: string }
  | { state: "nada" }
  | { state: "apagado"; days: UnclosedDay[] }
  | { state: "avisado"; days: UnclosedDay[]; delivered: number }
  | { state: "fallo"; message: string };

/**
 * El aviso de la noche. **Una vez por día**: si hoy ya hay una corrida buena en
 * `job_run`, no vuelve a sonar aunque el reconcile se corra a mano. Mientras
 * quede un día sin cerrar, suena cada noche —es el punto—, y el `tag` fijo hace
 * que el de hoy reemplace al de ayer.
 *
 * Mejor esfuerzo: nunca lanza, y deja constancia en `job_run`.
 */
export async function pushUnclosedDays(input: {
  db: Db;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<UnclosedDaysPushResult> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const today = instantToEaDate(now);
  const jobRuns = repositories(input.db).jobRuns;

  let result: UnclosedDaysPushResult;
  try {
    const last = await jobRuns.lastRun(JOB_UNCLOSED_DAYS);
    if (last && last.ok === 1 && instantToEaDate(new Date(last.started_at)) === today) {
      return { state: "ya", reason: `ya corrió hoy (${last.summary ?? "sin resumen"})` };
    }

    const days = await loadUnclosedDays({ db: input.db, env, now });
    const payload = buildUnclosedDaysPayload(days, today, PANEL_BASE_PATH);
    const vapid = parseVapidEnv(env);
    if (payload === null) result = { state: "nada" };
    else if (vapid === null) result = { state: "apagado", days };
    else result = { state: "avisado", days, delivered: await notifyCashClosers(input.db, payload, vapid) };
  } catch (error) {
    result = { state: "fallo", message: error instanceof Error ? error.message : String(error) };
  }

  try {
    await jobRuns.record({
      job: JOB_UNCLOSED_DAYS,
      startedAt: now,
      finishedAt: new Date(),
      ok: result.state !== "fallo",
      summary: summarizeUnclosedDaysPush(result),
    });
  } catch (error) {
    console.error("[caja-sin-cerrar] no se pudo registrar la corrida en job_run", error);
  }
  return result;
}

/** Una línea para el log y para `job_run.summary`. */
export function summarizeUnclosedDaysPush(result: UnclosedDaysPushResult): string {
  switch (result.state) {
    case "ya":
      return `caja sin cerrar: ${result.reason}`;
    case "nada":
      return summarizeUnclosedDays([]);
    case "apagado":
      return `${summarizeUnclosedDays(result.days)} · sin avisos push (faltan las VAPID)`;
    case "avisado":
      return `${summarizeUnclosedDays(result.days)} · aviso a ${result.delivered} dispositivo(s)`;
    case "fallo":
      return `caja sin cerrar: falló — ${result.message}`;
  }
}
