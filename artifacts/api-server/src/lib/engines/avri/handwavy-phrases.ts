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
//
// Task #120 — In-place edits. Reviewers can update an existing phrase's
// category and/or rationale without losing the original add context. Each
// edit appends an entry to a per-marker `edits` log (who, when, and the
// before/after for whatever fields actually changed). The `edits` log is
// bounded so a single phrase cannot grow the JSON file unboundedly.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

export type HandwavyCategory = "absence" | "hedging" | "buzzword";

export const HANDWAVY_CATEGORIES: readonly HandwavyCategory[] = [
  "absence",
  "hedging",
  "buzzword",
] as const;

/**
 * Task #120 — One entry in a marker's edit history. Each edit records the
 * reviewer (name/email) that made the change, the ISO timestamp, and the
 * before/after value for whichever fields actually changed (category and/or
 * rationale). Fields that did not change are omitted so the log stays compact.
 */
export interface HandwavyEditEntry {
  /** Reviewer name or email that performed the edit. */
  editedBy?: string;
  /** ISO 8601 timestamp of the edit. */
  editedAt: string;
  /** Category change, present only when the category was actually altered. */
  category?: { from: HandwavyCategory; to: HandwavyCategory };
  /** Rationale change, present only when the rationale was actually altered. `from`/`to` may be empty strings to indicate the rationale was set or cleared. */
  rationale?: { from?: string; to?: string };
}

export interface HandwavyMarker {
  phrase: string;
  category: HandwavyCategory;
  /** Reviewer name or email that added this phrase. Undefined for curated defaults. */
  addedBy?: string;
  /** ISO 8601 timestamp the phrase was added. Undefined for curated defaults. */
  addedAt?: string;
  /** Free-text justification supplied by the reviewer at add time. */
  rationale?: string;
  /** Task #120 — chronological list of edits applied since the phrase was added. Most recent last. */
  edits?: HandwavyEditEntry[];
}

export interface HandwavyHistoryEntry {
  /**
   * Single-removal entries (the legacy and still-supported single DELETE
   * path) carry the removed phrase here. Task #135 batch-removal entries
   * leave this empty and instead populate `phrases`.
   */
  phrase?: string;
  /** Category of the single removed phrase. Empty for batch entries. */
  category?: HandwavyCategory;
  addedBy?: string;
  addedAt?: string;
  rationale?: string;
  /** Task #120 — preserved on remove so reinstating still shows the edit history. */
  edits?: HandwavyEditEntry[];
  /** Reviewer name or email that removed the phrase(s). */
  removedBy?: string;
  /** ISO 8601 timestamp the phrase(s) were removed. */
  removedAt: string;
  /**
   * Task #121 — set to true once a reviewer has reinstated this phrase
   * straight from the history log. The same history row can't be reinstated
   * twice — a fresh remove of the live marker creates a new history row.
   * For batch entries this is the AGGREGATE flag: true once every inner
   * phrase has been reinstated (see `phrases[].reinstated`).
   */
  reinstated?: boolean;
  /** Reviewer name or email that reinstated the phrase from history. */
  reinstatedBy?: string;
  /** ISO 8601 timestamp the phrase was reinstated from history. */
  reinstatedAt?: string;
  /**
   * Task #130 — set to true when this history row was produced by a reviewer
   * undoing a brand-new add (the mirror of #121's Reinstate). The UI renders
   * undone rows distinctly from manual removals so the audit trail clearly
   * reads "added then undone" rather than "added then removed".
   */
  undone?: boolean;
  /** Reviewer name or email that pressed Undo. */
  undoneBy?: string;
  /**
   * Task #135 — populated when a reviewer removed multiple phrases in a
   * single batch action. Each entry mirrors the audit metadata that the
   * legacy single-removal entry carried at the top level. Per-phrase
   * `reinstated`/`reinstatedBy`/`reinstatedAt` track partial reinstates so a
   * reviewer can pull individual phrases back out of a batch removal.
   */
  phrases?: HandwavyBatchHistoryPhrase[];
}

export interface HandwavyBatchHistoryPhrase {
  phrase: string;
  category: HandwavyCategory;
  addedBy?: string;
  addedAt?: string;
  rationale?: string;
  edits?: HandwavyEditEntry[];
  reinstated?: boolean;
  reinstatedBy?: string;
  reinstatedAt?: string;
}

