/**
 * D2 — disponibilidad pública: qué horas puede ver una clienta en la landing.
 *
 * ## Por qué no alcanza con `GET /availabilities` de EA
 *
 * EA responde por **profesional**: `availabilities?providerId&serviceId&date`
 * devuelve una lista plana de `"HH:MM"`. Dos cosas faltan ahí, y las dos
 * importan:
 *
 * 1. **"Cualquiera" no existe en su API.** Hay que abanicar una llamada por
 *    técnica habilitada y unir los resultados. Quien llama hace el abanico
 *    (es E/S); este módulo recibe lo que volvió.
 * 2. **EA no sabe contar puestos.** El estudio tiene **dos estaciones**, y
 *    `attendantsNumber` es capacidad por servicio, no por local. EA puede decir
 *    que Lina y Daniela están libres a las 10 y que una tercera técnica también
 *    — pero solo hay dos sillas. Ofrecer esa hora es vender una silla que no
 *    existe, que es el peor error posible de esta pantalla.
 *
 * ## La invariante que sostiene todo
 *
 * **La landing nunca ofrece una hora que `checkConflicts` rechazaría.** Por eso
 * este módulo no reimplementa ninguna regla: arma el candidato y se lo pasa al
 * mismo motor de B3 que usa la agenda al guardar. Si las dos cosas divergieran,
 * la clienta reservaría y el panel le rebotaría la cita — o peor, la aceptaría
 * encimada. Una sola fuente de verdad, ejercitada desde los dos lados.
 *
 * Y se exige `ok`, no `!hard`: un motivo `soft` alcanza para que la recepción
 * confirme "guardar de todas formas" a sabiendas, pero nunca para ofrecérselo
 * en frío a una clienta que no puede evaluarlo.
 *
 * Módulo **puro**: sin red, sin `db/`, sin `server-only`. Se testea en una
 * línea y puede correr donde sea.
 */

import {
  addMinutes,
  minutesBetween,
  parseEaLocalDateTime,
  type EaLocalDate,
  type EaLocalDateTime,
} from "./ea/datetime";
import {
  checkConflicts,
  DEFAULT_FREE_STATUSES,
  type ServiceCapacity,
  type StationSlot,
} from "./conflict";
import type { GridProvider } from "./calendar-layout";
import type { Appointment, BlockedPeriod, Unavailability } from "./ea/types";

/** Lo que EA contestó para una técnica: sus horas libres, en `"HH:MM"`. */
export type ProviderOffer = {
  providerId: number;
  /** Tal cual `GET /availabilities`. Se asume hora local del estudio. */
  hours: readonly string[];
  /** Plan semanal y excepciones de esa técnica, para el motor de B3. */
  plan?: Pick<GridProvider, "workingPlan" | "workingPlanExceptions"> | null;
};

export type PublicAvailabilityInput = {
  date: EaLocalDate;
  /** El servicio que la clienta eligió. Un combo es un servicio más. */
  service: ServiceCapacity & { durationMin: number };
  /** Una entrada por técnica habilitada para ese servicio. */
  offers: readonly ProviderOffer[];
  /**
   * **Todas** las citas del día, de todas las técnicas — no solo las de quien
   * se está evaluando. Sin las de las demás, la cuenta de puestos da de más.
   */
  appointments?: readonly Appointment[];
  unavailabilities?: readonly Unavailability[];
  blockedPeriods?: readonly BlockedPeriod[];
  services?: readonly ServiceCapacity[];
  /** Los puestos del estudio. Ver la nota de `ConflictInput.stations`. */
  stations: readonly StationSlot[];
  freeStatuses?: readonly string[];
};

/** Una hora que la clienta sí puede elegir. */
export type PublicSlot = {
  /** `"HH:MM"`, hora local del estudio. */
  time: string;
  start: EaLocalDateTime;
  end: EaLocalDateTime;
  /**
   * Quiénes pueden tomarla. Nunca vacío.
   *
   * Viaja al navegador para que "cualquiera" no tenga que volver a preguntar,
   * y para que elegir una técnica concreta filtre sin otra vuelta al servidor.
   */
  providerIds: readonly number[];
};

