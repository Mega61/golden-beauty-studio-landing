"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { getDb } from "@/db/client";
import { auditLogRepository } from "@/db/repositories";
import { ForbiddenError, requireCapability } from "@/lib/dal";
import { instantToEaDate } from "@/lib/ea";
import { redeemCard } from "@/lib/stampee/client";

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
