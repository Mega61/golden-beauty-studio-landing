"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import { REMINDER_RULES, scheduledFor } from "@/jobs/reminders";
import { ForbiddenError, requireCapability } from "@/lib/dal";
import { eaLocalToInstant, instantToEaDate } from "@/lib/ea";
import { loadAppointmentForTemplate } from "@/lib/whatsapp/load-appointment";
import {
  MANUAL_TEMPLATE,
  planManualReminders,
  type ManualReminderAppointment,
} from "@/lib/whatsapp/manual-reminder";

import { registerManualConfirmation, type ManualConfirmationResult } from "./confirmation-send";
import { linkFor, nextEaDate, sentLabelOf } from "./data";

/**
 * Las dos escrituras de **Recordatorios**: registrar un aviso mandado a mano y
 * registrar una baja.
 *
 * ## La fila va antes del enlace
 *
 * `enviarRecordatorio` inserta en `wa_message` y **recién después** devuelve
 * el enlace de `wa.me`. Es la regla de la `020` aplicada al canal manual: si
 * el enlace saliera primero y el INSERT fallara, la clienta tendría el aviso y
 * la base no lo sabría — y el emisor automático, el día que exista, se lo
 * mandaría de nuevo. Al revés, el peor caso es una fila que dice `enviado` de
 * un WhatsApp que la persona abrió y no mandó; eso se ve en la pantalla
 * ("Recordada por…") y se resuelve abriendo de nuevo.
 *
 * ## Nada de lo que decide llega del navegador
 *
 * El navegador manda un id de cita. El teléfono, el texto, el tipo de aviso y
 * si corresponde mandarlo se vuelven a calcular acá contra EA, con la misma
 * función pura que dibujó la lista. Una pestaña abierta desde ayer no puede
 * mandar el aviso de "mañana" de una cita que hoy ya es de hoy.
 */

export type SendReminderResult =
  | {
      ok: true;
      url: string;
      /** `true` = ya estaba registrado; solo se reabre el enlace. */
      already: boolean;
      sentLabel: string;
    }
  | { ok: false; message: string };

export type OptoutResult = { ok: boolean; message: string };

const InputSchema = z.object({ eaAppointmentId: z.number().int().positive() });

const STATE_MESSAGE = {
  "sin-telefono": "Esta ficha no tiene un teléfono válido. Corrígelo en Clientes.",
  "opt-out": "Este número pidió no recibir recordatorios.",
  "estado-no-aplica": "Esta cita ya no lleva recordatorio por su estado en la agenda.",
  "no-enviada": "Ya hay un registro de este aviso que dice que no salió. Revísalo con administración.",
} as const;

/**
 * La cita, reducida a lo que deciden las funciones puras. Leída de EA.
 *
 * Con la visita resuelta (`lib/visits.ts`): si es la primera de un manos + pies
 * sin combo, `serviceName` ya nombra las dos, y `continuation` marca la segunda,
 * que no lleva aviso propio.
 */
const loadAppointment = loadAppointmentForTemplate;

