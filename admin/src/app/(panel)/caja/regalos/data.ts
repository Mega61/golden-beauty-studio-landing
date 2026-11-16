import "server-only";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import type { GiftCardSale } from "@/db/types";
import { instantToEaDate, type EaLocalDate } from "@/lib/ea";
import { listGiftCards, listGiftCardTiers, type GiftCardDto } from "@/lib/stampee/client";

/**
 * Los datos de **Caja → Tarjetas regalo**: los pedidos y tarjetas de Stampee,
 * cruzados con las ventas que el panel registró (`gift_card_sale`).
 *
 * Stampee caído no tumba la pantalla: se dice arriba y lo que sí está en el
 * panel (las ventas) se sigue viendo.
 */

/** Lo que la pantalla muestra de una tarjeta. Sin campos que no usa. */
export type GiftCardRow = {
  id: string;
  code: string;
  amountCop: number;
  tierName: string | null;
  status: GiftCardDto["status"];
  effectiveStatus: GiftCardDto["effectiveStatus"];
  funded: boolean;
  source: GiftCardDto["source"];
  buyerName: string | null;
  buyerPhone: string | null;
  recipientName: string | null;
  message: string;
  validTo: string | null;
  createdAt: string;
  redeemedAt: string | null;
  publicUrl: string | null;
};

/** La venta registrada en el panel, si la hay. */
export type GiftSaleRow = {
  id: number;
  cardId: string;
  code: string;
  amount: number;
  method: GiftCardSale["method"];
  paidOn: EaLocalDate;
  buyerName: string | null;
  tierName: string | null;
  pushed: boolean;
  voided: boolean;
  voidPushed: boolean;
};

export type TierOption = { id: string; name: string; amountCop: number };

export type RegalosView = {
  today: EaLocalDate;
  stampeeProblem: string | null;
  pending: GiftCardRow[];
  active: GiftCardRow[];
  redeemed: GiftCardRow[];
  tiers: TierOption[];
  sales: GiftSaleRow[];
};

function rowOf(card: GiftCardDto): GiftCardRow {
  return {
    id: card.id,
    code: card.code,
    amountCop: card.amountCop,
    tierName: card.tierName,
    status: card.status,
    effectiveStatus: card.effectiveStatus,
    funded: card.funded,
    source: card.source,
    buyerName: card.buyerName,
    buyerPhone: card.buyerPhone,
    recipientName: card.recipientName,
    message: card.message ?? "",
    validTo: card.validTo,
    createdAt: card.createdAt,
    redeemedAt: card.redeemedAt,
    publicUrl: card.publicUrl,
  };
}

export function saleRowOf(sale: GiftCardSale): GiftSaleRow {
  return {
    id: sale.id,
    cardId: sale.stampee_gift_card_id,
    code: sale.code,
    amount: sale.amount,
    method: sale.method,
    paidOn: instantToEaDate(sale.paid_at),
    buyerName: sale.buyer_name,
    tierName: sale.tier_name,
    pushed: sale.pushed_to_ingest_at !== null,
    voided: sale.voided_at !== null,
    voidPushed: sale.void_pushed_at !== null,
  };
}

export async function loadRegalosView(now: Date = new Date()): Promise<RegalosView> {
  const [pending, active, redeemed, tiers, sales] = await Promise.all([
    listGiftCards({ status: "pending_payment", limit: 100 }),
    listGiftCards({ status: "active", limit: 100 }),
    listGiftCards({ status: "redeemed", limit: 30 }),
    listGiftCardTiers({ enabledOnly: true }),
    repositories(getDb())
      .giftCardSales.listRecent(200)
      .catch((error: unknown) => {
        console.error("[regalos] no se pudieron leer las ventas", error);
        return [];
      }),
  ]);

  const problem = [pending, active, redeemed, tiers].find((r) => !r.ok);

  return {
    today: instantToEaDate(now),
    stampeeProblem: problem && !problem.ok ? problem.message : null,
    pending: pending.ok ? pending.cards.map(rowOf) : [],
    active: active.ok ? active.cards.map(rowOf) : [],
    redeemed: redeemed.ok ? redeemed.cards.map(rowOf) : [],
    tiers: tiers.ok
      ? tiers.tiers
          .filter((tier) => tier.isEnabled !== false)
          .sort((a, b) => a.sort - b.sort || a.amountCop - b.amountCop)
          .map((tier) => ({ id: tier.id, name: tier.name, amountCop: tier.amountCop }))
      : [],
    sales: sales.map(saleRowOf),
  };
}
