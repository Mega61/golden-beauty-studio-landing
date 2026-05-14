// One-shot generator that fills Lookbook category folders with brand-palette
// sample images. Each sample is a 900×1200 JPEG rendered from an SVG
// composition that uses the project's gold-leaf palette + a "SAMPLE" badge so
// it reads as a placeholder, never as a real shoot.
//
// Idempotent: never overwrites existing files. The owner replaces each
// sample by dropping a real photo with the same filename (or any new
// kebab-case name) into the category folder. Real photos take priority.
//
// Run with: `npm run seed-lookbook` (or `node scripts/seed-lookbook-samples.mjs`)
// After running, regenerate the manifest: `npm run build-manifest`.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LOOKBOOK_DIR = path.join(ROOT, "public", "lookbook");

const W = 900;
const H = 1200;

// Brand palette (mirrors src/app/globals.css @theme tokens).
const T = {
  ivory: "#f8f4ee",
  ivoryDeep: "#efe7da",
  cream: "#f3ecdf",
  paper: "#fbf8f3",
  carbon: "#1c1714",
  ink: "#2a221c",
  inkSoft: "#5b4a3a",
  goldDeep: "#5b2b08",
  goldDark: "#8b6a1f",
  gold: "#ac8231",
  goldBright: "#e7aa51",
  goldSoft: "#ffd49f",
  goldPale: "#fff1d6",
};

const COMPOSITIONS = {
  acrilico: [
    { name: "sample-onix", label: "Acrílico · Sample", gradient: ["#0d0a08", T.carbon, T.ink, T.goldDeep], accent: "diagonal-slash" },
    { name: "sample-almendra-mate", label: "Acrílico · Sample", gradient: [T.carbon, T.ink, T.inkSoft, T.goldDark], accent: "vertical-band" },
  ],
  polygel: [
    { name: "sample-pearl-cromado", label: "Polygel · Sample", gradient: [T.ivory, T.goldPale, T.goldSoft, T.ivory], accent: "radial-bloom" },
    { name: "sample-nacar", label: "Polygel · Sample", gradient: [T.paper, T.ivoryDeep, T.goldPale, T.cream], accent: "soft-arc" },
  ],
  "builder-gel": [
    { name: "sample-glow-ambar", label: "Builder gel · Sample", gradient: [T.gold, T.goldBright, T.goldSoft, T.goldPale], accent: "vertical-band" },
    { name: "sample-honey", label: "Builder gel · Sample", gradient: [T.goldDark, T.gold, T.goldBright, T.goldSoft], accent: "radial-bloom" },
  ],
  dipping: [
    { name: "sample-rosa-leche", label: "Dipping · Sample", gradient: ["#f0d7c6", T.cream, T.ivoryDeep, T.goldPale], accent: "speckle" },
    { name: "sample-beige-mate", label: "Dipping · Sample", gradient: [T.ivoryDeep, T.cream, T.paper, "#e8d8c2"], accent: "speckle" },
  ],
  semipermanente: [
    { name: "sample-glaze-coral", label: "Semipermanente · Sample", gradient: ["#f5c9b3", T.goldSoft, T.goldPale, T.cream], accent: "soft-arc" },
    { name: "sample-borgona", label: "Semipermanente · Sample", gradient: ["#5c1f24", "#8c3a3f", T.goldDeep, T.goldDark], accent: "vertical-band" },
  ],
  "press-on": [
    { name: "sample-editorial", label: "Press On · Sample", gradient: [T.carbon, T.goldDeep, T.gold, T.goldBright], accent: "diagonal-slash" },
    { name: "sample-nupcial", label: "Press On · Sample", gradient: [T.paper, T.goldPale, T.goldSoft, T.gold], accent: "radial-bloom" },
    { name: "sample-rojo-foil", label: "Press On · Sample", gradient: ["#5a0e14", "#8c1d23", T.goldDeep, T.gold], accent: "vertical-band" },
  ],
};

