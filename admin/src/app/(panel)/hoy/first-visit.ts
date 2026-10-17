import "server-only";

import type { FirstVisitStatus } from "@/components/ticket/types";
import type { EaLocalDateTime } from "@/lib/ea";
import type { EaClient } from "@/lib/ea/client";
import { loadHistoryByPhone } from "../clientes/data";
import { hasVisitedBefore } from "../clientes/history";
import { normalizePhoneE164 } from "../clientes/identity";

/**
 * **¿Es su primera visita?** — la pregunta del 10 %, contestada desde el
 * historial de la clienta (EA ∪ Agenda Pro).
 *
 * ## Por qué vive acá y no en la cuenta
 *
 * El historial incluye a Agenda Pro (`legacy_appointment`), y
 * `lib/legacy-history.money-paths.test.ts` prohíbe que la cuenta
 * (`lib/ticket.ts`, `components/ticket`) alcance cualquier lector de ese
 * historial: esa plata ya está en Actual y no puede volver a entrar. Así que la
 * pregunta se contesta en la capa de servidor de Hoy —que no es un camino de
 * plata: no escribe nada por sí misma— y lo único que cruza hacia la cuenta es
 * **un sí/no**. Ningún monto, ninguna fila, ningún precio del historial.
 *
 * ## Tres respuestas, no dos
 *
 * `desconocido` es cuando no se pudo leer todo (EA o la base no respondieron,
 * o la cita no tiene una clienta con teléfono). Se trata como **no**: el 10 %
 * no se pone solo sobre una duda — una clienta de años con la base caída
 * saldría como nueva. La hoja lo dice, y la técnica lo puede marcar a mano.
 */
export type { FirstVisitStatus };

export async function detectFirstVisit(
  ea: EaClient,
  appointment: { customerId: number | null; start: EaLocalDateTime },
): Promise<FirstVisitStatus> {
  if (appointment.customerId === null) return "desconocido";

  try {
    const customer = await ea.customers.get(appointment.customerId);
    const phone = normalizePhoneE164(customer.phone);
    if (phone === null) return "desconocido";

    const { history, partial } = await loadHistoryByPhone(phone, ea);
    // Una visita encontrada vale aunque falte la otra mitad: ya vino. Que no
    // se encuentre ninguna solo vale si se leyó todo.
    if (hasVisitedBefore(history.entries, appointment.start)) return "recurrente";
    return partial ? "desconocido" : "primera";
  } catch (error) {
    console.error("[hoy] no se pudo revisar si es primera visita", error);
    return "desconocido";
  }
}
