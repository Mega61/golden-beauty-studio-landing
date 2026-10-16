"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";

import { getDb } from "@/db/client";
import { repositories } from "@/db/repositories";
import { ForbiddenError, requireCapability } from "@/lib/dal";

import { AD_CHANNEL_LABEL, parseAdSpendForm } from "./acquisition";

/**
 * La única escritura de Reportes: la inversión en anuncios de un mes.
 *
 * Es de la dueña (`pauta:registrar`). Recepción ve el reporte —tiene
 * `reportes:ver`— pero el formulario no se le dibuja, y si lo arma a mano esta
 * acción la rebota igual: un botón escondido no es un permiso.
 *
 * Reemplaza la cifra de `(mes, canal)` en vez de sumarla —quien vuelve a
 * guardar está corrigiendo— y deja el antes y el después en `audit_log`, en la
 * misma transacción: una cifra que decide cuánto se invierte no se cambia sin
 * huella.
 */

export type AdSpendActionResult = { ok: boolean; message: string };

export async function guardarInversion(
  _previous: AdSpendActionResult | null,
  form: FormData,
): Promise<AdSpendActionResult> {
  let userId: string;
  try {
    ({ userId } = await requireCapability("pauta:registrar"));
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) {
      return { ok: false, message: "Solo la dueña registra la inversión en anuncios." };
    }
    throw error;
  }

  const parsed = parseAdSpendForm({
    month: form.get("month"),
    channel: form.get("channel"),
    amount: form.get("amount"),
    notes: form.get("notes"),
  });
  if (!parsed.ok) return { ok: false, message: parsed.message };

  const { month, channel, amountCop, notes } = parsed.value;

  try {
    await getDb()
      .transaction()
      .execute(async (trx) => {
        const repos = repositories(trx);
        const before = await repos.adSpend.find(month, channel);
        await repos.adSpend.upsert({ month, channel, amountCop, notes, updatedBy: userId });
        await repos.auditLog.append({
          actorUserId: userId,
          action: "ad_spend.save",
          entity: "ad_spend",
          entityId: `${month}:${channel}`,
          before:
            before === undefined
              ? undefined
              : { amount_cop: before.amount_cop, notes: before.notes },
          after: { amount_cop: amountCop, notes },
          at: new Date(),
        });
      });
  } catch (error) {
    console.error("[reportes] no se pudo guardar la inversión", error);
    return {
      ok: false,
      message:
        "No se pudo guardar. Si es la primera vez, falta aplicar la migración 023 (ad_spend); si no, la base no respondió.",
    };
  }

  revalidatePath("/reportes");
  return {
    ok: true,
    message: `Guardado: ${AD_CHANNEL_LABEL[channel]} en ${month}.`,
  };
}
