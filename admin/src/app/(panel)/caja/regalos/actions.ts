"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { isDuplicateKeyError } from "@/db";
import { repositories } from "@/db/repositories";
import { can } from "@/lib/auth-policy";
import { ForbiddenError, requireCapability } from "@/lib/dal";
import { isEaLocalDate } from "@/lib/ea";
import { buildGiftCardShareText, giftPaidAt, voidBlockReason } from "@/lib/gift-cards";
import {
  activateGiftCard,
  createGiftCard,
  getGiftCard,
  voidGiftCard,
  type GiftCardDto,
} from "@/lib/stampee/client";
import { presentableFirstName, waMeLink } from "@/lib/whatsapp/manual-reminder";

import { normalizePhoneE164 } from "../../clientes/identity";

/**
 * Las escrituras de **Caja → Tarjetas regalo**.
 *
 * Confirmar el pago de una tarjeta es registrar plata que entró, así que vive
 * acá y no en Stampee: la venta queda en `gift_card_sale` (migración `033`) y
 * la sincronización de la noche la manda al CRM como `bono:<código>`. Después,
 * y solo si la venta quedó, se activa la tarjeta en Stampee con
 * `paidRef = bono:<código>` (idempotente). Si Stampee no la activa, la venta se
 * borra —todavía no viajó— y se dice: una tarjeta sin activar no es una venta.
 *
 * Todas devuelven el resultado en vez de lanzarlo (un throw llega al navegador
 * como un digest opaco). Capacidad: `regalos:vender` (dueña y recepción).
 */

export type GiftActionResult =
  | { ok: true; message: string; whatsapp: string | null; code: string }
  | { ok: false; message: string };

const MAX_PESOS = 9_999_999;

const ConfirmSchema = z.object({
  cardId: z.string().min(1).max(64),
  method: z.enum(["efectivo", "transferencia", "otro"]),
  paidOn: z.string().refine(isEaLocalDate),
  amount: z.number().int().min(1).max(MAX_PESOS),
  paidRef: z.string().max(120).optional(),
});

const SellSchema = z.object({
  tierId: z.string().min(1).max(64),
  buyerName: z.string().trim().min(2).max(80),
  buyerPhone: z.string().trim().min(7).max(30),
  recipientName: z.string().trim().max(40).optional(),
  message: z.string().trim().max(140).optional(),
  method: z.enum(["efectivo", "transferencia", "otro"]),
  paidRef: z.string().max(120).optional(),
});

const VoidSchema = z.object({
  saleId: z.number().int().positive(),
  // Stampee guarda hasta 200.
  reason: z.string().trim().min(3).max(200),
});

/** El chat con la compradora, con el link a la tarjeta y sin precio. */
function buyerLink(card: GiftCardDto): string | null {
  const phone = normalizePhoneE164(card.buyerPhone);
  if (phone === null || !card.publicUrl) return null;
  return waMeLink(
    phone,
    buildGiftCardShareText({
      buyerFirstName: presentableFirstName(card.buyerName),
      recipientName: card.recipientName,
      code: card.code,
      url: card.publicUrl,
    }),
  );
}

async function guard(): Promise<
  { ok: true; session: Awaited<ReturnType<typeof requireCapability>> } | { ok: false; message: string }
> {
  try {
    return { ok: true, session: await requireCapability("regalos:vender") };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) return { ok: false, message: "Tu rol no puede vender tarjetas regalo." };
    console.error("[regalos] no se pudo verificar la sesión", error);
    return { ok: false, message: "No se pudo verificar la sesión." };
  }
}

/**
 * **Confirmar pago** de un pedido (`pending_payment`): la venta en el panel, y
 * después la tarjeta activa en Stampee. Repetirlo es seguro: la UNIQUE por
 * tarjeta no deja dos ventas, y la activación con el mismo `paidRef` es
 * idempotente en Stampee.
 */
export async function confirmarPagoRegalo(input: z.input<typeof ConfirmSchema>): Promise<GiftActionResult> {
  const parsed = ConfirmSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Faltan datos del pago: método, fecha y monto." };
  const auth = await guard();
  if (!auth.ok) return auth;

  const now = new Date();
  const paidAt = giftPaidAt(parsed.data.paidOn, now);
  if (paidAt === null) return { ok: false, message: "La fecha del pago no puede ser futura." };

  try {
    const fresh = await getGiftCard(parsed.data.cardId);
    if (!fresh.ok) return { ok: false, message: fresh.message };
    return await confirmCard(fresh.card, { ...parsed.data, paidAt, userId: auth.session.userId, now });
  } catch (error) {
    unstable_rethrow(error);
    console.error("[regalos] no se pudo confirmar el pago", error);
    return { ok: false, message: "No se pudo confirmar el pago. Intenta de nuevo." };
  }
}

