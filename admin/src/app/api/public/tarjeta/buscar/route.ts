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
 * un minuto) y responde. **Celular desconocido, nombre errado y celular
 * bloqueado dan la misma respuesta**: `{ found: false }`.
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

  const match = findCard(loyalty.data, loyalty.data.cardBaseUrl, phone, name);
  if (match === null) {
    gate.fail(key);
    return NextResponse.json({ found: false }, { headers: NO_STORE });
  }
  return NextResponse.json({ found: true, ...match }, { headers: NO_STORE });
}

function bad(field: string) {
  return NextResponse.json({ error: "bad_request", field }, { status: 400, headers: NO_STORE });
}