interface PhrasesFile {
  _meta?: unknown;
  phrases: Array<string | HandwavyMarker | Record<string, unknown>>;
  history?: HandwavyHistoryEntry[] | Array<Record<string, unknown>>;
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

function coerceEditEntry(entry: unknown): HandwavyEditEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  const editedAt = isIsoTimestamp(obj.editedAt) ? obj.editedAt : undefined;
  if (!editedAt) return null;
  const out: HandwavyEditEntry = { editedAt };
  const editedBy = trimOrUndefined(obj.editedBy, 200);
  if (editedBy) out.editedBy = editedBy;
  if (obj.category && typeof obj.category === "object") {
    const c = obj.category as Record<string, unknown>;
    if (isCategory(c.from) && isCategory(c.to) && c.from !== c.to) {
      out.category = { from: c.from, to: c.to };
    }
  }
  if (obj.rationale && typeof obj.rationale === "object") {
    const r = obj.rationale as Record<string, unknown>;
    const from = typeof r.from === "string" ? r.from : undefined;
    const to = typeof r.to === "string" ? r.to : undefined;
    if (from !== undefined || to !== undefined) {
      out.rationale = {};
      if (from !== undefined) out.rationale.from = from;
      if (to !== undefined) out.rationale.to = to;
    }
  }
  // An edit entry with neither category nor rationale change carries no info.
  if (!out.category && !out.rationale) return null;
  return out;
}

function coerceEdits(value: unknown): HandwavyEditEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .map(coerceEditEntry)
    .filter((e): e is HandwavyEditEntry => e !== null);
  return cleaned.length > 0 ? cleaned : undefined;
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
    const edits = coerceEdits(obj.edits);
    if (edits) marker.edits = edits;
    return marker;
  }
  return null;
}

function coerceBatchPhrase(entry: unknown): HandwavyBatchHistoryPhrase | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  if (typeof obj.phrase !== "string") return null;
  const phrase = normalizePhrase(obj.phrase);
  if (!phrase) return null;
  const category: HandwavyCategory = isCategory(obj.category) ? obj.category : "absence";
  const out: HandwavyBatchHistoryPhrase = { phrase, category };
  const addedBy = trimOrUndefined(obj.addedBy, 200);
  if (addedBy) out.addedBy = addedBy;
  if (isIsoTimestamp(obj.addedAt)) out.addedAt = obj.addedAt;
  const rationale = trimOrUndefined(obj.rationale, 500);
  if (rationale) out.rationale = rationale;
  const edits = coerceEdits(obj.edits);
  if (edits) out.edits = edits;
  if (obj.reinstated === true) out.reinstated = true;
  const reinstatedBy = trimOrUndefined(obj.reinstatedBy, 200);
  if (reinstatedBy) out.reinstatedBy = reinstatedBy;
  if (isIsoTimestamp(obj.reinstatedAt)) out.reinstatedAt = obj.reinstatedAt;
  return out;
}

function coerceHistory(entry: unknown): HandwavyHistoryEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;
  const removedAt = isIsoTimestamp(obj.removedAt) ? obj.removedAt : undefined;
  if (!removedAt) return null;
  // Task #135 — batch entries have a `phrases` array and no top-level
  // `phrase`. Each inner phrase carries its own audit metadata.
  const rawBatch = Array.isArray(obj.phrases) ? obj.phrases : null;
  if (rawBatch) {
    const phrases: HandwavyBatchHistoryPhrase[] = rawBatch
      .map(coerceBatchPhrase)
      .filter((p): p is HandwavyBatchHistoryPhrase => p !== null);
    if (phrases.length === 0) return null;
    const out: HandwavyHistoryEntry = { removedAt, phrases };
    const removedBy = trimOrUndefined(obj.removedBy, 200);
    if (removedBy) out.removedBy = removedBy;
    if (phrases.every((p) => p.reinstated)) out.reinstated = true;
    return out;
  }
  if (typeof obj.phrase !== "string") return null;
  const phrase = normalizePhrase(obj.phrase);
  if (!phrase) return null;
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
  const edits = coerceEdits(obj.edits);
  if (edits) out.edits = edits;
  if (obj.undone === true) out.undone = true;
  const undoneBy = trimOrUndefined(obj.undoneBy, 200);
  if (undoneBy) out.undoneBy = undoneBy;
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
        "Curated list of FLAT-family hand-wavy marker phrases. Loaded by lib/engines/avri/handwavy-phrases.ts. Phrases are matched as case-insensitive substrings against a whitespace-collapsed copy of the report text. Each entry is themed into one of three categories ('absence', 'hedging', 'buzzword') so the diagnostics panel can group matches into themed buckets. Reviewers can add, edit, or remove phrases through POST/PATCH/DELETE /feedback/calibration/handwavy-phrases without a redeploy. Each entry optionally tracks the reviewer (`addedBy`), ISO timestamp (`addedAt`), and free-text `rationale`, plus an `edits` log of subsequent in-place changes (who, when, before/after for category and rationale). Removed phrases are appended to `history` so reviewers can see what was pulled and reinstate it with context.",
    },
    phrases: markers as unknown as Array<Record<string, unknown>>,
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
  if (removed.edits && removed.edits.length > 0) {
    historyEntry.edits = removed.edits.map((e) => ({ ...e }));
  }
  const nextHistory = [...history, historyEntry];
  const trimmed = persist(next, nextHistory);
  CACHED_MARKERS = next;
  CACHED_HISTORY = trimmed;
  return { removed: true, phrase, total: next.length, historyEntry: { ...historyEntry } };
}

