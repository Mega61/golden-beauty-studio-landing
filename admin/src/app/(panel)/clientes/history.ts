/**
 * La historia unificada de una clienta: EA + `legacy_appointment`.
 *
 * El corte con Agenda Pro parte la historia en dos mitades que viven en bases
 * distintas y con formas distintas. La ficha no puede mostrar dos listas: si
 * "¿cuándo vino la última vez?" se contesta mirando dos pantallas, nadie la
 * contesta. Este módulo une las dos mitades en una sola línea de tiempo.
 *
 * Es puro y no toca la red ni la base. Recibe las dos mitades ya leídas y
 * devuelve la línea de tiempo más un resumen. Las consultas están en `data.ts`.
 *
 * ## La costura de zona horaria, que es la parte delicada
 *
 * EA transporta **hora de pared** (`EaLocalDateTime`, una cadena sin zona) y
 * `legacy_appointment.started_at` es un `DATETIME` que mysql2 devuelve como
 * `Date`. Esos dos no se pueden comparar sin decidir una zona, y elegirla mal
 * es el bug de cinco horas que este proyecto lleva persiguiendo desde el
 * principio.
 *
 * La conversión correcta no es "a Bogotá": es **la inversa exacta de lo que
 * hizo el driver**. mysql2 arma el `Date` interpretando el `DATETIME` en la
 * zona del proceso, así que leerlo de vuelta con los getters locales devuelve
 * la misma hora de pared que hay guardada, corra el proceso en Bogotá (la VM) o
 * en UTC (CI). Usar `Intl` con `America/Bogota` fijo daría un resultado
 * distinto en los dos entornos, que es justo lo que no se quiere.
 */

import type { Appointment, EaLocalDateTime } from "@/lib/ea";
import { compareEaLocal, parseEaLocalDateTime } from "@/lib/ea";
import type { LegacyAppointment } from "@/db/types";

import { eaStatusToken } from "./ea-status";

/** De qué mitad de la historia salió este renglón. */
export type HistorySource = "ea" | "legacy";

/**
 * Cómo terminó la cita, reducido a lo que la ficha necesita saber.
 *
 * `desconocido` existe para no mentir: el `status` de EA es texto libre y un
 * export viejo trae lo que traiga.
 */
export type HistoryOutcome = "atendida" | "cancelada" | "no-asistio" | "desconocido";

export type HistoryEntry = {
  /** Estable dentro de la ficha: `ea-4821` o `legacy-AP-99182`. */
  id: string;
  source: HistorySource;
  /** Hora de pared. La única forma comparable entre las dos mitades. */
  start: EaLocalDateTime;
  /** Lo que se prestó, con el nombre que tenga en cada mitad. */
  serviceName: string;
  providerName: string | null;
  /** El `status` tal cual lo guarda su origen. Se muestra sin traducir. */
  rawStatus: string | null;
  outcome: HistoryOutcome;
  /**
   * Lo que se cobró, en pesos. `null` significa **no se sabe**, no cero: una
   * cita de EA sin cuenta cerrada todavía no tiene monto, y pintarla en cero
   * bajaría el total gastado de la clienta sin que nadie lo note.
   */
  amountCharged: number | null;
};

export type HistorySummary = {
  /** Renglones en total, de las dos mitades. */
  entries: number;
  /** Cuántas veces se sentó en la silla. Es la que la dueña llama "visitas". */
  visits: number;
  cancellations: number;
  noShows: number;
  /** Suma de lo cobrado en las visitas con monto conocido. */
  totalSpent: number;
  /**
   * `true` si alguna visita no tenía monto. La ficha escribe "$X o más" en vez
   * de "$X": un total que se presenta como exacto y no lo es se convierte en
   * una decisión mal tomada.
   */
  totalIsPartial: boolean;
  firstVisit: EaLocalDateTime | null;
  lastVisit: EaLocalDateTime | null;
};

export type UnifiedHistory = {
  /** De la más reciente a la más vieja: es el orden en que se pregunta. */
  entries: HistoryEntry[];
  summary: HistorySummary;
};

/**
 * Lo que hay que saber de una cita de EA para ponerla en la línea de tiempo.
 *
 * Se pide resuelto en vez de pedir la `Appointment` cruda porque los nombres de
 * servicio y técnica salen de otros recursos, y resolverlos acá obligaría a
 * este módulo a hablar con la red.
 */
export type EaHistoryInput = {
  appointment: Appointment;
  serviceName: string | null;
  providerName: string | null;
  /** `appointment_finance.amount_charged`, o `null` si la cuenta no se cerró. */
  amountCharged: number | null;
};

