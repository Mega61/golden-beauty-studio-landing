/**
 * El catálogo que consume la pantalla de "Cerrar servicio".
 *
 * ## De dónde sale
 *
 * De **Easy!Appointments**, no de `src/data/pricing.ts`. La vitrina vive en la
 * landing, que es otra aplicación: `admin/` no la puede importar — lo dejó
 * escrito `jobs/snapshot.ts` cuando resolvió el mismo problema para el precio
 * de respaldo. Lo que sí hay acá es `service_map`, que da la correspondencia
 * `pricing_id ↔ ea_service_id` sin precio y sin categoría, y las categorías de
 * servicio de EA, que el panel publica desde `pricing.ts` en un solo sentido y
 * por eso llevan los nombres de la vitrina.
 *
 * De ahí la regla de este archivo: **un servicio es un adicional si su
 * categoría de EA se llama `extras`.** No es una traducción del catálogo de la
 * vitrina; es la única señal que el panel puede leer sin inventar una cuarta
 * copia de un dato que ya tiene dueño. Si nadie creó esa categoría en EA la
 * lista de adicionales queda vacía y la pantalla lo dice — mejor que ofrecer
 * como adicional un montaje de 120.000.
 *
 * ## Qué NO hace
 *
 * Ningún cálculo de plata. Los precios que viajan acá son **precios de lista**
 * tal como EA los tiene hoy; convertirlos en renglones y en un total es de
 * `lib/ticket.ts` (B1), y volver a hacerlo en un componente sería tener dos
 * algoritmos para el mismo número.
 */

import type { Cop } from "@/db/types";

/** Un servicio de EA, listo para dibujarse en la hoja de la cuenta. */
export type CatalogService = {
  eaServiceId: number;
  name: string;
  /**
   * Precio de lista **de hoy**, en pesos enteros. `null` = EA no lo sabe.
   *
   * No es el precio congelado de la cita: ése vive en `appointment_finance` y
   * llega aparte. Para el servicio realizado y los adicionales el congelado se
   * hace al cerrar la cuenta — mismo día, así que no hay deriva posible.
   */
  listPrice: Cop | null;
  durationMin: number | null;
  categoryId: number | null;
  /** Nombre de la categoría de EA. `""` si el servicio no tiene ninguna. */
  categoryName: string;
  /** Id de `src/data/pricing.ts`, si `service_map` lo conoce. */
  pricingId: string | null;
  /** De la categoría `extras`: se ofrece como chip con contador, no como servicio. */
  isExtra: boolean;
};

export type TicketCatalog = {
  services: readonly CatalogService[];
};

/**
 * Cómo se puede llamar en EA la categoría de adicionales.
 *
 * `extras` es el id de `pricing.ts`; los otros son cómo una persona la
 * escribiría al crearla a mano en la interfaz de EA. Se comparan normalizados
 * —sin tildes, sin mayúsculas—, la misma disciplina que usa
 * `components/ui/status.ts` con los estados que EA guarda como texto libre.
 */
export const EXTRAS_CATEGORY_ALIASES: readonly string[] = [
  "extras",
  "extra",
  "adicionales",
  "adicional",
];

/**
 * Los adicionales que van adelante, en este orden.
 *
 * Sale del plan, que los nombra así al describir el modelo (§ Cuenta de
 * servicio: «`design-per-nail`, `system-removal`, `single-press-on-nail`,
 * `in-depth-foot-cleaning`…»).
 *
 * **No es un ranking medido.** Un "cinco más usados" de verdad sería un
 * `COUNT(*)` sobre `appointment_finance_item`, y ese `SELECT` pertenece a un
 * repositorio de A2, no a este paquete. Cuando exista, `orderExtras()` recibe
 * el orden como argumento y no hay nada más que cambiar.
 */
export const PREFERRED_EXTRAS: readonly string[] = [
  "design-per-nail",
  "system-removal",
  "single-press-on-nail",
  "in-depth-foot-cleaning",
  "single-dual-system-nail",
];

/** Cuántos adicionales se muestran antes del "ver todos". */
export const FEATURED_EXTRAS = 5;

/** Grupo del selector de servicio. */
export type CatalogGroup = {
  categoryName: string;
  services: CatalogService[];
};

/** El cajón de los servicios que EA dejó sin categoría. */
export const UNCATEGORIZED = "Sin categoría";