export interface BatchRemovePhraseEntryResult {
  /** Original (raw) phrase as supplied by the caller. */
  raw: string;
  /** Normalized form actually compared against the active list. */
  phrase: string;
  removed: boolean;
  /** Reason when not removed: "not-found" or "duplicate-in-batch". */
  reason?: "not-found" | "duplicate-in-batch";
}

export interface BatchRemovePhraseResult {
  /** Number of active phrases AFTER the batch (unchanged when nothing was removed). */
  total: number;
  /** Per-phrase outcomes, in the same order as the input list. */
  results: BatchRemovePhraseEntryResult[];
  /** The single batch history entry, present iff at least one phrase was removed. */
  historyEntry?: HandwavyHistoryEntry;
  /** Count of phrases that actually came off the active list. */
  removed: number;
  /** Count of phrases that were not in the active list at lookup time. */
  notFound: number;
}

/**
 * Task #135 — remove multiple phrases in a single in-memory pass and a single
 * file rewrite. The history log gets ONE batch entry that lists every removed
 * phrase, so a release-checklist cleanup of a dozen phrases shows up as one
 * reviewer action instead of N. Phrases that aren't in the active list are
 * reported in the result with `removed: false, reason: "not-found"` and do
 * NOT contribute a history entry.
 */
export function removeHandwavyPhrasesBatch(
  rawPhrases: string[],
  options: RemovePhraseOptions = {},
): BatchRemovePhraseResult {
  const reviewer = trimOrUndefined(options.reviewer, 200);
  const removedAt = isIsoTimestamp(options.now) ? options.now : new Date().toISOString();
  const { markers: current, history } = load();

  const results: BatchRemovePhraseEntryResult[] = [];
  const removedMarkers: HandwavyMarker[] = [];
  // Walk the input in order so the per-phrase results array mirrors what
  // the caller asked for; track which indexes still need to be removed
  // before finally building the new active list in one pass.
  const toRemoveIndexes = new Set<number>();
  const seenInBatch = new Set<string>();
  for (const raw of rawPhrases) {
    const normalized = normalizePhrase(raw);
    if (seenInBatch.has(normalized)) {
      results.push({ raw, phrase: normalized, removed: false, reason: "duplicate-in-batch" });
      continue;
    }
    seenInBatch.add(normalized);
    const idx = current.findIndex((m) => m.phrase === normalized);
    if (idx < 0) {
      results.push({ raw, phrase: normalized, removed: false, reason: "not-found" });
      continue;
    }
    toRemoveIndexes.add(idx);
    removedMarkers.push(current[idx]);
    results.push({ raw, phrase: normalized, removed: true });
  }

  if (removedMarkers.length === 0) {
    return {
      total: current.length,
      results,
      removed: 0,
      notFound: results.filter((r) => r.reason === "not-found").length,
    };
  }

  const next = current.filter((_, i) => !toRemoveIndexes.has(i));
  const batchPhrases: HandwavyBatchHistoryPhrase[] = removedMarkers.map((m) => {
    const entry: HandwavyBatchHistoryPhrase = {
      phrase: m.phrase,
      category: m.category,
    };
    if (m.addedBy) entry.addedBy = m.addedBy;
    if (m.addedAt) entry.addedAt = m.addedAt;
    if (m.rationale) entry.rationale = m.rationale;
    if (m.edits && m.edits.length > 0) entry.edits = m.edits.map((e) => ({ ...e }));
    return entry;
  });
  const historyEntry: HandwavyHistoryEntry = {
    removedAt,
    phrases: batchPhrases,
  };
  if (reviewer) historyEntry.removedBy = reviewer;
  const nextHistory = [...history, historyEntry];
  const trimmed = persist(next, nextHistory);
  CACHED_MARKERS = next;
  CACHED_HISTORY = trimmed;
  return {
    total: next.length,
    results,
    historyEntry: {
      ...historyEntry,
      phrases: batchPhrases.map((p) => ({ ...p })),
    },
    removed: removedMarkers.length,
    notFound: results.filter((r) => r.reason === "not-found").length,
  };
}

