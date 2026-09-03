/**
 * El diff `src/data/pricing.ts` ↔ Easy!Appointments.
 *
 * Hay tres lugares donde puede vivir un precio —la vitrina, el override de
 * Strapi y `ea_services.price`— y tres escritores sobre el mismo número es
 * deriva garantizada. La decisión del plan (§ Catálogo y precios) es que la
 * vitrina manda y el panel **publica en un solo sentido**, con
 * `PUT /services/{id}`. Esta pantalla es la que muestra la diferencia antes de
 * publicarla; `service_map` guarda quién es quién.
 *
 * Este módulo es puro: recibe las tres listas ya leídas y devuelve los
 * renglones. Es la parte que decide qué se le va a escribir a EA, así que no
 * puede estar dentro de un componente.
 *
 * ## Las cinco cosas que pueden pasar
 *
 * | Estado | Qué significa | Qué se puede hacer |
 * | --- | --- | --- |
 * | `al-dia` | precio y duración coinciden | nada |
 * | `desincronizado` | está mapeado y algo difiere | publicar |
 * | `sin-vincular` | está en la vitrina y no tiene fila en `service_map` | vincular a un servicio de EA |
 * | `mapa-roto` | hay fila en `service_map` y el servicio ya no está en EA | desvincular |
 * | `solo-en-ea` | servicio de EA que nadie reclama | mirarlo; puede ser legítimo |
 *
 * ## Lo que este módulo NO hace
 *
 * **No crea servicios en EA.** La publicación es `PUT`, nunca `POST`, y la
 * razón no es prudencia: el nombre del servicio no vive en `pricing.ts` sino en
 * los diccionarios `es.json`/`en.json` de la landing, y un servicio de EA
 * necesita nombre. Crear uno desde acá significaría inventarle un nombre a
 * partir del id (`polygel-sculpted` → "Polygel Sculpted"), que es exactamente
 * el tipo de dato inventado que después nadie corrige. Se crea a mano en EA una
 * vez y se vincula.
 *
 * **No toca el color.** `service.color` es de solo escritura en la API de EA
 * (hallazgo de A1): un leer-modificar-guardar mandaría `null` y borraría el
 * color del calendario. El payload de publicación lleva **solo** precio y
 * duración.
 */

import type { Service } from "@/lib/ea";
import type { ServiceMap } from "@/db/types";

import type { PricingEntry } from "./pricing-parse";

export type DiffState =
  | "al-dia"
  | "desincronizado"
  | "sin-vincular"
  | "mapa-roto"
  | "solo-en-ea";

/** En qué difieren la vitrina y EA. Vacío ⇔ `al-dia`. */
export type DiffField = "precio" | "duracion";

export type DiffRow = {
  /** Estable entre renders: `pricing:<id>` o `ea:<id>`. */
  key: string;
  state: DiffState;
  /** El id de la vitrina. `null` en `solo-en-ea`. */
  pricingId: string | null;
  categoryId: string | null;
  /** El servicio de EA, si existe. */
  eaServiceId: number | null;
  eaName: string | null;

  showcasePrice: number | null;
  eaPrice: number | null;
  /** Minutos. `null` en la vitrina significa "no ocupa tiempo propio". */
  showcaseDuration: number | null;
  eaDuration: number | null;

  differing: DiffField[];
  /** Último `PUT /services/{id}` exitoso, si alguna vez hubo uno. */
  lastPublishedAt: Date | null;
  /** Marcado como "solo vitrina" en `pricing.ts`: no se espera que mapee. */
  showcaseOnly: boolean;
};

export type CatalogDiff = {
  rows: DiffRow[];
  /** Cuántos renglones hay de cada estado. Alimenta el encabezado. */
  counts: Record<DiffState, number>;
  /** Los que se pueden publicar de una. */
  publishable: DiffRow[];
};

/**
 * Lo que se le manda a `PUT /services/{id}`.
 *
 * Deliberadamente angosto. Cada campo que se agregue acá es un campo que la
 * publicación puede pisar sin que nadie lo haya pedido.
 */
export type PublishPayload = {
  eaServiceId: number;
  price: number;
  /** Se omite cuando la vitrina dice `null`: no ocupa tiempo propio. */
  duration: number | null;
};

/** El orden en que la pantalla los muestra: primero lo que hay que atender. */
const STATE_ORDER: Record<DiffState, number> = {
  desincronizado: 0,
  "sin-vincular": 1,
  "mapa-roto": 2,
  "solo-en-ea": 3,
  "al-dia": 4,
};

