#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "..", "src", "assets");

const TIER1_HEROES = [
  "insights-slopdemic-hero.webp",
  "engines-three-pillars-hero.webp",
  "pipeline-cross-section-hero.webp",
  "engines-avri-portrait.webp",
  "engines-cwe-portrait.webp",
  "engines-linguistic-portrait.webp",
  "engines-substance-portrait.webp",
  "methodology-verification-constellation.webp",
  "origin-analyst-wall.webp",
];

const TARGET_WIDTHS = [480, 768, 1200];

async function main() {
  for (const file of TIER1_HEROES) {
    const input = path.join(ASSETS_DIR, file);
    const buf = await fs.readFile(input);
    const meta = await sharp(buf).metadata();
    const baseName = file.replace(/\.webp$/, "");
    for (const w of TARGET_WIDTHS) {
      if (meta.width && w >= meta.width) {
        console.log(`skip ${file} @ ${w} (original is ${meta.width})`);
        continue;
      }
      const outPath = path.join(ASSETS_DIR, `${baseName}-${w}.webp`);
      await sharp(buf)
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 80, effort: 5 })
        .toFile(outPath);
      const stat = await fs.stat(outPath);
      console.log(`wrote ${path.basename(outPath)} (${(stat.size / 1024).toFixed(1)} KB)`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