// Task #145 — pure preview of a batch removal. Mirrors the per-phrase result
// shape that `removeHandwavyPhrasesBatch` produces but does NOT mutate the
// active list, the history log, or the cache. Reviewers (and the CLI
// `--dry-run` flag) get the same "would this remove anything? are there
// duplicates? not-founds?" breakdown they would see after a real DELETE,
// plus the projected `next` active list so callers can score corpus impact
// against it.
export interface PreviewBatchRemoveResult {
  /** Active list size BEFORE the batch (no mutation occurred). */
  total: number;
  /** Projected active list AFTER the batch would be applied. */
  nextMarkers: HandwavyMarker[];
  /** Per-phrase outcomes mirroring removeHandwavyPhrasesBatch.results. */
  results: BatchRemovePhraseEntryResult[];
  /** Number of phrases that WOULD have been removed. */
  wouldRemove: number;
  /** Number of phrases that were not in the active list. */
  notFound: number;
  /** Number of phrases that were duplicates of an earlier entry in the batch. */
  duplicateInBatch: number;
  /** Snapshot of the markers that would be removed (for callers that need
   *  audit metadata e.g. who originally added them). */
  removedMarkers: HandwavyMarker[];
}

export function previewRemoveHandwavyPhrasesBatch(
  rawPhrases: string[],
): PreviewBatchRemoveResult {
  const { markers: current } = load();
  const results: BatchRemovePhraseEntryResult[] = [];
  const removedMarkers: HandwavyMarker[] = [];
  const toRemoveIndexes = new Set<number>();
  const seenInBatch = new Set<string>();
  for (const raw of rawPhrases) {
    const normalized = normalizePhrase(raw);
    if (seenInBatch.has(normalized)) {
      results.push({ raw, phrase: normalized, removed: false, reason: "duplicate-in-batch" });
      continue;
    }
    seenInBatch.add(normalized);
    const idx = current.findIndex((m) => m.phrase === normalized);
    if (idx < 0) {
      results.push({ raw, phrase: normalized, removed: false, reason: "not-found" });
      continue;
    }
    toRemoveIndexes.add(idx);
    removedMarkers.push(current[idx]);
    results.push({ raw, phrase: normalized, removed: true });
  }
  const nextMarkers = current.filter((_, i) => !toRemoveIndexes.has(i));
  return {
    total: current.length,
    nextMarkers: nextMarkers.map((m) => ({ ...m })),
    results,
    wouldRemove: removedMarkers.length,
    notFound: results.filter((r) => r.reason === "not-found").length,
    duplicateInBatch: results.filter((r) => r.reason === "duplicate-in-batch").length,
    removedMarkers: removedMarkers.map((m) => ({ ...m })),
  };
}

export interface ReinstatePhraseOptions {
  reviewer?: string;
  /** Override the timestamp (tests). Defaults to `new Date().toISOString()`. */
  now?: string;
}

/**
 * Task #159 — options for `reinstateHandwavyPhrasesBatch`. Extends the
 * single-phrase reinstate options with a `dryRun` flag that lets reviewers
 * preview the per-phrase outcome of a batch reinstate (which inner phrases
 * would be reinstated, which would be skipped because they're already
 * reinstated or already on the active list) without mutating the active
 * marker list, the removal-history log, or the cache.
 */
export interface ReinstateBatchOptions extends ReinstatePhraseOptions {
  /**
   * When true, the function computes the same `results` / `reinstated` /
   * `skipped` shape but skips the `persist` step entirely. Reviewer name
   * and timestamp are still recorded in the in-memory `historyEntry` /
   * inner phrase rows that come back, so the caller can show "this batch
   * would be reinstated by <reviewer> at <now>" in the preview, but
   * nothing is written back to disk and `CACHED_*` are left untouched.
   */
  dryRun?: boolean;
}

/** Maximum number of edit-history entries kept on a single marker. */
const EDITS_PER_PHRASE_LIMIT = 50;