async function confirmCard(
  card: GiftCardDto,
  input: {
    method: "efectivo" | "transferencia" | "otro";
    amount: number;
    paidRef?: string;
    paidAt: Date;
    userId: string;
    now: Date;
  },
): Promise<GiftActionResult> {
  const paidRef = `bono:${card.code}`;
  const db = getDb();
  const repos = repositories(db);
  const existing = await repos.giftCardSales.findByCardId(card.id);

  if (card.status === "active" && card.paidRef === paidRef && existing !== undefined) {
    return { ok: true, message: `La tarjeta ${card.code} ya estaba pagada.`, whatsapp: buyerLink(card), code: card.code };
  }
  if (card.status !== "pending_payment" && !(card.status === "active" && card.paidRef === paidRef)) {
    return {
      ok: false,
      message:
        card.status === "void"
          ? `La tarjeta ${card.code} está anulada.`
          : `La tarjeta ${card.code} ya no está esperando pago.`,
    };
  }
  if (existing?.voided_at) {
    return { ok: false, message: `La venta de ${card.code} se anuló. No se puede volver a confirmar.` };
  }

  let saleId = existing?.id ?? null;
  let inserted = false;
  if (saleId === null) {
    try {
      saleId = await db.transaction().execute(async (trx) => {
        const tx = repositories(trx);
        const id = await tx.giftCardSales.insert({
          stampee_gift_card_id: card.id,
          code: card.code,
          tier_name: card.tierName,
          amount: input.amount,
          method: input.method,
          paid_at: input.paidAt,
          paid_ref: input.paidRef?.trim() || null,
          buyer_name: card.buyerName,
          buyer_phone: card.buyerPhone,
          created_by: input.userId,
        });
        await tx.auditLog.append({
          actorUserId: input.userId,
          action: "gift.sale",
          entity: "gift_card_sale",
          entityId: id,
          after: { code: card.code, amount: input.amount, method: input.method, paidAt: input.paidAt },
          at: input.now,
        });
        return id;
      });
      inserted = true;
    } catch (error) {
      // Dos confirmaciones a la vez: la otra ganó. Se sigue con la suya.
      if (!isDuplicateKeyError(error)) throw error;
      saleId = (await repos.giftCardSales.findByCardId(card.id))?.id ?? null;
      if (saleId === null) throw error;
    }
  }

  const activated = await activateGiftCard(card.id, {
    paidAt: input.paidAt.toISOString(),
    method: input.method,
    paidAmountCop: input.amount,
    paidRef,
  });
  if (!activated.ok) {
    if (inserted) await repos.giftCardSales.deleteUnpushed(saleId);
    if (activated.code === "ALREADY_ACTIVE" || activated.code === "NOT_PENDING") {
      return {
        ok: false,
        message: `La tarjeta ${card.code} ya se había confirmado por otro lado. Revísala en Stampee antes de cobrarla.`,
      };
    }
    return { ok: false, message: `${activated.message}. No quedó registrada la venta; intenta de nuevo.` };
  }

  revalidatePath("/caja/regalos");
  revalidatePath("/caja");
  return {
    ok: true,
    message: `Listo: ${card.code} quedó pagada y activa.`,
    whatsapp: buyerLink(activated.card),
    code: card.code,
  };
}

/** **Vender en el estudio**: el pedido y su pago en un solo paso. */
export async function venderRegaloEnEstudio(input: z.input<typeof SellSchema>): Promise<GiftActionResult> {
  const parsed = SellSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Revisa el monto, el nombre y el celular de quien compra." };
  const auth = await guard();
  if (!auth.ok) return auth;

  const phone = normalizePhoneE164(parsed.data.buyerPhone);
  if (phone === null) return { ok: false, message: "Ese celular no se reconoce. Escríbelo con sus diez dígitos." };

  try {
    const created = await createGiftCard({
      tierId: parsed.data.tierId,
      buyer: { name: parsed.data.buyerName, phone },
      recipientName: parsed.data.recipientName || null,
      message: parsed.data.message || null,
      source: "sale",
    });
    if (!created.ok) return { ok: false, message: created.message };
    const now = new Date();
    return await confirmCard(created.card, {
      method: parsed.data.method,
      amount: created.card.amountCop,
      paidRef: parsed.data.paidRef,
      paidAt: now,
      userId: auth.session.userId,
      now,
    });
  } catch (error) {
    unstable_rethrow(error);
    console.error("[regalos] no se pudo vender la tarjeta", error);
    return { ok: false, message: "No se pudo vender la tarjeta. Si ya aparece en Pedidos, confírmala desde ahí." };
  }
}