export function buildCatalogDiff(
  showcase: readonly PricingEntry[],
  eaServices: readonly Service[],
  serviceMap: readonly ServiceMap[],
): CatalogDiff {
  const eaById = new Map<number, Service>();
  for (const service of eaServices) eaById.set(service.id, service);

  const mapByPricingId = new Map<string, ServiceMap>();
  const mappedEaIds = new Set<number>();
  for (const row of serviceMap) {
    mapByPricingId.set(row.pricing_id, row);
    mappedEaIds.add(row.ea_service_id);
  }

  const rows: DiffRow[] = [];

  for (const entry of showcase) {
    const mapping = mapByPricingId.get(entry.id);

    if (!mapping) {
      rows.push({
        key: `pricing:${entry.id}`,
        state: "sin-vincular",
        pricingId: entry.id,
        categoryId: entry.categoryId,
        eaServiceId: null,
        eaName: null,
        showcasePrice: entry.priceCOP,
        eaPrice: null,
        showcaseDuration: entry.durationMin,
        eaDuration: null,
        differing: [],
        lastPublishedAt: null,
        showcaseOnly: entry.showcaseOnly,
      });
      continue;
    }

    const service = eaById.get(mapping.ea_service_id);

    if (!service) {
      // La fila del mapa apunta a un servicio que ya no existe. Puede ser un
      // borrado en EA o un id cambiado a mano; en los dos casos publicar
      // devolvería 404 y hay que desvincular antes.
      rows.push({
        key: `pricing:${entry.id}`,
        state: "mapa-roto",
        pricingId: entry.id,
        categoryId: entry.categoryId,
        eaServiceId: mapping.ea_service_id,
        eaName: null,
        showcasePrice: entry.priceCOP,
        eaPrice: null,
        showcaseDuration: entry.durationMin,
        eaDuration: null,
        differing: [],
        lastPublishedAt: mapping.last_published_at,
        showcaseOnly: entry.showcaseOnly,
      });
      continue;
    }

    const differing = compareFields(entry, service);

    rows.push({
      key: `pricing:${entry.id}`,
      state: differing.length === 0 ? "al-dia" : "desincronizado",
      pricingId: entry.id,
      categoryId: entry.categoryId,
      eaServiceId: service.id,
      eaName: service.name,
      showcasePrice: entry.priceCOP,
      eaPrice: service.price,
      showcaseDuration: entry.durationMin,
      eaDuration: service.duration,
      differing,
      lastPublishedAt: mapping.last_published_at,
      showcaseOnly: entry.showcaseOnly,
    });
  }

  for (const service of eaServices) {
    if (mappedEaIds.has(service.id)) continue;
    rows.push({
      key: `ea:${service.id}`,
      state: "solo-en-ea",
      pricingId: null,
      categoryId: null,
      eaServiceId: service.id,
      eaName: service.name,
      showcasePrice: null,
      eaPrice: service.price,
      showcaseDuration: null,
      eaDuration: service.duration,
      differing: [],
      lastPublishedAt: null,
      showcaseOnly: false,
    });
  }

  rows.sort((a, b) => {
    const byState = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (byState !== 0) return byState;
    return a.key.localeCompare(b.key);
  });

  const counts: Record<DiffState, number> = {
    "al-dia": 0,
    desincronizado: 0,
    "sin-vincular": 0,
    "mapa-roto": 0,
    "solo-en-ea": 0,
  };
  for (const row of rows) counts[row.state] += 1;

  return {
    rows,
    counts,
    publishable: rows.filter((row) => row.state === "desincronizado"),
  };
}

/**
 * Qué difiere entre la vitrina y EA.
 *
 * Dos decisiones que parecen detalles y no lo son:
 *
 * - **Un precio ausente en EA (`null`) cuenta como diferencia.** Un servicio sin
 *   precio congela `null` al agendar, y esa cita después no se puede liquidar.
 * - **La duración `null` de la vitrina NO se compara.** Significa "este
 *   adicional no ocupa tiempo propio" (un diseño por uña), no "la duración en EA
 *   debería ser nula". Publicar eso pondría en cero la duración de un servicio
 *   agendable, y una cita de duración cero rompe la grilla de la agenda.
 */
function compareFields(entry: PricingEntry, service: Service): DiffField[] {
  const differing: DiffField[] = [];
  if (service.price === null || service.price !== entry.priceCOP) {
    differing.push("precio");
  }
  if (entry.durationMin !== null && service.duration !== entry.durationMin) {
    differing.push("duracion");
  }
  return differing;
}

/**
 * El payload de publicación de un renglón, o `null` si ese renglón no se puede
 * publicar.
 *
 * Solo `desincronizado` se puede publicar: `sin-vincular` no tiene a quién
 * escribirle y `mapa-roto` le escribiría a un servicio que ya no existe.
 */
export function publishPayload(row: DiffRow): PublishPayload | null {
  if (row.state !== "desincronizado") return null;
  if (row.eaServiceId === null || row.showcasePrice === null) return null;
  return {
    eaServiceId: row.eaServiceId,
    price: row.showcasePrice,
    duration: row.showcaseDuration,
  };
}