/**
 * `Date` de mysql2 → hora de pared, sin pasar por ninguna zona.
 *
 * Ver la cabecera: los getters locales son la inversa exacta de cómo el driver
 * armó el `Date`, y por eso esto da lo mismo bajo `TZ=UTC` y bajo
 * `TZ=America/Bogota`.
 */
export function legacyStartToWallClock(value: Date): EaLocalDateTime {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return parseEaLocalDateTime(
    `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
      `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`,
  );
}

/**
 * El desenlace de una cita de EA.
 *
 * Solo `completada` cuenta como atendida. Una cita `confirmada` de la semana que
 * viene todavía no es una visita, y contarla inflaría el historial de la
 * clienta con algo que no pasó.
 */
function eaOutcome(rawStatus: string): HistoryOutcome {
  const token = eaStatusToken(rawStatus);
  if (token === "completada") return "atendida";
  if (token === "cancelada") return "cancelada";
  if (token === "no-asistio") return "no-asistio";
  return "desconocido";
}

/**
 * El desenlace de una fila del histórico de Agenda Pro.
 *
 * Distinto del de EA a propósito: **una fila sin estado reconocible cuenta como
 * atendida.** El export lista citas que ya pasaron, y las que se cayeron traen
 * su estado escrito. Tratar el silencio como "desconocido" dejaría a una
 * clienta de años con cero visitas el día del corte, que es exactamente lo que
 * `legacy_appointment` existe para evitar.
 */
function legacyOutcome(rawStatus: string | null): HistoryOutcome {
  const token = eaStatusToken(rawStatus);
  if (token === "cancelada") return "cancelada";
  if (token === "no-asistio") return "no-asistio";
  return "atendida";
}

/**
 * Une las dos mitades y arma el resumen.
 *
 * Ordena de la más reciente a la más vieja comparando **cadenas de hora de
 * pared**, que es una comparación lexicográfica exacta para el formato
 * `YYYY-MM-DD HH:mm:ss` y no depende de ninguna zona. El desempate es por `id`,
 * para que dos citas a la misma hora no bailen entre renders.
 */
export function buildUnifiedHistory(
  ea: readonly EaHistoryInput[],
  legacy: readonly LegacyAppointment[],
): UnifiedHistory {
  const entries: HistoryEntry[] = [];

  for (const row of ea) {
    const rawStatus = row.appointment.status;
    entries.push({
      id: `ea-${row.appointment.id}`,
      source: "ea",
      start: row.appointment.start,
      serviceName: row.serviceName?.trim() || "Servicio sin nombre",
      providerName: row.providerName?.trim() || null,
      rawStatus,
      outcome: eaOutcome(rawStatus),
      amountCharged: row.amountCharged,
    });
  }

  for (const row of legacy) {
    entries.push({
      id: `legacy-${row.source_id}`,
      source: "legacy",
      start: legacyStartToWallClock(row.started_at),
      serviceName: row.service_name.trim() || "Servicio sin nombre",
      providerName: row.provider_name?.trim() || null,
      rawStatus: row.status,
      outcome: legacyOutcome(row.status),
      amountCharged: row.amount_charged,
    });
  }

  entries.sort((a, b) => {
    const byTime = compareEaLocal(b.start, a.start);
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });

  return { entries, summary: summarize(entries) };
}

function summarize(entries: readonly HistoryEntry[]): HistorySummary {
  let visits = 0;
  let cancellations = 0;
  let noShows = 0;
  let totalSpent = 0;
  let totalIsPartial = false;
  let firstVisit: EaLocalDateTime | null = null;
  let lastVisit: EaLocalDateTime | null = null;

  for (const entry of entries) {
    if (entry.outcome === "cancelada") cancellations += 1;
    if (entry.outcome === "no-asistio") noShows += 1;
    if (entry.outcome !== "atendida") continue;

    visits += 1;
    if (entry.amountCharged === null) {
      totalIsPartial = true;
    } else {
      totalSpent += entry.amountCharged;
    }

    if (lastVisit === null || compareEaLocal(entry.start, lastVisit) > 0) {
      lastVisit = entry.start;
    }
    if (firstVisit === null || compareEaLocal(entry.start, firstVisit) < 0) {
      firstVisit = entry.start;
    }
  }

  return {
    entries: entries.length,
    visits,
    cancellations,
    noShows,
    totalSpent,
    totalIsPartial,
    firstVisit,
    lastVisit,
  };
}
