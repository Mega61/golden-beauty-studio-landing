import "server-only";

import { COMBO_COMPOSITION, type ComboCompositionEntry } from "@/data/combo-composition";
import { getDb } from "@/db/client";
import { comboRepository, serviceMapRepository } from "@/db/repositories";
import type { Db } from "@/db/repositories/shared";

import type { ComboComposition } from "./combos";

/**
 * De dónde sale la composición de un combo, y por qué de donde sale.
 *
 * La composición —qué servicio de manos y qué servicio de pies reemplaza un
 * combo— la **declara** `src/data/pricing.ts` de la landing, junto al precio y
 * la duración, porque es la misma clase de dato y la misma persona lo edita. Un
 * precio no puede tener dos dueños, y ya tiene uno.
 *
 * Pero la landing **no viaja dentro de la imagen del panel**: el Dockerfile
 * construye con contexto `admin/`. Leer aquel archivo en caliente obligaba a
 * montarlo en el contenedor y a apuntar `PRICING_SOURCE_PATH`, o sea que
 * componer combos solo funcionaba si alguien se acordaba de montar un archivo.
 * Una función que depende de eso es una función que en el estudio no existe.
 *
 * Así que la composición se **hornea**: `scripts/build-combo-map.mjs` de la
 * landing la copia a `@/data/combo-composition`, un módulo generado y
 * commiteado que sí viaja en la imagen. Corre en el `predev`/`prebuild` de la
 * landing y CI falla si quedó viejo.
 *
 * Lo único que queda por resolver en caliente es traducir los ids de vitrina a
 * los numéricos de EA, y eso sale de `service_map`, que está en la base del
 * propio panel. Resultado: **nada de esto pide un paso manual.** Publicar el
 * combo en `/admin/servicios` deja su fila en `service_map`, y desde ese momento
 * se puede componer.
 */
export type ComboSource = {
  combos: ComboComposition[];
  /** `null` cuando se pudo resolver. Con texto, componer está apagado y se dice. */
  reason: string | null;
};

/** Cuánto se reusa la traducción antes de volver a consultar `service_map`. */
const TTL_MS = 60_000;

let cached: { at: number; value: ComboSource } | null = null;

/**
 * Las composiciones en ids de EA, listas para el navegador.
 *
 * Se cachean un minuto en memoria del proceso: la agenda repregunta cada 30 s
 * por el sondeo y el catálogo público una vez por visita, y sin esto cada una
 * sería una consulta más para devolver siempre lo mismo. Un minuto es corto de
 * sobra para que vincular un servicio se note sin reiniciar nada — y
 * `forgetComboCompositions()` lo adelanta desde quien acaba de tocar el mapa.
 */
export async function loadComboCompositions(): Promise<ComboSource> {
  const now = Date.now();
  if (cached && now - cached.at < TTL_MS) return cached.value;

  const value = await resolveAgainstServiceMap();
  cached = { at: now, value };
  return value;
}

/** Tira el caché. Lo llama quien acaba de vincular o desvincular un servicio. */
export function forgetComboCompositions(): void {
  cached = null;
}

/**
 * Nunca lanza.
 *
 * Sin composiciones las dos pantallas que agendan siguen funcionando: los
 * combos se vuelven un servicio suelto más y dejan de poder alcanzarse por sus
 * mitades. Eso es degradación aceptable; tumbar la agenda por una consulta
 * auxiliar no lo es. Lo que sí se respeta es que "no pude leer" y "no hay
 * ninguno" lleguen distinguibles a quien muestre el resultado — con `[]` y
 * `reason: null` lo segundo, con `reason` escrito lo primero.
 */
async function resolveAgainstServiceMap(): Promise<ComboSource> {
  try {
    const rows = await serviceMapRepository(getDb()).listAll();
    const eaIdOf = new Map(rows.map((row) => [row.pricing_id, row.ea_service_id]));
    return { combos: toEaIds(COMBO_COMPOSITION, eaIdOf), reason: null };
  } catch (error) {
    console.error("[combos] no se pudo leer service_map", error);
    return {
      combos: [],
      reason:
        "No se pudo leer la correspondencia entre la vitrina y la agenda. " +
        "Los combos se pueden agendar sueltos; combinar manos y pies queda apagado.",
    };
  }
}

/**
 * Vitrina → EA, saltándose lo que todavía no está publicado.
 *
 * **Las tres partes tienen que existir en EA.** Un combo cuyo servicio de manos
 * no se publicó no se puede componer: se ofrecería un par que al guardar apunta
 * a un servicio inexistente. Se salta en silencio porque la pantalla de
 * Servicios ya es la que reporta qué falta publicar, con el detalle y el botón
 * al lado; repetir el aviso en la agenda sería ruido en la pantalla equivocada.
 */
