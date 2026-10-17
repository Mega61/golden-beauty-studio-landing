"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import { ForbiddenError, requireOwnProvider } from "@/lib/dal";
import {
  attendanceWindowOpen,
  planAttendanceWrite,
  type AttendanceMark,
} from "@/lib/attendance";
import { createEaClient } from "@/lib/ea/client";
import { instantToEaLocal } from "@/lib/ea/datetime";
import { EaApiError } from "@/lib/ea/errors";

/**
 * **"Llegó" / "No asistió" / "Deshacer"**, desde Hoy y desde la agenda.
 *
 * Es una acción aparte de `setAppointmentStatus()` de la agenda, aunque escriba
 * lo mismo, por una diferencia que importa: aquella confía en el `providerId`
 * que manda el navegador para decidir de quién es la cita. Ésta **lee la cita
 * de EA** y decide con la técnica que EA dice, igual que `cerrarCuenta`. Y
 * valida la transición con el estado fresco (`planAttendanceWrite()`), no con
 * el que tenía la pantalla cuando se dibujó el botón.
 *
 * La escritura es **solo el estado** —`PUT` con `{ status }`—, que EA mezcla
 * sobre la fila guardada sin tocar nada más. Efectos de EA que hay que saber:
 * sincroniza el evento de Google, dispara su webhook (que el panel recibe y no
 * le hace nada a la plata), y manda correos: a la clienta "los detalles de tu
 * cita cambiaron" si tiene correo y `customer_notifications` está prendido, y
 * a la técnica "Se han modificado los detalles de la cita" si tiene las
 * notificaciones de EA prendidas (verificado contra el EA de desarrollo y
 * Mailpit: salen aunque el estado no cambie). Casi ninguna clienta tiene correo
 * (ver § ADMIN-PANEL, EA deduplica por correo), pero por eso "No asistió" pide
 * confirmación en la pantalla y "Llegó" no: marcar asistencia es rutina; acusar
 * una inasistencia por error es lo que no se quiere mandar.
 *
 * Quién puede: la técnica sobre sus propias citas, recepción y la dueña sobre
 * cualquiera (`requireOwnProvider`).
 */

export type AttendanceResult =
  | { status: "ok"; eaStatus: string; previous: string }
  | { status: "error"; message: string };

export async function marcarAsistencia(input: {
  eaAppointmentId: number;
  mark: AttendanceMark;
  /** Para "Deshacer": el estado previo que vio la pantalla. */
  restoreTo?: string | null;
}): Promise<AttendanceResult> {
  const id = input.eaAppointmentId;
  // Los bloques de Agenda Pro viajan con id negativo y son de solo lectura.
  if (!Number.isInteger(id) || id <= 0) {
    return { status: "error", message: "Esa cita no se puede marcar desde el panel." };
  }
  if (input.mark !== "llego" && input.mark !== "no-asistio" && input.mark !== "deshacer") {
    return { status: "error", message: "Acción desconocida." };
  }

  let ea;
  let appointment;
  try {
    ea = createEaClient();
    appointment = await ea.appointments.get(id);
  } catch (error) {
    unstable_rethrow(error);
    console.error("[asistencia] no se pudo leer la cita", error);
    return { status: "error", message: failureMessage(error) };
  }

  let session;
  try {
    session = await requireOwnProvider(appointment.providerId);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { status: "error", message: "Esta cita no es tuya." };
    }
    throw error;
  }

  // ¿Tiene la cuenta cerrada? Es lo que impide acusar de inasistencia a quien
  // pagó. Sin la base no se sabe, y "no sé" solo se tolera para "Llegó", que
  // no depende de eso.
  let closed = false;
  try {
    const row = await repositories(getDb()).appointmentFinance.findByEaAppointmentId(id);
    closed = row !== undefined && row.closed_at !== null;
  } catch (error) {
    unstable_rethrow(error);
    console.error("[asistencia] no se pudo leer la cuenta", error);
    if (input.mark !== "llego") {
      return {
        status: "error",
        message: "La base del panel no respondió. No se marcó nada.",
      };
    }
  }

  const plan = planAttendanceWrite({
    mark: input.mark,
    currentStatus: appointment.status,
    closed,
    windowOpen: attendanceWindowOpen(appointment.start, instantToEaLocal(new Date())),
    restoreTo: input.restoreTo,
  });

  if (!plan.ok) return { status: "error", message: plan.message };

  const previous = appointment.status;
  if (plan.status === null) {
    // Ya estaba así: otra persona marcó primero. No se escribe —cada PUT es un
    // sync con Google y quizá un correo— y la pantalla se pone al día.
    return { status: "ok", eaStatus: previous, previous };
  }

  try {
    await ea.appointments.update(id, { status: plan.status });
  } catch (error) {
    unstable_rethrow(error);
    console.error("[asistencia] EA no aceptó el estado", error);
    return { status: "error", message: failureMessage(error) };
  }

  // Quién marcó a quién como inasistente es la pregunta que alguien va a hacer
  // el día que una clienta reclame. Mejor esfuerzo: la marca ya está en EA, y
  // una bitácora caída no la deshace.
  try {
    await repositories(getDb()).auditLog.append({
      actorUserId: session.userId,
      action: "cita.asistencia",
      entity: "ea_appointment",
      entityId: id,
      before: { status: previous },
      after: { status: plan.status },
      reason: input.mark,
      at: new Date(),
    });
  } catch (error) {
    console.error("[asistencia] no se pudo anotar en la bitácora", error);
  }

  revalidatePath("/hoy");
  revalidatePath("/agenda");
  return { status: "ok", eaStatus: plan.status, previous };
}

function failureMessage(error: unknown): string {
  if (error instanceof EaApiError) {
    if (error.kind === "not_found") return "Esa cita ya no existe en la agenda. Actualiza.";
    if (error.kind === "timeout" || error.kind === "network") {
      return "La agenda no respondió. No se marcó nada.";
    }
  }
  return "No se pudo marcar la asistencia.";
}
