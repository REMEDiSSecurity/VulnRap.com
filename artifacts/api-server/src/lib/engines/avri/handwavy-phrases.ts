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
//
// Task #112 — Audit trail. Each entry optionally records who added it
// (reviewer name/email), an ISO timestamp (`addedAt`), and a free-text
// `rationale`. Removed phrases are appended to a small `history` log on the
// JSON file so a reviewer can see what was pulled, by whom, and when, and
// reinstate it with the original context if needed. Older entries (pre-#112)
// have no audit metadata; the UI renders them as "Curated default".

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
  /** Reviewer name or email that added this phrase. Undefined for curated defaults. */
  addedBy?: string;
  /** ISO 8601 timestamp the phrase was added. Undefined for curated defaults. */
  addedAt?: string;
  /** Free-text justification supplied by the reviewer at add time. */
  rationale?: string;
}

export interface HandwavyHistoryEntry {
  phrase: string;
  category: HandwavyCategory;
  addedBy?: string;
  addedAt?: string;
  rationale?: string;
  /** Reviewer name or email that removed the phrase. */
  removedBy?: string;
  /** ISO 8601 timestamp the phrase was removed. */
  removedAt: string;
  /**
   * Task #121 — set to true once a reviewer has reinstated this phrase
   * straight from the history log. The same history row can't be reinstated
   * twice — a fresh remove of the live marker creates a new history row.
   */
  reinstated?: boolean;
  /** Reviewer name or email that reinstated the phrase from history. */
  reinstatedBy?: string;
  /** ISO 8601 timestamp the phrase was reinstated from history. */
  reinstatedAt?: string;
}

interface PhrasesFile {
  _meta?: unknown;
  phrases: Array<string | Record<string, unknown>>;
  history?: Array<Record<string, unknown>>;
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

const HISTORY_LIMIT = 200;

let CACHED_MARKERS: HandwavyMarker[] | null = null;
let CACHED_HISTORY: HandwavyHistoryEntry[] | null = null;
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

function trimOrUndefined(x: unknown, max: number): string | undefined {
  if (typeof x !== "string") return undefined;
  const v = x.trim();
  if (!v) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

function isIsoTimestamp(x: unknown): x is string {
  return typeof x === "string" && !Number.isNaN(Date.parse(x));
}

function coerceMarker(entry: unknown): HandwavyMarker | null {
  if (typeof entry === "string") {
    const phrase = normalizePhrase(entry);
    if (!phrase) return null;
    return { phrase, category: "absence" };
  }
  if (entry && typeof entry === "object") {
    const obj = entry as Record<string, unknown>;
    if (typeof obj.phrase !== "string") return null;
    const phrase = normalizePhrase(obj.phrase);
    if (!phrase) return null;
    const category: HandwavyCategory = isCategory(obj.category) ? obj.category : "absence";
    const marker: HandwavyMarker = { phrase, category };
    const addedBy = trimOrUndefined(obj.addedBy, 200);
    if (addedBy) marker.addedBy = addedBy;
    if (isIsoTimestamp(obj.addedAt)) marker.addedAt = obj.addedAt;
    const rationale = trimOrUndefined(obj.rationale, 500);
    if (rationale) marker.rationale = rationale;
    return marker;
  }
  return null;
}

function coerceHistory(entry: unknown): HandwavyHistoryEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  if (typeof obj.phrase !== "string") return null;
  const phrase = normalizePhrase(obj.phrase);
  if (!phrase) return null;
  const removedAt = isIsoTimestamp(obj.removedAt) ? obj.removedAt : undefined;
  if (!removedAt) return null;
  const category: HandwavyCategory = isCategory(obj.category) ? obj.category : "absence";
  const out: HandwavyHistoryEntry = { phrase, category, removedAt };
  const removedBy = trimOrUndefined(obj.removedBy, 200);
  if (removedBy) out.removedBy = removedBy;
  const addedBy = trimOrUndefined(obj.addedBy, 200);
  if (addedBy) out.addedBy = addedBy;
  if (isIsoTimestamp(obj.addedAt)) out.addedAt = obj.addedAt;
  const rationale = trimOrUndefined(obj.rationale, 500);
  if (rationale) out.rationale = rationale;
  if (obj.reinstated === true) out.reinstated = true;
  const reinstatedBy = trimOrUndefined(obj.reinstatedBy, 200);
  if (reinstatedBy) out.reinstatedBy = reinstatedBy;
  if (isIsoTimestamp(obj.reinstatedAt)) out.reinstatedAt = obj.reinstatedAt;
  return out;
}

function load(): { markers: HandwavyMarker[]; history: HandwavyHistoryEntry[] } {
  if (CACHED_MARKERS && CACHED_HISTORY) {
    return { markers: CACHED_MARKERS, history: CACHED_HISTORY };
  }
  const p = resolvePath();
  let markers: HandwavyMarker[] | null = null;
  let history: HandwavyHistoryEntry[] = [];
  if (existsSync(p)) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as PhrasesFile;
      if (Array.isArray(raw.phrases)) {
        markers = raw.phrases
          .map(coerceMarker)
          .filter((m): m is HandwavyMarker => m !== null);
      }
      if (Array.isArray(raw.history)) {
        history = raw.history
          .map(coerceHistory)
          .filter((h): h is HandwavyHistoryEntry => h !== null);
      }
    } catch {
      // Fall through to defaults.
    }
  }
  if (!markers || markers.length === 0) {
    markers = DEFAULT_MARKERS.map((m) => ({ phrase: normalizePhrase(m.phrase), category: m.category }));
  }
  // Dedupe by phrase while preserving order; first occurrence wins.
  const seen = new Set<string>();
  const deduped: HandwavyMarker[] = [];
  for (const m of markers) {
    if (!seen.has(m.phrase)) {
      seen.add(m.phrase);
      deduped.push(m);
    }
  }
  CACHED_MARKERS = deduped;
  CACHED_HISTORY = history;
  return { markers: deduped, history };
}

