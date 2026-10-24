import "server-only";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { AuthId } from "@/db/types";
import { instantToEaDate } from "@/lib/ea";
import { loadAppointmentForTemplate } from "@/lib/whatsapp/load-appointment";
import { confirmationStateOf } from "@/lib/whatsapp/manual-confirmation";
import { buildConfirmationText, waMeLink } from "@/lib/whatsapp/manual-reminder";

import { sentLabelOf } from "./data";

/**
 * Registrar una confirmación mandada a mano y devolver el enlace de WhatsApp.
 *
 * Un solo camino para los tres botones que confirman: la lista de "Reservas
 * nuevas", el detalle de la cita en la agenda (y el aviso de "Cita creada"), y
 * el "Escribirle por WhatsApp" del aviso push de una reserva web
 * (`/confirmar/[id]`). Antes ese último abría WhatsApp sin dejar rastro, y la
 * lista no tenía cómo saber que la clienta ya estaba confirmada.
 *
 * Misma regla que el recordatorio manual: **la fila va antes del enlace**. Si el
 * enlace saliera primero y el INSERT fallara, la confirmación existiría y la
 * base no lo sabría — y la Cloud API, el día que esté prendida, la mandaría de
 * nuevo. Y nada de lo que decide viene del navegador: llega un id de cita, y
 * el teléfono, el texto y si corresponde se calculan acá contra EA.
 *
 * El texto nombra la visita entera: si la cita es la primera de un manos + pies
 * sin combo, `loadAppointmentForTemplate` ya trae los dos servicios.
 */

/** La "plantilla" de una confirmación manual. Versionada como la del recordatorio. */
export const MANUAL_CONFIRMATION_TEMPLATE = "manual-wa-me-confirmacion-v1";

export type ManualConfirmationResult =
  | {
      ok: true;
      url: string;
      /** `true` = ya estaba confirmada; solo se reabre la conversación. */
      already: boolean;
      sentLabel: string;
    }
  | { ok: false; message: string };

const STATE_MESSAGE = {
  "sin-telefono": "Esta ficha no tiene un teléfono válido. Corrígelo en Clientes.",
  "opt-out": "Este número pidió no recibir mensajes del estudio.",
  "estado-no-aplica": "Por su estado en la agenda, esta cita no lleva confirmación.",
  "no-enviada": "Ya hay un registro de esta confirmación que dice que no salió. Revísalo con administración.",
} as const;

export async function registerManualConfirmation(
  eaAppointmentId: number,
  actor: { userId: AuthId; name: string },
  now: Date = new Date(),
): Promise<ManualConfirmationResult> {
  let appointment: Awaited<ReturnType<typeof loadAppointmentForTemplate>>;
  try {
    appointment = await loadAppointmentForTemplate(eaAppointmentId);
  } catch (error) {
    console.error("[confirmaciones] no se pudo leer la cita", eaAppointmentId, error);
    return { ok: false, message: "La agenda no respondió. Intenta de nuevo en un momento." };
  }

  const today = instantToEaDate(now);
  const textFor = (phone: string) =>
    waMeLink(
      phone,
      buildConfirmationText({
        customerFirstName: appointment.customerFirstName,
        serviceName: appointment.serviceName,
        start: appointment.start,
      }),
    );

  try {
    const db = getDb();
    const repos = repositories(db);

    const decide = async () => {
      const [stored, optedOut] = await Promise.all([
        repos.waMessages.findByAppointmentKind(eaAppointmentId, "confirmacion"),
        repos.waMessages.listOptedOut(
          appointment.phoneE164 === null ? [] : [appointment.phoneE164],
        ),
      ]);
      const state = confirmationStateOf({
        status: appointment.status,
        phoneE164: appointment.phoneE164,
        existing: stored ?? null,
        optedOut,
      });
      return { state, stored: stored ?? null };
    };

    const { state, stored } = await decide();

    // Ya confirmada (otra persona, otra pestaña, el automático, el doble
    // toque): no se escribe nada, se reabre la conversación con el número al
    // que se mandó.
    if (state === "confirmada" && stored !== null) {
      const url = textFor(stored.phoneE164);
      if (url === null) return { ok: false, message: "El número registrado no es válido." };
      return { ok: true, url, already: true, sentLabel: sentLabelOf(stored, today, "Confirmada") };
    }

    if (state !== "pendiente" && state !== "fallo-automatico") {
      return { ok: false, message: STATE_MESSAGE[state === "confirmada" ? "no-enviada" : state] };
    }

    const phoneE164 = appointment.phoneE164;
    const url = phoneE164 === null ? null : textFor(phoneE164);
    if (phoneE164 === null || url === null) {
      return { ok: false, message: STATE_MESSAGE["sin-telefono"] };
    }

    // La Cloud API lo intentó y no salió: la `UNIQUE` no admite otra fila, así
    // que se retoma esa. El UPDATE es condicional sobre `fallido`.
    const takeOverId = state === "fallo-automatico" ? (stored?.id ?? null) : null;

    const inserted = await db.transaction().execute(async (trx) => {
      const tx = repositories(trx);
      const fresh =
        takeOverId !== null
          ? await tx.waMessages.takeOverForManual({
              id: takeOverId,
              phoneE164,
              templateName: MANUAL_CONFIRMATION_TEMPLATE,
              sentAt: now,
              sentByUserId: actor.userId,
            })
          : await tx.waMessages.insertManualSent({
              eaAppointmentId,
              kind: "confirmacion",
              phoneE164,
              templateName: MANUAL_CONFIRMATION_TEMPLATE,
              scheduledFor: now,
              sentAt: now,
              sentByUserId: actor.userId,
            });
      // Sin teléfono ni texto en la bitácora: la fila ya dice a quién.
      if (fresh) {
        await tx.auditLog.append({
          actorUserId: actor.userId,
          action: "confirmacion.manual",
          entity: "ea_appointment",
          entityId: eaAppointmentId,
          after: {
            kind: "confirmacion",
            channel: "manual",
            template: MANUAL_CONFIRMATION_TEMPLATE,
            ...(takeOverId !== null ? { retomaFalloAutomatico: true } : {}),
          },
          at: now,
        });
      }
      return fresh;
    });

    if (!inserted) {
      // Perdió la carrera contra otro toque: la `UNIQUE` hizo su trabajo.
      const again = await decide();
      if (again.state === "confirmada" && again.stored !== null) {
        return {
          ok: true,
          url: textFor(again.stored.phoneE164) ?? url,
          already: true,
          sentLabel: sentLabelOf(again.stored, today, "Confirmada"),
        };
      }
    }

    return {
      ok: true,
      url,
      already: false,
      sentLabel: sentLabelOf({ channel: "manual", sentAt: now, sentByName: actor.name }, today, "Confirmada"),
    };
  } catch (error) {
    console.error("[confirmaciones] no se pudo registrar la confirmación", error);
    return {
      ok: false,
      message: "No se pudo registrar la confirmación, así que no se abrió WhatsApp. Intenta de nuevo.",
    };
  }
}