/**
 * Sin tildes, sin mayúsculas, sin espacios de sobra. El dato lo escribe una
 * persona en la interfaz de EA, así que se compara normalizado o no se compara.
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase();
}

/** ¿Esta categoría de EA es la de adicionales? */
export function isExtrasCategory(categoryName: string | null | undefined): boolean {
  if (!categoryName) return false;
  return EXTRAS_CATEGORY_ALIASES.includes(normalizeName(categoryName));
}

export function findService(
  catalog: TicketCatalog,
  eaServiceId: number | null,
): CatalogService | null {
  if (eaServiceId === null) return null;
  return catalog.services.find((s) => s.eaServiceId === eaServiceId) ?? null;
}

/** Todo lo que puede ser "lo que se hizo". Los adicionales no lo son. */
export function mainServices(catalog: TicketCatalog): CatalogService[] {
  return catalog.services.filter((s) => !s.isExtra);
}

/**
 * Los adicionales, con los preferidos adelante y el resto por nombre.
 *
 * El orden importa en un celular: los primeros son los únicos que se ven sin
 * desplegar la lista completa, y desplegarla entre dos clientas es justo el
 * gesto que no se hace.
 */
export function orderExtras(
  catalog: TicketCatalog,
  preferred: readonly string[] = PREFERRED_EXTRAS,
): CatalogService[] {
  const rank = new Map(preferred.map((id, index) => [id, index]));
  const weight = (s: CatalogService): number =>
    (s.pricingId === null ? undefined : rank.get(s.pricingId)) ?? Number.MAX_SAFE_INTEGER;

  return catalog.services
    .filter((s) => s.isExtra)
    .sort((a, b) => {
      const diff = weight(a) - weight(b);
      if (diff !== 0) return diff;
      return a.name.localeCompare(b.name, "es-CO");
    });
}

/**
 * Los servicios agrupados por categoría, **con la del servicio actual primero**.
 *
 * Es el paso 1 del flujo: la cita venía con un servicio elegido y cambiarlo
 * tiene que ser un toque. El caso real es "se reservó press-on y terminó en
 * forrado", y montajes y forrados son categorías distintas — así que después de
 * la propia va el resto en orden alfabético, no un orden inventado de
 * "categorías parecidas" que nadie podría explicar.
 *
 * Un servicio sin categoría cae en un grupo al final y se puede elegir igual.
 * Esconderlo dejaría a la técnica sin forma de registrar lo que hizo, que es
 * peor que un encabezado feo.
 */
export function groupServicesForPicker(
  catalog: TicketCatalog,
  currentServiceId: number | null,
): CatalogGroup[] {
  const current = findService(catalog, currentServiceId);
  const currentCategory = current && !current.isExtra ? current.categoryName : null;

  const groups = new Map<string, CatalogService[]>();

  for (const service of mainServices(catalog)) {
    const key = service.categoryName || UNCATEGORIZED;
    const bucket = groups.get(key);
    if (bucket) bucket.push(service);
    else groups.set(key, [service]);
  }

  const out: CatalogGroup[] = [...groups.entries()]
    .map(([categoryName, services]) => ({
      categoryName,
      services: services.sort((a, b) => a.name.localeCompare(b.name, "es-CO")),
    }))
    .sort((a, b) => {
      if (a.categoryName === UNCATEGORIZED) return 1;
      if (b.categoryName === UNCATEGORIZED) return -1;
      return a.categoryName.localeCompare(b.categoryName, "es-CO");
    });

  if (currentCategory === null || currentCategory === "") return out;

  const index = out.findIndex((g) => g.categoryName === currentCategory);
  if (index <= 0) return out;

  return [out[index], ...out.slice(0, index), ...out.slice(index + 1)];
}

/**
 * Filtra los grupos por texto, para cuando el catálogo no cabe en una pantalla.
 *
 * Busca sobre el nombre normalizado, así que "forrado" encuentra "Forrado" y
 * "polygel" encuentra "Polygel dual". Sin coincidencias devuelve la lista
 * vacía y la pantalla muestra su vacío — nunca el catálogo entero "por las
 * dudas", que es cómo alguien termina eligiendo el servicio equivocado.
 */
export function filterGroups(groups: readonly CatalogGroup[], query: string): CatalogGroup[] {
  const needle = normalizeName(query);
  if (needle === "") return [...groups];

  return groups
    .map((g) => ({
      categoryName: g.categoryName,
      services: g.services.filter((s) => normalizeName(s.name).includes(needle)),
    }))
    .filter((g) => g.services.length > 0);
}