export interface EditPhraseOptions {
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
  // Try a single-entry match first, then fall back to a batch entry that
  // contains this phrase with the matching removedAt (Task #135).
  const singleIdx = history.findIndex(
    (h) => h.phrase === phrase && h.removedAt === removedAt && !h.phrases,
  );
  let batchIdx = -1;
  let batchPhraseIdx = -1;
  if (singleIdx < 0) {
    for (let i = 0; i < history.length; i++) {
      const h = history[i];
      if (h.removedAt !== removedAt || !h.phrases) continue;
      const pi = h.phrases.findIndex((p) => p.phrase === phrase);
      if (pi >= 0) {
        batchIdx = i;
        batchPhraseIdx = pi;
        break;
      }
    }
  }
  if (singleIdx < 0 && batchIdx < 0) {
    return { ok: false, reason: "history-not-found", phrase };
  }

  const reviewer = trimOrUndefined(options.reviewer, 200);
  const at = isIsoTimestamp(options.now) ? options.now : new Date().toISOString();

  if (singleIdx >= 0) {
    const entry = history[singleIdx];
    if (entry.reinstated) {
      return { ok: false, reason: "already-reinstated", phrase };
    }
    if (current.some((m) => m.phrase === phrase)) {
      return { ok: false, reason: "already-active", phrase };
    }
    const category: HandwavyCategory = entry.category ?? "absence";
    const marker: HandwavyMarker = { phrase, category };
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
    nextHistory[singleIdx] = updatedEntry;
    const trimmed = persist(nextMarkers, nextHistory);
    CACHED_MARKERS = nextMarkers;
    CACHED_HISTORY = trimmed;
    return {
      ok: true,
      phrase,
      category,
      total: nextMarkers.length,
      marker: { ...marker },
      historyEntry: { ...updatedEntry },
    };
  }

  // Batch entry path.
  const entry = history[batchIdx];
  const innerPhrases = entry.phrases ?? [];
  const inner = innerPhrases[batchPhraseIdx];
  if (inner.reinstated) {
    return { ok: false, reason: "already-reinstated", phrase };
  }
  if (current.some((m) => m.phrase === phrase)) {
    return { ok: false, reason: "already-active", phrase };
  }
  const marker: HandwavyMarker = { phrase, category: inner.category };
  if (reviewer) marker.addedBy = reviewer;
  marker.addedAt = at;
  if (inner.rationale) marker.rationale = inner.rationale;
  const nextMarkers = [...current, marker];
  const nextInnerPhrases = innerPhrases.slice();
  const updatedInner: HandwavyBatchHistoryPhrase = {
    ...inner,
    reinstated: true,
    reinstatedAt: at,
  };
  if (reviewer) updatedInner.reinstatedBy = reviewer;
  nextInnerPhrases[batchPhraseIdx] = updatedInner;
  const updatedEntry: HandwavyHistoryEntry = {
    ...entry,
    phrases: nextInnerPhrases,
  };
  if (nextInnerPhrases.every((p) => p.reinstated)) {
    updatedEntry.reinstated = true;
  } else {
    delete updatedEntry.reinstated;
  }
  const nextHistory = history.slice();
  nextHistory[batchIdx] = updatedEntry;
  const trimmed = persist(nextMarkers, nextHistory);
  CACHED_MARKERS = nextMarkers;
  CACHED_HISTORY = trimmed;
  return {
    ok: true,
    phrase,
    category: inner.category,
    total: nextMarkers.length,
    marker: { ...marker },
    historyEntry: { ...updatedEntry, phrases: nextInnerPhrases.map((p) => ({ ...p })) },
  };
}

/**
 * Task #144 — outcome of attempting to reinstate one inner phrase as part of
 * a "Reinstate all from this batch" round-trip. Phrases that were already
 * reinstated (partial undo earlier) or are already in the active list (a
 * reviewer manually re-added them) are SKIPPED with a reason rather than
 * failing the whole batch.
 */
export interface ReinstateBatchEntryResult {
  phrase: string;
  reinstated: boolean;
  reason?: "already-reinstated" | "already-active";
}

export type ReinstateBatchResult =
  | {
      ok: true;
      removedAt: string;
      reinstated: number;
      skipped: number;
      total: number;
      historyEntry: HandwavyHistoryEntry;
      results: ReinstateBatchEntryResult[];
    }
  | {
      ok: false;
      reason: "history-not-found" | "not-a-batch";
      removedAt: string;
    };

