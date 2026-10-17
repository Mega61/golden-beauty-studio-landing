/**
 * Asistencia: ¿la clienta llegó o no?
 *
 * La dueña lo pidió con todas las letras: la inasistencia es una métrica
 * esencial. Hasta acá el panel no la podía medir, y no por falta de reporte
 * —`noShowReport` existía— sino porque **nadie marcaba nada**: "No asistió"
 * solo se alcanzaba abriendo el formulario de edición, y cerrar la cuenta no le
 * escribía nada a EA, así que una cita atendida y cobrada se quedaba
 * `Reservada` para siempre. Con eso toda clienta parecía nueva y la tasa se
 * dividía por citas que nadie sabía cómo terminaron.
 *
 * Este módulo es la regla, pura y testeada. Las escrituras viven en
 * `app/(panel)/hoy/attendance-actions.ts` (los botones), `hoy/attendance.ts`
 * (al cerrar la cuenta) y `jobs/attendance-backfill.ts` (lo de antes).
 *
 * ## Qué significa "Llegó"
 *
 * **"Llegó" escribe `Completada` en EA en el momento.** Se consideró que solo
 * abriera la cuenta y que `Completada` lo escribiera el cierre, y se descartó
 * por dos razones:
 *
 * 1. En la agenda no hay cuenta que abrir. Un botón que en Hoy hace una cosa y
 *    en la agenda otra —o nada— es un botón en el que nadie confía.
 * 2. La asistencia tiene que quedar registrada **cuando se sabe**, no cuando
 *    alguien se acuerda de cerrar la cuenta. Una cuenta que se cierra a las 9
 *    de la noche, o al día siguiente, no puede dejar la métrica coja mientras.
 *
 * `Completada` es el único estado de la lista que dice "vino" (no hay un "en
 * curso", y agregarlo es reconfigurar `appointment_status_options`, que
 * `jobs/status-options.ts` explica por qué no se toca a la ligera). En Hoy,
 * además, "Llegó" abre la hoja de la cuenta si todavía no hay una: es lo que la
 * técnica iba a hacer después.
 *
 * Cerrar la cuenta **también** escribe `Completada` (si hacía falta): una
 * cuenta cerrada es la prueba más fuerte de que la clienta estuvo en la silla,
 * así que el cierre corrige incluso un "No asistió" tocado por error.
 *
 * ## Solo el estado, nunca otra cosa
 *
 * `PUT /appointments/{id}` con `{ status }` y nada más. `api_decode()` de EA
 * parte de la fila guardada y solo pisa las claves presentes (verificado en
 * `Appointments_model::api_decode()`, 1.6.0), así que no se pierde ni la hora
 * ni el servicio ni las notas. Ver `encodeTable()` en `lib/ea/mapping.ts`.
 */

import { mapEaStatus } from "@/components/calendar/status-map";
import type { StatusToken } from "@/components/ui/status";
import { addMinutes, isEaLocalDateTime } from "@/lib/ea/datetime";

/** Las cadenas que se escriben en EA. Son las de `jobs/status-options.ts`. */
export const EA_STATUS = {
  reservada: "Reservada",
  completada: "Completada",
  noAsistio: "No asistió",
} as const;

/**
 * Cuántos minutos antes de la hora se puede marcar.
 *
 * Antes de eso no hay nada que saber: una clienta no "no asistió" a una cita
 * de las 4 a las 11 de la mañana. Quince minutos cubren a la que llega
 * temprano y la técnica la quiere marcar al sentarla.
 */
export const ATTENDANCE_LEAD_MINUTES = 15;

/**
 * ¿Ya se puede marcar esta cita? Comparación de hora de pared, sin zonas.
 *
 * Recibe cadenas y no el tipo marcado porque las pantallas las traen así
 * (`TodayAppointment.start`); una que no parsea no abre la ventana.
 */
export function attendanceWindowOpen(
  start: string,
  now: string,
  leadMinutes: number = ATTENDANCE_LEAD_MINUTES,
): boolean {
  if (!isEaLocalDateTime(start)) return false;
  return addMinutes(start, -leadMinutes) <= now;
}

// ── Lo que se dibuja ────────────────────────────────────────────────────────

export type AttendanceView =
  /** Botones "Llegó" y "No asistió". */
  | { kind: "marcar" }
  /** Todavía no es la hora: no hay botones, para no invitar a adivinar. */
  | { kind: "temprano" }
  /**
   * Ya está marcada. `undoable`: se ofrece "Deshacer". Una cita con la cuenta
   * cerrada nunca se deshace: la cuenta es la prueba de que vino.
   */
  | { kind: "marcada"; mark: "llego" | "no-asistio"; undoable: boolean }
  /** Cancelada o con un estado que el panel no reconoce: nada que marcar. */
  | { kind: "nada" };

export function attendanceView(input: {
  status: string | null | undefined;
  /** `null` = la pantalla no sabe (la agenda no lee la plata). */
  closed: boolean | null;
  windowOpen: boolean;
}): AttendanceView {
  const token = mapEaStatus(input.status);

  if (token === "cancelada") return { kind: "nada" };
  if (input.closed === true) return { kind: "marcada", mark: "llego", undoable: false };
  if (token === "completada") return { kind: "marcada", mark: "llego", undoable: true };
  if (token === "no-asistio") return { kind: "marcada", mark: "no-asistio", undoable: true };
  if (token === "reservada" || token === "confirmada") {
    return input.windowOpen ? { kind: "marcar" } : { kind: "temprano" };
  }
  return { kind: "nada" };
}

// ── Lo que se escribe ───────────────────────────────────────────────────────

