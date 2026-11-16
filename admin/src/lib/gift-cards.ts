/**
 * **Tarjetas regalo** — las reglas, puras y testeadas.
 *
 * La tarjeta vive en Stampee (`lib/stampee/client.ts` es lo único que le
 * habla); la plata, en el panel. Este módulo no toca ni la red ni la base: lo
 * usan la hoja de la cuenta (en el navegador), `cerrarCuenta()` y la pantalla
 * de Caja → Tarjetas regalo, que no pueden decir tres cosas distintas.
 *
 * ## Dos clases de tarjeta
 *
 * - **Pagada** (`funded`): alguien la compró y esa plata ya entró a Actual el
 *   día de la venta (`gift_card_sale`, `bono:<código>`). Al redimirla es un
 *   **pago** con método `bono` por lo que cubra de la cuenta, que no viaja otra
 *   vez. La comisión no cambia: se calcula sobre lo cobrado, como siempre.
 * - **Promocional** (sin plata detrás, la del calendario de adviento): es un
 *   **descuento** que compite con las promos —gana el mayor, nunca se suman—
 *   y respeta su ticket mínimo y su regla de destinataria.
 *
 * ## Un solo uso
 *
 * La tarjeta se usa entera en una visita. Si el servicio cuesta más, el resto
 * se paga con otro método; si cuesta menos, no hay vueltas (lo dicen los
 * términos de la página pública).
 */

import { EA_TIME_ZONE, eaLocalToInstant, instantToEaDate, parseEaLocalDateTime } from "@/lib/ea/datetime";

/** El alfabeto de Crockford sin I, L, O ni U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BLOCK = `[${CROCKFORD}]{4}`;

/** `TR-XXXX-XXXX`. Los cupones del adviento son `GB-…` y no chocan. */
export const GIFT_CODE_RE = new RegExp(`^TR-${BLOCK}-${BLOCK}$`);

/**
 * Lo que alguien escribió → el código canónico, o `null` si no puede ser uno.
 *
 * Se perdona lo que se equivoca una persona leyendo una tarjeta en voz alta:
 * minúsculas, espacios, guiones de más o de menos, y las letras que Crockford
 * confunde a propósito (O→0, I/L→1). La U no existe en el alfabeto y no se
 * adivina.
 */
export function normalizeGiftCode(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const compact = raw.toUpperCase().replace(/[\s\-_.]/g, "");
  if (!compact.startsWith("TR")) return null;
  const body = compact
    .slice(2)
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (body.length !== 8) return null;
  const code = `TR-${body.slice(0, 4)}-${body.slice(4)}`;
  return GIFT_CODE_RE.test(code) ? code : null;
}

/** La llave de la redención en Stampee: la cuenta de la cita. */
export function giftCardRedeemRef(eaAppointmentId: number): string {
  return `ea-appt:${eaAppointmentId}`;
}

// ── La tarjeta, como la ve el panel ─────────────────────────────────────────

export type GiftCardStatus = "pending_payment" | "active" | "redeemed" | "void";
export type GiftCardEffectiveStatus = GiftCardStatus | "expired";

/** Lo que las reglas necesitan del `GiftCardDto` de Stampee. */
export type GiftCardFacts = {
  code: string;
  amountCop: number;
  status: GiftCardStatus;
  effectiveStatus?: GiftCardEffectiveStatus;
  funded: boolean;
  tierName: string | null;
  recipientName: string | null;
  /** `YYYY-MM-DD`. */
  validFrom: string | null;
  validTo: string | null;
  minTicketCop: number | null;
  rules: { recipient?: "any" | "new_or_dormant" } | null;
  redeemedRef: string | null;
};

/**
 * Lo que cruza a la hoja y al cálculo de la cuenta: el monto y si es pago o
 * descuento. **No es una autoridad**: el servidor vuelve a leer la tarjeta de
 * Stampee al guardar, igual que vuelve a valorar los servicios.
 */
export type GiftCardQuote = {
  code: string;
  amountCop: number;
  funded: boolean;
  /** Solo promocionales: el subtotal mínimo para que aplique. */
  minTicketCop: number | null;
  tierName: string | null;
  recipientName: string | null;
  validTo: string | null;
};

