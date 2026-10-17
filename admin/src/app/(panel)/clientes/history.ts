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
import type { LegacyAppointment, PaymentMethod } from "@/db/types";

import { attendanceOutcome, noShowRate } from "@/lib/attendance";

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
  /**
   * Lo que se prestó, con el nombre que tenga en cada mitad. En EA es el
   * servicio **realizado** cuando la cuenta se cerró, y el agendado si no: lo
   * agendado no es lo realizado, y "¿qué se hizo la última vez?" pregunta por
   * lo segundo.
   */
  serviceName: string;
  /**
   * El id de EA de ese mismo servicio (realizado, o agendado sin cuenta).
   * `null` en el historial de Agenda Pro, que solo trae el nombre en texto.
   * Lo usa la sugerencia del formulario de cita para no tener que adivinar por
   * nombre lo que EA ya sabe.
   */
  serviceId: number | null;
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
  /**
   * Cómo se pagó, si se sabe. Hoy solo lo trae el historial de Agenda Pro
   * (`legacy_payment`, enlazado por el importador de pagos); vacío = no se
   * sabe, nunca "no se pagó". Varios = pago dividido, en el orden del panel.
   */
  paymentMethods: PaymentMethod[];
  /**
   * Cortesía (sin cobro a la clienta): la dueña, su hermana, Juan. El estudio
   * recibió $0 y la técnica sí cobró su comisión. Es visita, pero su monto no
   * entra a "total gastado".
   */
  courtesy: boolean;
};

/**
 * Un pago del historial de Agenda Pro enlazado a una de sus citas. Solo lo que
 * la ficha necesita: a qué cita va y con qué se pagó.
 */
export type LegacyPaymentLink = {
  legacyAppointmentId: number;
  method: PaymentMethod;
  courtesy: boolean;
};

const METHOD_ORDER: readonly PaymentMethod[] = ["efectivo", "transferencia", "otro"];