export async function enviarRecordatorio(input: {
  eaAppointmentId: number;
}): Promise<SendReminderResult> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Falta la cita." };
  const { eaAppointmentId } = parsed.data;

  let session;
  try {
    session = await requireCapability("recordatorios:enviar");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Tu rol no manda recordatorios." };
    }
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  let appointment: ManualReminderAppointment;
  try {
    const loaded = await loadAppointment(eaAppointmentId);
    if (loaded.continuation) {
      return {
        ok: false,
        message: "Esta cita sigue a otra de la misma visita: el recordatorio va con la primera.",
      };
    }
    appointment = loaded;
  } catch (error) {
    unstable_rethrow(error);
    console.error("[recordatorios] no se pudo leer la cita", error);
    return { ok: false, message: "La agenda no respondió. Intenta de nuevo en un momento." };
  }

  const now = new Date();
  const today = instantToEaDate(now);
  const tomorrow = nextEaDate(today);

  try {
    const db = getDb();
    const repos = repositories(db);

    const decide = async () => {
      const [stored, optedOut] = await Promise.all([
        repos.waMessages.listByAppointmentIds([eaAppointmentId]),
        repos.waMessages.listOptedOut(
          appointment.phoneE164 === null ? [] : [appointment.phoneE164],
        ),
      ]);
      const [row] = planManualReminders({
        appointments: [appointment],
        existing: stored,
        optedOut,
        now,
        today,
        tomorrow,
      });
      const sent = row === undefined ? undefined : stored.find((s) => s.kind === row.kind);
      return { row, sent };
    };

    const { row, sent } = await decide();

    if (row === undefined) {
      return {
        ok: false,
        message: "Esta cita ya no es de hoy ni de mañana, o ya empezó. Recarga la lista.",
      };
    }

    // Ya registrada (por otra persona, en otra pestaña, o el doble toque):
    // no se escribe nada, solo se reabre la conversación.
    if (row.state === "recordada") {
      const url = linkFor(row, sent?.phoneE164 ?? null);
      if (url === null || row.existing === null) {
        return { ok: false, message: "El número registrado no es válido." };
      }
      return { ok: true, url, already: true, sentLabel: sentLabelOf(row.existing, today) };
    }

    if (row.state !== "pendiente" && row.state !== "fallo-automatico") {
      return { ok: false, message: STATE_MESSAGE[row.state] };
    }

    const url = linkFor(row, null);
    if (url === null || appointment.phoneE164 === null) {
      return { ok: false, message: STATE_MESSAGE["sin-telefono"] };
    }

    // `scheduled_for` guarda el momento objetivo de la regla automática, como
    // haría el cron: así una consulta sobre la tabla compara los dos canales
    // con la misma vara ("¿salió antes o después de cuando tocaba?").
    const rule = REMINDER_RULES.find((r) => r.kind === row.kind);
    const target =
      rule === undefined
        ? now
        : scheduledFor(
            {
              eaAppointmentId,
              startAt: eaLocalToInstant(appointment.start),
              phoneE164: appointment.phoneE164,
              status: appointment.status,
            },
            rule,
          );

    const phoneE164 = appointment.phoneE164;
    // El automático lo intentó y Meta no lo mandó: la fila ya existe y la
    // `UNIQUE` no admite otra, así que se **retoma** esa (pasa a `manual`).
    // El UPDATE es condicional sobre `fallido`: si en el medio el job lo
    // reintentó y salió, no se toca nada y se informa como ya recordada.
    const takeOverId = row.state === "fallo-automatico" ? (sent?.id ?? null) : null;
    if (row.state === "fallo-automatico" && takeOverId === null) {
      return { ok: false, message: "No se encontró el registro del envío automático. Recarga la lista." };
    }
    const inserted = await db.transaction().execute(async (trx) => {
      const tx = repositories(trx);
      const fresh =
        takeOverId !== null
          ? await tx.waMessages.takeOverForManual({
              id: takeOverId,
              phoneE164,
              templateName: MANUAL_TEMPLATE,
              sentAt: now,
              sentByUserId: session.userId,
            })
          : await tx.waMessages.insertManualSent({
              eaAppointmentId,
              kind: row.kind,
              phoneE164,
              templateName: MANUAL_TEMPLATE,
              scheduledFor: target,
              sentAt: now,
              sentByUserId: session.userId,
            });
      // Solo se anota lo que se escribió. El teléfono y el texto no van a la
      // bitácora: la fila ya dice a quién, y el texto lleva datos de la
      // clienta que un log sin retención no tiene por qué guardar.
      if (fresh) {
        await tx.auditLog.append({
          actorUserId: session.userId,
          action: "recordatorio.manual",
          entity: "ea_appointment",
          entityId: eaAppointmentId,
          after: {
            kind: row.kind,
            channel: "manual",
            template: MANUAL_TEMPLATE,
            ...(takeOverId !== null ? { retomaFalloAutomatico: true } : {}),
          },
          at: now,
        });
      }
      return fresh;
    });

    revalidatePath("/recordatorios");

    if (!inserted) {
      // Perdió la carrera contra otro toque: la `UNIQUE` hizo su trabajo.
      const again = await decide();
      if (again.row?.existing) {
        const reopen = linkFor(again.row, again.sent?.phoneE164 ?? null) ?? url;
        return {
          ok: true,
          url: reopen,
          already: true,
          sentLabel: sentLabelOf(again.row.existing, today),
        };
      }
    }

    return {
      ok: true,
      url,
      already: false,
      sentLabel: sentLabelOf(
        { channel: "manual", sentAt: now, sentByName: session.name },
        today,
      ),
    };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[recordatorios] no se pudo registrar el aviso", error);
    // Sin la fila no se abre WhatsApp: ver el comentario del módulo.
    return {
      ok: false,
      message: "No se pudo registrar el aviso, así que no se abrió WhatsApp. Intenta de nuevo.",
    };
  }
}

