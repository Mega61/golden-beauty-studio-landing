// One-shot exporter: flattens src/app/[lang]/dictionaries/es.json into a CSV
// suitable for upload to Google Sheets as a "copy review" template.
//
// Output columns:
//   Sección       — human-readable section name (Hero, Nav, Servicios, …)
//   Ruta          — dot-path into the dictionary (e.g. hero.title1) — keep
//                   as-is when editing; used to map changes back into the dict.
//   Texto actual  — the current Spanish copy live on the page
//   Texto nuevo   — empty by default; editor fills in the proposed wording
//   Estado        — formula: "Sin cambios" if `Texto nuevo` is blank or equals
//                   the current, otherwise "Cambiado"
//   Notas         — empty; for editor's free-form notes
//
// Run with: `node scripts/export-copy-template.mjs > /tmp/copy-template.csv`

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ES_PATH = path.join(ROOT, "src", "app", "[lang]", "dictionaries", "es.json");

// Friendly section labels keyed off the top-level dict keys.
const SECTION_LABELS = {
  _todo: "Notas internas (no editar)",
  meta: "Meta · SEO",
  nav: "Navegación",
  hero: "Hero (portada)",
  lookbook: "Lookbook",
  servicios: "Servicios y precios",
  diccionario: "Diccionario de técnicas",
  tecnicas: "Técnicas (perfiles)",
  estudio: "El estudio",
  contacto: "Contacto",
  footer: "Pie de página",
  floating: "Botones flotantes",
};

// Keys to skip entirely (internal flags, machine identifiers).
const SKIP_PATHS = new Set([]);
// Skip everything under these top-level keys (TODO notes for us only).
const SKIP_TOP_KEYS = new Set(["_todo"]);

function csvEscape(s) {
  if (s == null) return "";
  const str = String(s);
  // Excel/Sheets safety: prevent =/+/-/@ leading chars from being read as formulas
  const needsApos = /^[=+\-@]/.test(str);
  const value = needsApos ? "'" + str : str;
  // Always quote; double internal quotes
  return `"${value.replace(/"/g, '""')}"`;
}

// Variant of csvEscape that preserves leading `=` so Sheets evaluates the cell
// as a formula. Used only for the auto-generated Estado column.
function csvEscapeFormula(s) {
  if (s == null) return "";
  return `"${String(s).replace(/"/g, '""')}"`;
}

function* walk(obj, prefix = []) {
  if (obj == null) return;
  if (typeof obj !== "object") {
    yield { path: prefix.join("."), value: obj };
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      yield* walk(obj[i], [...prefix, `[${i}]`]);
    }
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    yield* walk(v, [...prefix, k]);
  }
}

function joinPath(parts) {
  // Collapse the array-bracket marker into the path: hero.tiles.[0].title
  return parts.join(".").replace(/\.\[/g, "[");
}

async function main() {
  const raw = await fs.readFile(ES_PATH, "utf8");
  const dict = JSON.parse(raw);

  const rows = [];
  for (const [topKey, sectionLabel] of Object.entries(SECTION_LABELS)) {
    if (SKIP_TOP_KEYS.has(topKey)) continue;
    const subtree = dict[topKey];
    if (subtree == null) continue;
    for (const { path: subPath, value } of walk(subtree, [topKey])) {
      if (typeof value !== "string") continue; // we only collect string copy
      const fullPath = joinPath(subPath.split("."));
      if (SKIP_PATHS.has(fullPath)) continue;
      rows.push({ section: sectionLabel, path: fullPath, value });
    }
  }

  // Header
  const headers = [
    "Sección",
    "Ruta",
    "Texto actual",
    "Texto nuevo",
    "Estado",
    "Notas",
  ];
  const lines = [headers.map(csvEscape).join(",")];

  // Body. Status formula references row N (header is row 1, data starts row 2).
  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const status = `=IF(OR(D${rowNum}="",D${rowNum}=C${rowNum}),"Sin cambios","Cambiado")`;
    lines.push(
      [
        csvEscape(r.section),
        csvEscape(r.path),
        csvEscape(r.value),
        "", // empty — editor fills
        csvEscapeFormula(status),
        "", // notes — empty
      ].join(","),
    );
  });

  const csv = lines.join("\n") + "\n";
  process.stdout.write(csv);
  process.stderr.write(`[export-copy-template] wrote ${rows.length} rows.\n`);
}

main().catch((err) => {
  console.error("[export-copy-template] failed:", err);
  process.exit(1);
});
