import "server-only";

import { normalizePhoneE164 } from "@/app/(panel)/clientes/identity";
import {
  createDb,
  createPool,
  JOB_WHATSAPP_REMINDERS,
  repositories,
  requireDatabaseUrl,
  type Db,
  type WaMessageWithSender,
} from "@/db";
import type { WaMessageKind } from "@/db/types";
import {
  addMinutes,
  eaDatePart,
  eaLocalToInstant,
  instantToEaDate,
  parseEaLocalDateTime,
  type EaLocalDate,
  type EaLocalDateTime,
} from "@/lib/ea";
import {
  createEaClient,
  eaConfigFromEnv,
  listDayAppointments,
  type AppointmentWithRelations,
  type EaClient,
} from "@/lib/ea/client";
import { isRetryableError, type FetchLike } from "@/lib/whatsapp/cloud-api";
import { maskPhone, parseWhatsappEnv, type WhatsappConfig } from "@/lib/whatsapp/config";
import { deliverTemplate, sendOnRow, type DeliveryOutcome } from "@/lib/whatsapp/deliver";
import { reminderParams, type TemplateAppointment } from "@/lib/whatsapp/template-params";

import {
  isSendableStatus,
  planReminders,
  scheduledFor,
  type ReminderAppointment,
  type ReminderDecision,
  type ReminderRule,
  type SkipReason,
} from "./reminders";

/**
 * El emisor automático de recordatorios: el que ejecuta `jobs/reminders.ts`.
 *
 * Corre cada 30 minutos en el servicio `admin-recordatorios` del stack
 * (`deploy/compose/gbs-stack.yml`). Cada corrida:
 *
 * 1. Lee de EA, **fresco**, las citas de hoy, mañana y pasado mañana. Pasado
 *    mañana entra porque a las 11:40 p. m. la ventana de 24 h (± 35 min) ya
 *    alcanza citas de pasado mañana a las 12:15 a. m. — el estudio no atiende
 *    a esa hora, pero el job no tiene por qué saberlo.
 * 2. Cruza con `wa_message` (lo ya mandado, por cualquier canal) y `wa_optout`.
 * 3. `planReminders` decide. Lo que toca, se manda con `deliverTemplate`:
 *    fila primero, Meta después.
 * 4. Reintenta, una vez por corrida y solo dentro de la ventana, lo que Meta
 *    rechazó **explícitamente** por límite de tasa o caída suya.
 * 5. Anota la corrida en `job_run`, que es lo que Diagnóstico lee.
 *
 * ## Las omisiones no se escriben como filas
 *
 * `planReminders` devuelve `sin-telefono`, `opt-out`, `estado-no-aplica` y
 * `cita-ya-empezo` como decisiones con motivo. El job **las cuenta en el
 * resumen pero no escribe una fila `omitido`**: la `UNIQUE (cita, tipo)`
 * congelaría un motivo pasajero. Una clienta sin teléfono a las 9 a. m. a la
 * que recepción le corrige el número a las 9:10 tiene que recibir su aviso en
 * la corrida de las 9:30, y con una fila `omitido` ya no podría. El motivo
 * sigue a la vista en `/recordatorios`, que lo calcula en vivo.
 */

export type RemindersReport = {
  from: EaLocalDate;
  till: EaLocalDate;
  scanned: number;
  sent: number;
  failed: number;
  retried: number;
  alreadyHandled: number;
  skipped: Partial<Record<SkipReason, number>>;
};

/** Cada cuánto corre. El compose y el test de la tolerancia lo leen de acá. */
export const REMINDERS_INTERVAL_MINUTES = 30;

const DAYS_AHEAD = 2;

function plusDays(date: EaLocalDate, days: number): EaLocalDate {
  return eaDatePart(addMinutes(parseEaLocalDateTime(`${date} 12:00:00`), days * 24 * 60));
}

/** Una cita de EA con sus relaciones, en las dos formas que hacen falta. */
export type RunnerAppointment = {
  planning: ReminderAppointment;
  template: TemplateAppointment;
};

