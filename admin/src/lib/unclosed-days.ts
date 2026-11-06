/**
 * Los días con plata cobrada que no llegaron a un cierre de caja —puro,
 * testeado—.
 *
 * ## Por qué existe
 *
 * Cerrar la cuenta de una clienta no manda nada: el push a ingest va **por
 * cierre de caja** (`jobs/day-close.ts`). Un día con cuentas cerradas y sin
 * "Cerrar el día" deja esa plata en el panel: no llega al CRM ni a Actual
 * Budget, y el bot de finanzas se queda esperando la venta para enlazar la
 * transferencia del banco. (Los sellos de Stampee no: esos salen de la cuenta
 * cerrada, no del cierre del día.) Pasó del 27 al 31 de octubre de 2026: ocho cuentas
 * cobradas, ningún cierre, y nadie se enteró hasta que se buscó.
 *
 * Así que el panel lo dice: en Hoy, y con un aviso al celular cada noche
 * (`jobs/unclosed-days.ts`) mientras quede alguno.
 *
 * ## Dos casos, la misma plata quieta
 *
 * - **sin cierre**: el día tiene cuentas cerradas y no tiene fila en
 *   `day_close`. Se arregla cerrando el día en Caja.
 * - **por fuera**: el día sí se cerró, pero una cuenta se cerró después y nadie
 *   la agregó al cierre. Se arregla desde Caja con "Agregar al cierre".
 *
 * Hoy no cuenta: el día todavía no termina y cerrarlo es lo que se hace al
 * final de la jornada. Lo anterior al corte de Agenda Pro (`INGEST_SINCE`)
 * tampoco: esa plata entró a Actual por el scraper y no se empuja nunca.
 */

import { formatCOP } from "@/components/ui/format";
import { instantToEaDate, isEaLocalDate, type EaLocalDate } from "@/lib/ea";
import { relativeDayLabel, type PushPayload } from "@/lib/push/payload";

/** Hasta dónde se mira sin `INGEST_SINCE`. Un día perdido hace dos meses ya no es un aviso. */
export const UNCLOSED_FALLBACK_DAYS = 60;

export type ClosedAccountRow = {
  appointment_start_at: Date | null;
  amount_charged: number | null;
  tip: number;
};

export type UnclosedDay = {
  date: EaLocalDate;
  kind: "sin-cierre" | "por-fuera";
  /** Cuentas cerradas que no están en ningún cierre. */
  accounts: number;
  /** Lo cobrado en esas cuentas, con propina. Una cortesía suma cero. */
  total: number;
};

/** Un día de calendario antes o después. Sin husos: es una fecha. */
export function shiftEaDate(date: EaLocalDate, days: number): EaLocalDate {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10) as EaLocalDate;
}

/**
 * El primer día que se mira: el corte de Agenda Pro si está, y si no, los
 * últimos {@link UNCLOSED_FALLBACK_DAYS} días.
 */
export function unclosedDaysFrom(
  env: Record<string, string | undefined>,
  today: EaLocalDate,
): EaLocalDate {
  const since = env.INGEST_SINCE?.trim();
  return isEaLocalDate(since) ? since : shiftEaDate(today, -UNCLOSED_FALLBACK_DAYS);
}

/**
 * Agrupa por día las cuentas cerradas fuera de cierre, del más viejo al más
 * nuevo. `closedDates` son las fechas que sí tienen fila en `day_close`.
 */
export function findUnclosedDays(input: {
  accounts: readonly ClosedAccountRow[];
  closedDates: ReadonlySet<string>;
  from: EaLocalDate;
  today: EaLocalDate;
}): UnclosedDay[] {
  const byDate = new Map<EaLocalDate, UnclosedDay>();
  for (const account of input.accounts) {
    if (account.appointment_start_at === null) continue;
    const date = instantToEaDate(account.appointment_start_at);
    if (date < input.from || date >= input.today) continue;
    const day = byDate.get(date) ?? {
      date,
      kind: input.closedDates.has(date) ? "por-fuera" : "sin-cierre",
      accounts: 0,
      total: 0,
    };
    day.accounts += 1;
    day.total += (account.amount_charged ?? 0) + account.tip;
    byDate.set(date, day);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Cuánta plata hay quieta en total. */
export function unclosedTotal(days: readonly UnclosedDay[]): number {
  return days.reduce((sum, day) => sum + day.total, 0);
}

/**
 * El aviso de la noche, o `null` si no hay nada que avisar.
 *
 * Lleva plata y fechas, nunca nombres: es una pantalla de bloqueo. El enlace
 * abre Caja en el día más viejo, que es por donde hay que empezar. El `tag` es
 * fijo para que el aviso de hoy reemplace al de ayer en vez de apilarse.
 */
export function buildUnclosedDaysPayload(
  days: readonly UnclosedDay[],
  today: EaLocalDate,
  basePath: string,
): PushPayload | null {
  if (days.length === 0) return null;
  const sinCierre = days.filter((day) => day.kind === "sin-cierre");
  const title =
    sinCierre.length === 0
      ? "Hay cuentas por fuera del cierre de caja"
      : sinCierre.length === 1
        ? "Hay un día de caja sin cerrar"
        : `Hay ${sinCierre.length} días de caja sin cerrar`;
  const labels = days.map((day) => relativeDayLabel(day.date, today)).join(", ");
  return {
    title,
    body:
      `${labels} · ${formatCOP(unclosedTotal(days))} sin llegar a Actual.\n` +
      "Se arregla en Caja: ahí la plata sale para Actual y el bot de finanzas la enlaza.",
    url: `${basePath.replace(/\/+$/, "")}/caja?fecha=${days[0].date}`,
    tag: "caja-sin-cerrar",
  };
}

/** Una línea para el log y para `job_run.summary`. */
export function summarizeUnclosedDays(days: readonly UnclosedDay[]): string {
  if (days.length === 0) return "días sin cerrar: ninguno";
  return (
    `días sin cerrar: ${days
      .map((day) => `${day.date} (${day.accounts}${day.kind === "por-fuera" ? ", por fuera" : ""})`)
      .join(", ")} · ${formatCOP(unclosedTotal(days))}`
  );
}
