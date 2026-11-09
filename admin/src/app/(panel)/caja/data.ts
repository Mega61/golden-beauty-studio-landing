import "server-only";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { DayClose } from "@/db/types";
import { instantToEaDate, isEaLocalDate, type EaLocalDate } from "@/lib/ea";
import {
  createEaClient,
  listAppointmentsInRange,
  listDayAppointments,
  type EaClient,
} from "@/lib/ea/client";
import {
  createIngestClient,
  ingestConfigFromEnv,
  type PaymentLabel,
  type PaymentLabels,
} from "@/lib/ingest-client";
import type { DayRangeSource } from "@/jobs/pending-charges";
import {
  loadReview,
  type DayAccount,
  type DayAppointment,
  type DayAppointmentSource,
  type DayCloseDeps,
  type DayReview,
} from "@/jobs/day-close";

/**
 * Los datos de **Caja**.
 *
 * La pantalla es el día completo: cuentas cobradas, lo que quedó sin cobrar,
 * totales por método para cuadrar el cajón y qué ya llegó a Actual. No hay
 * cierre del día (desde 2026-11-09): lo cobrado sale solo cada noche. Toda la
 * lógica —los pendientes, los totales— vive en
 * `jobs/day-close.ts`; acá se arma el cruce entre las dos fuentes que no se
 * pueden unir con un JOIN (las citas están en `easyappointments` y se leen por
 * su API; la plata está en `gbs_admin` y se lee con otro usuario de MySQL) y se
 * construyen las dependencias que el cierre necesita.
 *
 * ## Nada de plata se calcula acá
 *
 * Ni un `+`. Los totales salen de `summarizeDayTotals()` a través de
 * `loadReview()`, y el lote de ingest lo arma `lib/ingest-payload.ts`. Este
 * archivo lee filas y las pasa.
 */

/**
 * Las citas de un día, reducidas a lo que la compuerta del cierre necesita.
 *
 * El recorrido —el acceso crudo para poder leer las relaciones en snake_case,
 * la paginación que **se agota o lanza**— es `listDayAppointments()` de
 * `lib/ea/client.ts`, compartido con la pantalla Hoy. Vivía duplicado en las
 * dos pantallas mientras ninguna era dueña de ese archivo; acá quedó solo la
 * parte propia de Caja, que es qué relaciones se piden y a qué forma se
 * reducen. Que la paginación no pueda mentir importa especialmente en esta
 * pantalla: un día al que le falta una cita se ve igual que uno completo, y eso
 * significaría cerrar el día sin una cuenta que sí existía.
 *
 * El cliente es opcional y se crea **dentro** de la función, no al construirla:
 * `createEaClient()` lanza si falta `EA_API_URL`, y ese throw tiene que caer
 * donde `loadReview()` lo atrapa —dejando la pantalla en solo lectura con el
 * motivo escrito— y no al armar las dependencias, donde reventaría la página.
 */
export function loadDayAppointments(client?: EaClient): DayAppointmentSource {
  return async (date: EaLocalDate) => {
    const ea = client ?? createEaClient();

    // Sin `service`: esta pantalla no dibuja el nombre del servicio agendado, y
    // pedirlo sería una consulta más por cita en EA para tirar el dato.
    const citas = await listDayAppointments(ea, {
      date,
      with: ["provider", "customer"],
    });

    return citas.map(({ appointment, provider, customer }): DayAppointment => ({
      eaAppointmentId: appointment.id,
      status: appointment.status,
      start: appointment.start,
      end: appointment.end,
      customerName: personName(customer, "Sin cliente"),
      providerName: personName(provider, "Sin asignar"),
    }));
  };
}

/**
 * Las citas de un rango de días, en una sola lectura a EA.
 *
 * Para el aviso de citas sin cobrar y la compuerta de comisiones, que miran
 * una semana o una quincena: pedirlas día por día serían quince viajes contra
 * un cupo de 100 peticiones cada 120 s para todo el panel.
 */
export function loadRangeAppointments(client?: EaClient): DayRangeSource {
  return async (from: EaLocalDate, till: EaLocalDate) => {
    const ea = client ?? createEaClient();
    const citas = await listAppointmentsInRange(ea, {
      from,
      till,
      with: ["provider", "customer"],
    });
    return citas.map(({ appointment, provider, customer }): DayAppointment => ({
      eaAppointmentId: appointment.id,
      status: appointment.status,
      start: appointment.start,
      end: appointment.end,
      customerName: personName(customer, "Sin cliente"),
      providerName: personName(provider, "Sin asignar"),
    }));
  };
}

/**
 * Las notas de cada movimiento en Actual: quién pagó y qué servicio se hizo.
 *
 * Antes las ponía el reporte de ventas de Agenda Pro. Dos lecturas a EA por
 * cierre (las citas del día con la clienta, y el catálogo), no una por cita. El
 * servicio es el **realizado** (`performed_service_id`), no el agendado. Si algo
 * falla, `runPush()` manda el lote sin nombres: no son plata.
 */
