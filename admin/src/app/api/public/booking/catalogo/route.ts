import { NextResponse } from "next/server";

import { createEaClient } from "@/lib/ea/client";
import { EaApiError } from "@/lib/ea/errors";

/**
 * Lo que el formulario de reserva necesita para dibujarse: qué se puede
 * reservar y con quién.
 *
 * Van juntos en una sola respuesta porque el formulario los necesita a los dos
 * para pintar el primer paso, y porque cada llamada del panel a EA cuenta
 * contra su límite de 100 por IP cada 120 s. Dos rutas serían dos viajes para
 * una sola pantalla.
 *
 * ## Qué se considera reservable
 *
 * La landing conoce los ids de `pricing.ts` (`acrylic-sculpted`); EA conoce los
 * suyos, numéricos, que son los que espera la sub-API de horarios. El puente
 * formal es `service_map`, pero para la vitrina pública la pregunta es más
 * simple y la respuesta más honesta: **lo reservable es lo que EA dice que es
 * reservable**, porque es lo que va a existir cuando se confirme. Un servicio
 * que el panel todavía no publicó a EA no se puede agendar, y ofrecerlo sería
 * mentir.
 *
 * - **`isPrivate`** es la palanca que ya existe en EA para "esto no se ofrece
 *   solo". Ahí viven los adicionales de `extras` — retiro de sistema, uña
 *   individual, diseño por uña — que se suman a una cuenta pero no son una cita.
 * - **Sin duración no hay tramo que reservar**, así que tampoco se lista.
 *
 * ## De las técnicas sale el nombre de pila y nada más
 *
 * El registro de un provider en EA trae correo, teléfono, dirección, usuario y
 * su plan de trabajo completo. Nada de eso tiene por qué salir a internet para
 * que alguien elija con quién quiere ir. Se arma un objeto nuevo en vez de
 * filtrar el de EA: filtrar deja la puerta abierta a que un campo nuevo de una
 * versión futura se cuele solo.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const client = createEaClient();
    const [services, providers, categories] = await Promise.all([
      client.services.list(),
      client.providers.list(),
      client.serviceCategories.list(),
    ]);

    // El nombre de la categoría, para que la lista se agrupe como la vitrina en
    // vez de caer como veinticinco tarjetas seguidas. EA ya las tiene: son las
    // mismas seis de `pricing.ts`, publicadas por el panel.
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));

    const bookable = services.filter(
      (s) => !s.isPrivate && s.duration !== null && s.duration > 0,
    );
    const bookableIds = new Set(bookable.map((s) => s.id));

    return NextResponse.json(
      {
        services: bookable.map((s) => ({
          id: s.id,
          name: s.name,
          durationMin: s.duration,
          // El precio de EA, no el de `pricing.ts`: es el que se va a cobrar.
          priceCOP: s.price,
          category:
            s.serviceCategoryId === null ? null : (categoryName.get(s.serviceCategoryId) ?? null),
        })),
        providers: providers
          // Una técnica sin servicios reservables no se ofrece: elegirla sería
          // un callejón sin salida.
          .filter((p) => (p.services ?? []).some((id) => bookableIds.has(id)))
          .map((p) => ({
            id: p.id,
            name: (p.firstName ?? "").trim() || `Profesional ${p.id}`,
            serviceIds: (p.services ?? []).filter((id) => bookableIds.has(id)),
          })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[public/booking/catalogo] no se pudo leer el catálogo", error);

    const transient = error instanceof EaApiError ? error.isTransient : true;
    return NextResponse.json(
      { error: "unavailable" },
      { status: transient ? 503 : 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
