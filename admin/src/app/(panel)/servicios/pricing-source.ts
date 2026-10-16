import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { SHOWCASE_PRICING_SOURCE } from "@/data/showcase-pricing";

import { parsePricingSource, type PricingEntry } from "./pricing-parse";

/**
 * De dónde sale el texto de la vitrina.
 *
 * En el repositorio, `pricing.ts` está un nivel arriba de `admin/`. En el
 * contenedor **no está**: la imagen del panel copia `admin/` y nada más. Por eso
 * la imagen lleva una copia textual, generada por `scripts/build-combo-map.mjs`
 * de la landing (`@/data/showcase-pricing`), que se usa cuando no hay ni
 * `PRICING_SOURCE_PATH` ni archivo al lado.
 *
 * ## Lo que no puede pasar
 *
 * Que "no pude leer la vitrina" se vea igual que "la vitrina está al día". Si
 * el diff se calculara contra una lista vacía, la pantalla diría que **todo el
 * catálogo de EA sobra** y ofrecería desvincularlo. Por eso este módulo
 * devuelve un resultado con dos formas —`ok` o `error`— en vez de una lista que
 * a veces viene vacía, y la pantalla tiene que atender las dos.
 */

/**
 * Ruta del archivo dentro del repositorio, relativa a `admin/`.
 *
 * Exportada porque el test del parser la usa para leer el archivo de verdad: es
 * el único contrato que ese parser tiene que cumplir.
 */
export const LANDING_PRICING_RELATIVE_PATH = path.join(
  "..",
  "src",
  "data",
  "pricing.ts",
);

/**
 * `PRICING_SOURCE_PATH` gana sobre todo.
 *
 * Es lo que le deja al despliegue montar el archivo (o una copia generada en el
 * build de la imagen) donde quiera, sin reconstruir nada. Sin la variable se
 * intenta la ruta del repositorio, que es la que sirve en desarrollo.
 */
function candidatePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.PRICING_SOURCE_PATH?.trim();
  if (configured) return [configured];
  return [
    path.resolve(process.cwd(), LANDING_PRICING_RELATIVE_PATH),
    // Por si el proceso corre desde la raíz del repositorio y no desde `admin/`.
    path.resolve(process.cwd(), "src", "data", "pricing.ts"),
  ];
}

export type PricingCatalogResult =
  | { ok: true; entries: PricingEntry[]; sourcePath: string }
  | { ok: false; error: string; tried: string[] };

/**
 * La vitrina, o el motivo por el que no se pudo leer.
 *
 * Nunca lanza. Un catálogo que no se pudo leer es información que la pantalla
 * tiene que mostrar —con el nombre del archivo que buscó— y no un 500 que deja
 * a la dueña sin saber qué configurar.
 */
export async function loadPricingCatalog(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PricingCatalogResult> {
  const tried = candidatePaths(env);
  let lastError = "No se intentó ninguna ruta.";

  for (const candidate of tried) {
    let source: string;
    try {
      source = await readFile(candidate, "utf8");
    } catch {
      lastError = `No se pudo abrir ${candidate}.`;
      continue;
    }

    try {
      return { ok: true, entries: parsePricingSource(source), sourcePath: candidate };
    } catch (error) {
      // Se encontró el archivo pero no se entendió. Eso **no** se reintenta con
      // la ruta siguiente: el archivo correcto está roto, y leer otro sería
      // publicar precios de una copia vieja.
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        tried: [candidate],
      };
    }
  }

  // Una ruta configurada a mano y ausente es un error de configuración, y se
  // dice: caer a la copia horneada escondería que alguien apuntó a otro lado.
  if (env.PRICING_SOURCE_PATH?.trim()) {
    return {
      ok: false,
      error: `${lastError} PRICING_SOURCE_PATH apunta a un archivo que no está.`,
      tried,
    };
  }

  // Sin configuración y sin la landing al lado —el contenedor—: la copia de
  // `pricing.ts` que viaja en la imagen (`@/data/showcase-pricing`), el mismo
  // texto leído por el mismo parser. Es generada y CI falla si quedó vieja, así
  // que no es "una lista cualquiera": es la vitrina del commit desplegado.
  try {
    return {
      ok: true,
      entries: parsePricingSource(SHOWCASE_PRICING_SOURCE),
      sourcePath: BAKED_SOURCE_LABEL,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      tried: [...tried, BAKED_SOURCE_LABEL],
    };
  }
}

/** Lo que la pantalla muestra como origen cuando se leyó la copia horneada. */
export const BAKED_SOURCE_LABEL = "la copia horneada en la imagen (admin/src/data/showcase-pricing.ts)";
