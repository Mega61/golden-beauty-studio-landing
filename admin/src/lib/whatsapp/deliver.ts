/**
 * Mandar una plantilla **con su fila**: tomar la fila, llamar a Meta, anotar.
 *
 * Es el único camino por el que el panel manda algo por la Cloud API, y lo
 * usan los dos emisores —la confirmación de una reserva y el job de
 * recordatorios— para que la regla de la `020` se cumpla en un solo lugar:
 *
 * 1. **La fila se inserta antes de llamar a Meta** (`pendiente`). Si ya había
 *    una para esa cita y ese tipo —de cualquier canal, también la de un aviso
 *    que recepción mandó a mano— no se manda nada. La `UNIQUE` decide, no un
 *    SELECT previo que dos procesos podrían pasar a la vez.
 * 2. Meta responde → `enviado` con su id, o `fallido` con el motivo.
 * 3. Si la llamada a Meta salió bien pero la escritura del resultado falla, la
 *    fila queda en `pendiente` y **no** se reintenta sola: el mensaje salió.
 *    Diagnóstico la cuenta como un estado raro, que es lo que es.
 *
 * Los repositorios entran como una interfaz mínima para poder testear la
 * secuencia sin base.
 */

import type { WaMessageKind } from "@/db/types";

import { encodeSendError, sendTemplate, type FetchLike, type SendResult } from "./cloud-api";
import { maskPhone, type WhatsappConfig } from "./config";

export type DeliveryStore = {
  insertPending(input: {
    eaAppointmentId: number;
    kind: WaMessageKind;
    phoneE164: string;
    templateName: string;
    scheduledFor: Date;
  }): Promise<number | null>;
  markSent(id: number, providerMessageId: string, sentAt: Date): Promise<void>;
  markFailed(id: number, error: string): Promise<void>;
};

export type DeliveryInput = {
  eaAppointmentId: number;
  kind: WaMessageKind;
  phoneE164: string;
  templateName: string;
  bodyParams: readonly string[];
  scheduledFor: Date;
};

export type DeliveryOutcome =
  | { status: "enviado"; rowId: number; messageId: string }
  | { status: "fallido"; rowId: number; result: Extract<SendResult, { ok: false }> }
  /** Ya había fila: alguien (el job, otra corrida, recepción) llegó antes. */
  | { status: "ya-existe" };

/**
 * Manda `input` a Meta usando la fila `rowId` ya tomada. Para el reintento,
 * que reusa una fila existente en vez de insertar otra.
 */
export async function sendOnRow(
  store: Pick<DeliveryStore, "markSent" | "markFailed">,
  config: WhatsappConfig,
  rowId: number,
  input: DeliveryInput,
  options: { fetchImpl?: FetchLike; now?: () => Date } = {},
): Promise<DeliveryOutcome> {
  const result = await sendTemplate(
    config,
    { to: input.phoneE164, templateName: input.templateName, bodyParams: input.bodyParams },
    options.fetchImpl,
  );

  if (result.ok) {
    await store.markSent(rowId, result.messageId, (options.now ?? (() => new Date()))());
    return { status: "enviado", rowId, messageId: result.messageId };
  }

  await store.markFailed(rowId, encodeSendError(result));
  console.error(
    `[whatsapp] ${input.kind} de la cita ${input.eaAppointmentId} a ${maskPhone(input.phoneE164)} no salió: ${result.code} — ${result.message}`,
  );
  return { status: "fallido", rowId, result };
}

export async function deliverTemplate(
  store: DeliveryStore,
  config: WhatsappConfig,
  input: DeliveryInput,
  options: { fetchImpl?: FetchLike; now?: () => Date } = {},
): Promise<DeliveryOutcome> {
  const rowId = await store.insertPending({
    eaAppointmentId: input.eaAppointmentId,
    kind: input.kind,
    phoneE164: input.phoneE164,
    templateName: input.templateName,
    scheduledFor: input.scheduledFor,
  });
  if (rowId === null) return { status: "ya-existe" };
  return sendOnRow(store, config, rowId, input, options);
}