/**
 * Task #144 — reinstate every not-yet-reinstated inner phrase from a batch
 * removal entry in a single round-trip and a single persist. Mirrors the
 * single-phrase `reinstateHandwavyPhrase` flow but operates on the whole
 * batch the reviewer originally removed in one CLI action. Inner phrases
 * that have already been reinstated (partial undo earlier) or that have
 * been re-added to the active list separately are skipped with a reason
 * instead of failing the whole call. The aggregate `reinstated` flag on
 * the parent entry is set true once every inner phrase is reinstated.
 */
export function reinstateHandwavyPhrasesBatch(
  removedAt: string,
  options: ReinstateBatchOptions = {},
): ReinstateBatchResult {
  const { markers: current, history } = load();
  const idx = history.findIndex((h) => h.removedAt === removedAt);
  if (idx < 0) {
    return { ok: false, reason: "history-not-found", removedAt };
  }
  const entry = history[idx];
  if (!Array.isArray(entry.phrases) || entry.phrases.length === 0) {
    return { ok: false, reason: "not-a-batch", removedAt };
  }

  const reviewer = trimOrUndefined(options.reviewer, 200);
  const at = isIsoTimestamp(options.now) ? options.now : new Date().toISOString();

  const nextMarkers = current.slice();
  const activePhrases = new Set(current.map((m) => m.phrase));
  const nextInnerPhrases = entry.phrases.map((p) => ({ ...p }));
  const results: ReinstateBatchEntryResult[] = [];
  let reinstatedCount = 0;

  for (let i = 0; i < nextInnerPhrases.length; i++) {
    const inner = nextInnerPhrases[i];
    if (inner.reinstated) {
      results.push({ phrase: inner.phrase, reinstated: false, reason: "already-reinstated" });
      continue;
    }
    if (activePhrases.has(inner.phrase)) {
      results.push({ phrase: inner.phrase, reinstated: false, reason: "already-active" });
      continue;
    }
    const marker: HandwavyMarker = { phrase: inner.phrase, category: inner.category };
    if (reviewer) marker.addedBy = reviewer;
    marker.addedAt = at;
    if (inner.rationale) marker.rationale = inner.rationale;
    nextMarkers.push(marker);
    activePhrases.add(inner.phrase);
    const updatedInner: HandwavyBatchHistoryPhrase = {
      ...inner,
      reinstated: true,
      reinstatedAt: at,
    };
    if (reviewer) updatedInner.reinstatedBy = reviewer;
    nextInnerPhrases[i] = updatedInner;
    results.push({ phrase: inner.phrase, reinstated: true });
    reinstatedCount += 1;
  }

  const updatedEntry: HandwavyHistoryEntry = {
    ...entry,
    phrases: nextInnerPhrases,
  };
  if (nextInnerPhrases.every((p) => p.reinstated)) {
    updatedEntry.reinstated = true;
  } else {
    delete updatedEntry.reinstated;
  }
  const nextHistory = history.slice();
  nextHistory[idx] = updatedEntry;

  // Task #159 — when called in dry-run mode, return the same result shape
  // (so the UI / CLI preview matches the real call) but skip the persist
  // step entirely. This lets reviewers see exactly which inner phrases
  // would be reinstated and which would be skipped (already-reinstated /
  // already-active) before pulling the trigger.
  //
  // Only persist when something actually changed AND this is not a dry
  // run; otherwise just report the skip reasons so a reviewer who clicks
  // "Reinstate all" on an already fully-reinstated batch sees a clean
  // no-op result.
  if (!options.dryRun && reinstatedCount > 0) {
    const trimmed = persist(nextMarkers, nextHistory);
    CACHED_MARKERS = nextMarkers;
    CACHED_HISTORY = trimmed;
  }

  return {
    ok: true,
    removedAt,
    reinstated: reinstatedCount,
    skipped: results.length - reinstatedCount,
    total: nextMarkers.length,
    historyEntry: { ...updatedEntry, phrases: nextInnerPhrases.map((p) => ({ ...p })) },
    results,
  };
}

export interface EditPhraseUpdates {
  category?: HandwavyCategory;
  /**
   * New rationale. `undefined` means "leave unchanged"; an empty string
   * means "clear the existing rationale". Otherwise the value is trimmed
   * and length-validated like the original add path.
   */
  rationale?: string;
}

export interface EditPhraseResult {
  edited: boolean;
  phrase: string;
  marker: HandwavyMarker;
  total: number;
  /** The single edit entry that was just appended, if any. */
  editEntry?: HandwavyEditEntry;
}

