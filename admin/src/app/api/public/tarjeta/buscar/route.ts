import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { createAttemptGate, findCard } from "@/lib/stampee/card-lookup";
import { loadLoyalty } from "@/lib/stampee/client";
import { phoneKey } from "@/lib/stampee/model";

/**
 * `/admin/api/public/tarjeta/buscar` — celular + primer nombre → link de la
 * tarjeta de sellos, para la sección "Encuentra tu tarjeta" de la landing.
 *
 * Las reglas (y el riesgo que se aceptó) están en `lib/stampee/card-lookup.ts`.
 * Acá solo: valida, lee la caché de Stampee del panel (la misma de Fidelidad,
 * un minuto) y responde:
 *
 * - `{ found: true, url, … }` — la tarjeta.
 * - `{ found: false, newClient: true }` — ningún celular así en Stampee: la
 *   landing la manda a reservar su primera cita.
 * - `{ found: false }` — nombre errado o celular bloqueado, sin distinguir.
 *
 * Detrás del límite por IP de la landing (`/api/tarjeta/buscar`); el bloqueo
 * por celular de acá cubre también a quien entre por el rewrite de `/admin`.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_FIELD = 60;

const globalGate = globalThis as unknown as { __gbsCardGate?: ReturnType<typeof createAttemptGate> };
const gate = (globalGate.__gbsCardGate ??= createAttemptGate({ maxFailures: 5, windowMs: 60 * 60_000 }));

export async function POST(req: NextRequest) {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = await req.json();
    if (typeof parsed !== "object" || parsed === null) return bad("body");
    raw = parsed as Record<string, unknown>;
  } catch {
    return bad("body");
  }
  const phone = typeof raw.phone === "string" ? raw.phone.trim() : "";
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const key = phoneKey(phone);
  if (key === null || key.length < 10 || phone.length > MAX_FIELD) return bad("phone");
  if (name === "" || name.length > MAX_FIELD) return bad("name");

  if (gate.locked(key)) return NextResponse.json({ found: false }, { headers: NO_STORE });

  const loyalty = await loadLoyalty();
  if (!loyalty.ok || loyalty.data.cardBaseUrl === null) {
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: NO_STORE });
  }

  const result = findCard(loyalty.data, loyalty.data.cardBaseUrl, phone, name);
  if (result.kind === "found") {
    const { url, stamps, totalStamps, rewardName } = result;
    return NextResponse.json({ found: true, url, stamps, totalStamps, rewardName }, { headers: NO_STORE });
  }
  // Los dos fallos suman al bloqueo: un barrido de números también se frena.
  gate.fail(key);
  return NextResponse.json(
    result.kind === "unknown-phone" ? { found: false, newClient: true } : { found: false },
    { headers: NO_STORE },
  );
}

function bad(field: string) {
  return NextResponse.json({ error: "bad_request", field }, { status: 400, headers: NO_STORE });
}
