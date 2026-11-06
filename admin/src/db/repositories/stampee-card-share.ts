import type { AuthId } from "../types";
import type { Db } from "./shared";

/**
 * `stampee_card_share`: a qué tarjetas de sellos ya se les mandó el link
 * (migración `029`).
 *
 * Lee y escribe filas, nada más. Qué tarjetas faltan por mandar lo decide
 * `lib/stampee/card-share.ts`.
 */
export function stampeeCardShareRepository(db: Db) {
  return {
    /**
     * Los ids de todas las tarjetas ya mandadas.
     *
     * Todas y no "las de esta lista": es una fila por clienta con tarjeta, unos
     * cientos a lo sumo, y Fidelidad y Hoy necesitan cruzarlas todas.
     */
    async listSentCardIds(): Promise<Set<string>> {
      const rows = await db.selectFrom("stampee_card_share").select("stampee_card_id").execute();
      return new Set(rows.map((row) => row.stampee_card_id));
    },

    /** Anota que alguien la mandó. Reenviar actualiza quién y cuándo. */
    async markSent(cardId: string, userId: AuthId | null, at: Date): Promise<void> {
      await db
        .insertInto("stampee_card_share")
        .values({ stampee_card_id: cardId, sent_by_user_id: userId, sent_at: at })
        .onDuplicateKeyUpdate({ sent_by_user_id: userId, sent_at: at })
        .execute();
    },
  };
}