export type AttendanceMark = "llego" | "no-asistio" | "deshacer";

export type AttendancePlan =
  /** `status: null` = ya estaba así; no hay nada que escribir. */
  | { ok: true; status: string | null }
  | { ok: false; message: string };

/**
 * La transición pedida, validada **en el servidor** contra el estado fresco de
 * EA y la cuenta.
 *
 * La pantalla ya esconde lo que no aplica; esto existe porque la acción se
 * puede invocar sin la pantalla, y porque entre que se dibujó el botón y se
 * tocó pudo cambiar todo: otra persona marcó, o cerró la cuenta.
 */
export function planAttendanceWrite(input: {
  mark: AttendanceMark;
  currentStatus: string | null | undefined;
  closed: boolean;
  windowOpen: boolean;
  /**
   * Para "Deshacer": el estado que tenía antes del toque, tal como lo vio la
   * pantalla. Solo se acepta si es una reserva (Reservada, Confirmada,
   * Reprogramada…); cualquier otra cosa vuelve a `Reservada`.
   */
  restoreTo?: string | null;
}): AttendancePlan {
  const token = mapEaStatus(input.currentStatus);

  if (token === "cancelada") {
    return { ok: false, message: "La cita está cancelada. No hay asistencia que marcar." };
  }
  if (token === "desconocido") {
    return {
      ok: false,
      message: "La cita tiene un estado que el panel no reconoce. Corrígelo desde Editar.",
    };
  }

  switch (input.mark) {
    case "llego": {
      if (token === "completada") return { ok: true, status: null };
      if (!input.windowOpen) return { ok: false, message: "Todavía no es la hora de la cita." };
      return { ok: true, status: EA_STATUS.completada };
    }
    case "no-asistio": {
      if (input.closed) {
        return { ok: false, message: "Esta cita ya tiene la cuenta cerrada: la clienta sí vino." };
      }
      if (token === "no-asistio") return { ok: true, status: null };
      if (!input.windowOpen) return { ok: false, message: "Todavía no es la hora de la cita." };
      return { ok: true, status: EA_STATUS.noAsistio };
    }
    case "deshacer": {
      if (token !== "completada" && token !== "no-asistio") return { ok: true, status: null };
      if (input.closed) {
        return { ok: false, message: "Con la cuenta cerrada, la asistencia no se deshace." };
      }
      return { ok: true, status: restoreStatus(input.restoreTo) };
    }
  }
}

/** A qué vuelve un "Deshacer". Solo a una reserva; si no, a `Reservada`. */
export function restoreStatus(previous: string | null | undefined): string {
  const token = mapEaStatus(previous);
  return (token === "reservada" || token === "confirmada") && previous
    ? previous.trim()
    : EA_STATUS.reservada;
}

/**
 * Qué escribirle a EA al cerrar la cuenta. `null` = nada.
 *
 * Desde una reserva o un "No asistió" pasa a `Completada`: la cuenta cerrada
 * gana, porque es la prueba más fuerte que existe. Una cancelada o un estado
 * desconocido no se tocan — no es este camino el que tiene que adivinar qué
 * pasó ahí — y lo que ya está `Completada` no se reescribe: cada `PUT` a EA
 * dispara el sync con Google y, si la clienta tiene correo, un aviso.
 */
export function statusAfterClose(currentStatus: string | null | undefined): string | null {
  const token = mapEaStatus(currentStatus);
  return token === "reservada" || token === "confirmada" || token === "no-asistio"
    ? EA_STATUS.completada
    : null;
}

// ── Lo que se cuenta ────────────────────────────────────────────────────────

/**
 * Cómo terminó una cita, para medir.
 *
 * - `asistio`: `Completada`, **o con la cuenta cerrada** aunque EA no lo diga
 *   (las cuentas cerradas antes de esta función nunca marcaron nada).
 * - `no-asistio`: marcada así y sin cuenta.
 * - `sin-marcar`: ya empezó, sigue reservada y no tiene cuenta. **No entra al
 *   denominador**: no sabemos si vino, y contarla de cualquier lado inventa la
 *   tasa. Se cuenta aparte para que se vea cuánto falta marcar.
 * - `pendiente`: todavía no es la hora.
 */
export type AttendanceOutcome =
  | "asistio"
  | "no-asistio"
  | "cancelada"
  | "sin-marcar"
  | "pendiente"
  | "desconocido";

export function attendanceOutcome(
  token: StatusToken,
  options: { closed: boolean; started: boolean },
): AttendanceOutcome {
  if (token === "cancelada") return "cancelada";
  if (options.closed || token === "completada") return "asistio";
  if (token === "no-asistio") return "no-asistio";
  if (token === "reservada" || token === "confirmada") {
    return options.started ? "sin-marcar" : "pendiente";
  }
  return "desconocido";
}

/** Tasa de inasistencia: no asistió ÷ (asistió + no asistió). `null` sin datos. */
export function noShowRate(noShows: number, attended: number): number | null {
  const marked = noShows + attended;
  return marked === 0 ? null : noShows / marked;
}

/**
 * Las citas que ya terminaron y nadie marcó. Alimenta el aviso de Hoy.
 *
 * "Terminó" y no "empezó": a mitad de servicio no hay nada pendiente, y un
 * aviso que aparece mientras la clienta sigue en la silla enseña a ignorarlo.
 */
export function unmarkedAppointments<
  T extends { end: string; status: string | null; closed: boolean },
>(rows: readonly T[], now: string): T[] {
  return rows.filter(
    (row) =>
      row.end <= now &&
      attendanceOutcome(mapEaStatus(row.status), { closed: row.closed, started: true }) ===
        "sin-marcar",
  );
}
