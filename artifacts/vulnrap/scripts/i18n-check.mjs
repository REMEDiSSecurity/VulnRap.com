#!/usr/bin/env node
// i18n lint — warn-only scan that flags JSX text nodes and a small set of
// user-facing string attributes (placeholder, title, aria-label) that are
// not yet wired through the t() catalog. Intentionally conservative:
// the goal is a nudge during code review, not a CI gate. See replit.md
// "Internationalization (i18n)" for the convention.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const CATALOG_PATH = path.join(SRC, "locales", "en.json");

if (!fs.existsSync(CATALOG_PATH)) {
  console.error(`[i18n:check] Missing catalog: ${CATALOG_PATH}`);
  process.exit(0);
}
const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
const catalogValues = new Set(
  Object.values(catalog).map((v) => String(v).trim()),
);

// Files we currently consider "in scope" for i18n: layout + the four
// most-visible pages from the scaffolding task. Expand this list as more
// surface area gets wired through t().
const IN_SCOPE = [
  path.join(SRC, "components", "layout.tsx"),
  path.join(SRC, "pages", "home", "index.tsx"),
  path.join(SRC, "pages", "check.tsx"),
  path.join(SRC, "pages", "results.tsx"),
];

const ATTR_NAMES = ["placeholder", "title", "aria-label"];
const TEXT_ATTR_RE = new RegExp(
  `\\b(${ATTR_NAMES.join("|")})="([^"{}\\n]+)"`,
  "g",
);
// Match a JSX text node: `>` then visible text then `<`. Skips fragments
// containing `{` (interpolation) or `}`.
const JSX_TEXT_RE = />([^<>{}\n]+)</g;

// Heuristics for "looks like a sentence/word a user would read".
function isUserFacing(s) {
  const t = s.trim();
  if (t.length < 3) return false;
  if (!/[A-Za-z]/.test(t)) return false; // pure punctuation/digits
  if (!/[A-Za-z]\s+[A-Za-z]|^[A-Z][a-z]+$/.test(t)) {
    // single short token like "px" — skip
    if (t.split(/\s+/).length === 1 && t.length < 4) return false;
  }
  // Skip className-like values (Tailwind utility soup) and obvious code.
  if (/[\/_:]\d|[a-z]-\d|hsl\(|rgb\(|#[0-9a-f]{3,}/i.test(t)) return false;
  if (/^(true|false|null|undefined)$/.test(t)) return false;
  return true;
}

let warnings = 0;
function warn(file, line, snippet, kind) {
  warnings++;
  const rel = path.relative(ROOT, file);
  console.log(`  ${rel}:${line}  [${kind}]  ${snippet.slice(0, 120)}`);
}

function scanFile(file) {
  const src = fs.readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // attribute strings
    let m;
    TEXT_ATTR_RE.lastIndex = 0;
    while ((m = TEXT_ATTR_RE.exec(line)) !== null) {
      const value = m[2];
      if (!isUserFacing(value)) continue;
      if (catalogValues.has(value.trim())) continue;
      warn(file, i + 1, `${m[1]}="${value}"`, "attr");
    }
    // JSX text nodes
    JSX_TEXT_RE.lastIndex = 0;
    while ((m = JSX_TEXT_RE.exec(line)) !== null) {
      const text = m[1];
      if (!isUserFacing(text)) continue;
      if (catalogValues.has(text.trim())) continue;
      warn(file, i + 1, `>${text}<`, "text");
    }
  }
}

console.log("[i18n:check] Scanning in-scope files for unkeyed strings...");
console.log(
  `[i18n:check] Catalog: ${path.relative(ROOT, CATALOG_PATH)} (${Object.keys(catalog).length} keys)`,
);
console.log("");
for (const file of IN_SCOPE) {
  if (!fs.existsSync(file)) continue;
  scanFile(file);
}
console.log("");
console.log(
  `[i18n:check] ${warnings} potential unkeyed string(s). Warn-only — exit 0.`,
);
process.exit(0);
