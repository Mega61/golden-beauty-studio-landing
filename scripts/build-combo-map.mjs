// Bakes what the admin panel needs from the landing into the panel's own source
// tree, because the panel's image does not contain the landing:
//
//   - admin/src/data/combo-composition.ts — which hands + feet each combo
//     replaces (from src/data/pricing.ts).
//   - admin/src/data/service-names.ts — the client-facing Spanish name of every
//     price-list item and the label of every category (from es.json). It is the
//     name `scripts/catalogo.js` gives each service it creates in EA.
//   - admin/src/data/showcase-pricing.ts — the text of src/data/pricing.ts
//     itself, verbatim, so the panel's own parser (`pricing-parse.ts`) reads the
//     same bytes in the container that it reads from the repo in development.
//
// ── Why generate instead of reading the file at runtime ─────────────────────
//
// The panel needs to know which hands service and which feet service each combo
// replaces: that is how both the admin agenda and the public booking flow reach
// a combo — you pick the two halves, never the combo itself.
//
// That fact lives in `src/data/pricing.ts`, next to the price, because a price
// has one owner. But the panel's Docker image is built with context `admin/`
// and copies `admin/` and nothing else, so on the VM that file does not exist.
// The panel used to read it through PRICING_SOURCE_PATH, which means composing
// combos only worked if somebody remembered to mount a file — a feature that is
// dead in the studio is not a feature.
//
// So the composition is copied, at authoring time, into a committed TypeScript
// module inside `admin/`. It travels in the image, needs no mount, no env var,
// and no button. What the panel still resolves at runtime is the translation
// from showcase ids to Easy!Appointments ids, and that comes from `service_map`
// in its own database — always available.
//
// ── What is NOT copied ──────────────────────────────────────────────────────
//
// No arithmetic. The generator emits raw facts — the combo's own price and
// duration, and each half's price — and the panel does the one calculation
// there is (`handsShareBp`, the commission split) in TypeScript, where it is
// tested. A number computed here would be a number nobody can test.
//
// ── Keeping it honest ───────────────────────────────────────────────────────
//
// Runs in `predev` and `prebuild`, so editing pricing.ts and running the site
// updates it. `--check` fails instead of writing, and that is what CI runs: a
// generated file that is out of date with its source is worse than no generated
// file, because it looks current.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PRICING_TS = path.join(ROOT, "src", "data", "pricing.ts");
const ES_JSON = path.join(ROOT, "src", "app", "[lang]", "dictionaries", "es.json");
const OUT = path.join(ROOT, "admin", "src", "data", "combo-composition.ts");
const NAMES_OUT = path.join(ROOT, "admin", "src", "data", "service-names.ts");
const SHOWCASE_OUT = path.join(ROOT, "admin", "src", "data", "showcase-pricing.ts");

const CHECK = process.argv.includes("--check");

/**
 * The items of `pricing.ts`, flat, with the fields this script needs.
 *
 * Same brace-depth scan as `check-pricing.mjs` rather than a regex per item: an
 * item can contain a nested object (`composedOf`), and `/\{[^{}]*\}/` would
 * return that inner object as if it were another item.
 */
function parseItems(source) {
  const catRegex = /\{\s*id:\s*"([^"]+)"\s*,\s*items:\s*\[/g;
  const out = [];
  let m;

  while ((m = catRegex.exec(source)) !== null) {
    const categoryId = m[1];
    let depth = 1;
    let i = catRegex.lastIndex;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
      i++;
    }

    const body = source.slice(catRegex.lastIndex, i - 1);
    let braces = 0;
    let from = 0;
    for (let j = 0; j < body.length; j += 1) {
      const ch = body[j];
      if (ch === "{") {
        if (braces === 0) from = j + 1;
        braces += 1;
      } else if (ch === "}") {
        braces -= 1;
        if (braces === 0) out.push(readItem(categoryId, body.slice(from, j)));
      }
    }

    catRegex.lastIndex = i;
  }

  return out.filter((item) => item.id !== null);
}

