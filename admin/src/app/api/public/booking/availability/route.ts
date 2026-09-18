import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { instantToEaDate, isEaLocalDate, type EaLocalDate } from "@/lib/ea/datetime";
import { EaApiError } from "@/lib/ea/errors";
import { loadAvailability } from "./data";

/**
 * Horarios libres para la landing. **Es la única ruta pública del panel.**
 *
 * Vive acá y no en la landing porque el token de EA no puede llegar nunca al
 * navegador, y EA no debe quedar expuesta a internet. La landing hace proxy
 * desde `src/app/api/reservas/*`, que es donde van Turnstile, el honeypot y el
 * límite por IP — el mismo patrón que `postulaciones`.
 *
 * Que sea pública obliga a dos cosas:
 *
 * - **No enumera nada.** Un servicio inexistente y uno sin técnicas responden
 *   igual: una lista vacía. Sin eso, esta ruta sería un mapa del catálogo y de
 *   la plantilla para cualquiera que itere ids.
 * - **No propaga el error de EA.** Un `EaApiError` lleva ruta y cuerpo de EA;
 *   afuera solo sale `unavailable`. El detalle va al log del contenedor.
 *
 * `force-dynamic` + `no-store`: una disponibilidad cacheada es una silla
 * vendida dos veces.
 */
export const dynamic = "force-dynamic";

const MAX_AHEAD_DAYS = 120;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;

  const serviceId = Number(params.get("serviceId"));
  const date = params.get("date");
  const rawProvider = params.get("providerId");
  const providerId = rawProvider === null || rawProvider === "" ? null : Number(rawProvider);

  if (!Number.isInteger(serviceId) || serviceId <= 0) return bad("serviceId");
  if (!isEaLocalDate(date)) return bad("date");
  if (providerId !== null && (!Number.isInteger(providerId) || providerId <= 0)) {
    return bad("providerId");
  }

  // Una fecha pasada, o a dos años vista, es una consulta que ninguna clienta
  // hace: es alguien barriendo. Cuesta un abanico de llamadas a EA, así que se
  // corta antes de salir a la red.
  if (outOfRange(date)) return NextResponse.json({ slots: [] }, { headers: NO_STORE });

  try {
    const result = await loadAvailability({ serviceId, date, providerId });

    // Los tres "no hay nada" responden igual a propósito: ver el encabezado.
    if (result.status !== "ok") {
      return NextResponse.json({ slots: [] }, { headers: NO_STORE });
    }

    return NextResponse.json(
      {
        slots: result.slots.map((slot) => ({
          time: slot.time,
          start: slot.start,
          end: slot.end,
          providerIds: slot.providerIds,
        })),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.error("[public/booking/availability] no se pudo consultar EA", error);

    // Un 429 o un EA caído son transitorios: 503 le dice al proxy —y a la
    // clienta— "volvé a intentar", que es verdad, en vez de "no hay horas",
    // que no lo es.
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

/**
 * Hoy no se descarta: una clienta puede reservar para esta tarde.
 *
 * El "hoy" es el del estudio, no el del servidor — `instantToEaDate` resuelve
 * en `America/Bogota`. Con el contenedor en UTC, un pedido de las 8 p. m. de
 * Bogotá caería en el día siguiente y se rechazaría el día que sí existe.
 */
function outOfRange(date: EaLocalDate): boolean {
  const now = new Date();
  if (date < instantToEaDate(now)) return true;
  return date > instantToEaDate(new Date(now.getTime() + MAX_AHEAD_DAYS * 86_400_000));
}