function trimHistory(history: HandwavyHistoryEntry[]): HandwavyHistoryEntry[] {
  return history.length > HISTORY_LIMIT
    ? history.slice(history.length - HISTORY_LIMIT)
    : history;
}

function persist(markers: HandwavyMarker[], history: HandwavyHistoryEntry[]): HandwavyHistoryEntry[] {
  const p = resolvePath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const trimmedHistory = trimHistory(history);
  const body: PhrasesFile = {
    _meta: {
      description:
        "Curated list of FLAT-family hand-wavy marker phrases. Loaded by lib/engines/avri/handwavy-phrases.ts. Phrases are matched as case-insensitive substrings against a whitespace-collapsed copy of the report text. Each entry is themed into one of three categories ('absence', 'hedging', 'buzzword') so the diagnostics panel can group matches into themed buckets. Reviewers can add or remove phrases through POST/DELETE /feedback/calibration/handwavy-phrases without a redeploy. Each entry optionally tracks the reviewer (`addedBy`), ISO timestamp (`addedAt`), and free-text `rationale`. Removed phrases are appended to `history` so reviewers can see what was pulled and reinstate it with context.",
    },
    phrases: markers,
    history: trimmedHistory,
  };
  writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
  return trimmedHistory;
}

export function getHandwavyPhrases(): HandwavyMarker[] {
  return load().markers.map((m) => ({ ...m }));
}

export function getHandwavyPhraseHistory(): HandwavyHistoryEntry[] {
  return load().history.map((h) => ({ ...h }));
}

export interface AddPhraseOptions {
  reviewer?: string;
  rationale?: string;
  /** Override the timestamp (tests). Defaults to `new Date().toISOString()`. */
  now?: string;
}

export interface AddPhraseResult {
  added: boolean;
  phrase: string;
  category: HandwavyCategory;
  total: number;
  marker: HandwavyMarker;
}

export function addHandwavyPhrase(
  rawPhrase: string,
  rawCategory?: unknown,
  options: AddPhraseOptions = {},
): AddPhraseResult {
  const phrase = normalizePhrase(rawPhrase);
  if (phrase.length < 3) {
    throw new Error("Phrase must be at least 3 characters after normalization.");
  }
  if (phrase.length > 200) {
    throw new Error("Phrase must be at most 200 characters.");
  }
  const category: HandwavyCategory = isCategory(rawCategory) ? rawCategory : "absence";
  const reviewer = trimOrUndefined(options.reviewer, 200);
  const rationale = trimOrUndefined(options.rationale, 500);
  if (rationale && rationale.length < 3) {
    throw new Error("Rationale must be at least 3 characters when provided.");
  }
  const { markers: current, history } = load();
  const existing = current.find((m) => m.phrase === phrase);
  if (existing) {
    return { added: false, phrase, category: existing.category, total: current.length, marker: { ...existing } };
  }
  const addedAt = isIsoTimestamp(options.now) ? options.now : new Date().toISOString();
  const marker: HandwavyMarker = { phrase, category };
  if (reviewer) marker.addedBy = reviewer;
  marker.addedAt = addedAt;
  if (rationale) marker.rationale = rationale;
  const next = [...current, marker];
  const trimmed = persist(next, history);
  CACHED_MARKERS = next;
  CACHED_HISTORY = trimmed;
  return { added: true, phrase, category, total: next.length, marker: { ...marker } };
}

export interface RemovePhraseOptions {
  reviewer?: string;
  now?: string;
}

export interface RemovePhraseResult {
  removed: boolean;
  phrase: string;
  total: number;
  historyEntry?: HandwavyHistoryEntry;
}

