import "server-only";

import { repositories, type Db } from "@/db";
import type { GiftCardSale } from "@/db/types";
import { giftSaleServiceName } from "@/lib/gift-cards";
import { instantToEaDate, type EaLocalDate } from "@/lib/ea";
import { IngestError, type IngestClient, type PaymentLabel } from "@/lib/ingest-client";
import { buildGiftSaleSourceTxId } from "@/lib/ingest-id";
import {
  buildGiftSalePayment,
  buildGiftSaleVoidAdjustment,
  IngestPayloadError,
  type GiftSaleForIngest,
  type IngestPayment,
} from "@/lib/ingest-payload";

/**
 * **Las tarjetas regalo vendidas, al CRM.** Corre con la sincronización de la
 * noche (`jobs/nightly-sync.ts`) y con "Sincronizar ahora" de Caja.
 *
 * Una venta es ingreso del día en que se pagó: viaja como `bono:<código>`, sin
 * propina, con la compradora y "Tarjeta regalo <nivel>" como notas en Actual.
 * No depende de ningún cierre del día (`day_close` es de las citas): cada fila
 * lleva su propia marca `pushed_to_ingest_at`.
 *
 * Una venta anulada **antes** de viajar no viaja nunca. Una anulada
 * **después** sale como `bono:<código>:adj1` en negativo (`void_pushed_at`):
 * Actual no cambia un monto ya importado.
 *
 * El día de caja anterior a `INGEST_SINCE` no se manda, como las cuentas.
 */

export type GiftSalePushPlan = {
  payments: IngestPayment[];
  /** Ventas cuyo movimiento va en el lote. */
  saleIds: number[];
  /** Anulaciones cuyo ajuste va en el lote. */
  voidIds: number[];
  labels: Map<string, PaymentLabel>;
  skipped: { code: string; message: string }[];
};

/** Fila → lo que necesita el armado del movimiento. */
export function giftSaleForIngest(row: GiftCardSale): GiftSaleForIngest {
  return { code: row.code, amount: row.amount, method: row.method, paidOn: instantToEaDate(row.paid_at) };
}

/**
 * Qué mandar, como función pura: el lote y qué marcar si llega.
 *
 * - Sin enviar y sin anular → la venta.
 * - Enviada y anulada, sin ajuste → el ajuste negativo.
 * - Anulada sin haber viajado → nada (y no se marca: nunca va a viajar).
 */
export function planGiftSalePush(
  rows: readonly GiftCardSale[],
  opts: { since?: string | null } = {},
): GiftSalePushPlan {
  const plan: GiftSalePushPlan = { payments: [], saleIds: [], voidIds: [], labels: new Map(), skipped: [] };

  for (const row of rows) {
    const sale = giftSaleForIngest(row);
    if (opts.since && sale.paidOn < opts.since) continue;

    const wantsSale = row.pushed_to_ingest_at === null && row.voided_at === null;
    const wantsVoid = row.pushed_to_ingest_at !== null && row.voided_at !== null && row.void_pushed_at === null;
    if (!wantsSale && !wantsVoid) continue;

    try {
      plan.payments.push(wantsSale ? buildGiftSalePayment(sale) : buildGiftSaleVoidAdjustment(sale));
    } catch (error) {
      if (!(error instanceof IngestPayloadError) && !(error instanceof Error && error.name === "IngestIdError")) {
        throw error;
      }
      plan.skipped.push({ code: row.code, message: error.message });
      continue;
    }
    (wantsSale ? plan.saleIds : plan.voidIds).push(row.id);
    plan.labels.set(buildGiftSaleSourceTxId(row.code), {
      clientName: row.buyer_name,
      serviceName: giftSaleServiceName(row.tier_name),
    });
  }

  return plan;
}

export type GiftSaleSyncOutcome =
  | { state: "nada" }
  | { state: "apagado"; pending: number }
  | { state: "hecho"; sales: number; voids: number }
  | { state: "fallo"; message: string; retryable: boolean };

/**
 * Manda las ventas de tarjetas pagadas en `[from, to)` que falten, y las
 * anulaciones posteriores al envío. Idempotente: las llaves son por código, y
 * reenviar el mismo lote no crea movimientos nuevos.
 */
export async function syncGiftCardSales(
  deps: { db: Db; ingest: IngestClient | null },
  input: { from: Date; to: Date; now?: Date },
): Promise<GiftSaleSyncOutcome> {
  const now = input.now ?? new Date();
  const repos = repositories(deps.db);
  const rows = await repos.giftCardSales.listPendingPush(input.from, input.to);
  const plan = planGiftSalePush(rows, { since: deps.ingest?.since ?? null });

  for (const skipped of plan.skipped) {
    console.error("[regalos] una venta no puede viajar", skipped.code, skipped.message);
  }
  if (plan.payments.length === 0) return { state: "nada" };
  if (deps.ingest === null) return { state: "apagado", pending: plan.payments.length };

  try {
    await deps.ingest.push(plan.payments, plan.labels);
  } catch (error) {
    if (error instanceof IngestError) {
      console.error("[regalos] el push de ventas falló", error.message, error.body ?? "");
      return { state: "fallo", message: error.message, retryable: error.retryable };
    }
    throw error;
  }

  await deps.db.transaction().execute(async (trx) => {
    const tx = repositories(trx);
    await tx.giftCardSales.markPushed(plan.saleIds, now);
    await tx.giftCardSales.markVoidPushed(plan.voidIds, now);
    await tx.auditLog.append({
      actorUserId: null,
      action: "gift.push",
      entity: "gift_card_sale",
      entityId: plan.saleIds[0] ?? plan.voidIds[0] ?? 0,
      after: { sales: plan.saleIds, voids: plan.voidIds },
      at: now,
    });
  });

  return { state: "hecho", sales: plan.saleIds.length, voids: plan.voidIds.length };
}

/** Una línea para el resumen de la noche. */
export function summarizeGiftSaleSync(outcome: GiftSaleSyncOutcome): string | null {
  switch (outcome.state) {
    case "nada":
      return null;
    case "apagado":
      return `tarjetas regalo: ${outcome.pending} movimiento(s) esperando (push apagado)`;
    case "hecho":
      return `tarjetas regalo: ${outcome.sales} venta(s)${outcome.voids > 0 ? ` y ${outcome.voids} anulación(es)` : ""} enviadas`;
    case "fallo":
      return `tarjetas regalo: falló — ${outcome.message}`;
  }
}

/** Para Caja: el día de caja de una venta. */
export function giftSaleDay(row: Pick<GiftCardSale, "paid_at">): EaLocalDate {
  return instantToEaDate(row.paid_at);
}
