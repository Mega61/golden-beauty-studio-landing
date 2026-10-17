import "server-only";

import { statusAfterClose } from "@/lib/attendance";
import type { EaClient } from "@/lib/ea/client";
import type { Appointment } from "@/lib/ea/types";

/**
 * Al cerrar la cuenta, la cita queda `Completada` en EA.
 *
 * Es la única escritura a EA que hace el cierre, y es **solo el estado** (ver
 * la cabecera de `actions.ts`). Vive en su propio archivo para que
 * `cerrarCuenta` la invoque con una línea: esa función la tocan varias manos y
 * la regla de asistencia no tiene por qué estar mezclada con la de la plata.
 *
 * ## Mejor esfuerzo, y nunca lanza
 *
 * La cuenta ya está guardada cuando esto corre. Si EA no contesta, la cuenta
 * **no** se da por fallida: la técnica vería "no se pudo guardar", la cola
 * reintentaría, y cada reintento reescribiría una cuenta que estaba bien. Se
 * deja en el log y la noche lo arregla: el reconcile corre
 * `jobs/attendance-backfill.ts` sobre los últimos días, que encuentra cuentas
 * cerradas con la cita todavía reservada.
 *
 * ## Se espera, no se manda a `after()`
 *
 * Al guardar, Hoy se refresca. Si el estado se escribiera después de
 * responder, la tarjeta diría "cuenta cerrada" con la pastilla en "Reservada"
 * hasta el siguiente refresco, que es exactamente la contradicción que esta
 * función existe para eliminar. El costo es una ida a EA más en el cierre.
 *
 * `appointment` es la que `cerrarCuenta` acaba de leer fresca de EA, así que el
 * estado de partida es el real y no hace falta otra lectura.
 */
export async function marcarCompletadaAlCerrar(
  ea: Pick<EaClient, "appointments">,
  appointment: Pick<Appointment, "id" | "status">,
): Promise<"escrita" | "sin-cambio" | "fallo"> {
  const status = statusAfterClose(appointment.status);
  if (status === null) return "sin-cambio";

  try {
    await ea.appointments.update(appointment.id, { status });
    return "escrita";
  } catch (error) {
    console.error(
      `[hoy] la cuenta de la cita ${appointment.id} se cerró, pero EA no aceptó el estado ` +
        `«${status}». La reconciliación nocturna lo reintenta.`,
      error,
    );
    return "fallo";
  }
}
