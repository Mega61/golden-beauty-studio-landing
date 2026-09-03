import { NextResponse } from "next/server";

import { parseEaLocalDate, type EaLocalDate } from "@/lib/ea/datetime";
import { verifySession } from "@/lib/dal";
import { loadAgenda } from "../data";

/**
 * El endpoint del refresco: `GET /admin/agenda/datos?dias=2026-09-02,2026-09-03`.
 *
 * ## Por qué un Route Handler y no una Server Action
 *
 * El polling es una lectura cada 30 segundos, no una mutación. Las Server
 * Actions son POST y **se serializan en cola**: un refresco lento retrasaría el
 * guardado que la recepción acaba de disparar. Un GET normal se cancela con un
 * `AbortController` cuando la pestaña pierde el foco y no bloquea nada.
 *
 * ## Vive bajo `(panel)/agenda/` a propósito
 *
 * Un grupo de rutas no aparece en la URL, así que este archivo responde en
 * `/agenda/datos` y no en `/(panel)/agenda/datos`. Está acá y no en `app/api/`
 * porque `app/api/**` pertenece a otros paquetes y porque un endpoint que solo
 * sirve a esta pantalla tiene que poder borrarse con ella.
 *
 * ## Autorización
 *
 * `verifySession()` otra vez, y no "el layout ya lo hizo": un Route Handler no
 * cruza ningún layout. Devuelve 401 en vez de redirigir — quien pregunta es
 * `fetch`, no un navegador siguiendo enlaces, y un 302 al login le llegaría como
 * un HTML que no sabe leer.
 *
 * El recorte por rol no se repite acá: lo hace `loadAgenda()`, que es el único
 * camino a los datos. Una técnica que pida los días de otra recibe su propia
 * columna, no un 403 — porque no está pidiendo la de nadie más: está pidiendo
 * un día.
 */

export const dynamic = "force-dynamic";

/** Tope de días por consulta. Semana son 7; el resto sería otra pantalla. */
const MAX_DAYS = 14;

export async function GET(request: Request): Promise<Response> {
  const session = await verifySession();
  if (!session) {
    return NextResponse.json({ error: "sin sesión" }, { status: 401 });
  }

  const raw = new URL(request.url).searchParams.get("dias") ?? "";
  const dates: EaLocalDate[] = [];

  for (const part of raw.split(",").filter(Boolean)) {
    try {
      dates.push(parseEaLocalDate(part));
    } catch {
      return NextResponse.json({ error: `fecha inválida: ${part}` }, { status: 400 });
    }
  }

  if (dates.length === 0 || dates.length > MAX_DAYS) {
    return NextResponse.json(
      { error: `hay que pedir entre 1 y ${MAX_DAYS} días` },
      { status: 400 },
    );
  }

  const result = await loadAgenda(dates);

  if (!result.ok) {
    // 503 y no 500: EA está caído, el panel no. La pantalla lo lee como "entrá
    // en solo lectura", que es distinto de "algo se rompió acá adentro".
    return NextResponse.json({ error: result.reason }, { status: 503 });
  }

  // Sin caché en ningún lado. El panel siempre quiere el estado de ahora; una
  // agenda cacheada es una agenda equivocada.
  return NextResponse.json(result.data, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
