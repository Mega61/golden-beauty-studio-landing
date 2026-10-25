import "server-only";

import { JOB_CRM_VISITS, repositories, type Db } from "@/db";
import { eaLocalToInstant, EA_TIME_ZONE, instantToEaDate, parseEaLocalDateTime } from "@/lib/ea";
import { listAppointmentsInRange, type EaClient } from "@/lib/ea/client";
import { safeBody } from "@/lib/ea";
import { buildCrmVisits, crmVisitsRange, type CrmFinance } from "@/lib/crm-visits";
import { INGEST_AUTH_HEADER, type IngestConfig } from "@/lib/ingest-client";
import { withPlannedServiceNames } from "@/lib/planned-services";

/**
 * El push nocturno de visitas al CRM: lo que reemplaza al reporte de reservas
 * del scraper de Agenda Pro. Corre dentro del reconcile (`jobs/reconcile.ts`),
 * después del barrido, **mejor esfuerzo**: un CRM caído no tumba la noche.
 *
 * Hacia atrás `CRM_VISITS_LOOKBACK_DAYS` (7) para que una asistencia marcada
 * tarde llegue como `completed`, nunca antes de `INGEST_SINCE`; hacia adelante
 * `CRM_VISITS_LOOKAHEAD_DAYS` (60), que es la próxima cita que el CRM le muestra
 * a la dueña. El CRM recalcula el win-back y sincroniza Stampee al recibirlo.
 *
 * Dos lecturas a EA en total (citas del rango con clienta y servicio, y el
 * catálogo si alguna cita tiene adicionales), no una por día.
 */

export type CrmVisitsResult =
  | { state: "apagado"; reason: string }
  | { state: "hecho"; sent: number; from: string; till: string; summary: unknown }
  | { state: "fallo"; message: string };

const DEFAULT_LOOKBACK_DAYS = 7;
const DEFAULT_LOOKAHEAD_DAYS = 60;
/** El CRM recalcula el win-back de todas y llama a Stampee: no es instantáneo. */
const TIMEOUT_MS = 120_000;

export async function pushCrmVisits(input: {
  db: Db;
  ea: Pick<EaClient, "raw">;
  config: IngestConfig | null;
  now?: Date;
  lookbackDays?: number;
  lookaheadDays?: number;
  fetch?: typeof fetch;
}): Promise<CrmVisitsResult> {
  const { config } = input;
  if (config === null) return { state: "apagado", reason: "falta INGEST_URL" };
  if (!config.since) return { state: "apagado", reason: "falta INGEST_SINCE" };
  if (!config.visitsUrl) {
    return { state: "apagado", reason: "sin INGEST_VISITS_URL (y INGEST_URL no termina en /payments)" };
  }

  const today = instantToEaDate(input.now ?? new Date());
  const { from, till, window } = crmVisitsRange({
    today,
    since: config.since,
    lookbackDays: input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
    lookaheadDays: input.lookaheadDays ?? DEFAULT_LOOKAHEAD_DAYS,
  });

  const rows = await withPlannedServiceNames(
    input.ea,
    await listAppointmentsInRange(input.ea, { from, till, with: ["customer", "service"] }),
    input.db,
  );

  const start = eaLocalToInstant(parseEaLocalDateTime(`${from} 00:00:00`), EA_TIME_ZONE);
  const end = eaLocalToInstant(parseEaLocalDateTime(`${till} 00:00:00`), EA_TIME_ZONE);
  const financeRows = await repositories(input.db).appointmentFinance.listByStartRange(
    start,
    new Date(end.getTime() + 24 * 60 * 60 * 1000),
  );
  const finances = new Map<number, CrmFinance>(
    financeRows.map((row) => [
      row.ea_appointment_id,
      {
        closed: row.closed_at !== null,
        priceList: row.service_price_snapshot,
        amountCharged: row.amount_charged,
      },
    ]),
  );

  const visits = buildCrmVisits(rows, finances);
  const doFetch = input.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await doFetch(config.visitsUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        [INGEST_AUTH_HEADER]: config.secret,
      },
      body: JSON.stringify({ visits, window }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    return {
      state: "fallo",
      message: `No se pudo alcanzar el CRM: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    return {
      state: "fallo",
      message: `El CRM respondió ${response.status}: ${safeBody(text, config.secret)}`,
    };
  }

  let summary: unknown = null;
  try {
    summary = (JSON.parse(text) as { summary?: unknown }).summary ?? null;
  } catch {
    // Un 2xx sin JSON igual es un push que entró.
  }
  return { state: "hecho", sent: visits.length, from, till, summary };
}

/** Una línea para el log y para `job_run.summary`. */
export function summarizeCrmVisits(result: CrmVisitsResult): string {
  switch (result.state) {
    case "apagado":
      return `visitas al CRM: apagado (${result.reason})`;
    case "fallo":
      return `visitas al CRM: falló — ${result.message}`.slice(0, 500);
    case "hecho":
      return `visitas al CRM ${result.from}→${result.till}: ${result.sent} enviadas · ${JSON.stringify(result.summary)}`.slice(0, 500);
  }
}

/** Deja constancia en `job_run` para Diagnóstico. Mejor esfuerzo. */
export async function recordCrmVisits(db: Db, startedAt: Date, result: CrmVisitsResult): Promise<void> {
  if (result.state === "apagado") return;
  try {
    await repositories(db).jobRuns.record({
      job: JOB_CRM_VISITS,
      startedAt,
      finishedAt: new Date(),
      ok: result.state === "hecho",
      summary: summarizeCrmVisits(result),
    });
  } catch (error) {
    console.error("[crm-visitas] no se pudo registrar la corrida en job_run", error);
  }
}