/**
 * Task #120 — In-place edit of an existing curated phrase. Only category
 * and rationale can change; the phrase string itself is the row's identity
 * and must be modified via remove + add. Returns `edited: false` when the
 * supplied updates are no-ops, so the UI can short-circuit without writing
 * a no-op audit entry.
 */
export function editHandwavyPhrase(
  rawPhrase: string,
  updates: EditPhraseUpdates,
  options: EditPhraseOptions = {},
): EditPhraseResult {
  const phrase = normalizePhrase(rawPhrase);
  const { markers: current, history } = load();
  const idx = current.findIndex((m) => m.phrase === phrase);
  if (idx < 0) {
    throw new Error("Phrase not found.");
  }
  const target = current[idx];

  const editEntry: HandwavyEditEntry = {
    editedAt: isIsoTimestamp(options.now) ? options.now : new Date().toISOString(),
  };
  const reviewer = trimOrUndefined(options.reviewer, 200);
  if (reviewer) editEntry.editedBy = reviewer;

  const updated: HandwavyMarker = { ...target };

  if (updates.category !== undefined) {
    if (!isCategory(updates.category)) {
      throw new Error("category must be one of 'absence', 'hedging', 'buzzword'.");
    }
    if (updates.category !== target.category) {
      editEntry.category = { from: target.category, to: updates.category };
      updated.category = updates.category;
    }
  }

  if (updates.rationale !== undefined) {
    // Empty string means "clear", any other string is trimmed + validated.
    let nextRationale: string | undefined;
    if (updates.rationale.trim().length === 0) {
      nextRationale = undefined;
    } else {
      const trimmed = updates.rationale.trim();
      if (trimmed.length < 3) {
        throw new Error("Rationale must be at least 3 characters when provided.");
      }
      if (trimmed.length > 500) {
        throw new Error("Rationale must be at most 500 characters.");
      }
      nextRationale = trimmed;
    }
    const prev = target.rationale ?? "";
    const next = nextRationale ?? "";
    if (prev !== next) {
      editEntry.rationale = { from: prev, to: next };
      if (nextRationale === undefined) {
        delete updated.rationale;
      } else {
        updated.rationale = nextRationale;
      }
    }
  }

  // No effective change — short-circuit without persisting an audit entry.
  if (!editEntry.category && !editEntry.rationale) {
    return { edited: false, phrase, marker: { ...target }, total: current.length };
  }

  const existingEdits = target.edits ?? [];
  const nextEdits = [...existingEdits, editEntry];
  // Bound the per-marker edit log so a noisy phrase cannot bloat the JSON file.
  updated.edits =
    nextEdits.length > EDITS_PER_PHRASE_LIMIT
      ? nextEdits.slice(nextEdits.length - EDITS_PER_PHRASE_LIMIT)
      : nextEdits;

  const next = current.slice();
  next[idx] = updated;
  const trimmed = persist(next, history);
  CACHED_MARKERS = next;
  CACHED_HISTORY = trimmed;
  return {
    edited: true,
    phrase,
    marker: { ...updated, edits: updated.edits ? updated.edits.map((e) => ({ ...e })) : undefined },
    total: next.length,
    editEntry: { ...editEntry },
  };
}

/**
 * Task #130 — default time window during which a brand-new add can be
 * undone. After this elapses the Undo button disappears and the reviewer
 * has to fall back to the regular Trash flow (which produces a normal
 * removal-history row, not an `undone: true` one).
 */
export const UNDO_WINDOW_MS = 5 * 60 * 1000;

export interface UndoPhraseOptions {
  reviewer?: string;
  /** Override "now" for tests. Defaults to `new Date().toISOString()`. */
  now?: string;
  /** Override the undo window (ms). Defaults to UNDO_WINDOW_MS. */
  windowMs?: number;
}

export type UndoPhraseResult =
  | {
      ok: true;
      phrase: string;
      total: number;
      historyEntry: HandwavyHistoryEntry;
    }
  | {
      ok: false;
      reason:
        | "not-found"
        | "addedAt-mismatch"
        | "no-addedAt"
        | "window-expired";
      phrase: string;
    };

/**
 * Task #130 — mirror of `reinstateHandwavyPhrase`. A reviewer who just
 * added a phrase by accident can press Undo within `UNDO_WINDOW_MS` and the
 * phrase is removed. The resulting history row is tagged `undone: true` so
 * the audit trail clearly shows "added then undone" rather than producing
 * an unrelated manual-removal entry.
 *
 * Match by `phrase` + `addedAt` so an Undo can't accidentally roll back a
 * different (older) re-add of the same phrase that happens to live in the
 * active list.
 */
