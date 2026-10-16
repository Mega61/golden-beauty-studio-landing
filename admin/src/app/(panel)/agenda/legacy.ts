/**
 * El historial de Agenda Pro en la grilla de la agenda: de solo lectura.
 *
 * ## Por qué
 *
 * La historia de antes del corte (mayo → octubre de 2026) vive en
 * `gbs_admin.legacy_appointment`, no en EA: rellenar el calendario de EA con
 * meses de citas pasadas habría ensuciado la agenda de trabajo y disparado
 * notificaciones. Pero una agenda vacía para los días pasados se lee como "no se
 * migró nada". Así que la grilla las **dibuja** —atenuadas y con la etiqueta
 * "Agenda Pro"— sin que existan en EA.
 *
 * ## Cómo entran sin poder editarse
 *
 * Se convierten en `Appointment` **sintéticas con id negativo** solo para que
 * `buildDayGrid()` les reparta carril y recorte igual que a cualquier cita: dos
 * citas encimadas se ven las dos, una de Agenda Pro y una de EA también. El id
 * negativo es la marca: ningún id de EA es negativo, `ResourceGrid` dibuja esos
 * bloques sin arrastre ni "Editar", y `saveAppointment()` rechaza cualquier id
 * que no sea positivo por si algo se escapara. Nunca entran a `data.appointments`:
 * se mezclan solo en la entrada de la grilla, así que ni el formulario, ni los
 * avisos de estados desconocidos, ni nada que escriba las ve.
 *
 * Todo lo de acá es puro; la lectura de la base está en `data.ts`.
 */

import type { AppointmentMeta, HistoryIndex } from "@/components/calendar/types";
import type { GridProvider } from "@/lib/calendar-layout";
import { addMinutes, eaDatePart, type EaLocalDate, type EaLocalDateTime } from "@/lib/ea/datetime";
import type { Appointment } from "@/lib/ea/types";
import {
  isShadowedByEa,
  legacyDurationMinutes,
  legacyReportKind,
  matchLegacyProvider,
  type LegacyReportKind,
} from "@/lib/legacy-history";

/**
 * La columna de las profesionales que ya no están en EA (Kati). Negativa, igual
 * que los ids de las citas heredadas: ninguna profesional de EA la tiene.
 */
export const LEGACY_LANE_ID = -1;
export const LEGACY_LANE_NAME = "Historial Agenda Pro";

/** Una fila de `legacy_appointment`, ya en hora de pared. */
export type LegacyAgendaRow = {
  id: number;
  sourceId: string;
  start: EaLocalDateTime;
  clientName: string | null;
  phone: string | null;
  serviceName: string;
  providerName: string | null;
  status: string | null;
};

/** Lo que cruza al navegador por cada cita heredada. Sin plata: la agenda no la muestra. */
export type LegacyAgendaItem = {
  /** Negativo. Ver la cabecera. */
  id: number;
  sourceId: string;
  start: EaLocalDateTime;
  end: EaLocalDateTime;
  /** `false` = no había servicio de EA con ese nombre y se dibujó de una hora. */
  durationDerived: boolean;
  /** La profesional actual que le corresponde, o `null` = carril de historial. */
  providerId: number | null;
  /** Como venía de Agenda Pro. */
  providerName: string | null;
  clientName: string | null;
  phone: string | null;
  serviceName: string;
  /** El texto de Agenda Pro, sin traducir ("Asiste", "No Asiste"…). */
  status: string | null;
  kind: LegacyReportKind;
};

export type LegacyContext = {
  providers: readonly { id: number; firstName: string | null }[];
  services: readonly { name: string; duration: number | null }[];
  /** Las citas de EA del mismo rango, para no mostrar dos veces la misma. */
  ea: readonly { start: string; phone: string | null; customerName: string | null }[];
  /** La técnica solo ve su columna; el carril de historial tampoco le llega. */
  ownProviderId: number | null;
  dates: readonly EaLocalDate[];
};

/** El id sintético de una fila. Siempre negativo, nunca cero. */
export function legacyAgendaId(rowId: number): number {
  return -Math.abs(rowId) - 1;
}

export function isLegacyAgendaId(id: number): boolean {
  return id < 0;
}

export const LEGACY_READ_ONLY = "Las citas del historial de Agenda Pro son de solo lectura.";

/**
 * ¿Esta escritura apunta a algo de EA?
 *
 * Lo llaman las Server Actions de la agenda antes de tocar la API: un id de
 * cita negativo, o la columna del carril de historial, son de Agenda Pro y no
 * existen en EA. La grilla ya no ofrece esos gestos; esto es la red.
 */
export function isWritableAgendaTarget(id: number | undefined, providerId: number): boolean {
  if (id !== undefined && !(Number.isInteger(id) && id > 0)) return false;
  return !(providerId < 0);
}

/**
 * Filas de la base → bloques de la agenda.
 *
 * Descarta, en este orden: lo que no cae en los días pedidos, lo que ya existe
 * como cita de EA (las reservas futuras que se recrearon a mano el día del
 * corte), y —para una técnica— todo lo que no es de su columna.
 */