export function quoteOf(card: GiftCardFacts): GiftCardQuote {
  return {
    code: card.code,
    amountCop: card.amountCop,
    funded: card.funded,
    minTicketCop: card.minTicketCop,
    tierName: card.tierName,
    recipientName: card.recipientName,
    validTo: card.validTo,
  };
}

export type GiftCardCheck = { ok: true; quote: GiftCardQuote } | { ok: false; message: string };

/**
 * ¿Esta tarjeta se puede usar en esta cuenta?
 *
 * - Activa y dentro de su vigencia (el día **de la cita**, no el de hoy).
 * - Ya redimida **en esta misma cuenta** también vale: es volver a guardar una
 *   cuenta que ya la usó, y Stampee lo trata como idempotente.
 * - Promocional con `recipient = new_or_dormant`: solo para una clienta nueva
 *   o de "Te extrañamos". `null` = el historial no respondió, y ante la duda
 *   no se regala.
 *
 * El ticket mínimo no se mira acá: depende del subtotal, que cambia mientras
 * se arma la cuenta. Lo mira {@link giftCardDiscount}.
 */
export function checkGiftCard(
  card: GiftCardFacts,
  ctx: { date: string; redeemRef: string; newOrDormant: boolean | null },
): GiftCardCheck {
  const own = card.status === "redeemed" && card.redeemedRef === ctx.redeemRef;
  if (!own) {
    if (card.status === "pending_payment") {
      return { ok: false, message: `La tarjeta ${card.code} todavía no está pagada. Confirma el pago en Caja → Tarjetas regalo.` };
    }
    if (card.status === "redeemed") {
      return { ok: false, message: `La tarjeta ${card.code} ya se usó en otra visita.` };
    }
    if (card.status === "void") return { ok: false, message: `La tarjeta ${card.code} está anulada.` };
  }
  if (card.validFrom !== null && ctx.date < card.validFrom) {
    return { ok: false, message: `La tarjeta ${card.code} vale desde el ${card.validFrom}.` };
  }
  if (card.validTo !== null && ctx.date > card.validTo) {
    return { ok: false, message: `La tarjeta ${card.code} venció el ${card.validTo}.` };
  }
  if (!card.funded && card.rules?.recipient === "new_or_dormant" && ctx.newOrDormant !== true) {
    return {
      ok: false,
      message:
        ctx.newOrDormant === null
          ? `La tarjeta ${card.code} es solo para clientas nuevas y no se pudo revisar el historial. Intenta de nuevo en un momento.`
          : `La tarjeta ${card.code} es solo para clientas nuevas o que no venían hace tiempo.`,
    };
  }
  if (!(card.amountCop > 0)) return { ok: false, message: `La tarjeta ${card.code} no tiene monto.` };
  return { ok: true, quote: quoteOf(card) };
}

/**
 * El descuento de una tarjeta **promocional** sobre este subtotal, o `null` si
 * no aplica (es pagada, o el subtotal no llega al mínimo). Nunca más que el
 * subtotal: no hay vueltas.
 */
export function giftCardDiscount(quote: GiftCardQuote | null, subtotal: number): number | null {
  if (quote === null || quote.funded) return null;
  if (quote.minTicketCop !== null && subtotal < quote.minTicketCop) return null;
  const discount = Math.min(quote.amountCop, Math.max(subtotal, 0));
  return discount > 0 ? discount : null;
}

/**
 * Lo que una tarjeta **pagada** cubre de lo cobrado: todo lo que alcance, una
 * sola vez. `0` = no aplica (es promocional, o la cuenta quedó en cero).
 */
export function giftCardPayment(quote: GiftCardQuote | null, amountCharged: number): number {
  if (quote === null || !quote.funded) return 0;
  return Math.min(quote.amountCop, Math.max(amountCharged, 0));
}

/** El texto del motivo de una cuenta con tarjeta promocional. */
export function giftCardReasonText(code: string): string {
  return `bono ${code}`;
}

/** El código guardado en el motivo de una cuenta, o `null`. */
export function giftCodeFromReason(reason: string | null | undefined): string | null {
  const match = /^bono (TR-\S+)/.exec(reason ?? "");
  return match === null ? null : normalizeGiftCode(match[1]);
}

// ── La venta ────────────────────────────────────────────────────────────────

