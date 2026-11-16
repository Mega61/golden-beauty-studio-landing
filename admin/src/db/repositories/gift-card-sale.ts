import type { AuthId, GiftCardSale, NewGiftCardSale } from "../types";
import type { Db } from "./shared";

/**
 * `gift_card_sale` (migración `033`): las tarjetas regalo vendidas.
 *
 * Lee y escribe filas, nada más. Qué viaja al CRM y con qué llave lo decide
 * `lib/ingest-payload.ts`; cuándo, `jobs/gift-card-sales.ts`.
 */
export function giftCardSaleRepository(db: Db) {
  return {
    async findByCardId(stampeeGiftCardId: string): Promise<GiftCardSale | undefined> {
      return db
        .selectFrom("gift_card_sale")
        .selectAll()
        .where("stampee_gift_card_id", "=", stampeeGiftCardId)
        .executeTakeFirst();
    },

    async findById(id: number): Promise<GiftCardSale | undefined> {
      return db.selectFrom("gift_card_sale").selectAll().where("id", "=", id).executeTakeFirst();
    },

    /** Inserta la venta y devuelve su id. La UNIQUE por tarjeta impide venderla dos veces. */
    async insert(row: NewGiftCardSale): Promise<number> {
      const result = await db.insertInto("gift_card_sale").values(row).executeTakeFirstOrThrow();
      return Number(result.insertId);
    },

    /**
     * Borra una venta que **todavía no viajó**. Es la compensación de
     * "Confirmar pago" cuando Stampee no activó la tarjeta: sin activar, esa
     * venta no existe. Una fila que ya salió al CRM no se borra nunca (se anula).
     */
    async deleteUnpushed(id: number): Promise<void> {
      await db
        .deleteFrom("gift_card_sale")
        .where("id", "=", id)
        .where("pushed_to_ingest_at", "is", null)
        .execute();
    },

    /** Las ventas cuyo pago cae en `[from, to)`. Para Caja. */
    async listPaidBetween(from: Date, to: Date): Promise<GiftCardSale[]> {
      return db
        .selectFrom("gift_card_sale")
        .selectAll()
        .where("paid_at", ">=", from)
        .where("paid_at", "<", to)
        .orderBy("paid_at")
        .orderBy("id")
        .execute();
    },

    /** Las más recientes, para la pantalla de tarjetas regalo. */
    async listRecent(limit: number): Promise<GiftCardSale[]> {
      return db
        .selectFrom("gift_card_sale")
        .selectAll()
        .orderBy("paid_at", "desc")
        .orderBy("id", "desc")
        .limit(limit)
        .execute();
    },

    /**
     * Lo que la sincronización tiene que mandar: ventas pagadas en `[from, to)`
     * que no viajaron (y no se anularon antes de viajar), y anulaciones de
     * ventas que ya viajaron y cuyo ajuste todavía no salió.
     */
    async listPendingPush(from: Date, to: Date): Promise<GiftCardSale[]> {
      return db
        .selectFrom("gift_card_sale")
        .selectAll()
        .where("paid_at", ">=", from)
        .where("paid_at", "<", to)
        .where((eb) =>
          eb.or([
            eb.and([eb("pushed_to_ingest_at", "is", null), eb("voided_at", "is", null)]),
            eb.and([
              eb("pushed_to_ingest_at", "is not", null),
              eb("voided_at", "is not", null),
              eb("void_pushed_at", "is", null),
            ]),
          ]),
        )
        .orderBy("paid_at")
        .orderBy("id")
        .execute();
    },

    async markPushed(ids: number[], at: Date): Promise<void> {
      if (ids.length === 0) return;
      await db
        .updateTable("gift_card_sale")
        .set({ pushed_to_ingest_at: at })
        .where("id", "in", ids)
        .where("pushed_to_ingest_at", "is", null)
        .execute();
    },

    async markVoidPushed(ids: number[], at: Date): Promise<void> {
      if (ids.length === 0) return;
      await db
        .updateTable("gift_card_sale")
        .set({ void_pushed_at: at })
        .where("id", "in", ids)
        .where("void_pushed_at", "is", null)
        .execute();
    },

    async markVoided(id: number, input: { at: Date; by: AuthId; reason: string }): Promise<void> {
      await db
        .updateTable("gift_card_sale")
        .set({ voided_at: input.at, voided_by: input.by, void_reason: input.reason })
        .where("id", "=", id)
        .where("voided_at", "is", null)
        .execute();
    },
  };
}

export type GiftCardSaleRepository = ReturnType<typeof giftCardSaleRepository>;
