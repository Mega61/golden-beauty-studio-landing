import { NextResponse } from "next/server";

import { listGiftCardTiers } from "@/lib/stampee/client";

/**
 * Los montos de las tarjetas regalo que se ofrecen en `/regalar` de la landing.
 *
 * Salen de Stampee (`gift_card_tiers`, solo los habilitados): los montos los
 * decide la dueña allá, no este código. Se arma un objeto nuevo en vez de
 * reenviar el de Stampee, como el catálogo de reservas: un campo nuevo de una
 * versión futura no se cuela solo a internet.
 *
 * Envoltura `{ ok, data }`, que es lo que la landing espera.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET() {
  const result = await listGiftCardTiers({ enabledOnly: true });
  if (!result.ok) {
    console.error("[public/gift-cards/tiers] Stampee no devolvió los montos", result.message);
    return NextResponse.json(
      { ok: false, error: "unavailable" },
      { status: result.status === null || result.status >= 500 ? 503 : 500, headers: NO_STORE },
    );
  }

  const data = result.tiers
    .filter((tier) => tier.isEnabled !== false && tier.amountCop > 0)
    .sort((a, b) => a.sort - b.sort || a.amountCop - b.amountCop)
    .map((tier) => ({
      id: tier.id,
      name: tier.name,
      amountCop: tier.amountCop,
      description: tier.description ?? "",
      validityDays: tier.validityDays,
    }));

  return NextResponse.json({ ok: true, data }, { headers: NO_STORE });
}
