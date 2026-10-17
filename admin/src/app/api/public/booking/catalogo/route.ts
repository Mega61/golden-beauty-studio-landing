import { NextResponse } from "next/server";

import { FIRST_VISIT_PERCENT } from "@/data/promo-rules";
import { getDb } from "@/db/client";
import { serviceMapRepository } from "@/db/repositories";
import { loadComboCompositions } from "@/lib/combo-source";
import { comboServiceIds } from "@/lib/combos";
import { createCachedEaClient } from "@/lib/ea/client";
import { instantToEaDate } from "@/lib/ea/datetime";
import { EaApiError } from "@/lib/ea/errors";
import { providerWorkingPlanExceptions } from "@/lib/ea/mapping";
import { dayPromosFor } from "@/lib/promos";
import { publicSchedule } from "@/lib/public-schedule";

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
    // De caché (60 s, ver `lib/ea/cache.ts`): es la primera pantalla de cada
    // visita desde un anuncio, y si EA está estrangulado se sirve el catálogo
    // de hace unos minutos en vez de un 503.
    const client = createCachedEaClient();
    const [services, providers, categories, composition, serviceMap] = await Promise.all([
      client.services.list(),
      client.providers.list(),
      client.serviceCategories.list(),
      // No toca EA: sale de la vitrina más `service_map`, y nunca lanza. Sin
      // composiciones la landing lista los combos como un servicio más, que es
      // exactamente como funcionaba antes.
      loadComboCompositions(),
      // El id de vitrina de cada servicio. Con él la landing pone el nombre y
      // la descripción en el idioma de quien reserva —EA solo los tiene en
      // español— y un enlace desde la lista de precios llega con el servicio
      // ya elegido. Sin mapa la reserva sigue funcionando con los nombres de EA.
      serviceMapRepository(getDb())
        .listAll()
        .catch((error: unknown) => {
          console.error("[public/booking/catalogo] sin service_map", error);
          return [];
        }),
    ]);

    const slugOf = new Map(serviceMap.map((row) => [row.ea_service_id, row.pricing_id]));
    const today = instantToEaDate(new Date());

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
          slug: slugOf.get(s.id) ?? null,
          category:
            s.serviceCategoryId === null ? null : (categoryName.get(s.serviceCategoryId) ?? null),
          // La landing esconde de la lista lo que es un combo. Se manda la
          // marca calculada en vez de dejar que la deduzca del nombre de la
          // categoría: "Combos" es texto que alguien puede renombrar en EA.
          isCombo: isCombo.has(s.id),
          // Las promos del día de este servicio, para que la landing las pinte
          // antes de que se elija fecha ("Miércoles $25.000"). Salen de las
          // mismas reglas que aplica la cotización; un combo nunca trae.
          // Solo las que de verdad bajan el precio de EA: tachar un precio
          // que no ahorra nada sería publicidad falsa.
          dayPromos: dayPromosFor(slugOf.get(s.id) ?? null)
            .filter((p) => s.price !== null && p.promoCOP < s.price)
            .map((p) => ({ slug: p.slug, label: p.label, weekday: p.weekday, promoCOP: p.promoCOP })),
        })),
        // El 10% de primera visita. Va como dato y no escrito en la landing
        // para que el número del texto sea el mismo que descuenta la cotización.
        firstVisitPercent: FIRST_VISIT_PERCENT,
        // Este panel sabe agendar un par sin combo como dos citas seguidas
        // (`thenServiceId`). La landing solo ofrece esos pares si lo dice.
        chained: true,
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
            // Solo qué días trabaja: ver `lib/public-schedule.ts`. Una excepción
            // mal formada no tumba el catálogo; se pierde la pista y nada más.
            schedule: scheduleOf(p, today),
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

function scheduleOf(
  provider: Parameters<typeof providerWorkingPlanExceptions>[0],
  today: string,
) {
  try {
    return publicSchedule(
      provider.settings?.workingPlan ?? null,
      providerWorkingPlanExceptions(provider),
      today,
    );
  } catch (error) {
    console.error("[public/booking/catalogo] plan de trabajo ilegible", provider.id, error);
    return { offWeekdays: [], closedDates: [], openDates: [] };
  }
}
