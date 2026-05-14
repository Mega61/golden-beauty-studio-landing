// Build-time SVG → WebP optimizer for heavy brand assets.
//
// Reads `public/logos/*.svg`, and for files ≥ 500 KB rasters them to
// 1200×1200 WebP at quality 75 in `public/logos/optimized/`.
// Small SVGs (LogoText, LogoSubText, FullLogo, ColorGuide) are left alone —
// they're already ≤110 KB and stay vector for crispness at small scales.
//
// Idempotent: skips output files newer than their source.
// Runs in `predev` and `prebuild` (see package.json).

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "public", "logos");
const OUT_DIR = path.join(SRC_DIR, "optimized");

const SIZE_THRESHOLD = 500 * 1024;
const RASTER_SIZE = 1200;
const QUALITY = 75;

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function needsRebuild(srcPath, outPath) {
  try {
    const [srcStat, outStat] = await Promise.all([
      fs.stat(srcPath),
      fs.stat(outPath),
    ]);
    return srcStat.mtimeMs > outStat.mtimeMs;
  } catch {
    return true; // missing output → rebuild
  }
}

async function main() {
  await ensureDir(OUT_DIR);

  let entries;
  try {
    entries = await fs.readdir(SRC_DIR);
  } catch (err) {
    console.error(`[optimize-logos] cannot read ${SRC_DIR}:`, err.message);
    process.exit(0);
  }

  const svgs = entries.filter((n) => n.toLowerCase().endsWith(".svg"));
  let processed = 0;
  let skipped = 0;
  let untouched = 0;

  for (const name of svgs) {
    const srcPath = path.join(SRC_DIR, name);
    const stat = await fs.stat(srcPath);
    if (stat.size < SIZE_THRESHOLD) {
      untouched += 1;
      continue;
    }
    const outName = name.replace(/\.svg$/i, ".webp");
    const outPath = path.join(OUT_DIR, outName);

    if (!(await needsRebuild(srcPath, outPath))) {
      skipped += 1;
      continue;
    }

    const buf = await fs.readFile(srcPath);
    await sharp(buf, { density: 200 })
      .resize(RASTER_SIZE, RASTER_SIZE, { fit: "inside" })
      .webp({ quality: QUALITY, effort: 5 })
      .toFile(outPath);

    const outStat = await fs.stat(outPath);
    console.log(
      `[optimize-logos] ${name} (${(stat.size / 1024).toFixed(0)} KB) → ${outName} (${(outStat.size / 1024).toFixed(0)} KB)`,
    );
    processed += 1;
  }

  console.log(
    `[optimize-logos] done: ${processed} rebuilt, ${skipped} cached, ${untouched} skipped (small).`,
  );
}

main().catch((err) => {
  console.error("[optimize-logos] failed:", err);
  process.exit(1);
});