export function undoHandwavyPhrase(
  rawPhrase: string,
  addedAt: string,
  options: UndoPhraseOptions = {},
): UndoPhraseResult {
  const phrase = normalizePhrase(rawPhrase);
  const { markers: current, history } = load();
  const idx = current.findIndex((m) => m.phrase === phrase);
  if (idx < 0) {
    return { ok: false, reason: "not-found", phrase };
  }
  const marker = current[idx];
  if (!marker.addedAt) {
    // Curated defaults have no addedAt — they were never "added" by a
    // reviewer in the first place, so there is nothing to undo.
    return { ok: false, reason: "no-addedAt", phrase };
  }
  if (marker.addedAt !== addedAt) {
    return { ok: false, reason: "addedAt-mismatch", phrase };
  }
  const windowMs = typeof options.windowMs === "number" && options.windowMs >= 0
    ? options.windowMs
    : UNDO_WINDOW_MS;
  const nowIso = isIsoTimestamp(options.now) ? options.now : new Date().toISOString();
  const elapsed = Date.parse(nowIso) - Date.parse(marker.addedAt);
  if (!Number.isFinite(elapsed) || elapsed > windowMs) {
    return { ok: false, reason: "window-expired", phrase };
  }
  const reviewer = trimOrUndefined(options.reviewer, 200);
  const next = current.slice(0, idx).concat(current.slice(idx + 1));
  const historyEntry: HandwavyHistoryEntry = {
    phrase: marker.phrase,
    category: marker.category,
    removedAt: nowIso,
    undone: true,
  };
  if (reviewer) {
    historyEntry.removedBy = reviewer;
    historyEntry.undoneBy = reviewer;
  }
  if (marker.addedBy) historyEntry.addedBy = marker.addedBy;
  if (marker.addedAt) historyEntry.addedAt = marker.addedAt;
  if (marker.rationale) historyEntry.rationale = marker.rationale;
  const nextHistory = [...history, historyEntry];
  const trimmed = persist(next, nextHistory);
  CACHED_MARKERS = next;
  CACHED_HISTORY = trimmed;
  return { ok: true, phrase, total: next.length, historyEntry: { ...historyEntry } };
}

/**
 * Task #132 — One-click revert of a single edit-history entry. The reviewer
 * picks an entry from a marker's `edits` log and we restore the marker to the
 * "before" state captured by that entry: category goes back to
 * `entry.category.from` (if the entry recorded a category change) and
 * rationale goes back to `entry.rationale.from` (if the entry recorded a
 * rationale change). Fields the entry did NOT change are left alone — so
 * reverting an old edit only undoes what that edit changed, regardless of any
 * intervening edits to OTHER fields.
 *
 * The audit log stays append-only: the revert is performed by calling the
 * normal `editHandwavyPhrase` path, which appends a new entry capturing the
 * inverse change (and the reviewer who pressed the revert button). Pure
 * no-op reverts (current values already match the target) do not append an
 * entry — `editHandwavyPhrase` short-circuits — and we surface that as
 * `edited: false` so the UI can tell the reviewer there was nothing to undo.
 *
 * The original entry on `edits` is NOT modified or deleted; the revert is
 * visible only as a fresh entry with the inverse before/after pair.
 */
export type RevertEditResult =
  | (EditPhraseResult & { ok: true; revertedEntry: HandwavyEditEntry })
  | { ok: false; reason: "phrase-not-found" | "edit-not-found"; phrase: string };

export function revertHandwavyPhraseEdit(
  rawPhrase: string,
  editedAt: string,
  options: EditPhraseOptions = {},
): RevertEditResult {
  const phrase = normalizePhrase(rawPhrase);
  const { markers: current } = load();
  const target = current.find((m) => m.phrase === phrase);
  if (!target) {
    return { ok: false, reason: "phrase-not-found", phrase };
  }
  const edits = target.edits ?? [];
  const entry = edits.find((e) => e.editedAt === editedAt);
  if (!entry) {
    return { ok: false, reason: "edit-not-found", phrase };
  }
  const updates: EditPhraseUpdates = {};
  if (entry.category) {
    updates.category = entry.category.from;
  }
  if (entry.rationale) {
    // editHandwavyPhrase treats undefined as "unchanged" and "" as "clear",
    // which mirrors how the original entry stored a clear (`to: ""`).
    updates.rationale = entry.rationale.from ?? "";
  }
  const result = editHandwavyPhrase(phrase, updates, options);
  return { ...result, ok: true, revertedEntry: { ...entry } };
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
