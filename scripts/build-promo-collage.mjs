// Builds the "Primera visita / First visit" promo hero: a 16:9 editorial
// collage of nail looks (spanning every service family) so the all-services
// welcome offer reads as a curated sampler rather than a single design.
//
// Laid out as a 2×4 GRID of near-square tiles. A single-row strip made each
// tile a tall sliver (~316×900) that cover-cropped ~half the width off portrait
// shots; near-square tiles (~400×450) match the source aspect (~0.8) so almost
// nothing is cropped. Output stays 16:9 to fit the FeaturedCard frame exactly.
//
// Source: the CLEAN lookbook images (public/lookbook/**), composited onto a
// gold base so the seams read as thin gold hairlines — matching the studio's
// hairline-and-gold system. Output is a single committed asset; the promo data
// just points `image_url` at it. Re-run after swapping the SOURCES below.
//
//   node scripts/build-promo-collage.mjs   (or: npm run build-promo-collage)

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "..", "public");

// ── Tunables ────────────────────────────────────────────────────────────────
const WIDTH = 1600;
const HEIGHT = 900; // 16:9 — matches the FeaturedCard frame exactly
const ROWS = 2;
const GUTTER = 3; // gold hairline between tiles
const GOLD = "#ac8231"; // var(--color-gold) — base/gutter colour
const QUALITY = 82;
const OUT = path.join(PUBLIC, "primera-visita.jpg");

// Eight looks across every active service family — rubber, semi, acrílico,
// polygel, builder gel, dipping — so the welcome offer visibly covers all
// services. Chosen portrait sources (~0.75–0.85) crop almost nothing in the
// near-square tiles.
const SOURCES = [
  "lookbook/rubber/brillantes.png",
  "lookbook/semipermanente/dorado-espejo.jpg",
  "lookbook/acrilico/3d-piedreria.jpg",
  "lookbook/polygel/dulces-coloridos.png",
  "lookbook/builder-gel/sugar-marmoleado.jpg",
  "lookbook/dipping/rayos-plateados.png",
  "lookbook/acrilico/relieve-3d-sirena.jpg",
  "lookbook/acrilico/rosas-acrilicas.png",
];

async function main() {
  const n = SOURCES.length;
  const cols = Math.ceil(n / ROWS);
  const tileW = Math.floor((WIDTH - GUTTER * (cols - 1)) / cols);
  const tileH = Math.floor((HEIGHT - GUTTER * (ROWS - 1)) / ROWS);
  // Centre the grid so leftover pixels split into matching edge hairlines.
  const usedW = tileW * cols + GUTTER * (cols - 1);
  const usedH = tileH * ROWS + GUTTER * (ROWS - 1);
  const startX = Math.round((WIDTH - usedW) / 2);
  const startY = Math.round((HEIGHT - usedH) / 2);

  const panels = await Promise.all(
    SOURCES.map(async (rel, i) => {
      const buf = await sharp(path.join(PUBLIC, rel))
        .resize(tileW, tileH, { fit: "cover", position: "attention" })
        // Gentle saturation pull-back so different shoots read as one cohesive
        // asset without flattening the colour.
        .modulate({ saturation: 0.95 })
        .toBuffer();
      const row = Math.floor(i / cols);
      const col = i % cols;
      return {
        input: buf,
        left: startX + col * (tileW + GUTTER),
        top: startY + row * (tileH + GUTTER),
      };
    }),
  );

  await sharp({
    create: { width: WIDTH, height: HEIGHT, channels: 3, background: GOLD },
  })
    .composite(panels)
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toFile(OUT);

  console.log(
    `✓ promo collage → public/primera-visita.jpg (${WIDTH}×${HEIGHT}, ${ROWS}×${cols} grid, ${n} tiles)`,
  );
}

main().catch((err) => {
  console.error("✗ build-promo-collage failed:", err);
  process.exit(1);
});
