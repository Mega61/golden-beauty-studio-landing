import type { EaLocalDateTime } from "@/lib/ea/datetime";
import {
  suggestService,
  type ServiceSuggestion,
  type SuggestionCatalog,
} from "@/lib/service-suggestion";

import {
  countsAsVisit,
  hasVisitedBefore,
  type HistoryEntry,
  type HistoryOutcome,
} from "../clientes/history";

/**
 * Lo que el formulario de cita muestra de una clienta en cuanto se la elige:
 * qué se hizo las últimas veces, si es nueva, si suele faltar, y qué agendarle.
 *
 * Existe porque la dueña lo pidió el primer día del sistema nuevo: "cuando estoy
 * agendando necesito ver cuál fue el último servicio". Sobre todo para los
 * retoques — la clienta dice "vengo a retocarme" y quien agenda tiene que saber
 * de qué. Antes eso era abrir la ficha en otra pestaña con la clienta al
 * teléfono.
 *
 * Es puro: recibe el historial unificado (EA ∪ Agenda Pro) ya leído y el
 * catálogo vigente. La lectura está en `client-context-data.ts`. **No lleva
 * plata**: ni montos ni medios de pago salen de acá hacia el navegador. El
 * formulario de cita no los necesita y la técnica que agenda no tiene por qué
 * verlos.
 */

/** Cuántas citas pasadas se muestran. Tres caben en el celular sin desplazar. */
export const RECENT_LENGTH = 3;

export type ClientContextRow = {
  id: string;
  start: EaLocalDateTime;
  /** Lo que se hizo (el realizado, si se cerró la cuenta). */
  serviceName: string;
  providerName: string | null;
  outcome: HistoryOutcome;
};

export type ClientContext = {
  /** Las últimas citas resueltas, de la más reciente a la más vieja. */
  recent: ClientContextRow[];
  noShows: number;
  cancellations: number;
  /**
   * Nunca se sentó en la silla antes de hoy. Con `partial` no vale: quien lo
   * muestre como "clienta nueva" estaría ofreciendo un 10% sin saber.
   */
  isFirstVisit: boolean;
  suggestion: ServiceSuggestion | null;
  /** Falta la mitad de EA del historial (EA no respondió). */
  partial: boolean;
  /**
   * El "ahora" con el que se armó, en hora de pared de Bogotá. La tarjeta lo
   * usa para decidir si una fecha lleva año, sin leer el reloj del celular.
   */
  asOf: EaLocalDateTime | null;
};

export const EMPTY_CLIENT_CONTEXT: ClientContext = {
  recent: [],
  noShows: 0,
  cancellations: 0,
  isFirstVisit: false,
  suggestion: null,
  partial: true,
  asOf: null,
};

export type BuildClientContextOptions = {
  /** Hora de pared de "ahora". Lo que empieza después no es historia. */
  asOf: EaLocalDateTime;
  /**
   * La cita que se está editando, si hay. No es historia de sí misma: sin
   * esto, editar la cita de hoy ya cerrada diría "última visita: hoy".
   */
  excludeAppointmentId?: number | null;
  partial: boolean;
  catalog: SuggestionCatalog;
};

/**
 * Arma el contexto. `entries` viene como lo deja `buildUnifiedHistory()`: de
 * la más reciente a la más vieja.
 */
export function buildClientContext(
  entries: readonly HistoryEntry[],
  options: BuildClientContextOptions,
): ClientContext {
  const skip = options.excludeAppointmentId == null ? null : `ea-${options.excludeAppointmentId}`;
  const past = entries.filter((entry) => entry.id !== skip && entry.start < options.asOf);

  // Lo que se muestra es lo que terminó de alguna forma que se sabe: atendida,
  // cancelada o inasistencia. Una cita pasada de EA que nadie cerró ni marcó no
  // dice nada, y ponerla de "última visita" sería inventar que vino.
  const resolved = past.filter(
    (entry) => countsAsVisit(entry) || entry.outcome === "cancelada" || entry.outcome === "no-asistio",
  );

  const visits = past.filter(countsAsVisit);

  return {
    recent: resolved.slice(0, RECENT_LENGTH).map((entry) => ({
      id: entry.id,
      start: entry.start,
      serviceName: entry.serviceName,
      providerName: entry.providerName,
      // Una cita de EA con la cuenta cerrada pero sin marcar en EA sí vino
      // (ver `hasVisitedBefore()`): se muestra como atendida.
      outcome: countsAsVisit(entry) ? "atendida" : entry.outcome,
    })),
    noShows: past.filter((entry) => entry.outcome === "no-asistio").length,
    cancellations: past.filter((entry) => entry.outcome === "cancelada").length,
    isFirstVisit: !hasVisitedBefore(past, options.asOf),
    suggestion: suggestService(
      visits.map((entry) => ({ serviceName: entry.serviceName, serviceId: entry.serviceId })),
      options.catalog,
    ),
    partial: options.partial,
    asOf: options.asOf,
  };
}
