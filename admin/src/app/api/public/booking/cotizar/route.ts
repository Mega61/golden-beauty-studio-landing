import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { isEaLocalDate } from "@/lib/ea/datetime";
import { EaApiError } from "@/lib/ea/errors";
import { loadQuote } from "./data";

/**
 * Cuánto va a pagar: el precio de la visita con la promo que le toca, para la
 * reserva de la landing.
 *
 * - **Nunca confía en un precio del navegador.** Llegan ids, una fecha y, si
 *   ya lo escribió, el celular; los precios salen de EA y el id de vitrina, de
 *   `service_map`. La promo la decide `bestPromo()` —la misma función que usa
 *   el cierre de la cuenta—, así que la pantalla y la caja no pueden decir dos
 *   números distintos.
 * - **Con el celular dice si es su primera visita.** Eso revela si un número ya
 *   es clienta del estudio; la dueña aceptó ese riesgo (2026-10-16) a cambio de
 *   mostrar el 10% al reservar. Lo acotan el límite por IP del proxy de la
 *   landing (`/api/reservas/cotizar`) y, acá adentro, un cupo global de
 *   consultas a EA con recuerdo por teléfono (`quote.ts` → `createLookupGate`).
 * - **Lo que responde es lo que se ve, no lo que se cobra.** El cierre de la
 *   cuenta vuelve a decidir la promo con datos frescos; por eso esta ruta lee
 *   de la caché de EA sin culpa.
 *
 * `firstVisit: null` = no se sabe, y la landing no promete nada.
 */
export const dynamic = "force-dynamic";

const MAX_PHONE = 40;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("body");
  }
  if (typeof body !== "object" || body === null) return bad("body");
  const raw = body as Record<string, unknown>;

  const serviceId = Number(raw.serviceId);
  const thenServiceId =
    raw.thenServiceId === null || raw.thenServiceId === undefined || raw.thenServiceId === ""
      ? null
      : Number(raw.thenServiceId);
  const date = raw.date;
  const phone = typeof raw.phone === "string" && raw.phone.trim() !== "" ? raw.phone.trim() : null;

  if (!Number.isInteger(serviceId) || serviceId <= 0) return bad("serviceId");
  if (
    thenServiceId !== null &&
    (!Number.isInteger(thenServiceId) || thenServiceId <= 0 || thenServiceId === serviceId)
  ) {
    return bad("thenServiceId");
  }
  if (!isEaLocalDate(date)) return bad("date");
  if (phone !== null && phone.length > MAX_PHONE) return bad("phone");

  try {
    const result = await loadQuote({ serviceId, thenServiceId, date, phone });
    // Un servicio inexistente y uno privado responden igual: esta ruta no es un
    // mapa del catálogo de EA.
    if (result.status === "unknown-service") return bad("serviceId");
    return NextResponse.json(result.quote, { headers: NO_STORE });
  } catch (error) {
    console.error("[public/booking/cotizar] no se pudo cotizar", error);
    const transient = error instanceof EaApiError ? error.isTransient : true;
    return NextResponse.json(
      { error: "unavailable" },
      { status: transient ? 503 : 500, headers: NO_STORE },
    );
  }
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function bad(field: string) {
  return NextResponse.json({ error: "bad_request", field }, { status: 400, headers: NO_STORE });
}