export function labelDayPayments(client?: EaClient) {
  return async (date: EaLocalDate, accounts: readonly DayAccount[]): Promise<PaymentLabels> => {
    const ea = client ?? createEaClient();
    const [citas, services] = await Promise.all([
      listDayAppointments(ea, { date, with: ["customer", "service"] }),
      ea.services.list(),
    ]);
    const serviceName = new Map(services.map((service) => [service.id, service.name]));
    const byId = new Map(citas.map((cita) => [cita.appointment.id, cita]));

    const labels = new Map<number, PaymentLabel>();
    for (const account of accounts) {
      const cita = byId.get(account.eaAppointmentId);
      const performed =
        account.performedServiceId === null ? null : serviceName.get(account.performedServiceId);
      labels.set(account.eaAppointmentId, {
        clientName: cita === undefined ? null : personName(cita.customer, "") || null,
        serviceName: performed ?? cita?.service?.name ?? null,
      });
    }
    return labels;
  };
}

function personName(
  person: { firstName: string | null; lastName: string | null } | null,
  fallback: string,
): string {
  if (person === null) return fallback;
  const name = [person.firstName, person.lastName].filter(Boolean).join(" ").trim();
  return name === "" ? fallback : name;
}

/**
 * Las dependencias de la sincronización.
 *
 * Es el único lugar del panel web que decide si el envío está encendido:
 * `ingestConfigFromEnv()` devuelve `null` cuando falta `INGEST_URL`, y ese
 * `null` viaja hasta `syncDay()`, que deja las cuentas listas y reporta
 * `apagado`.
 */
export function dayCloseDeps(): DayCloseDeps {
  const config = ingestConfigFromEnv();
  return {
    db: getDb(),
    loadAppointments: loadDayAppointments(),
    ingest: config === null ? null : createIngestClient(config),
    labelPayments: labelDayPayments(),
  };
}

/** El día del **estudio**, no el del proceso. */
export function todayInStudio(now: Date = new Date()): EaLocalDate {
  return instantToEaDate(now);
}

/**
 * La fecha de la pantalla.
 *
 * Se acepta `?fecha=YYYY-MM-DD` para poder mirar —y sincronizar— un día
 * anterior. Cualquier cosa que no sea una fecha real cae en hoy: un
 * parámetro roto no puede dejar la pantalla en blanco.
 */
export function parseFecha(raw: string | undefined, today: EaLocalDate): EaLocalDate {
  return isEaLocalDate(raw) ? raw : today;
}

export type CajaView = {
  date: EaLocalDate;
  today: EaLocalDate;
  review: DayReview;
  /** `null` = todavía no se sincronizó nada de este día. */
  dayClose: DayClose | null;
  /**
   * Cuentas cobradas del día que todavía no llegaron a Actual: salen en la
   * sincronización de esta noche, o con "Sincronizar ahora".
   */
  unsynced: DayAccount[];
  /** Días anteriores cuyo envío al CRM falló. Se reintentan solos cada noche. */
  pendingPush: DayClose[];
  /** Si el envío está configurado. Lo dice la pantalla en vez de mentir. */
  pushEnabled: boolean;
  /** `INGEST_SINCE`: los días anteriores no se envían nunca. */
  cutover?: string | null;
};

/**
 * Todo lo que Caja dibuja.
 *
 * `loadReview()` no lanza si EA no responde: devuelve la revisión con el motivo
 * escrito. La pantalla sigue siendo útil sin la agenda —la plata está en
 * `gbs_admin`—; lo que no se puede saber es qué citas quedaron sin cobrar.
 */
export async function loadCajaView(
  fecha: string | undefined,
  now: Date = new Date(),
): Promise<CajaView> {
  const today = todayInStudio(now);
  const date = parseFecha(fecha, today);

  const db = getDb();
  const repos = repositories(db);

  // El cliente de ingest no se crea acá: la pantalla no envía nada. Lo único
  // que necesita saber es si está configurado.
  const config = ingestConfigFromEnv();
  const pushEnabled = config !== null;

  const [review, dayClose, pendingPush] = await Promise.all([
    loadReview({ db, loadAppointments: loadDayAppointments() }, date, now),
    repos.dayCloses.findByDate(date),
    repos.dayCloses.listPendingPush(config?.since),
  ]);

  return {
    date,
    today,
    review,
    dayClose: dayClose ?? null,
    unsynced: unsyncedOf(review),
    pendingPush: pendingPush.filter((row) => row.close_date !== date && row.close_date < today),
    pushEnabled,
    cutover: config?.since ?? null,
  };
}

/** Las cuentas cobradas que todavía no viajaron. Una cortesía no viaja nunca. */
export function unsyncedOf(review: DayReview): DayAccount[] {
  return review.closed.filter(
    (account) => account.houseCourtesy !== true && account.pushedToIngestAt === null,
  );
}
