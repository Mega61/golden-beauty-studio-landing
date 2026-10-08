import { NextResponse } from "next/server";

import { loadComboCompositions } from "@/lib/combo-source";
import { comboServiceIds } from "@/lib/combos";
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
 * ## Los combos se mandan, pero aparte
 *
 * Un combo es un servicio reservable como cualquier otro —va en `services`— y
 * además aparece en `combos` con las dos mitades que reemplaza. Esa segunda
 * lista es lo que le permite a la landing hacer lo mismo que hace la agenda del
 * panel: **esconder los combos de la lista y llegar a ellos componiendo**.
 * Quien reserva piensa "semipermanente… y pies también", no "combo número
 * cuatro", y buscar el combo correcto entre veinticinco filas justo en el
 * primer paso —que es donde más se abandona un formulario— es pedirle trabajo a
 * cambio de nada.
 *
 * El precio y la duración de un combo salen de EA como los de cualquier
 * servicio, y **no** se suman ni se recalculan acá. La suma de las dos mitades
 * la hace la landing con los precios que ya tiene en `services`, y solo para
 * mostrarla tachada.
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
    const [services, providers, categories, composition] = await Promise.all([
      client.services.list(),
      client.providers.list(),
      client.serviceCategories.list(),
      // No toca EA: sale de la vitrina más `service_map`, y nunca lanza. Sin
      // composiciones la landing lista los combos como un servicio más, que es
      // exactamente como funcionaba antes.
      loadComboCompositions(),
    ]);

    // El nombre de la categoría, para que la lista se agrupe como la vitrina en
    // vez de caer como veinticinco tarjetas seguidas. EA ya las tiene: son las
    // mismas seis de `pricing.ts`, publicadas por el panel.
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));

    const bookable = services.filter(
      (s) => !s.isPrivate && s.duration !== null && s.duration > 0,
    );
    const bookableIds = new Set(bookable.map((s) => s.id));

    // Una composición cuyas tres partes no sean todas reservables no se manda:
    // la landing la usaría para ofrecer un par que no se puede reservar, y el
    // callejón aparecería recién al pedir los horarios.
    const combos = composition.combos.filter(
      (c) =>
        bookableIds.has(c.eaServiceId) &&
        bookableIds.has(c.handsEaServiceId) &&
        bookableIds.has(c.feetEaServiceId),
    );
    const isCombo = comboServiceIds(combos);

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
          // La landing esconde de la lista lo que es un combo. Se manda la
          // marca calculada en vez de dejar que la deduzca del nombre de la
          // categoría: "Combos" es texto que alguien puede renombrar en EA.
          isCombo: isCombo.has(s.id),
        })),
        combos: combos.map((c) => ({
          serviceId: c.eaServiceId,
          handsServiceId: c.handsEaServiceId,
          feetServiceId: c.feetEaServiceId,
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
