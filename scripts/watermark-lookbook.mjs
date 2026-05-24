// Build-time watermarker for lookbook photos.
//
// Reads `public/lookbook/<category>/*.{jpg,jpeg,png,webp}`, composites
// `public/logos/LogoText.svg` as a semi-transparent wordmark in the
// bottom-right corner, and writes the result to
// `public/lookbook-wm/<category>/*.jpg` — the path the manifest points at.
//
// The watermark is baked into the JPEG bytes, so right-click "Save image as…"
// downloads the marked file. Originals in `public/lookbook/` are untouched.
//
// Idempotent + cached: `public/lookbook-wm/.cache.json` tracks per-file
// source mtime and a hash of the tunable constants below. A run that finds
// every source unchanged and the settings hash matching emits zero work.
//
// Runs in `predev` and `prebuild` (see package.json), placed after
// optimize-logos and before build-lookbook-manifest.

import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_ROOT = path.join(ROOT, "public", "lookbook");
const OUT_ROOT = path.join(ROOT, "public", "lookbook-wm");
const WATERMARK_SVG = path.join(ROOT, "public", "logos", "LogoText.svg");
const CACHE_FILE = path.join(OUT_ROOT, ".cache.json");

const SETTINGS = {
  WIDTH_RATIO: 0.32,
  OPACITY: 0.28,
  PADDING_PCT: 0.04,
  JPEG_QUALITY: 88,
  // Density rasterizes the 2000-unit-wide LogoText.svg to ~5555px, which
  // stays under sharp's default 268MP output limit yet downscales sharply
  // to any target width photos call for (largest so far ~1700px).
  SVG_DENSITY: 200,
  VERSION: 1,
};

const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const IGNORED_FOLDERS = new Set([".ds_store", "thumbs.db"]);

function settingsHash() {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(SETTINGS))
    .digest("hex")
    .slice(0, 16);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_FILE, "utf8"));
  } catch {
    return { settingsHash: null, entries: {} };
  }
}

async function writeCache(cache) {
  await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

async function listCategories() {
  try {
    const entries = await fs.readdir(SRC_ROOT, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          !IGNORED_FOLDERS.has(e.name.toLowerCase()),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function listImagesIn(category) {
  const dir = path.join(SRC_ROOT, category);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) continue;
    out.push({ name: e.name, ext });
  }
  return out;
}

// Rasterize the SVG once and trim its transparent padding so WIDTH_RATIO
// refers to the visible mark, not the SVG canvas.
let trimmedWatermarkPromise = null;
async function getTrimmedWatermark() {
  if (!trimmedWatermarkPromise) {
    trimmedWatermarkPromise = (async () => {
      const svgBuf = await fs.readFile(WATERMARK_SVG);
      return sharp(svgBuf, { density: SETTINGS.SVG_DENSITY })
        .trim()
        .png()
        .toBuffer();
    })();
  }
  return trimmedWatermarkPromise;
}

// Resize trimmed mark to target width and uniformly scale its alpha to
// SETTINGS.OPACITY using a tiled `dest-in` composite — a standard sharp idiom.
const sizedWatermarkCache = new Map();
async function getSizedWatermark(width) {
  if (sizedWatermarkCache.has(width)) return sizedWatermarkCache.get(width);
  const base = await getTrimmedWatermark();
  const buf = await sharp(base)
    .resize({ width })
    .composite([
      {
        input: {
          create: {
            width: 1,
            height: 1,
            channels: 4,
            background: {
              r: 255,
              g: 255,
              b: 255,
              alpha: SETTINGS.OPACITY,
            },
          },
        },
        tile: true,
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
  sizedWatermarkCache.set(width, buf);
  return buf;
}

async function processOne(srcPath, dstPath) {
  const pipeline = sharp(srcPath).rotate(); // honour EXIF orientation
  const meta = await pipeline.metadata();
  const imgW = meta.width ?? 1600;
  const imgH = meta.height ?? 1200;

  const targetW = Math.max(1, Math.round(imgW * SETTINGS.WIDTH_RATIO));
  const wm = await getSizedWatermark(targetW);
  const wmMeta = await sharp(wm).metadata();
  const wmW = wmMeta.width ?? targetW;
  const wmH = wmMeta.height ?? 0;
  const pad = Math.round(imgW * SETTINGS.PADDING_PCT);
  const top = Math.max(0, imgH - wmH - pad);
  const left = Math.max(0, imgW - wmW - pad);

  await pipeline
    .composite([{ input: wm, top, left }])
    .jpeg({ quality: SETTINGS.JPEG_QUALITY, mozjpeg: true })
    .toFile(dstPath);
}

async function main() {
  await ensureDir(OUT_ROOT);

  try {
    await fs.access(WATERMARK_SVG);
  } catch {
    console.error(
      `[watermark-lookbook] watermark SVG not found at ${WATERMARK_SVG}`,
    );
    process.exit(1);
  }

  const categories = await listCategories();
  if (categories.length === 0) {
    console.warn(
      "[watermark-lookbook] no category folders under public/lookbook/",
    );
    return;
  }

  const hash = settingsHash();
  const cache = await readCache();
  const settingsChanged = cache.settingsHash !== hash;
  const nextEntries = {};

  let processed = 0;
  let skipped = 0;

  for (const cat of categories) {
    const outCatDir = path.join(OUT_ROOT, cat);
    await ensureDir(outCatDir);
    const items = await listImagesIn(cat);
    for (const it of items) {
      const srcPath = path.join(SRC_ROOT, cat, it.name);
      const base = path.basename(it.name, it.ext);
      const dstName = `${base}.jpg`;
      const dstPath = path.join(outCatDir, dstName);
      const key = `${cat}/${it.name}`;
      const srcStat = await fs.stat(srcPath);

      let outExists = false;
      try {
        await fs.stat(dstPath);
        outExists = true;
      } catch {
        outExists = false;
      }

      const prev = cache.entries[key];
      if (
        !settingsChanged &&
        outExists &&
        prev &&
        prev.srcMtime === srcStat.mtimeMs
      ) {
        nextEntries[key] = prev;
        skipped += 1;
        continue;
      }

      await processOne(srcPath, dstPath);
      nextEntries[key] = { srcMtime: srcStat.mtimeMs };
      processed += 1;
      console.log(`[watermark-lookbook] ${key} → ${cat}/${dstName}`);
    }
  }

  await writeCache({ settingsHash: hash, entries: nextEntries });

  console.log(
    `[watermark-lookbook] done: ${processed} rebuilt, ${skipped} cached.`,
  );
}

main().catch((err) => {
  console.error("[watermark-lookbook] failed:", err);
  process.exit(1);
});
