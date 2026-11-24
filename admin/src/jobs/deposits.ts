import "server-only";

import { repositories, type Db } from "@/db";
import type { AppointmentDeposit } from "@/db/types";
import { depositServiceName } from "@/lib/deposits";
import { instantToEaDate, type EaLocalDate } from "@/lib/ea";
import { IngestError, type IngestClient, type PaymentLabel } from "@/lib/ingest-client";
import { buildDepositAdjustmentSourceTxId, buildDepositSourceTxId } from "@/lib/ingest-id";
import {
  buildDepositPayment,
  buildDepositRefundAdjustment,
  IngestPayloadError,
  type IngestPayment,
} from "@/lib/ingest-payload";

/**
 * **Los adelantos, al CRM.** Corre con la sincronización de la noche
 * (`jobs/nightly-sync.ts`) y con "Sincronizar ahora" de Caja.
 *
 * Un adelanto es ingreso del día en que entró: viaja como `abono:<id>`, sin
 * propina, con la clienta y "Adelanto cita <día>" como notas en Actual. Es la
 * venta que el bot de finanzas enlaza con la transferencia de ese día. No
 * depende de la cita ni de su cuenta: cada fila lleva su propia marca
 * `pushed_to_ingest_at`.
 *
 * Una devolución sale como `abono:<id>:adj1` en negativo, el día en que salió
 * la plata (`refund_pushed_at`). Si el adelanto y su devolución están los dos
 * pendientes, viajan en el mismo lote: los dos movimientos fueron reales.
 *
 * El día de caja anterior a `INGEST_SINCE` no se manda, como las cuentas.
 */

export type DepositPushPlan = {
  payments: IngestPayment[];
  /** Adelantos cuyo movimiento va en el lote. */
  depositIds: number[];
  /** Devoluciones cuyo ajuste va en el lote. */
  refundIds: number[];
  labels: Map<string, PaymentLabel>;
  skipped: { id: number; message: string }[];
};

/** El día de caja en que entró un adelanto. */
export function depositDay(row: Pick<AppointmentDeposit, "paid_at">): EaLocalDate {
  return instantToEaDate(row.paid_at);
}

/** El día de la cita del adelanto, para el rótulo, o `null`. */
function appointmentDayOf(row: Pick<AppointmentDeposit, "appointment_start_at">): string | null {
  return row.appointment_start_at === null ? null : instantToEaDate(row.appointment_start_at);
}

/**
 * Qué mandar, como función pura: el lote y qué marcar si llega.
 *
 * - Sin enviar → el adelanto (y su devolución, si ya la tiene).
 * - Enviado, con devolución sin ajuste → el ajuste negativo.
 *
 * `to` es el corte: una devolución de hoy espera a la noche, como la venta.
 */