export type HistorySummary = {
  /** Renglones en total, de las dos mitades. */
  entries: number;
  /** Cuántas veces se sentó en la silla. Es la que la dueña llama "visitas". */
  visits: number;
  cancellations: number;
  noShows: number;
  /**
   * `noShows ÷ (visitas + noShows)`: de las citas que tenía que cumplir, a
   * cuántas faltó. Las canceladas y las que nadie marcó no entran. `null` sin
   * ninguna.
   */
  noShowRate: number | null;
  /** Suma de lo cobrado en las visitas con monto conocido, sin cortesías. */
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
  /** El nombre del servicio realizado si lo hay; si no, el del agendado. */
  serviceName: string | null;
  /**
   * `appointment_finance.performed_service_id`: lo que se hizo de verdad al
   * cerrar la cuenta. Ausente o `null` = no hay cuenta, vale lo agendado.
   */
  performedServiceId?: number | null;
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
 * Atendida es `completada` **o con la cuenta cerrada** (`amountCharged` no
 * nulo, cortesías incluidas: cobran cero, no `null`). Hasta el 2026-10-16
 * cerrar la cuenta no marcaba nada en EA, y sin esto esas visitas salían como
 * "desconocido". La regla es la de la inasistencia de Reportes,
 * `attendanceOutcome()`, para que la ficha y el reporte no discutan.
 *
 * Una cita `confirmada` de la semana que viene todavía no es una visita, y
 * contarla inflaría el historial de la clienta con algo que no pasó.
 */
function eaOutcome(rawStatus: string, amountCharged: number | null): HistoryOutcome {
  const outcome = attendanceOutcome(eaStatusToken(rawStatus), {
    closed: amountCharged !== null,
    started: true,
  });
  if (outcome === "asistio") return "atendida";
  if (outcome === "cancelada") return "cancelada";
  if (outcome === "no-asistio") return "no-asistio";
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
  legacyPayments: readonly LegacyPaymentLink[] = [],
): UnifiedHistory {
  const entries: HistoryEntry[] = [];

  // Métodos por cita heredada. Un pago dividido deja dos; se muestran los dos
  // en un orden fijo, para que la misma cita no cambie de texto entre renders.
  const methodsByAppointment = new Map<number, Set<PaymentMethod>>();
  const courtesyAppointments = new Set<number>();
  for (const payment of legacyPayments) {
    if (payment.courtesy) {
      // En una cortesía no hubo medio de pago: el que diga Agenda Pro es un
      // registro, no plata. Se muestra "Cortesía" en su lugar.
      courtesyAppointments.add(payment.legacyAppointmentId);
      continue;
    }
    const set = methodsByAppointment.get(payment.legacyAppointmentId) ?? new Set<PaymentMethod>();
    set.add(payment.method);
    methodsByAppointment.set(payment.legacyAppointmentId, set);
  }

  for (const row of ea) {
    const rawStatus = row.appointment.status;
    entries.push({
      id: `ea-${row.appointment.id}`,
      source: "ea",
      start: row.appointment.start,
      serviceName: row.serviceName?.trim() || "Servicio sin nombre",
      serviceId: row.performedServiceId ?? row.appointment.serviceId ?? null,
      providerName: row.providerName?.trim() || null,
      rawStatus,
      outcome: eaOutcome(rawStatus, row.amountCharged),
      amountCharged: row.amountCharged,
      paymentMethods: [],
      courtesy: false,
    });
  }

  for (const row of legacy) {
    const methods = methodsByAppointment.get(row.id);
    entries.push({
      id: `legacy-${row.source_id}`,
      source: "legacy",
      start: legacyStartToWallClock(row.started_at),
      serviceName: row.service_name.trim() || "Servicio sin nombre",
      serviceId: null,
      providerName: row.provider_name?.trim() || null,
      rawStatus: row.status,
      outcome: legacyOutcome(row.status),
      amountCharged: row.amount_charged,
      paymentMethods: methods === undefined ? [] : METHOD_ORDER.filter((method) => methods.has(method)),
      courtesy: courtesyAppointments.has(row.id),
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
    // Una cortesía es visita, pero no plata que la clienta gastó: ni suma ni
    // vuelve parcial el total.
    if (!entry.courtesy) {
      if (entry.amountCharged === null) totalIsPartial = true;
      else totalSpent += entry.amountCharged;
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
    noShowRate: noShowRate(noShows, visits),
    totalSpent,
    totalIsPartial,
    firstVisit,
    lastVisit,
  };
}

/**
 * ¿La clienta llegó alguna vez antes de `asOf`? Lo contrario es **primera
 * visita**, la que lleva el 10% (`lib/promos.ts`).
 *
 * Cuenta como visita lo atendido, igual que `summarize()`, **más** una cita de
 * EA con la cuenta cerrada (`amountCharged !== null`) aunque su estado no diga
 * Completada: hasta el 2026-10-16 cerrar la cuenta no marcaba la cita en EA, y
 * esas clientas sí estuvieron en la silla. Una inasistencia o una cancelación
 * no cuentan: quien reservó y no llegó sigue siendo nueva.
 *
 * Solo decide un sí/no. Ningún monto del historial de Agenda Pro sale de acá
 * hacia la cuenta, que es lo que protege `legacy-history.money-paths.test.ts`.
 */
export function hasVisitedBefore(entries: readonly HistoryEntry[], asOf: EaLocalDateTime): boolean {
  return entries.some((entry) => entry.start < asOf && countsAsVisit(entry));
}

/**
 * ¿Este renglón es una vez que la clienta se sentó en la silla? El criterio de
 * `hasVisitedBefore()`, suelto para que "su última visita" del formulario de
 * cita cuente igual que el 10% de primera visita: si uno dice "nueva" y el otro
 * muestra una visita, alguien deja de creerle a los dos.
 */
export function countsAsVisit(entry: HistoryEntry): boolean {
  return (
    entry.outcome === "atendida" ||
    (entry.source === "ea" && entry.amountCharged !== null && entry.outcome === "desconocido")
  );
}
