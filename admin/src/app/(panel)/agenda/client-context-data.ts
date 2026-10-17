import "server-only";

import { getDb } from "@/db/client";
import { serviceMapRepository } from "@/db/repositories";
import { createCachedEaClient, type EaClient } from "@/lib/ea/client";
import { instantToEaLocal } from "@/lib/ea/datetime";
import type { SuggestionCatalog } from "@/lib/service-suggestion";

import { loadHistoryByPhone, loadHistoryForCustomer } from "../clientes/data";
import { normalizePhoneE164 } from "../clientes/identity";
import { buildClientContext, EMPTY_CLIENT_CONTEXT, type ClientContext } from "./client-context";

/**
 * La lectura detrás de la tarjeta "Última visita" del formulario de cita.
 *
 * Usa el cliente **con caché** de EA a propósito: es una lectura de pantalla
 * que no decide ninguna escritura, se dispara cada vez que se elige una clienta,
 * y EA corta a 100 peticiones cada 120 s para todo el panel. Servicios,
 * técnicas y citas salen de la caché; la búsqueda de la ficha por teléfono no
 * se cachea (ver `lib/ea/cache.ts`), así que cuesta unas pocas llamadas.
 *
 * Nunca lanza: una tarjeta auxiliar que falla no puede trabar el formulario.
 */
export async function loadClientContext(input: {
  customerId: number | null;
  phone: string | null;
  excludeAppointmentId: number | null;
}): Promise<ClientContext> {
  let ea: EaClient;
  try {
    ea = createCachedEaClient();
  } catch (error) {
    console.error("[agenda] contexto de clienta sin cliente de EA", error);
    return EMPTY_CLIENT_CONTEXT;
  }

  try {
    const phone = normalizePhoneE164(input.phone);
    const historyLoad =
      input.customerId !== null
        ? loadHistoryForCustomer(input.customerId, ea)
        : phone !== null
          ? loadHistoryByPhone(phone, ea)
          : null;
    if (historyLoad === null) return EMPTY_CLIENT_CONTEXT;

    const [{ history, partial }, catalog] = await Promise.all([historyLoad, loadCatalog(ea)]);

    return buildClientContext(history.entries, {
      asOf: instantToEaLocal(new Date()),
      excludeAppointmentId: input.excludeAppointmentId,
      partial,
      catalog,
    });
  } catch (error) {
    console.error("[agenda] no se pudo armar el contexto de la clienta", error);
    return EMPTY_CLIENT_CONTEXT;
  }
}

/**
 * Los servicios de EA de hoy y `service_map`. Sin alguno de los dos, la
 * sugerencia sale `null` y la tarjeta muestra el historial igual: es una
 * comodidad, no algo de lo que dependa agendar.
 */
async function loadCatalog(ea: EaClient): Promise<SuggestionCatalog> {
  const [services, map] = await Promise.all([
    ea.services.list().catch((error: unknown) => {
      console.error("[agenda] contexto de clienta sin servicios de EA", error);
      return [];
    }),
    serviceMapRepository(getDb())
      .listAll()
      .catch((error: unknown) => {
        console.error("[agenda] contexto de clienta sin service_map", error);
        return [];
      }),
  ]);
  return {
    services: services.map((service) => ({ id: service.id, name: service.name })),
    eaIdOfPricing: new Map(map.map((row) => [row.pricing_id, row.ea_service_id])),
  };
}