export function buildLegacyAgendaItems(
  rows: readonly LegacyAgendaRow[],
  context: LegacyContext,
): LegacyAgendaItem[] {
  const days = new Set<string>(context.dates);
  const items: LegacyAgendaItem[] = [];

  for (const row of rows) {
    if (!days.has(eaDatePart(row.start))) continue;
    if (
      isShadowedByEa(
        { start: row.start, phone: row.phone, clientName: row.clientName },
        context.ea,
      )
    ) {
      continue;
    }

    const providerId = matchLegacyProvider(row.providerName, context.providers);
    if (context.ownProviderId !== null && providerId !== context.ownProviderId) continue;

    // Agenda Pro no exportó la hora de fin. La duración sale del servicio de EA
    // con el mismo nombre, o una hora si no lo hay: ver `legacyDurationMinutes`.
    const duration = legacyDurationMinutes(row.serviceName, context.services);

    items.push({
      id: legacyAgendaId(row.id),
      sourceId: row.sourceId,
      start: row.start,
      end: addMinutes(row.start, duration.minutes),
      durationDerived: duration.derived,
      providerId,
      providerName: row.providerName,
      clientName: row.clientName,
      phone: row.phone,
      serviceName: row.serviceName,
      status: row.status,
      kind: legacyReportKind(row.status),
    });
  }

  return items;
}

/**
 * Lo que la grilla de **un** día necesita además de lo de EA.
 *
 * El carril "Historial Agenda Pro" se agrega solo si ese día hay alguna cita
 * sin profesional actual: una columna vacía en cada día de la semana sería
 * ruido permanente para contar algo que pasó una vez.
 */
export function legacyLayerForDay(
  items: readonly LegacyAgendaItem[],
  providers: readonly GridProvider[],
  date: EaLocalDate,
): { providers: GridProvider[]; appointments: Appointment[] } {
  const own = items.filter((item) => eaDatePart(item.start) === date);
  const known = new Set(providers.map((provider) => provider.id));
  const needsLane = own.some((item) => item.providerId === null || !known.has(item.providerId));

  return {
    providers: needsLane
      ? [
          ...providers,
          // Sin plan de trabajo: la columna sale entera en gris y la grilla no
          // ofrece huecos ahí (ver `ResourceGrid`). Es historia, no agenda.
          { id: LEGACY_LANE_ID, name: LEGACY_LANE_NAME, workingPlan: null },
        ]
      : [...providers],
    appointments: own.map((item) => toSyntheticAppointment(item, known)),
  };
}

function toSyntheticAppointment(item: LegacyAgendaItem, known: ReadonlySet<number>): Appointment {
  return {
    id: item.id,
    bookedAt: null,
    start: item.start,
    end: item.end,
    hash: null,
    location: null,
    meetingLink: null,
    color: null,
    status: item.status ?? "",
    notes: null,
    customerId: null,
    providerId:
      item.providerId !== null && known.has(item.providerId) ? item.providerId : LEGACY_LANE_ID,
    serviceId: null,
    googleCalendarId: null,
    caldavCalendarId: null,
  };
}

/** Nombre y servicio por id sintético, con la misma forma que las citas de EA. */
export function legacyMeta(items: readonly LegacyAgendaItem[]): Record<number, AppointmentMeta> {
  const meta: Record<number, AppointmentMeta> = {};
  for (const item of items) {
    meta[item.id] = {
      customer: item.clientName,
      service: item.serviceName,
      serviceColor: null,
      phone: item.phone,
    };
  }
  return meta;
}

export function legacyIndex(
  items: readonly LegacyAgendaItem[],
): Readonly<Record<number, LegacyAgendaItem>> {
  const index: Record<number, LegacyAgendaItem> = {};
  for (const item of items) index[item.id] = item;
  return index;
}

/** Lo que la grilla necesita para rotular cada bloque de historial. */
export function legacyHistoryIndex(items: readonly LegacyAgendaItem[]): HistoryIndex {
  const index: Record<number, HistoryIndex[number]> = {};
  for (const item of items) {
    index[item.id] = {
      source: "Agenda Pro",
      statusLabel: LEGACY_KIND_LABEL[item.kind],
      statusToken: LEGACY_KIND_TOKEN[item.kind],
    };
  }
  return index;
}

/** La etiqueta del estado, en la voz del panel pero sin esconder el texto original. */
export const LEGACY_KIND_LABEL: Record<LegacyReportKind, string> = {
  atendida: "Atendida",
  "no-asistio": "No asistió",
  cancelada: "Cancelada",
  reservada: "Reservada",
};

/** El color del punto: el mismo token de estado que usan las citas de EA. */
const LEGACY_KIND_TOKEN: Record<LegacyReportKind, HistoryIndex[number]["statusToken"]> = {
  atendida: "completada",
  "no-asistio": "no-asistio",
  cancelada: "cancelada",
  reservada: "reservada",
};