/** El nombre del "servicio" en las notas de Actual. */
export function giftSaleServiceName(tierName: string | null): string {
  return tierName ? `Tarjeta regalo ${tierName}` : "Tarjeta regalo";
}

/**
 * El mensaje para la compradora, con el link a su tarjeta. **Sin precio**,
 * como todo lo que sale por WhatsApp del estudio.
 */
export function buildGiftCardShareText(input: {
  buyerFirstName: string | null;
  recipientName: string | null;
  code: string;
  url: string;
}): string {
  const greeting = input.buyerFirstName ? `¡Hola, ${input.buyerFirstName}! ✨` : "¡Hola! ✨";
  const para = input.recipientName
    ? `Ya está lista la tarjeta regalo para ${input.recipientName} 🎁`
    : "Ya está lista tu tarjeta regalo de Golden Beauty Studio 🎁";
  return [
    greeting,
    "",
    "Recibimos tu pago, ¡gracias!",
    para,
    `Código: ${input.code}`,
    "",
    `👉 ${input.url}`,
    "",
    input.recipientName
      ? "Compártele el link: desde ahí puede ver su regalo y reservar su cita. 🤍"
      : "Compártela con quien quieras: desde el link puede escribir su nombre y reservar su cita. 🤍",
  ].join("\n");
}

export const GIFT_PAYMENT_LABEL: Record<"efectivo" | "transferencia" | "otro", string> = {
  efectivo: "Efectivo",
  transferencia: "Transferencia",
  otro: "Otro",
};

/** Las ventas de tarjetas de un día, por método, para cuadrar el cajón. Sin las anuladas. */
export type GiftSalesTotals = {
  efectivo: number;
  transferencia: number;
  otro: number;
  total: number;
  count: number;
  /** Anuladas ese día: se listan, no suman. */
  voided: number;
};

export function summarizeGiftSales(
  sales: readonly { method: "efectivo" | "transferencia" | "otro"; amount: number; voided: boolean }[],
): GiftSalesTotals {
  const totals: GiftSalesTotals = { efectivo: 0, transferencia: 0, otro: 0, total: 0, count: 0, voided: 0 };
  for (const sale of sales) {
    if (sale.voided) {
      totals.voided += 1;
      continue;
    }
    totals[sale.method] += sale.amount;
    totals.total += sale.amount;
    totals.count += 1;
  }
  return totals;
}

/**
 * ¿Se puede anular esta venta? `null` = sí; si no, por qué.
 *
 * - Una tarjeta ya usada no se anula: el servicio ya se prestó con esa plata.
 * - Una venta que ya llegó a Actual sí, pero solo la dueña: sale como ajuste
 *   negativo (`bono:<código>:adj1`), igual que corregir una cuenta ya enviada.
 */
export function voidBlockReason(input: {
  voided: boolean;
  pushed: boolean;
  cardStatus: GiftCardStatus | null;
  canFixAfterSync: boolean;
}): string | null {
  if (input.voided) return "La venta ya está anulada.";
  if (input.cardStatus === "redeemed") return "La tarjeta ya se usó: no se puede anular la venta.";
  if (input.pushed && !input.canFixAfterSync) {
    return "La venta ya llegó a Actual. Solo la dueña la puede anular (sale como ajuste).";
  }
  return null;
}

// ── El pedido público ───────────────────────────────────────────────────────

export type GiftOrder = {
  tierId: string;
  buyerName: string;
  /** E.164 (`+573001234567`). */
  buyerPhone: string;
  recipientName: string | null;
  message: string | null;
  ref: string | null;
};

const ORDER_NAME_MAX = 80;
const ORDER_MESSAGE_MAX = 140;
const RECIPIENT_MIN = 2;
const RECIPIENT_MAX = 40;

/**
 * El cuerpo de `POST /api/public/gift-cards/order`, validado. El celular sale
 * en E.164: la landing lo manda tal como se escribió ("300 123 4567"), y se
 * acepta con o sin indicativo de Colombia.
 */
