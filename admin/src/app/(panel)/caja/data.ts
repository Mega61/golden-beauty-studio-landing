import "server-only";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { DayClose } from "@/db/types";
import { instantToEaDate, isEaLocalDate, type EaLocalDate } from "@/lib/ea";
import { createEaClient, listDayAppointments, type EaClient } from "@/lib/ea/client";
import { createIngestClient, ingestConfigFromEnv } from "@/lib/ingest-client";
import {
  loadReview,
  type DayAppointment,
  type DayAppointmentSource,
  type DayCloseDeps,
  type DayReview,
} from "@/jobs/day-close";

/**
 * Los datos de **Caja**.
 *
 * La pantalla es el día completo: cuentas cerradas, pendientes, totales por
 * método y el botón de cerrar. Toda la lógica —la compuerta, los totales— vive en
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
      customerName: personName(customer, "Sin clienta"),
      providerName: personName(provider, "Sin asignar"),
    }));
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
 * Las dependencias del cierre diario.
 *
 * Es el único lugar del paquete que decide si el push está encendido, y lo hace
 * en una línea: `ingestConfigFromEnv()` devuelve `null` cuando falta
 * `INGEST_URL`, y ese `null` viaja hasta `closeDay()`, que cierra el día igual y
 * reporta `apagado`. Cerrar la caja no depende de una integración cuyo contrato
 * todavía no está verificado contra el CRM.
 */
export function dayCloseDeps(): DayCloseDeps {
  const config = ingestConfigFromEnv();
  return {
    db: getDb(),
    loadAppointments: loadDayAppointments(),
    ingest: config === null ? null : createIngestClient(config),
  };
}

/** El día del **estudio**, no el del proceso. */
export function todayInStudio(now: Date = new Date()): EaLocalDate {
  return instantToEaDate(now);
}

/**
 * La fecha de la pantalla.
 *
 * Se acepta `?fecha=YYYY-MM-DD` para poder mirar —y reintentar el push de— un
 * día anterior. Cualquier cosa que no sea una fecha real cae en hoy: un
 * parámetro roto no puede dejar la pantalla en blanco.
 */
export function parseFecha(raw: string | undefined, today: EaLocalDate): EaLocalDate {
  return isEaLocalDate(raw) ? raw : today;
}

export type CajaView = {
  date: EaLocalDate;
  today: EaLocalDate;
  review: DayReview;
  /** `null` = el día todavía no se cerró. */
  dayClose: DayClose | null;
  /** Cierres anteriores que quedaron sin llegar a ingest. */
  pendingPush: DayClose[];
  /** Si el push está configurado. Lo dice la pantalla en vez de mentir. */
  pushEnabled: boolean;
};

/**
 * Todo lo que Caja dibuja.
 *
 * `loadReview()` no lanza si EA no responde: devuelve la revisión con el
 * bloqueo puesto y el motivo escrito. Es lo que el plan pide para este caso —
 * solo lectura con banda de aviso, no una pantalla de error: `gbs_admin` sigue
 * arriba y las cuentas del día se pueden ver igual.
 */
export async function loadCajaView(
  fecha: string | undefined,
  now: Date = new Date(),
): Promise<CajaView> {
  const today = todayInStudio(now);
  const date = parseFecha(fecha, today);

  const db = getDb();
  const repos = repositories(db);

  // El cliente de ingest no se crea acá: la pantalla no empuja nada. Lo único
  // que necesita saber es si está configurado, para no ofrecer "Reintentar" en
  // un panel donde el push está apagado a propósito.
  const pushEnabled = ingestConfigFromEnv() !== null;

  const [review, dayClose, pendingPush] = await Promise.all([
    loadReview({ db, loadAppointments: loadDayAppointments() }, date, now),
    repos.dayCloses.findByDate(date),
    repos.dayCloses.listPendingPush(),
  ]);

  return {
    date,
    today,
    review,
    dayClose: dayClose ?? null,
    pendingPush: pendingPush.filter((row) => row.close_date !== date),
    pushEnabled,
  };
}