export function removeHandwavyPhrase(
  rawPhrase: string,
  options: RemovePhraseOptions = {},
): RemovePhraseResult {
  const phrase = normalizePhrase(rawPhrase);
  const { markers: current, history } = load();
  const idx = current.findIndex((m) => m.phrase === phrase);
  if (idx < 0) {
    return { removed: false, phrase, total: current.length };
  }
  const reviewer = trimOrUndefined(options.reviewer, 200);
  const removedAt = isIsoTimestamp(options.now) ? options.now : new Date().toISOString();
  const removed = current[idx];
  const next = current.slice(0, idx).concat(current.slice(idx + 1));
  const historyEntry: HandwavyHistoryEntry = {
    phrase: removed.phrase,
    category: removed.category,
    removedAt,
  };
  if (reviewer) historyEntry.removedBy = reviewer;
  if (removed.addedBy) historyEntry.addedBy = removed.addedBy;
  if (removed.addedAt) historyEntry.addedAt = removed.addedAt;
  if (removed.rationale) historyEntry.rationale = removed.rationale;
  const nextHistory = [...history, historyEntry];
  const trimmed = persist(next, nextHistory);
  CACHED_MARKERS = next;
  CACHED_HISTORY = trimmed;
  return { removed: true, phrase, total: next.length, historyEntry: { ...historyEntry } };
}

export interface ReinstatePhraseOptions {
  reviewer?: string;
  /** Override the timestamp (tests). Defaults to `new Date().toISOString()`. */
  now?: string;
}

export type ReinstatePhraseResult =
  | {
      ok: true;
      phrase: string;
      category: HandwavyCategory;
      total: number;
      marker: HandwavyMarker;
      historyEntry: HandwavyHistoryEntry;
    }
  | {
      ok: false;
      reason: "history-not-found" | "already-reinstated" | "already-active";
      phrase: string;
    };

/**
 * Task #121 — reinstate a previously removed phrase straight from the history
 * log. The history entry is matched by `phrase` + `removedAt` so two distinct
 * removes of the same phrase can be reinstated independently. The reinstated
 * marker is added with the original category/rationale, but with the CURRENT
 * reviewer recorded as `addedBy` and the current time as `addedAt`, so the
 * audit trail still shows who reinstated and when. The history entry is
 * marked `reinstated: true` so the same row cannot be reinstated twice (the
 * UI hides the button after that).
 */
export function reinstateHandwavyPhrase(
  rawPhrase: string,
  removedAt: string,
  options: ReinstatePhraseOptions = {},
): ReinstatePhraseResult {
  const phrase = normalizePhrase(rawPhrase);
  const { markers: current, history } = load();
  const idx = history.findIndex((h) => h.phrase === phrase && h.removedAt === removedAt);
  if (idx < 0) {
    return { ok: false, reason: "history-not-found", phrase };
  }
  const entry = history[idx];
  if (entry.reinstated) {
    return { ok: false, reason: "already-reinstated", phrase };
  }
  // If the phrase is already active (someone manually re-added it before
  // this reinstate fired), refuse rather than silently flipping the history
  // row to "reinstated" — the audit trail must reflect reality.
  if (current.some((m) => m.phrase === phrase)) {
    return { ok: false, reason: "already-active", phrase };
  }
  const reviewer = trimOrUndefined(options.reviewer, 200);
  const at = isIsoTimestamp(options.now) ? options.now : new Date().toISOString();
  const marker: HandwavyMarker = { phrase, category: entry.category };
  if (reviewer) marker.addedBy = reviewer;
  marker.addedAt = at;
  if (entry.rationale) marker.rationale = entry.rationale;
  const nextMarkers = [...current, marker];
  const updatedEntry: HandwavyHistoryEntry = {
    ...entry,
    reinstated: true,
    reinstatedAt: at,
  };
  if (reviewer) updatedEntry.reinstatedBy = reviewer;
  const nextHistory = history.slice();
  nextHistory[idx] = updatedEntry;
  const trimmed = persist(nextMarkers, nextHistory);
  CACHED_MARKERS = nextMarkers;
  CACHED_HISTORY = trimmed;
  return {
    ok: true,
    phrase,
    category: entry.category,
    total: nextMarkers.length,
    marker: { ...marker },
    historyEntry: { ...updatedEntry },
  };
}

/** Test helper: drop the in-memory cache so the next read re-parses the file. */
export function __resetHandwavyPhrasesForTests(): void {
  CACHED_MARKERS = null;
  CACHED_HISTORY = null;
  RESOLVED_PATH = null;
}

/** Test helper: completely reset on-disk file to the curated defaults. */
export function __restoreHandwavyPhraseDefaultsForTests(): void {
  const defaults = DEFAULT_MARKERS.map((m) => ({
    phrase: normalizePhrase(m.phrase),
    category: m.category,
  }));
  persist(defaults, []);
  CACHED_MARKERS = defaults;
  CACHED_HISTORY = [];
}