/**
 * **Anular** una venta: la tarjeta queda anulada en Stampee y la venta, en el
 * panel. Si ya había viajado a Actual, la noche manda el ajuste negativo
 * (`bono:<código>:adj1`), y eso solo lo decide la dueña.
 */
export async function anularVentaRegalo(input: z.input<typeof VoidSchema>): Promise<GiftActionResult> {
  const parsed = VoidSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: "Escribe por qué se anula." };
  const auth = await guard();
  if (!auth.ok) return auth;

  try {
    const db = getDb();
    const sale = await repositories(db).giftCardSales.findById(parsed.data.saleId);
    if (sale === undefined) return { ok: false, message: "Esa venta ya no está." };

    const fresh = await getGiftCard(sale.stampee_gift_card_id);
    if (!fresh.ok) return { ok: false, message: fresh.message };

    const blocked = voidBlockReason({
      voided: sale.voided_at !== null,
      pushed: sale.pushed_to_ingest_at !== null,
      cardStatus: fresh.card.status,
      canFixAfterSync: can(auth.session.role, "cuenta:corregir-tras-cierre"),
    });
    if (blocked !== null) return { ok: false, message: blocked };

    if (fresh.card.status !== "void") {
      const voided = await voidGiftCard(sale.stampee_gift_card_id, parsed.data.reason);
      if (!voided.ok) return { ok: false, message: voided.message };
    }

    const now = new Date();
    await db.transaction().execute(async (trx) => {
      const tx = repositories(trx);
      await tx.giftCardSales.markVoided(sale.id, { at: now, by: auth.session.userId, reason: parsed.data.reason });
      await tx.auditLog.append({
        actorUserId: auth.session.userId,
        action: "gift.void",
        entity: "gift_card_sale",
        entityId: sale.id,
        before: { code: sale.code, amount: sale.amount, pushed: sale.pushed_to_ingest_at !== null },
        reason: parsed.data.reason,
        at: now,
      });
    });

    revalidatePath("/caja/regalos");
    revalidatePath("/caja");
    return {
      ok: true,
      code: sale.code,
      whatsapp: null,
      message:
        sale.pushed_to_ingest_at === null
          ? `Venta de ${sale.code} anulada. No llega a Actual.`
          : `Venta de ${sale.code} anulada. Esta noche sale el ajuste negativo a Actual.`,
    };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[regalos] no se pudo anular la venta", error);
    return { ok: false, message: "No se pudo anular. Intenta de nuevo." };
  }
}

/** **Descartar** un pedido que nunca se pagó: la tarjeta queda anulada en Stampee. */
export async function descartarPedidoRegalo(cardId: string): Promise<GiftActionResult> {
  if (typeof cardId !== "string" || cardId === "" || cardId.length > 64) {
    return { ok: false, message: "El pedido no es válido." };
  }
  const auth = await guard();
  if (!auth.ok) return auth;
  try {
    const fresh = await getGiftCard(cardId);
    if (!fresh.ok) return { ok: false, message: fresh.message };
    if (fresh.card.status !== "pending_payment") {
      return { ok: false, message: `La tarjeta ${fresh.card.code} ya no es un pedido sin pagar.` };
    }
    const voided = await voidGiftCard(cardId, "Pedido sin pagar, descartado desde el panel");
    if (!voided.ok) return { ok: false, message: voided.message };
    revalidatePath("/caja/regalos");
    return { ok: true, code: fresh.card.code, whatsapp: null, message: `Pedido ${fresh.card.code} descartado.` };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[regalos] no se pudo descartar el pedido", error);
    return { ok: false, message: "No se pudo descartar. Intenta de nuevo." };
  }
}

/** El chat con la compradora de una tarjeta ya pagada, para reenviársela. */
export async function enlaceCompradoraRegalo(cardId: string): Promise<
  { ok: true; url: string; already: boolean; sentLabel: string } | { ok: false; message: string }
> {
  const auth = await guard();
  if (!auth.ok) return auth;
  const fresh = await getGiftCard(cardId);
  if (!fresh.ok) return { ok: false, message: fresh.message };
  const url = buyerLink(fresh.card);
  if (url === null) {
    return { ok: false, message: "No hay celular de la compradora o Stampee no devolvió el link de la tarjeta." };
  }
  return { ok: true, url, already: false, sentLabel: "" };
}
