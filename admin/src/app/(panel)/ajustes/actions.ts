"use server";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import { receivesBookingPush } from "@/lib/auth-policy";
import { requireSession } from "@/lib/dal";
import { sendTestPush, vapidConfig } from "@/lib/push/send";

/**
 * Las escrituras de **Ajustes → Avisos**: suscribir este dispositivo, darlo
 * de baja y mandarle un aviso de prueba.
 *
 * ## Qué llega del navegador y qué no
 *
 * Llega la suscripción que creó el navegador (endpoint + dos llaves), y nada
 * más. A quién pertenece sale de la sesión; el agente de usuario, de la
 * cabecera de la petición. Un cliente no puede suscribir un celular a nombre
 * de otra persona.
 *
 * ## Lo que va a la bitácora
 *
 * Que alguien prendió o apagó avisos, y en qué tipo de dispositivo. **No el
 * endpoint**: es una capacidad (con él y la llave VAPID se le escribe a ese
 * celular), y `audit_log` no tiene política de retención.
 */

export type PushActionResult = { ok: true; message?: string } | { ok: false; message: string };

const B64URL = /^[A-Za-z0-9_-]+=*$/;

const SubscriptionSchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .refine((v) => {
      try {
        return new URL(v).protocol === "https:";
      } catch {
        return false;
      }
    }),
  keys: z.object({
    p256dh: z.string().min(1).max(255).regex(B64URL),
    auth: z.string().min(1).max(255).regex(B64URL),
  }),
});

const EndpointSchema = z.object({ endpoint: z.string().min(1).max(2048) });

async function userAgent(): Promise<string | null> {
  const ua = (await headers()).get("user-agent")?.trim();
  return ua ? ua.slice(0, 300) : null;
}

/**
 * La sesión, si a esta persona le puede llegar algún aviso: el de reservas web
 * (dueña y recepción) o el de su propia columna (`avisos:mis-citas`, quien
 * tiene `ea_provider_id`). Sin sesión, `requireSession` manda a entrar.
 */
async function requirePushSession() {
  const session = await requireSession();
  return receivesBookingPush(session.role, session.eaProviderId) ? session : null;
}

export async function activarAvisos(input: unknown): Promise<PushActionResult> {
  if (vapidConfig() === null) {
    return { ok: false, message: "Los avisos no están configurados en este servidor." };
  }
  const parsed = SubscriptionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "El navegador mandó una suscripción inválida." };

  const session = await requirePushSession();
  if (session === null) return { ok: false, message: "Tu cuenta no recibe avisos de reservas." };

  const ua = await userAgent();
  try {
    const now = new Date();
    await getDb()
      .transaction()
      .execute(async (trx) => {
        const tx = repositories(trx);
        const fresh = await tx.pushSubscriptions.upsert({
          userId: session.userId,
          endpoint: parsed.data.endpoint,
          p256dh: parsed.data.keys.p256dh,
          auth: parsed.data.keys.auth,
          userAgent: ua,
        });
        // Volver a abrir Ajustes re-sincroniza la suscripción (por si la
        // podaron); eso no es una decisión de nadie y no se anota.
        if (fresh) {
          const row = await tx.pushSubscriptions.findForUser(session.userId, parsed.data.endpoint);
          await tx.auditLog.append({
            actorUserId: session.userId,
            action: "push.activar",
            entity: "push_subscription",
            entityId: row?.id ?? session.userId,
            after: { userAgent: ua },
            at: now,
          });
        }
      });
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[ajustes] no se pudo guardar la suscripción", error);
    return { ok: false, message: "No se pudo guardar. Intenta de nuevo." };
  }
}

/**
 * Apagar avisos en este dispositivo. Pide sesión y **no** el permiso: quien ya
 * no tiene el rol tiene que poder apagar lo que le quedó prendido.
 */
export async function desactivarAvisos(input: unknown): Promise<PushActionResult> {
  const parsed = EndpointSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Falta el dispositivo." };

  const session = await requireSession();
  try {
    const now = new Date();
    await getDb()
      .transaction()
      .execute(async (trx) => {
        const tx = repositories(trx);
        const row = await tx.pushSubscriptions.findForUser(session.userId, parsed.data.endpoint);
        const removed = await tx.pushSubscriptions.deleteForUser(session.userId, parsed.data.endpoint);
        if (removed) {
          await tx.auditLog.append({
            actorUserId: session.userId,
            action: "push.desactivar",
            entity: "push_subscription",
            entityId: row?.id ?? session.userId,
            at: now,
          });
        }
      });
    return { ok: true };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[ajustes] no se pudo borrar la suscripción", error);
    return { ok: false, message: "No se pudo apagar. Intenta de nuevo." };
  }
}

/** Un aviso de prueba a este dispositivo, para ver que llega antes de necesitarlo. */
export async function probarAviso(input: unknown): Promise<PushActionResult> {
  const parsed = EndpointSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Falta el dispositivo." };

  const session = await requirePushSession();
  if (session === null) return { ok: false, message: "Tu cuenta no recibe avisos de reservas." };

  try {
    const sub = await repositories(getDb()).pushSubscriptions.findForUser(
      session.userId,
      parsed.data.endpoint,
    );
    if (!sub) return { ok: false, message: "Este dispositivo no tiene avisos activos." };

    const outcome = await sendTestPush(sub);
    switch (outcome.kind) {
      case "ok":
        return { ok: true, message: "Enviado. Debería llegarte en unos segundos." };
      case "gone":
        return {
          ok: false,
          message: "El navegador ya no acepta avisos en este dispositivo. Apágalos y vuelve a prenderlos.",
        };
      default:
        return { ok: false, message: "El servicio de avisos no respondió. Intenta en un momento." };
    }
  } catch (error) {
    unstable_rethrow(error);
    console.error("[ajustes] no se pudo mandar el aviso de prueba", error);
    return { ok: false, message: "No se pudo mandar la prueba. Intenta de nuevo." };
  }
}
