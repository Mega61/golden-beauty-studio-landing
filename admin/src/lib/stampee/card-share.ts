/**
 * Mandarle a la clienta **su** tarjeta de sellos por WhatsApp —puro, testeado—.
 *
 * El CRM crea la tarjeta en Stampee la noche después de la primera visita con
 * la cuenta cerrada, y la crea **en silencio**: Stampee no le avisa a nadie, y
 * el link solo aparecía dentro de Fidelidad. Resultado: clientas nuevas con
 * tarjeta y sellos que nunca la vieron. Este módulo arma el mensaje con el link
 * y decide a quién todavía no se le mandó; el panel guarda quién lo mandó
 * (`stampee_card_share`, migración `029`).
 *
 * "Mandado" quiere decir que alguien tocó el botón, que abre el chat con el
 * texto ya escrito. Si después no le dio "enviar" en WhatsApp, el panel no se
 * entera — igual que con los recordatorios manuales.
 */

import { normalizePhoneE164 } from "@/app/(panel)/clientes/identity";
import { presentableFirstName, waMeLink } from "@/lib/whatsapp/manual-reminder";

import type { LoyaltyCard, LoyaltyRow } from "./model";

/**
 * Cuántos días hacia atrás una tarjeta sin mandar se sigue pidiendo.
 *
 * Las tarjetas de antes del panel las repartía la técnica a mano en el
 * mostrador, y el panel no sabe a quién sí: pedirlas todas sería una lista de
 * cien que nadie va a mirar. El botón sigue en cada tarjeta, para reenviar.
 */
export const SHARE_PENDING_DAYS = 30;

/** El link público de la tarjeta, como lo abre la clienta. */
export function cardUrl(cardBaseUrl: string | null, card: Pick<LoyaltyCard, "uniqueId">): string | null {
  return cardBaseUrl ? `${cardBaseUrl}/${card.uniqueId}` : null;
}

/**
 * El mensaje: mismo saludo y mismo tono que las confirmaciones, para que se
 * reconozca como del estudio. El link va solo en su renglón: WhatsApp lo
 * convierte en vista previa solo si no tiene texto pegado.
 */
export function buildCardShareText(input: {
  customerName: string | null;
  stamps: number;
  totalStamps: number;
  rewardName: string;
  url: string;
}): string {
  const name = presentableFirstName(input.customerName);
  const greeting = name === null ? "¡Hola! ✨" : `¡Hola, ${name}! ✨`;
  const progress =
    input.stamps === 1
      ? `Ya tienes 1 de ${input.totalStamps} sellos.`
      : `Ya tienes ${input.stamps} de ${input.totalStamps} sellos.`;
  const reward = input.rewardName ? ` Al completarla te ganas: ${input.rewardName} 🎁` : " Al completarla te ganas un premio 🎁";
  return [
    greeting,
    "",
    "Esta es tu tarjeta de sellos de Golden Beauty Studio 💅",
    `${progress}${reward}`,
    "",
    `👉 ${input.url}`,
    "",
    "Ábrela y guárdala en tu celular para tenerla siempre a mano. ¡Gracias por visitarnos! 🤍",
  ].join("\n");
}

/** El chat de WhatsApp con el mensaje ya escrito, o `null` sin número o sin link. */
export function cardShareLink(input: {
  phone: string | null | undefined;
  customerName: string | null;
  card: Pick<LoyaltyCard, "uniqueId" | "stamps" | "totalStamps" | "rewardName">;
  cardBaseUrl: string | null;
}): string | null {
  const e164 = normalizePhoneE164(input.phone);
  const url = cardUrl(input.cardBaseUrl, input.card);
  if (e164 === null || url === null) return null;
  return waMeLink(
    e164,
    buildCardShareText({
      customerName: input.customerName,
      stamps: input.card.stamps,
      totalStamps: input.card.totalStamps,
      rewardName: input.card.rewardName,
      url,
    }),
  );
}

/**
 * Las tarjetas activas, emitidas hace menos de {@link SHARE_PENDING_DAYS} días,
 * que nadie le ha mandado a su clienta. Una tarjeta sin fecha de emisión no
 * entra: no se puede saber si es de antes del panel.
 */
export function pendingShares(
  rows: readonly LoyaltyRow[],
  sent: ReadonlySet<string>,
  now: Date,
): LoyaltyRow[] {
  const since = now.getTime() - SHARE_PENDING_DAYS * 24 * 60 * 60 * 1000;
  return rows.filter(
    ({ client, card }) =>
      card.stage !== "canjeada" &&
      !sent.has(card.id) &&
      card.issuedAt !== null &&
      Date.parse(card.issuedAt) >= since &&
      normalizePhoneE164(client.mobile) !== null,
  );
}

/**
 * Qué dice la tarjeta de una cita en Hoy sobre la tarjeta de sellos, una vez
 * cerrada la cuenta:
 *
 * - `enviar`: tiene tarjeta y nadie se la ha mandado.
 * - `manana`: no tiene tarjeta todavía. El CRM la crea esta noche, con la
 *   visita que se acaba de cerrar; mañana sale en Fidelidad para mandarla.
 * - `null`: ya se la mandaron, o la cuenta sigue abierta, o no hay cómo saber.
 */
export type HoyCardShare =
  | { state: "enviar"; cardId: string; whatsapp: string }
  | { state: "manana" }
  | null;

export function hoyCardShare(input: {
  closed: boolean;
  cards: readonly LoyaltyCard[];
  /** La tarjeta que importa (`leadingCard`), o `null` si no tiene activas. */
  leading: LoyaltyCard | null;
  sent: ReadonlySet<string>;
  phone: string | null | undefined;
  customerName: string | null;
  cardBaseUrl: string | null;
}): HoyCardShare {
  if (!input.closed) return null;
  if (input.cards.length === 0) return { state: "manana" };
  // Tuvo tarjetas y todas están canjeadas: el CRM solo le emite tarjeta a
  // quien no tiene ninguna, así que no se le promete una para mañana.
  const card = input.leading;
  if (card === null || input.sent.has(card.id)) return null;
  const whatsapp = cardShareLink({
    phone: input.phone,
    customerName: input.customerName,
    card,
    cardBaseUrl: input.cardBaseUrl,
  });
  return whatsapp === null ? null : { state: "enviar", cardId: card.id, whatsapp };
}
