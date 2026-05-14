// Build-time favicon generator.
//
// Renders `public/logos/RoundLogoTextureBisel.svg` (the circular brand mark)
// to a Next.js icon set placed under `src/app/`. Next 16 auto-discovers the
// files via its metadata file-convention pipeline:
//
//   src/app/icon.png         → 32×32  (default browser tab icon)
//   src/app/icon-192.png     → 192×192 (PWA manifest / Android home screen)
//   src/app/apple-icon.png   → 180×180 (iOS home screen)
//
// The source SVG is ~2.7 MB raw — sharp rasters it at high density so the
// 32×32 stays crisp. The textured bevel survives down to ~32 px; at 16 px
// browsers will downscale (they handle this well).
//
// Idempotent: skips regeneration if the output is newer than the source.
// Runs in `predev` and `prebuild` alongside the other build scripts.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC_SVG = path.join(ROOT, "public", "logos", "RoundLogoTextureBisel.svg");
const APP_DIR = path.join(ROOT, "src", "app");

// Two icons cover the major surfaces:
//   icon.png at 256×256 — browsers downscale for tab favicons (~16/32 px) and
//     keep clarity on retina; Next 16 picks this up via file-convention.
//   apple-icon.png at 180×180 — iOS home-screen / Safari tab spec.
// `icon-192.png` etc. don't match Next 16's auto-discovery pattern, so we
// skip those — the 256 icon covers Android / PWA install needs by downscale.
const TARGETS = [
  { file: "icon.png", size: 256 },
  { file: "apple-icon.png", size: 180 },
];

async function needsRebuild(outPath) {
  try {
    const [srcStat, outStat] = await Promise.all([
      fs.stat(SRC_SVG),
      fs.stat(outPath),
    ]);
    return srcStat.mtimeMs > outStat.mtimeMs;
  } catch {
    return true; // missing output → rebuild
  }
}

async function main() {
  try {
    await fs.stat(SRC_SVG);
  } catch {
    console.warn(
      `[build-favicon] source not found: ${SRC_SVG} — skipping favicon build.`,
    );
    return;
  }

  const buf = await fs.readFile(SRC_SVG);
  let built = 0;
  let skipped = 0;

  for (const { file, size } of TARGETS) {
    const outPath = path.join(APP_DIR, file);
    if (!(await needsRebuild(outPath))) {
      skipped += 1;
      continue;
    }
    // Scale the intermediate raster to ~4× the target so sharp has headroom
    // to downsample cleanly without hitting its 268M-pixel input limit.
    const density = Math.min(300, Math.max(96, size * 4));
    await sharp(buf, { density })
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toFile(outPath);
    const written = await fs.stat(outPath);
    console.log(
      `[build-favicon] ${file} (${size}×${size}) → ${(written.size / 1024).toFixed(1)} KB`,
    );
    built += 1;
  }

  console.log(
    `[build-favicon] done: ${built} rebuilt, ${skipped} cached.`,
  );
}

main().catch((err) => {
  console.error("[build-favicon] failed:", err);
  process.exit(1);
});
