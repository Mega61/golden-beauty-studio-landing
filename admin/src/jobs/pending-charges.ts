import "server-only";

import { JOB_UNCLOSED_DAYS, repositories, type Db } from "@/db";
import { instantToEaDate, type EaLocalDate } from "@/lib/ea";
import {
  buildPendingChargesPayload,
  pendingWindow,
  shiftEaDate,
  summarizePendingCharges,
  type PendingCharge,
} from "@/lib/pending-charges";
import { PANEL_BASE_PATH, parseVapidEnv } from "@/lib/push/config";
import { notifyCashClosers } from "@/lib/push/send";

import {
  dayBounds,
  loadAccountsInRange,
  reviewDay,
  type DayAccount,
  type DayAppointment,
} from "./day-close";

/**
 * Las citas de días anteriores sin cobrar: la lectura (para Hoy y Comisiones)
 * y el aviso nocturno (para el reconcile). Las reglas de presentación viven en
 * `lib/pending-charges.ts`; la de qué cuenta como pendiente es `reviewDay()`,
 * la misma de siempre.
 */

/**
 * Las citas de un rango de días, de EA. Una sola lectura para todo el rango:
 * EA corta a 100 peticiones cada 120 s y todo el panel es una sola IP.
 */
export type DayRangeSource = (
  from: EaLocalDate,
  till: EaLocalDate,
) => Promise<readonly DayAppointment[]>;

/**
 * Lo pendiente de cobro entre `from` y `till` (inclusivos).
 *
 * `null` si EA no respondió: sin la agenda no se sabe qué citas hubo, y "no sé"
 * no es "nada pendiente". Quien llama decide qué hacer con la duda —Hoy se
 * calla, Comisiones bloquea—.
 */
export async function loadPendingCharges(input: {
  db: Db;
  loadRange: DayRangeSource;
  from: EaLocalDate;
  till: EaLocalDate;
  now?: Date;
}): Promise<PendingCharge[] | null> {
  const now = input.now ?? new Date();
  if (input.from > input.till) return [];

  let appointments: readonly DayAppointment[];
  try {
    appointments = await input.loadRange(input.from, input.till);
  } catch (error) {
    console.error("[caja] no se pudieron leer las citas para los pendientes", error);
    return null;
  }

  const [start] = dayBounds(input.from);
  const [, end] = dayBounds(input.till);
  const accounts = await loadAccountsInRange(input.db, start, end);

  return collectPendingCharges({ appointments, accounts, from: input.from, till: input.till, now });
}

/**
 * El cruce, puro: agrupa citas y cuentas por día y le pregunta a `reviewDay()`
 * qué falta en cada uno.
 */
export function collectPendingCharges(input: {
  appointments: readonly DayAppointment[];
  accounts: readonly DayAccount[];
  from: EaLocalDate;
  till: EaLocalDate;
  now: Date;
}): PendingCharge[] {
  const appointmentsByDate = new Map<EaLocalDate, DayAppointment[]>();
  for (const appointment of input.appointments) {
    const date = appointment.start.slice(0, 10) as EaLocalDate;
    const list = appointmentsByDate.get(date) ?? [];
    list.push(appointment);
    appointmentsByDate.set(date, list);
  }

  // Cada cuenta va al día de su cita. Se cruza por id con la cita de EA, que
  // es la que trae la fecha; una cuenta cuya cita no vino (otro rango, borrada)
  // cae en el día de su fecha de caja.
  const dateById = new Map(
    input.appointments.map((a) => [a.eaAppointmentId, a.start.slice(0, 10) as EaLocalDate]),
  );
  const accountsByDate = new Map<EaLocalDate, DayAccount[]>();
  for (const account of input.accounts) {
    const date = dateById.get(account.eaAppointmentId) ?? (account.paidOn as EaLocalDate | null);
    if (date === null || date === undefined) continue;
    const list = accountsByDate.get(date) ?? [];
    list.push(account);
    accountsByDate.set(date, list);
  }

  const out: PendingCharge[] = [];
  for (let date = input.from; date <= input.till; date = shiftEaDate(date, 1)) {
    const review = reviewDay({
      date,
      appointments: appointmentsByDate.get(date) ?? [],
      accounts: accountsByDate.get(date) ?? [],
      now: input.now,
    });
    for (const issue of review.issues) {
      if (!issue.blocks) continue;
      out.push({
        date,
        eaAppointmentId: issue.eaAppointmentId,
        kind: issue.kind === "sin-cuenta" ? "sin-cobrar" : "incompleta",
        customerName: issue.customerName,
        providerName: issue.providerName,
        message: issue.kind === "sin-cuenta" ? "Sin cobrar" : issue.message,
      });
    }
  }
  return out;
}

