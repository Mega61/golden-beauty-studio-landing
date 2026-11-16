import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { parseGiftOrder } from "@/lib/gift-cards";
import { createGiftCard } from "@/lib/stampee/client";

/**
 * **Pedir una tarjeta regalo** desde `/regalar` de la landing.
 *
 * Crea la tarjeta en Stampee como `pending_payment`: no hay pasarela, la
 * compradora paga por transferencia o en efectivo y alguien confirma el pago
 * desde Caja → Tarjetas regalo, que es donde la plata entra al panel.
 *
 * Las defensas anti-abuso (Turnstile, honeypot, tiempo mínimo, límite por IP)
 * viven en la landing, como en `/reservar`; acá se asume que ya pasaron. Lo
 * que **no** se delega:
 *
 * - **El monto sale del nivel**, nunca del navegador: el cuerpo trae `tierId`
 *   y Stampee rechaza un nivel apagado o inexistente.
 * - **El celular se normaliza acá** (`+57…`): la landing lo manda tal como se
 *   escribió, y Stampee cruza la compradora por los últimos diez dígitos.
 * - `ref === "adviento"` le pone a la tarjeta `buyerStampOnPaid`: quien compra
 *   desde el calendario de adviento recibe un sello al confirmarse el pago.
 *
 * Respuestas: `201 { ok, data: { code, amountCop, tierName, publicUrl } }`;
 * `400 { field }` con un campo malo; `422 { field: "tierId" }` solo cuando
 * Stampee dice `TIER_REQUIRED` / `TIER_UNAVAILABLE`; `502` con cualquier otro
 * rechazo de Stampee; `503` si no responde.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("body");
  }

  const parsed = parseGiftOrder(body);
  if (!parsed.ok) return bad(parsed.field);
  const order = parsed.order;

  const result = await createGiftCard({
    tierId: order.tierId,
    buyer: { name: order.buyerName, phone: order.buyerPhone },
    recipientName: order.recipientName,
    message: order.message,
    source: "sale",
    rules: order.ref === "adviento" ? { buyerStampOnPaid: true, ref: "adviento" } : order.ref ? { ref: order.ref } : undefined,
    ref: order.ref,
  });

  if (!result.ok) {
    console.error("[public/gift-cards/order] Stampee no creó el pedido", result.status, result.message);
    if (result.code === "TIER_REQUIRED" || result.code === "TIER_UNAVAILABLE") {
      return NextResponse.json(
        { ok: false, error: "tier_unavailable", field: "tierId" },
        { status: 422, headers: NO_STORE },
      );
    }
    // Cualquier otro rechazo es nuestro o de Stampee, no de quien pide: un
    // error general, sin campo, para que la landing no culpe al nivel.
    return NextResponse.json(
      { ok: false, error: "unavailable" },
      { status: result.status === null || result.status >= 500 ? 503 : 502, headers: NO_STORE },
    );
  }

  const card = result.card;
  return NextResponse.json(
    {
      ok: true,
      data: {
        code: card.code,
        amountCop: card.amountCop,
        tierName: card.tierName,
        publicUrl: card.publicUrl,
      },
    },
    { status: 201, headers: NO_STORE },
  );
}

function bad(field: string) {
  return NextResponse.json({ ok: false, error: "bad_request", field }, { status: 400, headers: NO_STORE });
}