export function parseGiftOrder(
  body: unknown,
  normalizePhone: (raw: string) => string | null = normalizeColombianPhone,
): { ok: true; order: GiftOrder } | { ok: false; field: string } {
  if (typeof body !== "object" || body === null) return { ok: false, field: "body" };
  const raw = body as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "");

  const tierId = text(raw.tierId);
  if (tierId === "" || tierId.length > 64) return { ok: false, field: "tierId" };

  const buyer = typeof raw.buyer === "object" && raw.buyer !== null ? (raw.buyer as Record<string, unknown>) : {};
  const buyerName = text(buyer.name);
  if (buyerName.length < 2 || buyerName.length > ORDER_NAME_MAX) return { ok: false, field: "buyer.name" };
  const buyerPhone = normalizePhone(text(buyer.phone));
  if (buyerPhone === null) return { ok: false, field: "buyer.phone" };

  const recipient = text(raw.recipientName);
  if (recipient !== "" && (recipient.length < RECIPIENT_MIN || recipient.length > RECIPIENT_MAX)) {
    return { ok: false, field: "recipientName" };
  }
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (message.length > ORDER_MESSAGE_MAX) return { ok: false, field: "message" };

  const ref = text(raw.ref).toLowerCase();
  if (ref !== "" && !/^[a-z0-9_-]{1,40}$/.test(ref)) return { ok: false, field: "ref" };

  return {
    ok: true,
    order: {
      tierId,
      buyerName,
      buyerPhone,
      recipientName: recipient === "" ? null : recipient,
      message: message === "" ? null : message,
      ref: ref === "" ? null : ref,
    },
  };
}

/**
 * Un celular de Colombia como lo escribe una persona → E.164, o `null`. Diez
 * dígitos que empiezan por 3, con o sin `57`/`+57` adelante. Es la misma
 * llave que usa Stampee (los últimos diez dígitos).
 */
export function normalizeColombianPhone(raw: string): string | null {
  if (/\p{L}/u.test(raw)) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.length === 12 && digits.startsWith("57")) digits = digits.slice(2);
  if (digits.length !== 10 || !digits.startsWith("3")) return null;
  return `+57${digits}`;
}

/**
 * El instante del pago de una venta. Hoy = ahora; un día anterior (la
 * transferencia que llegó ayer y se confirma hoy) = mediodía de ese día en
 * Bogotá, que es lo que decide su día de caja. El futuro no se acepta (`null`).
 */
export function giftPaidAt(paidOn: string, now: Date): Date | null {
  const today = instantToEaDate(now);
  if (paidOn > today) return null;
  if (paidOn === today) return now;
  return eaLocalToInstant(parseEaLocalDateTime(`${paidOn} 12:00:00`), EA_TIME_ZONE);
}

/**
 * Lo que la técnica lee cuando Stampee no acepta la tarjeta al guardar. Por
 * `error.code` del sobre; lo que no se reconoce cae en el texto general.
 */
export function redeemErrorMessage(code: string | null, status: number | null, giftCode: string): string {
  switch (code) {
    case "ALREADY_REDEEMED":
      return `La tarjeta ${giftCode} ya se usó en otra visita.`;
    case "NOT_PAID":
      return `La tarjeta ${giftCode} todavía no está pagada. Recepción confirma el pago en Caja → Tarjetas regalo.`;
    case "VOID":
      return `La tarjeta ${giftCode} está anulada. No se puede usar.`;
    case "EXPIRED":
      return `La tarjeta ${giftCode} ya venció para la fecha de esta cita.`;
    case "NOT_YET_VALID":
      return `La tarjeta ${giftCode} todavía no vale en la fecha de esta cita.`;
    case "NOT_FOUND":
      return `No hay ninguna tarjeta regalo con el código ${giftCode}.`;
    case "VALIDATION":
      return `La cuenta pide usar más de lo que vale la tarjeta ${giftCode}. Revisa el total y guarda de nuevo.`;
    default:
      return status !== null && status < 500
        ? `Stampee no aceptó la tarjeta ${giftCode}. Revísala con recepción.`
        : `Stampee no respondió para la tarjeta ${giftCode}.`;
  }
}

/**
 * ¿Una respuesta a "liberar la tarjeta" deja la cuenta libre de ella? Solo el
 * OK (incluye "ya estaba activa") y `REF_MISMATCH` (la tiene otra cuenta, no
 * esta). Todo lo demás se registra y se reintenta.
 */
export function releaseSettled(result: { ok: true } | { ok: false; code: string | null }): boolean {
  return result.ok || result.code === "REF_MISMATCH";
}
