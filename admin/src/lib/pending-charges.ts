/**
 * Las citas de días anteriores que quedaron sin cobrar —puro, testeado—.
 *
 * ## Por qué existe
 *
 * Desde 2026-11-09 no hay cierre de caja: lo cobrado viaja solo a Actual cada
 * noche (`jobs/nightly-sync.ts`). Lo único que el sistema no puede hacer solo
 * es cobrar una cita que nadie cobró, o elegir el método de pago que nadie
 * eligió. Eso es lo que este aviso nombra, en Hoy y con un aviso al celular
 * cada noche mientras quede algo.
 *
 * Reemplaza al aviso de "días de caja sin cerrar", que pedía un acto —cerrar el
 * día— que ya no existe.
 *
 * ## Qué cuenta
 *
 * Lo que `reviewDay()` marca como bloqueante, que es lo mismo que antes
 * frenaba el cierre:
 *
 * - **sin cobrar**: la cita ya pasó, no está cancelada ni marcada como
 *   inasistencia, y no tiene cuenta cerrada.
 * - **cuenta incompleta**: la cuenta está cerrada pero le falta el método de
 *   pago (o es una cortesía con plata adentro). La sincronización la salta.
 *
 * Solo la última semana, y nunca antes del corte de Agenda Pro: una cita sin
 * cobrar de hace dos meses ya no es un recordatorio, es un dato para Reportes.
 */

import { isEaLocalDate, type EaLocalDate } from "@/lib/ea";
import { relativeDayLabel, type PushPayload } from "@/lib/push/payload";

/** Hasta dónde mira la sincronización sin `INGEST_SINCE`. */
export const SYNC_FALLBACK_DAYS = 60;

/** Cuántos días hacia atrás mira el aviso de citas sin cobrar. */
export const PENDING_LOOKBACK_DAYS = 7;

/** Un día de calendario antes o después. Sin husos: es una fecha. */
export function shiftEaDate(date: EaLocalDate, days: number): EaLocalDate {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10) as EaLocalDate;
}

/**
 * El primer día que la sincronización mira: el corte de Agenda Pro si está, y
 * si no, los últimos 60 días. Lo anterior al corte entró a Actual por el
 * scraper y no se manda nunca.
 */
export function syncWindowFrom(
  env: Record<string, string | undefined>,
  today: EaLocalDate,
): EaLocalDate {
  const since = env.INGEST_SINCE?.trim();
  return isEaLocalDate(since) ? since : shiftEaDate(today, -SYNC_FALLBACK_DAYS);
}

/**
 * Los días que mira el aviso: la última semana hasta ayer, sin pasar del corte.
 * `null` si no queda ningún día (el corte es hoy o después).
 */
export function pendingWindow(
  env: Record<string, string | undefined>,
  today: EaLocalDate,
): { from: EaLocalDate; till: EaLocalDate } | null {
  const cutoff = syncWindowFrom(env, today);
  const lookback = shiftEaDate(today, -PENDING_LOOKBACK_DAYS);
  const from = cutoff > lookback ? cutoff : lookback;
  const till = shiftEaDate(today, -1);
  return from > till ? null : { from, till };
}

export type PendingCharge = {
  date: EaLocalDate;
  eaAppointmentId: number;
  kind: "sin-cobrar" | "incompleta";
  customerName: string;
  providerName: string;
  /** Qué falta, en palabras de la pantalla. */
  message: string;
};

/** Agrupadas por día, en orden. Para la banda de Hoy y la pantalla de Caja. */
export function groupPendingByDay(
  charges: readonly PendingCharge[],
): { date: EaLocalDate; charges: PendingCharge[] }[] {
  const byDate = new Map<EaLocalDate, PendingCharge[]>();
  for (const charge of charges) {
    const list = byDate.get(charge.date) ?? [];
    list.push(charge);
    byDate.set(charge.date, list);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => ({ date, charges: list }));
}

/** "2 citas sin cobrar y 1 cuenta sin método de pago", o `""` si nada. */
export function describePending(charges: readonly PendingCharge[]): string {
  const sinCobrar = charges.filter((charge) => charge.kind === "sin-cobrar").length;
  const incompletas = charges.length - sinCobrar;
  const parts: string[] = [];
  if (sinCobrar > 0) parts.push(sinCobrar === 1 ? "1 cita sin cobrar" : `${sinCobrar} citas sin cobrar`);
  if (incompletas > 0) {
    parts.push(
      incompletas === 1 ? "1 cuenta con datos por completar" : `${incompletas} cuentas con datos por completar`,
    );
  }
  return parts.join(" y ");
}

/**
 * El aviso de la noche, o `null` si no hay nada.
 *
 * Lleva a Hoy en el día más viejo: ahí es donde se cobra, y una vez cobrada la
 * cita la sincronización de esa misma noche la manda a Actual. No hay que ir a
 * ningún otro lado.
 */
export function buildPendingChargesPayload(
  charges: readonly PendingCharge[],
  today: EaLocalDate,
  basePath: string,
): PushPayload | null {
  if (charges.length === 0) return null;
  const days = groupPendingByDay(charges);
  const names = charges
    .slice(0, 3)
    .map((charge) => charge.customerName)
    .join(", ");
  const more = charges.length > 3 ? ` y ${charges.length - 3} más` : "";
  return {
    title: `Quedan ${describePending(charges)}`,
    body:
      `${days.map((day) => relativeDayLabel(day.date, today)).join(", ")} · ${names}${more}.\n` +
      "Se cobran desde Hoy, en su día. Lo demás ya viaja solo a Actual.",
    url: `${basePath.replace(/\/+$/, "")}/hoy?fecha=${days[0].date}`,
    tag: "caja-sin-cobrar",
  };
}

/** Una línea para el log y para `job_run.summary`. */
export function summarizePendingCharges(charges: readonly PendingCharge[]): string {
  if (charges.length === 0) return "citas sin cobrar: ninguna";
  return `pendientes: ${describePending(charges)} (${groupPendingByDay(charges)
    .map((day) => `${day.date}×${day.charges.length}`)
    .join(", ")})`;
}