/**
 * Lo pendiente de la última semana, para la banda de Hoy. Es un aviso: si algo
 * falla, se calla (`[]`).
 */
export async function loadRecentPendingCharges(input: {
  db: Db;
  loadRange: DayRangeSource;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<PendingCharge[]> {
  const now = input.now ?? new Date();
  const window = pendingWindow(input.env ?? process.env, instantToEaDate(now));
  if (window === null) return [];
  try {
    return (await loadPendingCharges({ ...input, ...window, now })) ?? [];
  } catch (error) {
    console.error("[hoy] no se pudieron calcular los pendientes de cobro", error);
    return [];
  }
}

export type PendingChargesPushResult =
  | { state: "ya"; reason: string }
  | { state: "nada" }
  | { state: "sin-agenda" }
  | { state: "apagado"; charges: PendingCharge[] }
  | { state: "avisado"; charges: PendingCharge[]; delivered: number }
  | { state: "fallo"; message: string };

/**
 * El aviso de la noche. **Una vez por día**: si hoy ya hay una corrida buena en
 * `job_run`, no vuelve a sonar aunque el reconcile se corra a mano. El `tag`
 * fijo hace que el de hoy reemplace al de ayer.
 *
 * Mejor esfuerzo: nunca lanza, y deja constancia en `job_run`.
 */
export async function pushPendingCharges(input: {
  db: Db;
  loadRange: DayRangeSource;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<PendingChargesPushResult> {
  const env = input.env ?? process.env;
  const now = input.now ?? new Date();
  const today = instantToEaDate(now);
  const jobRuns = repositories(input.db).jobRuns;

  let result: PendingChargesPushResult;
  try {
    const last = await jobRuns.lastRun(JOB_UNCLOSED_DAYS);
    if (last && last.ok === 1 && instantToEaDate(new Date(last.started_at)) === today) {
      return { state: "ya", reason: `ya corrió hoy (${last.summary ?? "sin resumen"})` };
    }

    const window = pendingWindow(env, today);
    const charges =
      window === null ? [] : await loadPendingCharges({ ...input, ...window, now });
    const payload =
      charges === null ? null : buildPendingChargesPayload(charges, today, PANEL_BASE_PATH);
    const vapid = parseVapidEnv(env);
    if (charges === null) result = { state: "sin-agenda" };
    else if (payload === null) result = { state: "nada" };
    else if (vapid === null) result = { state: "apagado", charges };
    else {
      result = {
        state: "avisado",
        charges,
        delivered: await notifyCashClosers(input.db, payload, vapid),
      };
    }
  } catch (error) {
    result = { state: "fallo", message: error instanceof Error ? error.message : String(error) };
  }

  try {
    await jobRuns.record({
      job: JOB_UNCLOSED_DAYS,
      startedAt: now,
      finishedAt: new Date(),
      // Sin agenda no se supo nada: no cuenta como corrida buena, y mañana —o
      // en la próxima corrida a mano— se vuelve a intentar.
      ok: result.state !== "fallo" && result.state !== "sin-agenda",
      summary: summarizePendingChargesPush(result),
    });
  } catch (error) {
    console.error("[caja-sin-cobrar] no se pudo registrar la corrida en job_run", error);
  }
  return result;
}

/** Una línea para el log y para `job_run.summary`. */
export function summarizePendingChargesPush(result: PendingChargesPushResult): string {
  switch (result.state) {
    case "ya":
      return `citas sin cobrar: ${result.reason}`;
    case "nada":
      return summarizePendingCharges([]);
    case "sin-agenda":
      return "citas sin cobrar: la agenda no respondió, no se pudo revisar";
    case "apagado":
      return `${summarizePendingCharges(result.charges)} · sin avisos push (faltan las VAPID)`;
    case "avisado":
      return `${summarizePendingCharges(result.charges)} · aviso a ${result.delivered} dispositivo(s)`;
    case "fallo":
      return `citas sin cobrar: falló — ${result.message}`;
  }
}
