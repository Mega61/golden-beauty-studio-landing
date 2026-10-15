import type { AuthId, WaMessageChannel, WaMessageKind, WaMessageStatus } from "../types";
import type { Db } from "./shared";

/**
 * `wa_message` y `wa_optout`: lo que se le mandó a quién, y quién no quiere más.
 *
 * Hoy la única escritora es el botón de `wa.me` (el paliativo manual de X7).
 * El emisor automático, cuando Meta apruebe las plantillas, escribe en las
 * mismas tablas y **choca contra la misma `UNIQUE (ea_appointment_id, kind)`**:
 * esa llave es lo que hace que un aviso que recepción ya mandó a mano no lo
 * vuelva a mandar el cron.
 */

/** Una fila de mensaje, con el nombre de quien la mandó a mano. */
export type WaMessageWithSender = {
  id: number;
  eaAppointmentId: number;
  kind: WaMessageKind;
  channel: WaMessageChannel;
  status: WaMessageStatus;
  phoneE164: string;
  sentAt: Date | null;
  sentByUserId: AuthId | null;
  /** `user.name`; `null` si la fila es automática o la cuenta ya no existe. */
  sentByName: string | null;
};

export type ManualSendInput = {
  eaAppointmentId: number;
  kind: WaMessageKind;
  phoneE164: string;
  templateName: string;
  scheduledFor: Date;
  sentAt: Date;
  sentByUserId: AuthId;
};

/** El código de MySQL para "esa llave única ya existe". */
const ER_DUP_ENTRY = 1062;

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "errno" in error &&
    (error as { errno: unknown }).errno === ER_DUP_ENTRY
  );
}

export function waMessageRepository(db: Db) {
  const withSender = () =>
    db
      .selectFrom("wa_message")
      .leftJoin("user", "user.id", "wa_message.sent_by_user_id")
      .select([
        "wa_message.id as id",
        "wa_message.ea_appointment_id as eaAppointmentId",
        "wa_message.kind as kind",
        "wa_message.channel as channel",
        "wa_message.status as status",
        "wa_message.phone_e164 as phoneE164",
        "wa_message.sent_at as sentAt",
        "wa_message.sent_by_user_id as sentByUserId",
        "user.name as sentByName",
      ]);

  return {
    /** Lo que ya hay para estas citas, de cualquier tipo y canal. */
    async listByAppointmentIds(ids: readonly number[]): Promise<WaMessageWithSender[]> {
      if (ids.length === 0) return [];
      return withSender().where("wa_message.ea_appointment_id", "in", [...ids]).execute();
    },

    async findByAppointmentKind(
      eaAppointmentId: number,
      kind: WaMessageKind,
    ): Promise<WaMessageWithSender | undefined> {
      return withSender()
        .where("wa_message.ea_appointment_id", "=", eaAppointmentId)
        .where("wa_message.kind", "=", kind)
        .executeTakeFirst();
    },

    /**
     * Registra un recordatorio mandado a mano. Devuelve `false` si ya había
     * una fila para esa cita y ese tipo.
     *
     * **Se apoya en la `UNIQUE`, no en un SELECT previo.** Dos personas
     * tocando el botón al mismo tiempo pasarían las dos un "¿ya existe?", y la
     * clienta recibiría dos mensajes. El INSERT es atómico; el que pierde la
     * carrera recibe el duplicado y se entera de que ya estaba.
     *
     * No es `INSERT IGNORE`: ese convierte en advertencia cualquier error —un
     * valor truncado, un enum inválido— y la fila quedaría mal escrita en
     * silencio. Acá solo se traga el duplicado.
     */
    async insertManualSent(input: ManualSendInput): Promise<boolean> {
      try {
        await db
          .insertInto("wa_message")
          .values({
            ea_appointment_id: input.eaAppointmentId,
            kind: input.kind,
            channel: "manual",
            sent_by_user_id: input.sentByUserId,
            phone_e164: input.phoneE164,
            template_name: input.templateName,
            status: "enviado",
            scheduled_for: input.scheduledFor,
            sent_at: input.sentAt,
          })
          .execute();
        return true;
      } catch (error) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
    },

    /** Cuáles de estos números pidieron no recibir más. */
    async listOptedOut(phones: readonly string[]): Promise<Set<string>> {
      if (phones.length === 0) return new Set();
      const rows = await db
        .selectFrom("wa_optout")
        .select("phone_e164")
        .where("phone_e164", "in", [...new Set(phones)])
        .execute();
      return new Set(rows.map((row) => row.phone_e164));
    },

    /**
     * Registra la baja de un número. Devuelve `false` si ya estaba.
     *
     * La baja es del **número**, no de la ficha (ver la `020`): sobrevive a
     * que alguien borre y recree a la clienta.
     */
    async addOptout(phoneE164: string, reason: string | null): Promise<boolean> {
      try {
        await db.insertInto("wa_optout").values({ phone_e164: phoneE164, reason }).execute();
        return true;
      } catch (error) {
        if (isDuplicateKey(error)) return false;
        throw error;
      }
    },
  };
}
