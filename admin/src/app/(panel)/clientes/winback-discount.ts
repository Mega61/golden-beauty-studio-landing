import "server-only";

import { getDb } from "@/db/client";
import { winbackRepository } from "@/db/repositories";
import { instantToEaLocal, type EaLocalDateTime } from "@/lib/ea";
import { winbackDiscountApplies } from "@/lib/winback";

import { countsAsVisit, type HistoryEntry } from "./history";

/**
 * ¿Le toca a esta clienta el 10 % de "Te extrañamos" en una cita en `asOf`?
 *
 * Se le mandó el regalo (`winback_offer`) y no ha venido desde entonces: la
 * primera visita atendida después de mandarlo es la que lo usa. El historial
 * (EA ∪ Agenda Pro) lo trae quien pregunta —la cuenta en Hoy y la cotización
 * de `/reservar`, que ya lo leyeron para la primera visita—, y de acá solo sale
 * un sí/no, como la primera visita: ningún monto del historial cruza a la
 * cuenta. Cualquier falla es **no**.
 */
export async function hasWinbackDiscount(
  phone: string,
  entries: readonly HistoryEntry[],
  asOf: EaLocalDateTime,
): Promise<boolean> {
  try {
    const offer = await winbackRepository(getDb()).findOffer(phone);
    if (offer === null) return false;
    const sentAt = instantToEaLocal(offer.sentAt);
    const attendedSince = entries.some((e) => e.start > sentAt && e.start < asOf && countsAsVisit(e));
    return winbackDiscountApplies(
      { discountPercent: offer.discountPercent, sentAt, expiresOn: offer.expiresOn },
      asOf,
      attendedSince,
    );
  } catch (error) {
    console.error("[clientes] no se pudo revisar el regalo de Te extrañamos", error);
    return false;
  }
}