/**
 * Registrar una confirmación de reserva mandada a mano y devolver el enlace.
 *
 * La llaman "Reservas nuevas" y la agenda (el detalle de la cita y el aviso de
 * "Cita creada"). Lo que decide vive en `confirmation-send.ts`, que comparte
 * con `/confirmar/[id]`.
 */
export async function enviarConfirmacion(input: {
  eaAppointmentId: number;
}): Promise<ManualConfirmationResult> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Falta la cita." };

  let session;
  try {
    session = await requireCapability("recordatorios:enviar");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Tu rol no manda mensajes por WhatsApp." };
    }
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  const result = await registerManualConfirmation(parsed.data.eaAppointmentId, {
    userId: session.userId,
    name: session.name,
  });
  if (result.ok && !result.already) revalidatePath("/recordatorios");
  return result;
}

/**
 * Registrar que una clienta no quiere más recordatorios.
 *
 * Se manda el id de la cita y no el número: el número se lee de EA y se
 * normaliza acá, igual que en el envío, para que la baja quede con la misma
 * llave con la que después se consulta.
 */
export async function registrarBaja(input: { eaAppointmentId: number }): Promise<OptoutResult> {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Falta la cita." };

  let session;
  try {
    session = await requireCapability("recordatorios:baja");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Tu rol no registra bajas." };
    }
    return { ok: false, message: "No se pudo verificar la sesión." };
  }

  let appointment: ManualReminderAppointment;
  try {
    appointment = await loadAppointment(parsed.data.eaAppointmentId);
  } catch (error) {
    unstable_rethrow(error);
    console.error("[recordatorios] no se pudo leer la cita", error);
    return { ok: false, message: "La agenda no respondió. Intenta de nuevo en un momento." };
  }

  const phone = appointment.phoneE164;
  if (phone === null) return { ok: false, message: STATE_MESSAGE["sin-telefono"] };

  try {
    const db = getDb();
    const now = new Date();
    const added = await db.transaction().execute(async (trx) => {
      const tx = repositories(trx);
      const fresh = await tx.waMessages.addOptout(phone, "Registrada en el panel");
      if (fresh) {
        await tx.auditLog.append({
          actorUserId: session.userId,
          action: "wa.baja",
          entity: "wa_optout",
          entityId: phone,
          after: { desdeCita: appointment.eaAppointmentId },
          at: now,
        });
      }
      return fresh;
    });

    revalidatePath("/recordatorios");
    return {
      ok: true,
      message: added
        ? `${appointment.customerName} no va a recibir más recordatorios.`
        : "Ese número ya estaba dado de baja.",
    };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[recordatorios] no se pudo registrar la baja", error);
    return { ok: false, message: "No se pudo registrar la baja. Intenta de nuevo." };
  }
}