/** Pura: lo que viene de EA → lo que deciden el planificador y la plantilla. */
export function toRunnerAppointments(
  rows: readonly AppointmentWithRelations[],
): Map<number, RunnerAppointment> {
  const out = new Map<number, RunnerAppointment>();
  for (const { appointment, service, provider, customer } of rows) {
    out.set(appointment.id, {
      planning: {
        eaAppointmentId: appointment.id,
        startAt: eaLocalToInstant(appointment.start),
        phoneE164: normalizePhoneE164(customer?.phone ?? null),
        status: appointment.status,
      },
      template: {
        start: appointment.start as EaLocalDateTime,
        customerFirstName: customer?.firstName ?? null,
        serviceName: service?.name ?? null,
        providerFirstName: provider?.firstName ?? null,
      },
    });
  }
  return out;
}

/** Lo mínimo de una fila guardada que mira el reintento. */
export type StoredRow = Pick<
  WaMessageWithSender,
  "id" | "eaAppointmentId" | "kind" | "channel" | "status" | "error"
>;

export type RetryPlan = { rowId: number; appointment: ReminderAppointment; rule: ReminderRule };

/**
 * Qué filas automáticas fallidas se reintentan en esta corrida.
 *
 * Solo las que el planificador marcó `ya-existe` **dentro de la ventana** (el
 * reintento no estira la ventana: un recordatorio de 24 h no sale 20 h antes
 * porque Meta estuvo caído), cuyo error es reintentable, y para las que la
 * cita sigue mereciendo aviso con los mismos filtros de siempre.
 */
export function planRetries(input: {
  decisions: readonly ReminderDecision[];
  stored: readonly StoredRow[];
  optedOut: ReadonlySet<string>;
  now: Date;
}): RetryPlan[] {
  const byKey = new Map(input.stored.map((row) => [`${row.eaAppointmentId}:${row.kind}`, row]));
  const out: RetryPlan[] = [];
  for (const decision of input.decisions) {
    if (decision.action !== "omitir" || decision.reason !== "ya-existe") continue;
    const { appointment, rule } = decision;
    const row = byKey.get(`${appointment.eaAppointmentId}:${rule.kind}`);
    if (!row || row.channel !== "cloud_api" || row.status !== "fallido") continue;
    if (!isRetryableError(row.error)) continue;
    if (appointment.startAt.getTime() <= input.now.getTime()) continue;
    if (!isSendableStatus(appointment.status)) continue;
    if (appointment.phoneE164 === null || input.optedOut.has(appointment.phoneE164)) continue;
    out.push({ rowId: row.id, appointment, rule });
  }
  return out;
}

/** El resumen de una línea que va a `job_run.summary` y al log. */
export function summarize(report: RemindersReport): string {
  const skipped = Object.entries(report.skipped)
    .filter(([reason]) => reason !== "ya-existe")
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  return (
    `${report.from}→${report.till}: ${report.scanned} citas · ${report.sent} enviados · ` +
    `${report.failed} fallidos · ${report.retried} reintentados · ${report.alreadyHandled} ya resueltos` +
    (skipped === "" ? "" : ` · omitidos: ${skipped}`)
  );
}

export type RunRemindersDeps = {
  db: Db;
  ea: Pick<EaClient, "raw">;
  config: WhatsappConfig;
  now?: Date;
  fetchImpl?: FetchLike;
};

