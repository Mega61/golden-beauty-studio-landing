/**
 * Lee `src/data/pricing.ts` de la landing **como dato**, no como módulo.
 *
 * `pricing.ts` es la fuente de verdad de los precios (§ Catálogo y precios) y
 * vive en la otra aplicación. Importarlo desde `admin/` tendría tres problemas,
 * y el tercero es el que decide:
 *
 * 1. Arrastraría `pricing-format.ts`, los diccionarios y el cliente de Strapi
 *    al bundle del panel, que no necesita nada de eso.
 * 2. Ataría el `tsconfig` del panel a un `rootDir` fuera de `admin/`, que es
 *    justo lo que el andamiaje separó.
 * 3. **La imagen del panel no contiene la landing.** Un import se resolvería en
 *    el build local y no existiría en el contenedor: el error aparecería en
 *    producción, no acá.
 *
 * Entonces se parsea el texto. El parser es a propósito **estricto y ruidoso**:
 * si el archivo cambia de forma, lanza. Un parser tolerante que devolviera una
 * lista a medias haría que la pantalla de diff dijera "todo publicado" sobre un
 * catálogo que no leyó entero, y ése es el único resultado inaceptable de esta
 * pantalla.
 *
 * Es puro: recibe el texto, devuelve entradas. Quién trae el texto y de dónde,
 * en `pricing-source.ts`.
 */

/** Una entrada de la vitrina, con su categoría. */
export type PricingEntry = {
  /** El id de `pricing.ts`. Es la llave de `service_map`. */
  id: string;
  /** `montajes`, `retoques`, `forrados`, `sencillos`, `combos`, `extras`. */
  categoryId: string;
  priceCOP: number;
  /** Minutos. `null` en los adicionales que no ocupan tiempo propio. */
  durationMin: number | null;
  /** `"desde $…"` en la vitrina. No cambia nada de lo que se publica a EA. */
  fromPrice: boolean;
  /**
   * Marca explícita de "esta entrada no se agenda, solo se muestra".
   *
   * **Hoy `pricing.ts` no la trae todavía.** El plan la pide (§ Catálogo:
   * "todo id de `pricing.ts` tiene entrada en `service_map` o está marcado
   * explícitamente como solo vitrina") y la migración `011` explica por qué
   * vive allá y no en la base. El parser ya la reconoce para que agregarla sea
   * una línea en la landing y nada acá.
   */
  showcaseOnly: boolean;
};

export class PricingParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingParseError";
  }
}

/**
 * Quita comentarios sin romper las cadenas.
 *
 * Un `//` dentro de `"https://…"` no es un comentario, y una expresión regular
 * como `/\D/g` no es una división. El barrido es carácter por carácter y
 * mantiene el estado de "estoy dentro de una cadena", que es la única forma de
 * no equivocarse en un archivo real.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < n) {
        const ch = source[i];
        out += ch;
        i += 1;
        if (ch === "\\") {
          if (i < n) {
            out += source[i];
            i += 1;
          }
          continue;
        }
        if (ch === quote) break;
      }
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/** El literal de arreglo que sigue a `export const pricing`, con sus corchetes. */
function extractPricingArray(source: string): string {
  const anchor = /export\s+const\s+pricing\s*(?::[^=]+)?=\s*\[/.exec(source);
  if (!anchor) {
    throw new PricingParseError(
      'No se encontró "export const pricing = [" en el archivo de la vitrina. ' +
        "Si pricing.ts cambió de forma, este parser hay que actualizarlo — pero " +
        "primero hay que mirar qué pasó, porque el panel publica precios a partir de acá.",
    );
  }

  const open = anchor.index + anchor[0].length - 1;
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const c = source[i];
    if (c === "[") depth += 1;
    else if (c === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }

  throw new PricingParseError(
    "El arreglo `pricing` quedó sin cerrar. El archivo de la vitrina está truncado o mal formado.",
  );
}

const CATEGORY_RE =
  /\{\s*id\s*:\s*["']([^"']+)["']\s*,\s*items\s*:\s*\[([\s\S]*?)\]\s*,?\s*\}/g;
const ITEM_RE = /\{([^{}]*)\}/g;

function field(body: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*:\\s*([^,}]+)`);
  const m = re.exec(body);
  return m ? m[1].trim() : null;
}

function requiredInt(body: string, name: string, itemId: string): number {
  const raw = field(body, name);
  if (raw === null) {
    throw new PricingParseError(
      `El ítem "${itemId}" de la vitrina no tiene "${name}". Sin ese número no se puede publicar nada.`,
    );
  }
  const value = Number(raw.replace(/_/g, ""));
  if (!Number.isInteger(value)) {
    throw new PricingParseError(
      `"${name}" de "${itemId}" no es un entero: ${raw}.`,
    );
  }
  return value;
}

/**
 * Texto de `pricing.ts` → entradas.
 *
 * Lanza si no encuentra el arreglo, si queda vacío, o si un ítem no trae
 * precio. Un catálogo vacío no es "no hay servicios": es "no supe leer el
 * archivo", y la diferencia entre las dos cosas es toda la pantalla.
 */
export function parsePricingSource(source: string): PricingEntry[] {
  const array = extractPricingArray(stripComments(source));
  const entries: PricingEntry[] = [];
  const seen = new Set<string>();

  CATEGORY_RE.lastIndex = 0;
  let category: RegExpExecArray | null;
  while ((category = CATEGORY_RE.exec(array)) !== null) {
    const categoryId = category[1];
    const itemsBody = category[2];

    ITEM_RE.lastIndex = 0;
    let item: RegExpExecArray | null;
    while ((item = ITEM_RE.exec(itemsBody)) !== null) {
      const body = item[1];
      const idMatch = /\bid\s*:\s*["']([^"']+)["']/.exec(body);
      if (!idMatch) {
        throw new PricingParseError(
          `Un ítem de la categoría "${categoryId}" no tiene id: ${body.trim()}`,
        );
      }
      const id = idMatch[1];
      if (seen.has(id)) {
        throw new PricingParseError(
          `El id "${id}" aparece dos veces en la vitrina. Es la llave de service_map: no puede repetirse.`,
        );
      }
      seen.add(id);

      const durationRaw = field(body, "durationMin");
      if (durationRaw === null) {
        throw new PricingParseError(
          `El ítem "${id}" no tiene "durationMin". Debe ser un número o null explícito.`,
        );
      }

      entries.push({
        id,
        categoryId,
        priceCOP: requiredInt(body, "priceCOP", id),
        durationMin:
          durationRaw === "null" ? null : requiredInt(body, "durationMin", id),
        fromPrice: field(body, "fromPrice") === "true",
        showcaseOnly: field(body, "showcaseOnly") === "true",
      });
    }
  }

  if (entries.length === 0) {
    throw new PricingParseError(
      "La vitrina se leyó pero quedó vacía. Eso no es un catálogo sin servicios: " +
        "es un parser que no entendió el archivo, y publicar contra una lista vacía " +
        "haría ver todo el catálogo de EA como sobrante.",
    );
  }

  return entries;
}
