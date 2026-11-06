"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { auditLogRepository, stampeeCardShareRepository } from "@/db/repositories";
import { ForbiddenError, requireCapability } from "@/lib/dal";
import { instantToEaDate } from "@/lib/ea";
import { cardShareLink } from "@/lib/stampee/card-share";
import { loadLoyalty, redeemCard } from "@/lib/stampee/client";

import type { SendOutcome } from "../recordatorios/open-whatsapp";

export type RedeemActionResult = { ok: boolean; message: string };

const CardId = z.string().trim().min(1).max(120);

/**
 * "Aplicar premio": marca en Stampee que el premio de una tarjeta llena ya se
 * usó. No toca la cuenta de la cita: el descuento lo pone quien cierra la
 * cuenta, con el motivo de siempre. Esto solo cierra la tarjeta, para que la
 * clienta no pueda usar el mismo premio dos veces.
 */
export async function aplicarPremio(cardId: string): Promise<RedeemActionResult> {
  try {
    const session = await requireCapability("fidelidad:canjear");
    const parsed = CardId.safeParse(cardId);
    if (!parsed.success) return { ok: false, message: "Esa tarjeta no se reconoce." };

    const outcome = await redeemCard(parsed.data, {
      actorName: session.name || session.email,
      today: instantToEaDate(new Date()),
    });
    if (!outcome.ok) return outcome;

    await auditLogRepository(getDb())
      .append({
        actorUserId: session.userId,
        action: "fidelidad.canjear",
        entity: "stampee_card",
        entityId: parsed.data,
        after: { customer: outcome.customerName, reward: outcome.rewardName },
        at: new Date(),
      })
      // La tarjeta ya quedó canjeada en Stampee; una bitácora caída no la
      // descanjea ni tiene por qué decirle a la recepción que falló.
      .catch((error) => console.error("[fidelidad] no se pudo anotar el canje", error));

    revalidatePath("/fidelidad");
    revalidatePath("/hoy");
    revalidatePath("/clientes", "layout");

    const reward = outcome.rewardName ? ` (${outcome.rewardName})` : "";
    return {
      ok: true,
      message: outcome.historyRecorded
        ? `Premio de ${outcome.customerName}${reward} aplicado.`
        : `Premio de ${outcome.customerName}${reward} aplicado. Stampee no guardó el renglón en la historia de la tarjeta, pero la tarjeta sí quedó cerrada.`,
    };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Aplicar el premio es de la dueña o de recepción." };
    }
    console.error("[fidelidad] el canje falló", error);
    return { ok: false, message: "No se pudo aplicar el premio. Intenta de nuevo." };
  }
}

/**
 * "Enviar tarjeta": anota que se le mandó a la clienta el link de su tarjeta de
 * sellos y devuelve el chat de WhatsApp con el mensaje ya escrito.
 *
 * El link lo arma el servidor desde la tarjeta que Stampee tiene, no el
 * navegador: el número y el nombre son los de Stampee, que es a quien
 * pertenece la tarjeta. La fila va **antes** de abrir WhatsApp, como en los
 * recordatorios manuales; si después no se le da "enviar", el panel no se
 * entera, y el botón queda como "Reenviar" para eso.
 */
export async function enviarTarjeta(cardId: string): Promise<SendOutcome> {
  try {
    const session = await requireCapability("fidelidad:ver");
    const parsed = CardId.safeParse(cardId);
    if (!parsed.success) return { ok: false, message: "Esa tarjeta no se reconoce." };

    const loyalty = await loadLoyalty();
    if (!loyalty.ok) return { ok: false, message: loyalty.message };
    const owner = loyalty.data.clients.find((c) => c.cards.some((card) => card.id === parsed.data));
    const card = owner?.cards.find((c) => c.id === parsed.data);
    if (!owner || !card) return { ok: false, message: "Esa tarjeta ya no está en Stampee." };

    const url = cardShareLink({
      phone: owner.mobile,
      customerName: owner.name,
      card,
      cardBaseUrl: loyalty.data.cardBaseUrl,
    });
    if (url === null) {
      return {
        ok: false,
        message: loyalty.data.cardBaseUrl
          ? `${owner.name} no tiene un celular usable en Stampee.`
          : "Falta STAMPEE_APP_URL en el panel: no hay link de tarjeta para mandar.",
      };
    }

    const shares = stampeeCardShareRepository(getDb());
    const already = (await shares.listSentCardIds()).has(parsed.data);
    await shares.markSent(parsed.data, session.userId, new Date());

    revalidatePath("/fidelidad");
    revalidatePath("/hoy");
    revalidatePath("/clientes", "layout");
    return { ok: true, url, already, sentLabel: "Tarjeta enviada" };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Mandar la tarjeta es de la dueña o de recepción." };
    }
    console.error("[fidelidad] no se pudo anotar el envío de la tarjeta", error);
    return { ok: false, message: "No se pudo preparar el mensaje. Intenta de nuevo." };
  }
}
