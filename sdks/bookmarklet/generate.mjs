#!/usr/bin/env node
// Generate the VulnRap "Check selection" bookmarklet from src/bookmarklet.js.
//
// What this produces:
//   - sdks/bookmarklet/vulnrap.bookmarklet.js     (minified IIFE source)
//   - sdks/bookmarklet/vulnrap.bookmarklet.url    (the full `javascript:` href)
//   - artifacts/vulnrap/public/vulnrap.bookmarklet.js (mirror, served same-origin)
//
// The href is what goes into the bookmarks bar. The `/developers` page
// renders a draggable <a href="..."> using the same string at build time so
// the generated artifact and the rendered button can never drift.
//
// Usage:
//   node sdks/bookmarklet/generate.mjs
//   pnpm --filter @workspace/scripts run generate:bookmarklet

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const srcPath = path.join(__dirname, "src", "bookmarklet.js");
const outJs = path.join(__dirname, "vulnrap.bookmarklet.js");
const outUrl = path.join(__dirname, "vulnrap.bookmarklet.url");
const publicMirror = path.join(
  repoRoot,
  "artifacts",
  "vulnrap",
  "public",
  "vulnrap.bookmarklet.js",
);

function minify(src) {
  // Conservative, deterministic minifier for our tiny IIFE source. We do not
  // pull in terser to keep this script dependency-free; the input is hand-
  // written and stays small enough that this is safe.
  return src
    // strip // line comments
    .replace(/^\s*\/\/.*$/gm, "")
    // strip /* */ block comments
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // collapse runs of whitespace (incl. newlines) to single space
    .replace(/\s+/g, " ")
    // tighten around punctuation
    .replace(/\s*([{}();,:=<>!+\-*/?&|])\s*/g, "$1")
    .trim();
}

const src = await readFile(srcPath, "utf8");
const minified = minify(src);
const href = "javascript:" + encodeURI(minified);

await writeFile(outJs, minified + "\n", "utf8");
await writeFile(outUrl, href + "\n", "utf8");
await mkdir(path.dirname(publicMirror), { recursive: true });
await writeFile(publicMirror, minified + "\n", "utf8");

console.log("Wrote", path.relative(repoRoot, outJs), `(${minified.length} bytes)`);
console.log("Wrote", path.relative(repoRoot, outUrl), `(${href.length} bytes)`);
console.log("Mirrored to", path.relative(repoRoot, publicMirror));
