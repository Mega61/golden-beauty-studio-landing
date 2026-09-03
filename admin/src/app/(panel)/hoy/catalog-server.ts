import "server-only";

import type { Db } from "@/db/repositories";
import { serviceMapRepository } from "@/db/repositories";
import type { EaClient } from "@/lib/ea/client";
import { isExtrasCategory, type CatalogService, type TicketCatalog } from "@/components/ticket/catalog";

/**
 * El catálogo con el que se valora una cuenta.
 *
 * Vive en un archivo propio porque lo usan **los dos lados de la misma
 * pregunta**: la pantalla, para pintar el total mientras la técnica arma la
 * cuenta, y la Server Action, para volver a valorarla antes de escribir. Que
 * sea el mismo código es lo que garantiza que lo que se ve y lo que se guarda
 * no puedan diferir; que la Action lo cargue de nuevo, en vez de confiar en lo
 * que llegó del navegador, es lo que garantiza que un cliente manipulado no
 * pueda fijar un precio.
 *
 * Las tres fuentes y qué aporta cada una:
 *
 * | Fuente | Qué aporta | Por qué no otra |
 * | --- | --- | --- |
 * | `GET /services` de EA | nombre, precio de hoy, duración, categoría | es lo que se cobra |
 * | `GET /service_categories` | el nombre de la categoría | decide qué es un adicional |
 * | `service_map` | el `pricing_id` | lo necesitan las reglas de comisión por categoría |
 *
 * `src/data/pricing.ts` **no** entra: vive en la landing, que es otra
 * aplicación. Ver la cabecera de `components/ticket/catalog.ts`.
 */
export async function loadCatalogForClose(db: Db, ea: EaClient): Promise<TicketCatalog> {
  const [services, categories, maps] = await Promise.all([
    ea.services.list(),
    ea.serviceCategories.list(),
    serviceMapRepository(db).listAll(),
  ]);

  const nameOfCategory = new Map(categories.map((c) => [c.id, c.name ?? ""]));
  const pricingIdOf = new Map(maps.map((m) => [m.ea_service_id, m.pricing_id]));

  const rows: CatalogService[] = services.map((service) => {
    const categoryName =
      service.serviceCategoryId === null
        ? ""
        : (nameOfCategory.get(service.serviceCategoryId) ?? "");

    return {
      eaServiceId: service.id,
      name: service.name ?? `Servicio #${service.id}`,
      // EA guarda el precio en un `DECIMAL`, así que llega como número con
      // decimales posibles. Colombia no tiene centavos y la columna de la
      // cuenta es `INT`: se redondea acá, una vez, en vez de dejar que un
      // `1234.5` reviente el INSERT tres capas más abajo.
      listPrice:
        service.price === null || !Number.isFinite(service.price)
          ? null
          : Math.round(service.price),
      durationMin: service.duration,
      categoryId: service.serviceCategoryId,
      categoryName,
      pricingId: pricingIdOf.get(service.id) ?? null,
      isExtra: isExtrasCategory(categoryName),
    };
  });

  return { services: rows };
}