export async function runReminders(deps: RunRemindersDeps): Promise<RemindersReport> {
  const now = deps.now ?? new Date();
  const from = instantToEaDate(now);
  const dates = Array.from({ length: DAYS_AHEAD + 1 }, (_, i) => plusDays(from, i));

  const rows = (
    await Promise.all(
      dates.map((date) =>
        listDayAppointments(deps.ea, { date, providerId: null, with: ["service", "provider", "customer"] }),
      ),
    )
  ).flat();
  const appointments = toRunnerAppointments(rows);

  const repo = repositories(deps.db).waMessages;
  const ids = [...appointments.keys()];
  const phones = [...appointments.values()].flatMap((a) =>
    a.planning.phoneE164 === null ? [] : [a.planning.phoneE164],
  );
  const [stored, optedOut] = await Promise.all([
    repo.listByAppointmentIds(ids),
    repo.listOptedOut(phones),
  ]);

  const decisions = planReminders({
    appointments: [...appointments.values()].map((a) => a.planning),
    existing: stored.map((row) => ({ eaAppointmentId: row.eaAppointmentId, kind: row.kind })),
    optedOut,
    now,
  });

  const report: RemindersReport = {
    from,
    till: dates[dates.length - 1],
    scanned: appointments.size,
    sent: 0,
    failed: 0,
    retried: 0,
    alreadyHandled: 0,
    skipped: {},
  };

  const tally = (outcome: DeliveryOutcome) => {
    if (outcome.status === "enviado") report.sent += 1;
    else if (outcome.status === "fallido") report.failed += 1;
    else report.alreadyHandled += 1;
  };

  const sendDay = { today: from, tomorrow: plusDays(from, 1) };
  const inputFor = (appointment: ReminderAppointment, rule: ReminderRule, phone: string) => {
    const data = appointments.get(appointment.eaAppointmentId);
    return {
      eaAppointmentId: appointment.eaAppointmentId,
      kind: rule.kind as WaMessageKind,
      phoneE164: phone,
      templateName: deps.config.templates.recordatorio,
      bodyParams: data ? reminderParams(data.template, sendDay) : [],
      scheduledFor: scheduledFor(appointment, rule),
    };
  };

  // En serie: son pocos mensajes por corrida, y una ráfaga en paralelo es la
  // forma más rápida de chocar con el límite por número de Meta.
  for (const decision of decisions) {
    if (decision.action === "omitir") {
      report.skipped[decision.reason] = (report.skipped[decision.reason] ?? 0) + 1;
      continue;
    }
    const phone = decision.appointment.phoneE164;
    if (phone === null) continue; // El planificador ya lo descarta; esto es para el tipo.
    try {
      tally(
        await deliverTemplate(repo, deps.config, inputFor(decision.appointment, decision.rule, phone), {
          fetchImpl: deps.fetchImpl,
        }),
      );
    } catch (error) {
      // Una fila que no se pudo escribir no tumba la corrida: las demás citas
      // también necesitan su aviso.
      report.failed += 1;
      console.error(
        `[whatsapp] recordatorio ${decision.rule.kind} de la cita ${decision.appointment.eaAppointmentId} (${maskPhone(phone)}) no se pudo procesar`,
        error,
      );
    }
  }

  for (const retry of planRetries({ decisions, stored, optedOut, now })) {
    const phone = retry.appointment.phoneE164;
    if (phone === null) continue;
    try {
      if (!(await repo.claimForRetry(retry.rowId, phone))) continue;
      report.retried += 1;
      const outcome = await sendOnRow(repo, deps.config, retry.rowId, inputFor(retry.appointment, retry.rule, phone), {
        fetchImpl: deps.fetchImpl,
      });
      if (outcome.status === "enviado") report.sent += 1;
      else if (outcome.status === "fallido") report.failed += 1;
    } catch (error) {
      report.failed += 1;
      console.error(`[whatsapp] el reintento de la fila ${retry.rowId} no se pudo procesar`, error);
    }
  }

  // "ya-existe" que no se reintentó = ya resuelto por otro camino.
  report.alreadyHandled += report.skipped["ya-existe"] ?? 0;
  return report;
}

async function recordRun(
  db: Db,
  input: { startedAt: Date; finishedAt: Date; ok: boolean; summary: string },
): Promise<void> {
  try {
    await repositories(db).jobRuns.record({ job: JOB_WHATSAPP_REMINDERS, ...input });
  } catch (error) {
    console.error("recordatorios: no se pudo registrar la corrida en job_run.", error);
  }
}

export type MainResult = { status: "apagado" } | { status: "ok"; report: RemindersReport };

/**
 * La corrida completa, con su conexión. Sin configuración de Meta no abre ni
 * una conexión: devuelve `apagado` y el CLI sale con 0.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<MainResult> {
  const config = parseWhatsappEnv(env);
  if (config === null) return { status: "apagado" };

  const db = createDb(createPool(requireDatabaseUrl(env)));
  const startedAt = new Date();
  try {
    const report = await runReminders({ db, ea: createEaClient(eaConfigFromEnv(env)), config, now: startedAt });
    await recordRun(db, { startedAt, finishedAt: new Date(), ok: true, summary: summarize(report) });
    return { status: "ok", report };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordRun(db, { startedAt, finishedAt: new Date(), ok: false, summary: `falló: ${message}` });
    throw error;
  } finally {
    await db.destroy();
  }
}