function readItem(categoryId, body) {
  // The nested object is removed before reading scalars, so a key inside
  // `composedOf` can never be mistaken for a key of the item.
  const flat = body.replace(/\{[^{}]*\}/g, "");
  const id = /(^|[\s,{])id:\s*"([^"]+)"/.exec(flat);
  const price = /(^|[\s,{])priceCOP:\s*([\d_]+)/.exec(flat);
  const duration = /(^|[\s,{])durationMin:\s*(null|[\d_]+)/.exec(flat);
  const composed =
    /composedOf:\s*\{\s*hands:\s*"([^"]+)"\s*,\s*feet:\s*"([^"]+)"\s*,?\s*\}/.exec(body);

  return {
    id: id ? id[2] : null,
    categoryId,
    priceCOP: price ? Number(price[2].replace(/_/g, "")) : null,
    durationMin:
      !duration || duration[2] === "null" ? null : Number(duration[2].replace(/_/g, "")),
    composedOf: composed ? { hands: composed[1], feet: composed[2] } : null,
  };
}

function render(entries) {
  const rows = entries
    .map(
      (e) =>
        `  {\n` +
        `    pricingId: ${JSON.stringify(e.pricingId)},\n` +
        `    hands: ${JSON.stringify(e.hands)},\n` +
        `    feet: ${JSON.stringify(e.feet)},\n` +
        `    priceCOP: ${e.priceCOP},\n` +
        `    durationMin: ${e.durationMin},\n` +
        `    handsPriceCOP: ${e.handsPriceCOP},\n` +
        `    feetPriceCOP: ${e.feetPriceCOP},\n` +
        `  },`,
    )
    .join("\n");

  return `// GENERADO POR \`npm run build-combo-map\` EN LA LANDING. No editar a mano:
// el siguiente \`npm run dev\` o \`npm run build\` de la landing lo reescribe, y
// CI falla si quedó desactualizado respecto de \`src/data/pricing.ts\`.
//
// ## Por qué este archivo existe
//
// La composición de un combo —qué servicio de manos y qué servicio de pies
// reemplaza— la declara la vitrina, que vive en la landing. Pero la imagen del
// panel se construye con contexto \`admin/\` y no contiene la landing: leer aquel
// archivo en caliente obligaba a montarlo en el contenedor, y una función que
// depende de que alguien se acuerde de montar un archivo es una función que en
// el estudio no existe.
//
// Así que la composición se copia acá, en tiempo de autoría, y viaja dentro de
// la imagen. Lo único que queda por resolver en caliente es la traducción de
// estos ids de vitrina a los numéricos de Easy!Appointments, y eso sale de
// \`service_map\`, que está en la base del propio panel.
//
// ## Lo que acá NO hay
//
// Aritmética. Los precios de las dos mitades vienen crudos: el reparto de
// comisión (\`handsShareBp\`) lo calcula \`lib/combo-source.ts\`, en TypeScript,
// donde está testeado. Un número calculado por el generador sería un número que
// ningún test mira.
//
// Y el **precio del combo no es la suma de sus mitades**: es criterio de la
// dueña y suele ser menor (ver \`db/migrations/010-combo.ts\`). Las dos cifras
// viajan juntas justamente para poder mostrar la suma tachada al lado del
// precio real.

/** Un combo y las dos mitades que reemplaza, en ids de \`src/data/pricing.ts\`. */
export type ComboCompositionEntry = {
  pricingId: string;
  hands: string;
  feet: string;
  /** Lo que cuesta el combo. **No** es \`handsPriceCOP + feetPriceCOP\`. */
  priceCOP: number;
  /** Lo que dura el combo. Tampoco es la suma. */
  durationMin: number;
  /** Precio de lista de la mitad de manos. Solo para tachar y para el reparto. */
  handsPriceCOP: number;
  /** Precio de lista de la mitad de pies. Igual. */
  feetPriceCOP: number;
};

export const COMBO_COMPOSITION: readonly ComboCompositionEntry[] = [
${rows}
];
`;
}

/**
 * The Spanish names, in price-list order. Every pricing id must have one: a
 * service created in EA without its real name would show the client an
 * invented label in her confirmation.
 */
function namesFrom(items, dictionary, errors) {
  const categories = dictionary?.servicios?.categories ?? {};
  const names = [];
  const labels = [];
  const seenCategories = new Set();

  for (const item of items) {
    const category = categories[item.categoryId];
    if (!seenCategories.has(item.categoryId)) {
      seenCategories.add(item.categoryId);
      const label = typeof category?.label === "string" ? category.label.trim() : "";
      if (label === "") errors.push(`categoría "${item.categoryId}": sin label en es.json.`);
      labels.push({ id: item.categoryId, label });
    }
    const name = category?.items?.[item.id]?.name;
    if (typeof name !== "string" || name.trim() === "") {
      errors.push(`"${item.id}": sin servicios.categories.${item.categoryId}.items.${item.id}.name en es.json.`);
      continue;
    }
    names.push({ id: item.id, name: name.trim() });
  }

  return { names, labels };
}

function renderNames({ names, labels }) {
  const nameRows = names
    .map((n) => `  ${JSON.stringify(n.id)}: ${JSON.stringify(n.name)},`)
    .join("\n");
  const labelRows = labels
    .map((c) => `  { id: ${JSON.stringify(c.id)}, label: ${JSON.stringify(c.label)} },`)
    .join("\n");

  return `// GENERADO POR \`npm run build-combo-map\` EN LA LANDING. No editar a mano:
// sale de \`src/data/pricing.ts\` (los ids) y de
// \`src/app/[lang]/dictionaries/es.json\` (los nombres), y CI falla si quedó
// desactualizado.
//
// Son los nombres que ve la clienta: los mismos de la lista de precios de la
// landing. \`scripts/catalogo.js\` los usa para crear en Easy!Appointments los
// servicios que faltan; la imagen del panel no contiene la landing, así que
// leer el diccionario en caliente no es una opción.

/** El nombre en español de cada id de la vitrina. */
export const SERVICE_NAMES: Readonly<Record<string, string>> = {
${nameRows}
};

/** Las categorías de la vitrina, en su orden, con la etiqueta de la landing. */
export const SERVICE_CATEGORIES: ReadonlyArray<{ id: string; label: string }> = [
${labelRows}
];
`;
}

function renderShowcase(source) {
  return `// GENERADO POR \`npm run build-combo-map\` EN LA LANDING. No editar a mano:
// es el texto de \`src/data/pricing.ts\`, copiado tal cual, y CI falla si quedó
// desactualizado.
//
// La pantalla de Servicios y \`scripts/catalogo.js\` comparan la vitrina contra
// EA leyendo ese archivo con \`pricing-parse.ts\`. En el repositorio lo
// encuentran al lado; en el contenedor no está, porque la imagen se construye
// con contexto \`admin/\`. Ésta es la copia que viaja en la imagen: el mismo
// texto, leído por el mismo parser, en vez de una segunda representación que
// pudiera discrepar.

export const SHOWCASE_PRICING_SOURCE: string = ${JSON.stringify(source)};
`;
}

/** Writes `next` to `file`, or under `--check` reports whether it is stale. */
async function emit(file, next, label) {
  const current = await fs.readFile(file, "utf8").catch(() => null);
  const relative = path.relative(ROOT, file);
  if (current === next) {
    console.log(`[build-combo-map] OK — ${label}, ya estaba al día.`);
    return true;
  }
  if (CHECK) {
    console.error(
      `[build-combo-map] ${relative} está desactualizado respecto de\n` +
        "  src/data/pricing.ts / es.json. Corre `npm run build-combo-map` en la landing y commitea el\n" +
        "  resultado. Un archivo generado que quedó viejo es peor que no tenerlo: parece al día.",
    );
    return false;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, next, "utf8");
  console.log(`[build-combo-map] escrito — ${label}.`);
  return true;
}

async function main() {
  const source = await fs.readFile(PRICING_TS, "utf8");
  const items = parseItems(source);

  if (items.length === 0) {
    console.error(
      "[build-combo-map] no se pudo leer ningún ítem de src/data/pricing.ts — ¿cambió de forma?",
    );
    process.exit(1);
  }

  const priceOf = new Map(items.map((it) => [it.id, it.priceCOP]));
  const entries = [];
  const errors = [];

  for (const item of items) {
    if (!item.composedOf) continue;

    const handsPriceCOP = priceOf.get(item.composedOf.hands);
    const feetPriceCOP = priceOf.get(item.composedOf.feet);

    // `check-pricing.mjs` ya rechaza un `composedOf` que apunte a un id
    // inexistente. Se vuelve a verificar acá porque este script puede correr
    // solo, y emitir una entrada con un `undefined` adentro dejaría el archivo
    // generado sin compilar — un error a tres pasos de su causa.
    if (handsPriceCOP === undefined || feetPriceCOP === undefined || item.durationMin === null) {
      errors.push(
        `"${item.id}": composedOf apunta a un id que no existe, o el combo no tiene durationMin.`,
      );
      continue;
    }

    entries.push({
      pricingId: item.id,
      hands: item.composedOf.hands,
      feet: item.composedOf.feet,
      priceCOP: item.priceCOP,
      durationMin: item.durationMin,
      handsPriceCOP,
      feetPriceCOP,
    });
  }

  if (errors.length > 0) {
    console.error("[build-combo-map] la composición de los combos está mal:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }

  const dictionary = JSON.parse(await fs.readFile(ES_JSON, "utf8"));
  const nameErrors = [];
  const names = namesFrom(items, dictionary, nameErrors);
  if (nameErrors.length > 0) {
    console.error("[build-combo-map] faltan nombres en es.json:");
    for (const e of nameErrors) console.error("  - " + e);
    process.exit(1);
  }

  const results = [
    await emit(OUT, render(entries), `${entries.length} combos`),
    await emit(NAMES_OUT, renderNames(names), `${names.names.length} nombres`),
    await emit(SHOWCASE_OUT, renderShowcase(source), "copia de pricing.ts"),
  ];
  if (results.includes(false)) process.exit(1);
}

main().catch((err) => {
  console.error("[build-combo-map] failed:", err);
  process.exit(1);
});
