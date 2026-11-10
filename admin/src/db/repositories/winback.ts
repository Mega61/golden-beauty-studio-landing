import type { AuthId } from "../types";
import type { Db } from "./shared";

/**
 * `winback_config` y `winback_offer` (migración `032`): "Te extrañamos".
 *
 * Lee y escribe filas, nada más. Las reglas (a quién se le ofrece, qué dice el
 * mensaje, cuándo vale el 10 %) viven en `lib/winback.ts`.
 */

export type WinbackConfigRow = {
  stampeeCampaignId: string | null;
  messageTemplate: string | null;
  discountEnabled: boolean;
  validDays: number | null;
  lapsedDays: number;
  updatedAt: Date | null;
};

export type WinbackOfferRow = {
  phone: string;
  clientName: string | null;
  stampeeCustomerId: string | null;
  stampeeCardId: string | null;
  stampeeCardUniqueId: string | null;
  giftedStamps: number;
  discountPercent: number;
  /** `YYYY-MM-DD` (Bogotá), inclusivo. `null` = no vence. */
  expiresOn: string | null;
  sentAt: Date;
  lastSentAt: Date;
};

const CONFIG_ID = 1;

export function winbackRepository(db: Db) {
  return {
    /** La configuración, o `null` si nadie la ha guardado todavía. */
    async getConfig(): Promise<WinbackConfigRow | null> {
      const row = await db
        .selectFrom("winback_config")
        .selectAll()
        .where("id", "=", CONFIG_ID)
        .executeTakeFirst();
      if (!row) return null;
      return {
        stampeeCampaignId: row.stampee_campaign_id,
        messageTemplate: row.message_template,
        discountEnabled: row.discount_enabled === 1,
        validDays: row.valid_days,
        lapsedDays: row.lapsed_days,
        updatedAt: row.updated_at,
      };
    },

    async saveConfig(
      config: Omit<WinbackConfigRow, "updatedAt">,
      userId: AuthId | null,
      at: Date,
    ): Promise<void> {
      const values = {
        stampee_campaign_id: config.stampeeCampaignId,
        message_template: config.messageTemplate,
        discount_enabled: config.discountEnabled ? 1 : 0,
        valid_days: config.validDays,
        lapsed_days: config.lapsedDays,
        updated_by_user_id: userId,
        updated_at: at,
      };
      await db
        .insertInto("winback_config")
        .values({ id: CONFIG_ID, ...values })
        .onDuplicateKeyUpdate(values)
        .execute();
    },

    /** Todas las ofertas mandadas. Unas decenas: la pantalla las cruza todas. */
    async listOffers(): Promise<WinbackOfferRow[]> {
      const rows = await db.selectFrom("winback_offer").selectAll().execute();
      return rows.map(toOffer);
    },

    /** La oferta de un teléfono E.164, si se le mandó. */
    async findOffer(phone: string): Promise<WinbackOfferRow | null> {
      const row = await db
        .selectFrom("winback_offer")
        .selectAll()
        .where("phone_e164", "=", phone)
        .executeTakeFirst();
      return row ? toOffer(row) : null;
    },

    /**
     * Anota el regalo. La primera vez fija la tarjeta, el descuento y la fecha
     * de vencimiento; reenviar solo actualiza `last_sent_at` (lo prometido no
     * cambia porque alguien volvió a tocar el botón).
     */
    async recordSent(
      offer: Omit<WinbackOfferRow, "sentAt" | "lastSentAt">,
      userId: AuthId | null,
      at: Date,
    ): Promise<void> {
      await db
        .insertInto("winback_offer")
        .values({
          phone_e164: offer.phone,
          client_name: offer.clientName,
          stampee_customer_id: offer.stampeeCustomerId,
          stampee_card_id: offer.stampeeCardId,
          stampee_card_unique_id: offer.stampeeCardUniqueId,
          gifted_stamps: offer.giftedStamps,
          discount_percent: offer.discountPercent,
          expires_on: offer.expiresOn,
          sent_by_user_id: userId,
          sent_at: at,
          last_sent_at: at,
        })
        .onDuplicateKeyUpdate({ last_sent_at: at })
        .execute();
    },
  };
}

function toOffer(row: {
  phone_e164: string;
  client_name: string | null;
  stampee_customer_id: string | null;
  stampee_card_id: string | null;
  stampee_card_unique_id: string | null;
  gifted_stamps: number;
  discount_percent: number;
  expires_on: string | null;
  sent_at: Date;
  last_sent_at: Date;
}): WinbackOfferRow {
  return {
    phone: row.phone_e164,
    clientName: row.client_name,
    stampeeCustomerId: row.stampee_customer_id,
    stampeeCardId: row.stampee_card_id,
    stampeeCardUniqueId: row.stampee_card_unique_id,
    giftedStamps: row.gifted_stamps,
    discountPercent: row.discount_percent,
    expiresOn: row.expires_on,
    sentAt: row.sent_at,
    lastSentAt: row.last_sent_at,
  };
}