export function planDepositPush(
  rows: readonly AppointmentDeposit[],
  opts: { since?: string | null; to: Date },
): DepositPushPlan {
  const plan: DepositPushPlan = { payments: [], depositIds: [], refundIds: [], labels: new Map(), skipped: [] };

  for (const row of rows) {
    const paidOn = depositDay(row);
    const label: PaymentLabel = {
      clientName: row.customer_name,
      serviceName: depositServiceName(appointmentDayOf(row)),
    };
    const wantsDeposit = row.pushed_to_ingest_at === null && row.paid_at < opts.to;
    const refundReady =
      row.refunded_at !== null &&
      row.refunded_amount !== null &&
      row.refund_method !== null &&
      row.refund_pushed_at === null &&
      row.refunded_at < opts.to;
    const sendsDeposit = wantsDeposit && !(opts.since && paidOn < opts.since);
    // Una devolución nunca viaja sin su adelanto: restaría plata que Actual no tiene.
    const wantsRefund = refundReady && (row.pushed_to_ingest_at !== null || sendsDeposit);

    const batch: IngestPayment[] = [];
    try {
      if (sendsDeposit) {
        batch.push(buildDepositPayment({ id: row.id, amount: row.amount, method: row.method, paidOn }));
      }
      if (wantsRefund && row.refunded_at !== null && row.refunded_amount !== null && row.refund_method !== null) {
        const refundedOn = instantToEaDate(row.refunded_at);
        if (!(opts.since && refundedOn < opts.since)) {
          batch.push(
            buildDepositRefundAdjustment({
              id: row.id,
              refundedAmount: row.refunded_amount,
              refundMethod: row.refund_method,
              refundedOn,
            }),
          );
        }
      }
    } catch (error) {
      if (!(error instanceof IngestPayloadError) && !(error instanceof Error && error.name === "IngestIdError")) {
        throw error;
      }
      plan.skipped.push({ id: row.id, message: error.message });
      continue;
    }

    for (const payment of batch) {
      plan.payments.push(payment);
      plan.labels.set(payment.source_tx_id, label);
      if (payment.source_tx_id === buildDepositSourceTxId(row.id)) plan.depositIds.push(row.id);
      if (payment.source_tx_id === buildDepositAdjustmentSourceTxId(row.id, 1)) plan.refundIds.push(row.id);
    }
  }

  return plan;
}

export type DepositSyncOutcome =
  | { state: "nada" }
  | { state: "apagado"; pending: number }
  | { state: "hecho"; deposits: number; refunds: number }
  | { state: "fallo"; message: string; retryable: boolean };

/**
 * Manda los adelantos pagados en `[from, to)` que falten, y las devoluciones
 * de ese rango. Idempotente: las llaves son por adelanto, y reenviar el mismo
 * lote no crea movimientos nuevos.
 */
export async function syncDeposits(
  deps: { db: Db; ingest: IngestClient | null },
  input: { from: Date; to: Date; now?: Date },
): Promise<DepositSyncOutcome> {
  const now = input.now ?? new Date();
  const repos = repositories(deps.db);
  const rows = await repos.appointmentDeposits.listPendingPush(input.from, input.to);
  const plan = planDepositPush(rows, { since: deps.ingest?.since ?? null, to: input.to });

  for (const skipped of plan.skipped) {
    console.error("[adelantos] un adelanto no puede viajar", skipped.id, skipped.message);
  }
  if (plan.payments.length === 0) return { state: "nada" };
  if (deps.ingest === null) return { state: "apagado", pending: plan.payments.length };

  try {
    await deps.ingest.push(plan.payments, plan.labels);
  } catch (error) {
    if (error instanceof IngestError) {
      console.error("[adelantos] el push de adelantos falló", error.message, error.body ?? "");
      return { state: "fallo", message: error.message, retryable: error.retryable };
    }
    throw error;
  }

  await deps.db.transaction().execute(async (trx) => {
    const tx = repositories(trx);
    await tx.appointmentDeposits.markPushed(plan.depositIds, now);
    await tx.appointmentDeposits.markRefundPushed(plan.refundIds, now);
    await tx.auditLog.append({
      actorUserId: null,
      action: "deposit.push",
      entity: "appointment_deposit",
      entityId: plan.depositIds[0] ?? plan.refundIds[0] ?? 0,
      after: { deposits: plan.depositIds, refunds: plan.refundIds },
      at: now,
    });
  });

  return { state: "hecho", deposits: plan.depositIds.length, refunds: plan.refundIds.length };
}

/** Una línea para el resumen de la noche. */
export function summarizeDepositSync(outcome: DepositSyncOutcome): string | null {
  switch (outcome.state) {
    case "nada":
      return null;
    case "apagado":
      return `adelantos: ${outcome.pending} movimiento(s) esperando (push apagado)`;
    case "hecho":
      return `adelantos: ${outcome.deposits} adelanto(s)${outcome.refunds > 0 ? ` y ${outcome.refunds} devolución(es)` : ""} enviados`;
    case "fallo":
      return `adelantos: falló — ${outcome.message}`;
  }
}