/** Une `YYYY-MM-DD` con `"HH:MM"`. Pasa por el parser, que además valida. */
function at(date: EaLocalDate, time: string): EaLocalDateTime {
  return parseEaLocalDateTime(`${date} ${time}:00`);
}

/** `"9:5"` y `"09:05:00"` son la misma hora. Normaliza a `"HH:MM"`. */
function normalizeHour(raw: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * Cruza lo que EA ofreció contra la ocupación real del estudio.
 *
 * El resultado viene ordenado por hora, sin repetidos, y cada hora sabe qué
 * técnicas pueden atenderla.
 */
export function publicSlots(input: PublicAvailabilityInput): PublicSlot[] {
  const { date, service, offers, stations } = input;

  // Una duración que no avanza produciría un tramo vacío que choca con nada y
  // se ofrecería siempre. Es un dato imposible, no un caso borde.
  if (!Number.isFinite(service.durationMin) || service.durationMin <= 0) return [];

  const capacities: ServiceCapacity[] = [
    ...(input.services ?? []),
    // La del servicio pedido, si quien llamó no la incluyó en el catálogo.
    ...(input.services?.some((s) => s.id === service.id) ? [] : [service]),
  ];

  /** hora → técnicas que pueden tomarla. */
  const byTime = new Map<string, number[]>();

  for (const offer of offers) {
    for (const raw of offer.hours) {
      const time = normalizeHour(raw);
      if (time === null) continue;

      const start = at(date, time);
      const end = addMinutes(start, service.durationMin);

      const report = checkConflicts({
        candidate: {
          providerId: offer.providerId,
          serviceId: service.id,
          start,
          end,
        },
        appointments: input.appointments,
        unavailabilities: input.unavailabilities,
        blockedPeriods: input.blockedPeriods,
        provider: offer.plan ?? null,
        services: capacities,
        stations,
        freeStatuses: input.freeStatuses ?? DEFAULT_FREE_STATUSES,
      });

      // `ok`, no `!hard`: ver la nota del encabezado.
      if (!report.ok) continue;

      const already = byTime.get(time);
      if (already) already.push(offer.providerId);
      else byTime.set(time, [offer.providerId]);
    }
  }

  return [...byTime.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([time, providerIds]) => {
      const start = at(date, time);
      return {
        time,
        start,
        end: addMinutes(start, service.durationMin),
        // Orden estable: el mismo abanico tiene que dar la misma respuesta.
        providerIds: [...new Set(providerIds)].sort((x, y) => x - y),
      };
    });
}

/**
 * A quién se le asigna una reserva de "cualquiera".
 *
 * **La de menor carga ese día**, contando minutos ya agendados y no citas: una
 * técnica con un montaje de 150 minutos está más ocupada que otra con dos
 * semipermanentes de 45. Los empates se rompen por el id más bajo, para que la
 * elección sea determinista y un test pueda afirmarla.
 *
 * La clienta nunca se entera de que "cualquiera" era una decisión nuestra: la
 * confirmación le dice el nombre.
 */
export function pickProvider(
  candidates: readonly number[],
  appointments: readonly Appointment[],
  freeStatuses: readonly string[] = DEFAULT_FREE_STATUSES,
): number | null {
  if (candidates.length === 0) return null;

  const free = new Set(freeStatuses.map((s) => s.toLowerCase()));
  const load = new Map<number, number>(candidates.map((id) => [id, 0]));

  for (const appointment of appointments) {
    const providerId = appointment.providerId;
    if (providerId === null || !load.has(providerId)) continue;
    // Una cancelada no ocupó a nadie: contarla haría que la técnica a la que
    // más le cancelan reciba menos trabajo.
    if (free.has(normalizeForLoad(appointment.status))) continue;
    load.set(providerId, (load.get(providerId) ?? 0) + minutesOf(appointment));
  }

  return [...load.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0][0];
}

/** Mismo normalizado que `conflict.ts`: sin tildes, sin mayúsculas, con guiones. */
function normalizeForLoad(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** Minutos que ocupa una cita. `minutesBetween` ya sabe de la zona del estudio. */
function minutesOf(appointment: Appointment): number {
  const minutes = minutesBetween(appointment.start, appointment.end);
  return minutes > 0 ? minutes : 0;
}
