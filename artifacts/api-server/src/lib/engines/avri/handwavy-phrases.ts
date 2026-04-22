// FLAT-family hand-wavy marker phrases. Loaded from a curated JSON file so
// reviewers can extend/remove the list without an engineer + redeploy.
//
// Storage: data/handwavy-phrases.json (shipped with the package). Add/remove
// operations rewrite the file in place; subsequent triages pick up the new
// list because the cache is invalidated on every successful mutation.
//
// Each marker carries a `category` ("absence" | "hedging" | "buzzword") so the
// diagnostics panel can group matched entries into themed buckets rather than
// rendering one long flat list. The category travels with each absence-penalty
// entry into the diagnostics payload via `flatHandwavyCategory`.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

export type HandwavyCategory = "absence" | "hedging" | "buzzword";

export const HANDWAVY_CATEGORIES: readonly HandwavyCategory[] = [
  "absence",
  "hedging",
  "buzzword",
] as const;

export interface HandwavyMarker {
  phrase: string;
  category: HandwavyCategory;
}

interface PhrasesFile {
  _meta?: unknown;
  phrases: Array<string | { phrase?: unknown; category?: unknown }>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CANDIDATE_PATHS = [
  // dist-relative (after tsc): dist/lib/engines/avri/ -> dist/../../../data
  path.resolve(__dirname, "../../../../data/handwavy-phrases.json"),
  // src-relative (vitest / tsx): src/lib/engines/avri/ -> src/../../../data
  path.resolve(__dirname, "../../../../data/handwavy-phrases.json"),
  // pkg-root fallback
  path.resolve(process.cwd(), "data/handwavy-phrases.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/handwavy-phrases.json"),
];

const DEFAULT_MARKERS: HandwavyMarker[] = [
  { phrase: "do not have a runnable reproducer", category: "absence" },
  { phrase: "do not have a reproducer", category: "absence" },
  { phrase: "private fuzzing harness", category: "absence" },
  { phrase: "private poc", category: "absence" },
  { phrase: "structural rather than", category: "absence" },
  { phrase: "structural vulnerability follows from the design", category: "absence" },
  { phrase: "i have not enumerated", category: "absence" },
  { phrase: "have not been able to confirm", category: "absence" },
  { phrase: "no working proof-of-concept", category: "absence" },
  { phrase: "no runnable proof", category: "absence" },
  { phrase: "follows from the design as observed", category: "absence" },
  { phrase: "deployment is no different in this respect", category: "absence" },
  { phrase: "may not be encrypted", category: "hedging" },
  { phrase: "may be present in environment variables", category: "hedging" },
  { phrase: "do not appear to be", category: "hedging" },
  { phrase: "does not appear to be", category: "hedging" },
  { phrase: "appears to be susceptible", category: "hedging" },
  { phrase: "consider a holistic remediation", category: "hedging" },
  { phrase: "leadership-level discussion", category: "hedging" },
  { phrase: "comprehensive zero-trust assessment", category: "buzzword" },
  { phrase: "modern threat landscape", category: "buzzword" },
  { phrase: "advanced persistent threats", category: "buzzword" },
  { phrase: "defense-in-depth posture", category: "buzzword" },
  { phrase: "weak security culture", category: "buzzword" },
];

let CACHED: HandwavyMarker[] | null = null;
let RESOLVED_PATH: string | null = null;

function resolvePath(): string {
  if (RESOLVED_PATH) return RESOLVED_PATH;
  // Tests/operators can pin the storage path explicitly via HANDWAVY_PHRASES_PATH
  // so tests don't mutate the shipped JSON file.
  const override = process.env.HANDWAVY_PHRASES_PATH;
  if (override && override.trim().length > 0) {
    RESOLVED_PATH = path.resolve(override);
    return RESOLVED_PATH;
  }
  for (const p of CANDIDATE_PATHS) {
    if (existsSync(p)) {
      RESOLVED_PATH = p;
      return p;
    }
  }
  // Fall back to the first candidate so a write can create it on demand.
  RESOLVED_PATH = CANDIDATE_PATHS[0];
  return RESOLVED_PATH;
}

function normalizePhrase(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

function isCategory(x: unknown): x is HandwavyCategory {
  return x === "absence" || x === "hedging" || x === "buzzword";
}

function coerceMarker(entry: unknown): HandwavyMarker | null {
  if (typeof entry === "string") {
    const phrase = normalizePhrase(entry);
    if (!phrase) return null;
    return { phrase, category: "absence" };
  }
  if (entry && typeof entry === "object") {
    const obj = entry as { phrase?: unknown; category?: unknown };
    if (typeof obj.phrase !== "string") return null;
    const phrase = normalizePhrase(obj.phrase);
    if (!phrase) return null;
    const category: HandwavyCategory = isCategory(obj.category) ? obj.category : "absence";
    return { phrase, category };
  }
  return null;
}

function loadMarkers(): HandwavyMarker[] {
  if (CACHED) return CACHED;
  const p = resolvePath();
  let markers: HandwavyMarker[] | null = null;
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as PhrasesFile;
      if (Array.isArray(raw.phrases)) {
        markers = raw.phrases
          .map(coerceMarker)
          .filter((m): m is HandwavyMarker => m !== null);
      }
    } catch {
      // Fall through to defaults.
    }
  }
  if (!markers || markers.length === 0) {
    markers = DEFAULT_MARKERS.map((m) => ({ phrase: normalizePhrase(m.phrase), category: m.category }));
  }
  // Dedupe by phrase while preserving order; first occurrence wins (so the
  // first category seen for a phrase sticks, matching loader-edit semantics).
  const seen = new Set<string>();
  const deduped: HandwavyMarker[] = [];
  for (const m of markers) {
    if (!seen.has(m.phrase)) {
      seen.add(m.phrase);
      deduped.push(m);
    }
  }
  CACHED = deduped;
  return CACHED;
}

