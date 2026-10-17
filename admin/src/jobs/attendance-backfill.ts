import { mapEaStatus } from "@/components/calendar/status-map";
import type { Db } from "@/db";
import { repositories } from "@/db/repositories";
import { statusAfterClose } from "@/lib/attendance";
import type { EaClient } from "@/lib/ea/client";
import {
  eaLocalToInstant,
  parseEaLocalDateTime,
  type EaLocalDate,
} from "@/lib/ea/datetime";
import type { Appointment } from "@/lib/ea/types";

/**
 * Poner `Completada` en EA a las citas que ya tienen la cuenta cerrada.
 *
 * ## Por qué hace falta
 *
 * Hasta el 2026-10-16 cerrar la cuenta no le escribía nada a EA (ver la
 * cabecera de `hoy/actions.ts`), así que toda cita atendida y cobrada quedó
 * `Reservada` o `Confirmada`. La historia de la clienta, "clienta nueva", la
 * retención y la inasistencia leen el estado de EA: con esas filas así, cada
 * clienta parecía nueva y la tasa de inasistencia se dividía por citas que
 * nadie sabía cómo terminaron. Desde esa fecha el cierre marca `Completada`;
 * esto arregla lo de antes, y de noche, lo que el cierre no alcanzó a escribir
 * porque EA no contestó.
 *
 * ## Qué toca y qué no
 *
 * Solo citas con `appointment_finance.closed_at` puesto, y solo si su estado es
 * una reserva o "No asistió" (`statusAfterClose()`, la misma regla del cierre).
 * Una cancelada con cuenta, o un estado que el panel no reconoce, **no se
 * toca**: se lista para que alguien la mire. La escritura es solo el estado.
 *
 * ## El cupo de EA
 *
 * EA corta a 100 peticiones por IP cada 120 s y el panel entero es una IP. Las
 * escrituras van en serie con una pausa entre una y otra (`pauseMs`), y hay un
 * tope por corrida (`maxWrites`): la de la noche corrige pocas, y la corrida a
 * mano de la puesta en marcha se puede repetir hasta que no quede nada.
 *
 * ## Efectos en EA
 *
 * Cada `PUT` sincroniza el evento de Google (el contenido no cambia) y dispara
 * el webhook del panel (que no le hace nada a la plata). Y manda correos: a la
 * clienta con correo, si `customer_notifications` está prendido, "los detalles
 * de tu cita cambiaron" —por una cita que ya pasó—; y a la técnica, si tiene
 * las notificaciones de EA prendidas, uno por cita. El CLI advierte las dos
 * cosas antes de `--aplicar`.
 */

/** Lo único que este job le pide a EA. */
export type AttendanceBackfillEa = Pick<EaClient, "appointments">;

export type BackfillCandidate = {
  id: number;
  /** El estado que tenía, tal cual. */
  from: string;
  start: string;
};

export type AttendanceBackfillPlan = {
  /** Las que hay que pasar a `Completada`, en orden de inicio. */
  toComplete: BackfillCandidate[];
  /** Cerradas que ya decían `Completada`. */
  alreadyCompleted: number;
  /** Cuentas cerradas cuya cita EA ya no tiene (borrada, o fuera del rango). */
  notInEa: number[];
  /** Cerradas con un estado que no se toca: cancelada o desconocido. */
  skipped: { id: number; status: string }[];
};

/** La decisión, pura. */
export function planAttendanceBackfill(
  closedIds: readonly number[],
  appointments: readonly Pick<Appointment, "id" | "status" | "start">[],
): AttendanceBackfillPlan {
  const byId = new Map(appointments.map((appointment) => [appointment.id, appointment]));
  const plan: AttendanceBackfillPlan = {
    toComplete: [],
    alreadyCompleted: 0,
    notInEa: [],
    skipped: [],
  };

  for (const id of [...new Set(closedIds)].sort((a, b) => a - b)) {
    const appointment = byId.get(id);
    if (appointment === undefined) {
      plan.notInEa.push(id);
      continue;
    }
    if (statusAfterClose(appointment.status) !== null) {
      plan.toComplete.push({ id, from: appointment.status, start: appointment.start });
    } else if (mapEaStatus(appointment.status) === "completada") {
      plan.alreadyCompleted += 1;
    } else {
      plan.skipped.push({ id, status: appointment.status });
    }
  }

  plan.toComplete.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id));
  return plan;
}

