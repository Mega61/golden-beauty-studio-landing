import "server-only";

import { getDb } from "@/db/client";
import { serviceMapRepository } from "@/db/repositories";
import type { ServiceMap } from "@/db/types";
import { EaApiError, type Service, type ServiceCategory } from "@/lib/ea";
import { createEaClient, type EaClient } from "@/lib/ea/client";

import { buildCatalogDiff, type CatalogDiff } from "./diff";
import { loadPricingCatalog } from "./pricing-source";

/**
 * Lo que la pantalla de Servicios necesita saber.
 *
 * Tres fuentes que se cruzan: la vitrina (texto de `pricing.ts`), el catálogo
 * operativo (EA) y el mapa (`service_map`). Las tres se leen enteras: son
 * decenas de filas, y traerlas completas evita el N+1 y deja el diff en una
 * función pura.
 *
 * **Si falta cualquiera de las tres, no hay diff.** Un diff calculado contra una
 * lista incompleta no dice "falta un dato": dice "todo el catálogo sobra", y
 * ofrece desvincularlo. Por eso `diff` es `null` cuando algo falló, y la
 * pantalla muestra qué falta en vez de una tabla mentirosa.
 */

export type ServicesFailure = {
  transient: boolean;
  message: string;
  detail?: string;
};

export type ServicesView = {
  /** Los servicios de EA, para el catálogo en lectura. */
  services: Service[];
  categories: ServiceCategory[];
  /** El nombre de cada categoría de EA, ya resuelto. */
  categoryName: Map<number, string>;
  serviceMap: ServiceMap[];
  /** `null` si alguna de las tres fuentes no se pudo leer. */
  diff: CatalogDiff | null;
  /** De dónde se leyó la vitrina. Se muestra: es configuración que hay que ver. */
  pricingSourcePath: string | null;
  failures: ServicesFailure[];
};

function describeEaFailure(error: unknown): ServicesFailure {
  if (error instanceof EaApiError) {
    return {
      transient: error.isTransient,
      message: error.isConfiguration
        ? "El panel no puede autenticarse contra la agenda."
        : "La agenda no está respondiendo.",
      detail: error.message,
    };
  }
  return {
    transient: true,
    message: "La agenda no está respondiendo.",
    detail: error instanceof Error ? error.message : String(error),
  };
}

export async function loadServicesView(): Promise<ServicesView> {
  const failures: ServicesFailure[] = [];

  let ea: EaClient | null = null;
  try {
    ea = createEaClient();
  } catch (error) {
    failures.push(describeEaFailure(error));
  }

  let services: Service[] = [];
  let categories: ServiceCategory[] = [];
  let eaOk = false;
  if (ea) {
    try {
      [services, categories] = await Promise.all([
        ea.services.list(),
        ea.serviceCategories.list(),
      ]);
      eaOk = true;
    } catch (error) {
      failures.push(describeEaFailure(error));
    }
  }

  let serviceMap: ServiceMap[] = [];
  let mapOk = false;
  try {
    serviceMap = await serviceMapRepository(getDb()).listAll();
    mapOk = true;
  } catch (error) {
    failures.push({
      transient: true,
      message: "No se pudo leer la correspondencia entre la vitrina y la agenda.",
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const pricing = await loadPricingCatalog();
  if (!pricing.ok) {
    failures.push({
      transient: false,
      message: "No se pudo leer la vitrina (src/data/pricing.ts).",
      detail: `${pricing.error} Rutas intentadas: ${pricing.tried.join(", ")}`,
    });
  }

  const diff =
    pricing.ok && eaOk && mapOk
      ? buildCatalogDiff(pricing.entries, services, serviceMap)
      : null;

  return {
    services: [...services].sort(byName),
    categories,
    categoryName: new Map(
      categories.map((category) => [category.id, category.name ?? "Sin categoría"]),
    ),
    serviceMap,
    diff,
    pricingSourcePath: pricing.ok ? pricing.sourcePath : null,
    failures,
  };
}

function byName(a: Service, b: Service): number {
  return (a.name ?? "").localeCompare(b.name ?? "", "es");
}