function persist(markers: HandwavyMarker[]): void {
  const p = resolvePath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body: PhrasesFile = {
    _meta: {
      description:
        "Curated list of FLAT-family hand-wavy marker phrases. Loaded by lib/engines/avri/handwavy-phrases.ts. Phrases are matched as case-insensitive substrings against a whitespace-collapsed copy of the report text. Each entry is themed into one of three categories ('absence', 'hedging', 'buzzword') so the diagnostics panel can group matches into themed buckets. Reviewers can add or remove phrases through POST/DELETE /feedback/calibration/handwavy-phrases without a redeploy.",
    },
    phrases: markers,
  };
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
}

export function getHandwavyPhrases(): HandwavyMarker[] {
  return loadMarkers().map((m) => ({ ...m }));
}

export interface AddPhraseResult {
  added: boolean;
  phrase: string;
  category: HandwavyCategory;
  total: number;
}

export function addHandwavyPhrase(
  rawPhrase: string,
  rawCategory?: unknown,
): AddPhraseResult {
  const phrase = normalizePhrase(rawPhrase);
  if (phrase.length < 3) {
    throw new Error("Phrase must be at least 3 characters after normalization.");
  }
  if (phrase.length > 200) {
    throw new Error("Phrase must be at most 200 characters.");
  }
  const category: HandwavyCategory = isCategory(rawCategory) ? rawCategory : "absence";
  const current = loadMarkers();
  const existing = current.find((m) => m.phrase === phrase);
  if (existing) {
    return { added: false, phrase, category: existing.category, total: current.length };
  }
  const next = [...current, { phrase, category }];
  persist(next);
  CACHED = next;
  return { added: true, phrase, category, total: next.length };
}

export interface RemovePhraseResult {
  removed: boolean;
  phrase: string;
  total: number;
}

export function removeHandwavyPhrase(rawPhrase: string): RemovePhraseResult {
  const phrase = normalizePhrase(rawPhrase);
  const current = loadMarkers();
  const idx = current.findIndex((m) => m.phrase === phrase);
  if (idx < 0) {
    return { removed: false, phrase, total: current.length };
  }
  const next = current.slice(0, idx).concat(current.slice(idx + 1));
  persist(next);
  CACHED = next;
  return { removed: true, phrase, total: next.length };
}

/** Test helper: drop the in-memory cache so the next read re-parses the file. */
export function __resetHandwavyPhrasesForTests(): void {
  CACHED = null;
  RESOLVED_PATH = null;
}

/** Test helper: completely reset on-disk file to the curated defaults. */
export function __restoreHandwavyPhraseDefaultsForTests(): void {
  const defaults = DEFAULT_MARKERS.map((m) => ({
    phrase: normalizePhrase(m.phrase),
    category: m.category,
  }));
  persist(defaults);
  CACHED = defaults;
}
