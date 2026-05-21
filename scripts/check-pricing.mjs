// Prebuild parity check for pricing data.
//
// Asserts every (categoryId, itemId) declared in src/data/pricing.ts has a
// matching { name, desc } entry under servicios.categories.<catId>.items.<itemId>
// in BOTH es.json and en.json — and that each dictionary carries
// labels.from and labels.currencySuffix.
//
// Fails the build (exit 1) on any mismatch so a broken edit can't ship.
// Runs in predev and prebuild (see package.json).

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PRICING_TS = path.join(ROOT, "src", "data", "pricing.ts");
const ES_JSON = path.join(ROOT, "src", "app", "[lang]", "dictionaries", "es.json");
const EN_JSON = path.join(ROOT, "src", "app", "[lang]", "dictionaries", "en.json");

function parsePricing(source) {
  // Each category looks like: { id: "<cat>", items: [ { id: "<item>", ... }, ... ] }
  // Scan with a bracket-depth counter so nested `[ ]` doesn't confuse us.
  const catRegex = /\{\s*id:\s*"([^"]+)"\s*,\s*items:\s*\[/g;
  const out = [];
  let m;
  while ((m = catRegex.exec(source)) !== null) {
    const catId = m[1];
    let depth = 1;
    let i = catRegex.lastIndex;
    while (i < source.length && depth > 0) {
      const ch = source[i];
      if (ch === "[") depth++;
      else if (ch === "]") depth--;
      i++;
    }
    const itemsBody = source.slice(catRegex.lastIndex, i - 1);
    const itemIds = [...itemsBody.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((x) => x[1]);
    out.push({ id: catId, itemIds });
    catRegex.lastIndex = i;
  }
  return out;
}

async function main() {
  const [pricingSrc, esRaw, enRaw] = await Promise.all([
    fs.readFile(PRICING_TS, "utf8"),
    fs.readFile(ES_JSON, "utf8"),
    fs.readFile(EN_JSON, "utf8"),
  ]);

  let es, en;
  try {
    es = JSON.parse(esRaw);
  } catch (err) {
    console.error("[check-pricing] es.json is not valid JSON:", err.message);
    process.exit(1);
  }
  try {
    en = JSON.parse(enRaw);
  } catch (err) {
    console.error("[check-pricing] en.json is not valid JSON:", err.message);
    process.exit(1);
  }

  const cats = parsePricing(pricingSrc);
  if (cats.length === 0) {
    console.error(
      "[check-pricing] failed to parse any categories from src/data/pricing.ts — has the file shape changed?",
    );
    process.exit(1);
  }

  const errors = [];

  for (const [lang, dict] of [
    ["es", es],
    ["en", en],
  ]) {
    const s = dict.servicios;
    if (!s) {
      errors.push(`${lang}: missing "servicios" section`);
      continue;
    }
    if (
      !s.labels ||
      typeof s.labels.from !== "string" ||
      typeof s.labels.currencySuffix !== "string"
    ) {
      errors.push(`${lang}: servicios.labels.from / labels.currencySuffix must be strings`);
    }
    if (typeof s.footnote !== "string" || s.footnote.length === 0) {
      errors.push(`${lang}: servicios.footnote must be a non-empty string`);
    }
    if (
      !s.categories ||
      typeof s.categories !== "object" ||
      Array.isArray(s.categories)
    ) {
      errors.push(`${lang}: servicios.categories must be an object map`);
      continue;
    }

    for (const cat of cats) {
      const catCopy = s.categories[cat.id];
      if (!catCopy) {
        errors.push(`${lang}: missing servicios.categories.${cat.id}`);
        continue;
      }
      if (typeof catCopy.label !== "string" || typeof catCopy.sub !== "string") {
        errors.push(
          `${lang}: servicios.categories.${cat.id} needs string "label" and "sub"`,
        );
      }
      if (
        !catCopy.items ||
        typeof catCopy.items !== "object" ||
        Array.isArray(catCopy.items)
      ) {
        errors.push(
          `${lang}: servicios.categories.${cat.id}.items must be an object map`,
        );
        continue;
      }
      for (const itemId of cat.itemIds) {
        const itemCopy = catCopy.items[itemId];
        if (!itemCopy) {
          errors.push(
            `${lang}: missing servicios.categories.${cat.id}.items.${itemId}`,
          );
          continue;
        }
        if (typeof itemCopy.name !== "string" || typeof itemCopy.desc !== "string") {
          errors.push(
            `${lang}: servicios.categories.${cat.id}.items.${itemId} needs string "name" and "desc"`,
          );
        }
      }
      for (const extraId of Object.keys(catCopy.items)) {
        if (!cat.itemIds.includes(extraId)) {
          errors.push(
            `${lang}: servicios.categories.${cat.id}.items.${extraId} has no matching entry in src/data/pricing.ts (orphaned translation)`,
          );
        }
      }
    }
    for (const extraCat of Object.keys(s.categories)) {
      if (!cats.some((c) => c.id === extraCat)) {
        errors.push(
          `${lang}: servicios.categories.${extraCat} has no matching entry in src/data/pricing.ts (orphaned category)`,
        );
      }
    }
  }

  if (errors.length) {
    console.error("[check-pricing] dictionary/pricing parity failed:");
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }

  const totalItems = cats.reduce((n, c) => n + c.itemIds.length, 0);
  console.log(
    `[check-pricing] OK — ${cats.length} categories, ${totalItems} items, both locales aligned.`,
  );
}

main().catch((err) => {
  console.error("[check-pricing] failed:", err);
  process.exit(1);
});
