import "server-only";

import { normalizePhoneE164 } from "@/app/(panel)/clientes/identity";
import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";

import { whatsappConfigured } from "./config";

/**
 * ¿La reserva pública va a recibir confirmación por WhatsApp?
 *
 * La respuesta viaja en el 201 (`whatsappConfirmation`) y la landing la usa
 * para decir "Te enviamos la confirmación por WhatsApp" **solo** si es cierto.
 * Una pantalla que promete un mensaje que nunca llega es peor que no decir
 * nada: la clienta se queda esperando y escribe preguntando si la cita quedó.
 *
 * - `"sending"`: hay configuración de Meta, el número es utilizable y no se
 *   dio de baja. La confirmación se intenta en `after()`; puede fallar igual
 *   (Meta la rechaza, el número no tiene WhatsApp), pero se intentó.
 * - `"disabled"`: cualquier otra cosa, incluida una base que no contesta —
 *   sin base no se puede tomar la fila antes de llamar a Meta, así que tampoco
 *   se intenta.
 */
export type WhatsappConfirmationIntent = "sending" | "disabled";

/** La decisión, pura. */
export function confirmationIntent(input: {
  configured: boolean;
  phoneE164: string | null;
  /** `null` = no se pudo consultar la baja. */
  optedOut: boolean | null;
}): WhatsappConfirmationIntent {
  if (!input.configured || input.phoneE164 === null) return "disabled";
  if (input.optedOut !== false) return "disabled";
  return "sending";
}

export async function whatsappConfirmationFor(rawPhone: string): Promise<WhatsappConfirmationIntent> {
  const configured = whatsappConfigured();
  const phoneE164 = normalizePhoneE164(rawPhone);
  if (!configured || phoneE164 === null) {
    return confirmationIntent({ configured, phoneE164, optedOut: null });
  }

  let optedOut: boolean | null;
  try {
    const set = await repositories(getDb()).waMessages.listOptedOut([phoneE164]);
    optedOut = set.has(phoneE164);
  } catch (error) {
    console.error("[whatsapp] no se pudo consultar la baja; la confirmación no se intenta", error);
    optedOut = null;
  }
  return confirmationIntent({ configured, phoneE164, optedOut });
}
