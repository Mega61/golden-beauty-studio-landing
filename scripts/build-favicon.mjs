// Build-time icon + social-asset generator.
//
// Rasterizes the brand SVGs into the PNGs that Next.js, the web manifest, and
// the Open Graph image consume:
//
//   src/app/icon.png              → 256×256  (browser tab favicon, downscaled)
//   src/app/apple-icon.png        → 180×180  (iOS home screen)
//   public/icons/icon-192.png     → 192×192  (PWA manifest / Android)
//   public/icons/icon-512.png     → 512×512  (PWA manifest / splash)
//   public/icons/icon-512-maskable.png → 512×512 maskable (ivory safe-zone)
//   public/og/logo.png            → 1000px-wide brand logo for the OG image
//
// The round bevel mark feeds the icons; the full logo feeds the OG image.
// Idempotent: skips any output newer than its source.
// Runs in `predev` and `prebuild` alongside the other build scripts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const APP_DIR = path.join(ROOT, "src", "app");
const ICONS_DIR = path.join(PUBLIC, "icons");
const OG_DIR = path.join(PUBLIC, "og");

const ROUND_SVG = path.join(PUBLIC, "logos", "RoundLogoTextureBisel.svg");
const FULL_SVG = path.join(PUBLIC, "logos", "FullLogoTexture.svg");

const IVORY = { r: 248, g: 244, b: 238, alpha: 1 };
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

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

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

// Square icon (contain fit) on a transparent or solid background.
async function buildSquare(srcBuf, size, bg, outPath) {
  // Raster the SVG at ~4× the target so sharp has headroom to downsample
  // cleanly without hitting its input-pixel limit.
  const density = Math.min(384, Math.max(96, size * 4));
  await sharp(srcBuf, { density })
    .resize(size, size, { fit: "contain", background: bg })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outPath);
}

// Maskable icon: logo at ~80% inside a solid ivory safe-zone so platform
// masks (circle/squircle) never clip the mark.
async function buildMaskable(srcBuf, size, outPath) {
  const inner = Math.round(size * 0.8);
  const density = Math.min(384, Math.max(96, inner * 4));
  const mark = await sharp(srcBuf, { density })
    .resize(inner, inner, { fit: "contain", background: TRANSPARENT })
    .png()
    .toBuffer();
  await sharp({
    create: { width: size, height: size, channels: 4, background: IVORY },
  })
    .composite([{ input: mark, gravity: "center" }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outPath);
}

// Width-constrained logo (auto height) on transparent — for the OG image.
async function buildWide(srcBuf, width, outPath) {
  await sharp(srcBuf, { density: 300 })
    .resize(width, null, { fit: "inside", background: TRANSPARENT })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(outPath);
}

async function main() {
  await fs.mkdir(ICONS_DIR, { recursive: true });
  await fs.mkdir(OG_DIR, { recursive: true });

  let built = 0;
  let skipped = 0;

  // Round-mark derived icons.
  if (await exists(ROUND_SVG)) {
    const buf = await fs.readFile(ROUND_SVG);
    const squares = [
      { out: path.join(APP_DIR, "icon.png"), size: 256, bg: TRANSPARENT },
      { out: path.join(APP_DIR, "apple-icon.png"), size: 180, bg: TRANSPARENT },
      { out: path.join(ICONS_DIR, "icon-192.png"), size: 192, bg: TRANSPARENT },
      { out: path.join(ICONS_DIR, "icon-512.png"), size: 512, bg: TRANSPARENT },
    ];
    for (const { out, size, bg } of squares) {
      if (!(await needsRebuild(ROUND_SVG, out))) {
        skipped += 1;
        continue;
      }
      await buildSquare(buf, size, bg, out);
      built += 1;
      console.log(`[build-favicon] ${path.relative(ROOT, out)} (${size}×${size})`);
    }
    const maskable = path.join(ICONS_DIR, "icon-512-maskable.png");
    if (await needsRebuild(ROUND_SVG, maskable)) {
      await buildMaskable(buf, 512, maskable);
      built += 1;
      console.log(`[build-favicon] ${path.relative(ROOT, maskable)} (512×512 maskable)`);
    } else {
      skipped += 1;
    }
  } else {
    console.warn(
      `[build-favicon] source not found: ${ROUND_SVG} — skipping icons.`,
    );
  }

  // Full logo → OG image asset.
  const ogLogo = path.join(OG_DIR, "logo.png");
  if (await exists(FULL_SVG)) {
    if (await needsRebuild(FULL_SVG, ogLogo)) {
      const buf = await fs.readFile(FULL_SVG);
      await buildWide(buf, 1000, ogLogo);
      built += 1;
      console.log(`[build-favicon] ${path.relative(ROOT, ogLogo)} (1000px wide)`);
    } else {
      skipped += 1;
    }
  } else {
    console.warn(
      `[build-favicon] source not found: ${FULL_SVG} — skipping OG logo.`,
    );
  }

  console.log(`[build-favicon] done: ${built} rebuilt, ${skipped} cached.`);
}

main().catch((err) => {
  console.error("[build-favicon] failed:", err);
  process.exit(1);
});