export function toEaIds(
  entries: readonly ComboCompositionEntry[],
  eaIdOf: ReadonlyMap<string, number>,
): ComboComposition[] {
  const out: ComboComposition[] = [];

  for (const entry of entries) {
    const eaServiceId = eaIdOf.get(entry.pricingId);
    const handsEaServiceId = eaIdOf.get(entry.hands);
    const feetEaServiceId = eaIdOf.get(entry.feet);

    if (
      eaServiceId === undefined ||
      handsEaServiceId === undefined ||
      feetEaServiceId === undefined
    ) {
      continue;
    }

    out.push({ eaServiceId, handsEaServiceId, feetEaServiceId });
  }

  return out;
}

// ---------------------------------------------------------------------------
// La tabla `combo`, para las comisiones
// ---------------------------------------------------------------------------

export type ComboSyncResult = {
  written: number;
  removed: number;
  /** Ids de vitrina que todavía no se pueden componer: falta publicar algo. */
  skipped: string[];
};

/**
 * Deja `gbs_admin.combo` igual a la composición horneada.
 *
 * **Agendar no necesita esta tabla** —eso lo resuelve `loadComboCompositions()`
 * contra `service_map`— pero las comisiones sí: es de donde
 * `lib/combo-allocation.ts` saca `allocation_hands_bp` para repartir un combo
 * trabajado a cuatro manos. Sin filas acá, esa cuenta se salta entera en la
 * liquidación como `reparto-desconocido`.
 *
 * Lo corre el **reconcile nocturno**, que es el trabajo que ya existe para que
 * ningún dato dependa de que alguien se acuerde. Es idempotente: correrlo dos
 * veces escribe lo mismo.
 *
 * Dos decisiones que no son obvias:
 *
 * - **El precio y la duración se copian, no se calculan.** Son criterio de la
 *   dueña (`db/migrations/010-combo.ts`): un combo cuesta y dura *menos* que
 *   sus mitades justamente porque alguien lo decidió así.
 * - **`allocation_hands_bp` sí se deriva**, y es lo único que acá se calcula:
 *   en proporción a lo que vale cada mitad en la vitrina. Es la mejor
 *   aproximación disponible al trabajo de cada técnica, y la diferencia entre
 *   repartir el combo o saltarlo.
 */
export async function syncComboTable(db: Db = getDb()): Promise<ComboSyncResult> {
  const rows = await serviceMapRepository(db).listAll();
  const eaIdOf = new Map(rows.map((row) => [row.pricing_id, row.ea_service_id]));

  const repo = comboRepository(db);
  const written: number[] = [];
  const skipped: string[] = [];

  for (const entry of COMBO_COMPOSITION) {
    const eaServiceId = eaIdOf.get(entry.pricingId);
    const handsEaServiceId = eaIdOf.get(entry.hands);
    const feetEaServiceId = eaIdOf.get(entry.feet);

    if (
      eaServiceId === undefined ||
      handsEaServiceId === undefined ||
      feetEaServiceId === undefined
    ) {
      skipped.push(entry.pricingId);
      continue;
    }

    await repo.upsert({
      ea_service_id: eaServiceId,
      hands_ea_service_id: handsEaServiceId,
      feet_ea_service_id: feetEaServiceId,
      price: entry.priceCOP,
      duration_min: entry.durationMin,
      allocation_hands_bp: handsShareBp(entry.handsPriceCOP, entry.feetPriceCOP),
    });
    written.push(eaServiceId);
  }

  const removed = await repo.removeExcept(written);
  forgetComboCompositions();

  return { written: written.length, removed, skipped };
}

/**
 * Qué parte del combo son las manos, en puntos básicos enteros.
 *
 * En proporción al precio de lista de cada mitad. Se redondea al entero más
 * cercano y se guarda en bp y no en decimal por la misma razón que las tasas de
 * `commission_rule`: `0.4` no existe en coma flotante y una comisión calculada
 * con él se desvía de a un peso.
 *
 * Con las dos mitades en cero se reparte mitad y mitad. No es una suposición
 * sobre el trabajo: es que sin precios no hay proporción que calcular, y 50/50
 * es el único reparto que no privilegia a ninguna de las dos por accidente.
 */
export function handsShareBp(handsPrice: number, feetPrice: number): number {
  const total = handsPrice + feetPrice;
  if (total <= 0) return 5000;
  return Math.min(10000, Math.max(0, Math.round((handsPrice / total) * 10000)));
}
