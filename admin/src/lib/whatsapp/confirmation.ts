import "server-only";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { AuthId } from "@/db/types";
import { isSendableStatus } from "@/jobs/reminders";

import { maskPhone, parseWhatsappEnv } from "./config";
import { deliverTemplate, type DeliveryOutcome } from "./deliver";
import { loadAppointmentForTemplate } from "./load-appointment";
import { confirmationParams } from "./template-params";

/**
 * La confirmación por WhatsApp de una cita recién creada.
 *
 * La llaman dos caminos, siempre dentro de `after()`:
 *
 * - la reserva pública (`api/public/booking/reservar`), cuando la clienta ya
 *   tiene su 201;
 * - la agenda del panel, al crear una cita con la casilla "Enviar confirmación
 *   por WhatsApp" marcada. Ahí `actorUserId` dice quién la creó y la
 *   confirmación queda en `audit_log`.
 *
 * ## Nunca lanza, nunca demora
 *
 * Una reserva que ya existe en EA no puede fallar porque Meta esté caído. Todo
 * error termina en el log con `[whatsapp]` y, si alcanzó a tomar la fila, en
 * `wa_message` como `fallido` — que es lo que `/recordatorios` y Diagnóstico
 * leen.
 *
 * ## Sin configuración, no hace nada
 *
 * Ni una consulta a EA: `parseWhatsappEnv` es lo primero.
 */
export type ConfirmationResult =
  | DeliveryOutcome
  | { status: "apagado" }
  | { status: "omitido"; reason: "sin-telefono" | "opt-out" | "estado-no-aplica" | "misma-visita" }
  | { status: "error"; message: string };

export async function sendAppointmentConfirmation(
  eaAppointmentId: number,
  options: { actorUserId?: AuthId | null } = {},
): Promise<ConfirmationResult> {
  const config = parseWhatsappEnv(process.env);
  if (config === null) return { status: "apagado" };

  try {
    const appointment = await loadAppointmentForTemplate(eaAppointmentId);
    if (!isSendableStatus(appointment.status)) return { status: "omitido", reason: "estado-no-aplica" };
    // La segunda mitad de una visita no confirma por su cuenta: la primera ya
    // nombró los dos servicios. Ver `lib/visits.ts`.
    if (appointment.continuation) return { status: "omitido", reason: "misma-visita" };
    const phone = appointment.phoneE164;
    if (phone === null) return { status: "omitido", reason: "sin-telefono" };

    const db = getDb();
    const repo = repositories(db).waMessages;
    const optedOut = await repo.listOptedOut([phone]);
    if (optedOut.has(phone)) return { status: "omitido", reason: "opt-out" };

    const now = new Date();
    const outcome = await deliverTemplate(repo, config, {
      eaAppointmentId,
      kind: "confirmacion",
      phoneE164: phone,
      templateName: config.templates.confirmacion,
      bodyParams: confirmationParams(appointment),
      scheduledFor: now,
    });

    // La bitácora es de lo que hizo una persona del equipo. La reserva pública
    // no tiene actor: su rastro es la fila de `wa_message`.
    if (options.actorUserId && outcome.status !== "ya-existe") {
      try {
        await repositories(db).auditLog.append({
          actorUserId: options.actorUserId,
          action: "whatsapp.confirmacion",
          entity: "ea_appointment",
          entityId: eaAppointmentId,
          after: {
            kind: "confirmacion",
            channel: "cloud_api",
            template: config.templates.confirmacion,
            status: outcome.status,
          },
          at: now,
        });
      } catch (error) {
        console.error("[whatsapp] la confirmación salió pero no se pudo anotar en la bitácora", error);
      }
    }

    if (outcome.status === "enviado") {
      console.log(`[whatsapp] confirmación de la cita ${eaAppointmentId} enviada a ${maskPhone(phone)}`);
    }
    return outcome;
  } catch (error) {
    console.error(`[whatsapp] no se pudo confirmar la cita ${eaAppointmentId}`, error);
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}