export type AttendanceBackfillReport = {
  from: EaLocalDate;
  till: EaLocalDate;
  plan: AttendanceBackfillPlan;
  /** `false` = ejecución en seco. */
  applied: boolean;
  written: number[];
  failed: { id: number; message: string }[];
  /** Las que el tope de la corrida dejó para la próxima. */
  deferred: number;
};

export type AttendanceBackfillOptions = {
  db: Db;
  ea: AttendanceBackfillEa;
  /** Días del estudio, inclusivos, por inicio de la cita. */
  from: EaLocalDate;
  till: EaLocalDate;
  apply: boolean;
  /** Tope de escrituras por corrida. */
  maxWrites?: number;
  /** Pausa entre escrituras, por el cupo de EA. */
  pauseMs?: number;
  /** Inyectable para que los tests no esperen. */
  sleep?: (ms: number) => Promise<void>;
  /** Una línea por escritura, para quien mira la consola. */
  log?: (line: string) => void;
};

const DEFAULT_PAUSE_MS = 1_500;
const DEFAULT_MAX_WRITES = 500;

export async function runAttendanceBackfill(
  options: AttendanceBackfillOptions,
): Promise<AttendanceBackfillReport> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = options.log ?? (() => {});
  const pauseMs = options.pauseMs ?? DEFAULT_PAUSE_MS;
  const maxWrites = options.maxWrites ?? DEFAULT_MAX_WRITES;

  // Las cuentas cerradas del rango, por el inicio de la cita. Es `gbs_admin`,
  // que se lee sin costo de cupo.
  const fromInstant = eaLocalToInstant(parseEaLocalDateTime(`${options.from} 00:00:00`));
  const tillInstant = eaLocalToInstant(parseEaLocalDateTime(`${options.till} 23:59:59`));
  const rows = await repositories(options.db).appointmentFinance.listByStartRange(
    fromInstant,
    new Date(tillInstant.getTime() + 1_000),
  );
  const closedIds = rows.filter((row) => row.closed_at !== null).map((row) => row.ea_appointment_id);

  // EA filtra por día de inicio y de **fin** (ver `reconcile.ts`): se pide el
  // rango justo y lo que cruce medianoche, que en este estudio no pasa, caería
  // en `notInEa` y se vería en el resumen en vez de perderse.
  const appointments =
    closedIds.length === 0
      ? []
      : await options.ea.appointments.list({ from: options.from, till: options.till });

  const plan = planAttendanceBackfill(closedIds, appointments);
  const report: AttendanceBackfillReport = {
    from: options.from,
    till: options.till,
    plan,
    applied: options.apply,
    written: [],
    failed: [],
    deferred: 0,
  };

  if (!options.apply) return report;

  const batch = plan.toComplete.slice(0, maxWrites);
  report.deferred = plan.toComplete.length - batch.length;
  const audit = repositories(options.db).auditLog;

  for (const [index, candidate] of batch.entries()) {
    if (index > 0 && pauseMs > 0) await sleep(pauseMs);
    try {
      await options.ea.appointments.update(candidate.id, { status: "Completada" });
      report.written.push(candidate.id);
      log(`  ✓ ${candidate.id} (${candidate.start}): «${candidate.from}» → «Completada»`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.failed.push({ id: candidate.id, message });
      log(`  ✗ ${candidate.id}: ${message}`);
      continue;
    }

    // Misma acción que los botones de Hoy, con actor `null` = el sistema.
    // Mejor esfuerzo: la marca ya está en EA.
    try {
      await audit.append({
        actorUserId: null,
        action: "cita.asistencia",
        entity: "ea_appointment",
        entityId: candidate.id,
        before: { status: candidate.from },
        after: { status: "Completada" },
        reason: "cuenta-cerrada",
        at: new Date(),
      });
    } catch {
      // La bitácora caída no deshace ni frena la corrida.
    }
  }

  return report;
}

/** El resumen, en una línea. Lo imprimen el CLI y el reconcile nocturno. */
export function summarizeAttendanceBackfill(report: AttendanceBackfillReport): string {
  const { plan } = report;
  const head =
    `asistencia ${report.from}→${report.till}: ` +
    `${plan.toComplete.length} por marcar Completada · ${plan.alreadyCompleted} ya estaban · ` +
    `${plan.skipped.length} sin tocar (cancelada o estado desconocido) · ` +
    `${plan.notInEa.length} no están en EA`;
  if (!report.applied) return `${head}. En seco.`;
  return (
    `${head} → ${report.written.length} escritas, ${report.failed.length} con error` +
    (report.deferred > 0 ? `, ${report.deferred} para la próxima corrida.` : ".")
  );
}