function buildSvg({ gradient, accent, label }) {
  const [c1, c2, c3, c4] = gradient;
  const accentLayer = (() => {
    switch (accent) {
      case "diagonal-slash":
        return `
          <rect x="-200" y="380" width="${W + 400}" height="36" fill="${T.goldBright}" opacity="0.16" transform="rotate(-22 ${W / 2} ${H / 2})"/>
          <rect x="-200" y="780" width="${W + 400}" height="14" fill="${T.goldSoft}" opacity="0.22" transform="rotate(-22 ${W / 2} ${H / 2})"/>
        `;
      case "vertical-band":
        return `
          <rect x="${W * 0.55}" y="0" width="${W * 0.06}" height="${H}" fill="${T.goldBright}" opacity="0.22"/>
          <rect x="${W * 0.62}" y="0" width="${W * 0.015}" height="${H}" fill="${T.goldSoft}" opacity="0.45"/>
        `;
      case "radial-bloom":
        return `
          <defs>
            <radialGradient id="bloom" cx="50%" cy="38%" r="55%">
              <stop offset="0%" stop-color="${T.goldBright}" stop-opacity="0.45"/>
              <stop offset="60%" stop-color="${T.goldBright}" stop-opacity="0.05"/>
              <stop offset="100%" stop-color="${T.goldBright}" stop-opacity="0"/>
            </radialGradient>
          </defs>
          <rect width="${W}" height="${H}" fill="url(#bloom)"/>
        `;
      case "soft-arc":
        return `
          <path d="M -50 ${H * 0.7} Q ${W / 2} ${H * 0.45} ${W + 50} ${H * 0.72}" stroke="${T.goldBright}" stroke-width="2" fill="none" opacity="0.35"/>
          <path d="M -50 ${H * 0.74} Q ${W / 2} ${H * 0.49} ${W + 50} ${H * 0.76}" stroke="${T.goldSoft}" stroke-width="1" fill="none" opacity="0.45"/>
        `;
      case "speckle": {
        let dots = "";
        for (let i = 0; i < 80; i++) {
          const x = ((i * 137) % W).toFixed(0);
          const y = ((i * 263) % H).toFixed(0);
          const r = 1 + ((i * 7) % 3);
          dots += `<circle cx="${x}" cy="${y}" r="${r}" fill="${T.goldDeep}" opacity="0.12"/>`;
        }
        return dots;
      }
      default:
        return "";
    }
  })();

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.7" y2="1">
      <stop offset="0%"   stop-color="${c1}"/>
      <stop offset="38%"  stop-color="${c2}"/>
      <stop offset="72%"  stop-color="${c3}"/>
      <stop offset="100%" stop-color="${c4}"/>
    </linearGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3"/>
      <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.05 0"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${accentLayer}
  <rect width="${W}" height="${H}" filter="url(#grain)"/>
  <g transform="translate(40, ${H - 80})">
    <rect width="160" height="34" fill="rgba(20,15,12,0.55)" rx="0"/>
    <text x="80" y="22" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" font-weight="600" letter-spacing="2.5" fill="${T.goldSoft}" text-anchor="middle">SAMPLE</text>
  </g>
  <g transform="translate(${W - 220}, ${H - 80})">
    <text font-family="ui-serif, Cormorant Garamond, serif" font-style="italic" font-size="22" fill="${T.ivory}" opacity="0.78">${label}</text>
  </g>
</svg>`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  let written = 0;
  let skipped = 0;

  for (const [category, samples] of Object.entries(COMPOSITIONS)) {
    const dir = path.join(LOOKBOOK_DIR, category);
    await ensureDir(dir);

    for (const sample of samples) {
      const outPath = path.join(dir, `${sample.name}.jpg`);
      if (await fileExists(outPath)) {
        skipped += 1;
        continue;
      }
      const svg = buildSvg(sample);
      await sharp(Buffer.from(svg))
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(outPath);
      console.log(
        `[seed-lookbook] ${category}/${sample.name}.jpg → ${(await fs.stat(outPath)).size / 1024 | 0} KB`,
      );
      written += 1;
    }
  }

  console.log(
    `[seed-lookbook] done: ${written} sample(s) written, ${skipped} skipped (already present).`,
  );
}

main().catch((err) => {
  console.error("[seed-lookbook] failed:", err);
  process.exit(1);
});
