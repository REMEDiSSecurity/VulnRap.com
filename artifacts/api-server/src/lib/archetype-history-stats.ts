// Task #211 — persisted stats about the archetype-history compaction
// pass: last-run timestamp + rows removed, plus a bounded ring buffer
// of recent outcomes (Task #289) so the dashboard can show cadence.
//
// Stats live in a sibling file (not the config JSON) so the
// high-frequency compaction writer cannot race the low-frequency
// reviewer-driven config writer. Path override env var mirrors the
// rest of the archetype-history surface.
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";

/** One persisted compaction-pass outcome. */
export interface CompactionRunRecord {
  /** ISO-8601 timestamp of when the pass ran. */
  at: string;
  /** Number of snapshot rows the pass collapsed. Zero means "ran, nothing to roll up". */
  removed: number;
}

export interface CompactionStats {
  /** ISO-8601 timestamp of the most recent compaction pass. */
  lastCompactedAt: string;
  /**
   * Number of snapshot rows the most recent pass collapsed (raw rows
   * before minus rows after). Zero when the pass ran but had nothing to
   * roll up (e.g. all snapshots are within the window) — still useful to
   * surface so reviewers can see the routine is alive.
   */
  lastRemovedCount: number;
  /**
   * Bounded ring buffer of recent compaction outcomes, oldest -> newest.
   * Always contains at least one entry when the stats file exists; the
   * tail equals (lastCompactedAt, lastRemovedCount). Capped at MAX_RECENT_RUNS.
   */
  recentRuns: CompactionRunRecord[];
}

interface PersistedRunRecord {
  at: string;
  removed: number;
}

interface PersistedStats {
  version: 1;
  lastCompactedAt: string;
  lastRemovedCount: number;
  // Optional so legacy files (pre-Task #289) still parse; back-filled on read.
  recentRuns?: PersistedRunRecord[];
}

const DEFAULT_STATS_PATH = path.resolve(
  process.cwd(),
  "artifacts/api-server/data/archetype-history-stats.json",
);

/** Cap on the recent-runs ring buffer. Keeps the stats file small. */
const MAX_RECENT_RUNS = 20;

function statsPath(): string {
  return process.env.ARCHETYPE_HISTORY_STATS_PATH ?? DEFAULT_STATS_PATH;
}

// Cached so the GET /api/test/archetype-history/config handler (called
// on every dashboard refresh) doesn't pay a synchronous disk read. The
// cache is keyed by path so a test that overrides the env var cannot
// read another test's value. `undefined` means "unloaded"; `null` means
// "loaded, no stats yet".
let cached: CompactionStats | null | undefined;
let cachedFromPath: string | null = null;

function isValidRunRecord(value: unknown): value is PersistedRunRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<PersistedRunRecord>;
  if (typeof r.at !== "string") return false;
  if (!Number.isFinite(Date.parse(r.at))) return false;
  if (typeof r.removed !== "number") return false;
  if (!Number.isFinite(r.removed) || r.removed < 0) return false;
  return true;
}

function isValidStats(parsed: unknown): parsed is PersistedStats {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Partial<PersistedStats>;
  if (typeof p.lastCompactedAt !== "string") return false;
  if (!Number.isFinite(Date.parse(p.lastCompactedAt))) return false;
  if (typeof p.lastRemovedCount !== "number") return false;
  if (!Number.isFinite(p.lastRemovedCount) || p.lastRemovedCount < 0) return false;
  if (p.recentRuns !== undefined) {
    if (!Array.isArray(p.recentRuns)) return false;
    if (!p.recentRuns.every(isValidRunRecord)) return false;
  }
  return true;
}

/**
 * Materialize CompactionStats; back-fills `recentRuns` from the last-run
 * fields for legacy files, and clamps to MAX_RECENT_RUNS defensively.
 */
function fromPersisted(parsed: PersistedStats): CompactionStats {
  const lastRemoved = Math.round(parsed.lastRemovedCount);
  const seeded: CompactionRunRecord[] =
    parsed.recentRuns && parsed.recentRuns.length > 0
      ? parsed.recentRuns.map(r => ({ at: r.at, removed: Math.round(r.removed) }))
      : [{ at: parsed.lastCompactedAt, removed: lastRemoved }];
  const recentRuns = seeded.slice(-MAX_RECENT_RUNS);
  return {
    lastCompactedAt: parsed.lastCompactedAt,
    lastRemovedCount: lastRemoved,
    recentRuns,
  };
}

export function readCompactionStats(): CompactionStats | null {
  const p = statsPath();
  if (cached !== undefined && cachedFromPath === p) return cached;
  try {
    const raw = fsSync.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidStats(parsed)) {
      cached = fromPersisted(parsed);
    } else {
      cached = null;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(
        `[archetype-history-stats] failed to read ${p} (${code ?? (err as Error)?.message ?? "unknown"}); ignoring persisted compaction stats`,
      );
    }
    cached = null;
  }
  cachedFromPath = p;
  return cached;
}

/**
 * Persist a compaction-pass outcome and append it to the recent-runs
 * ring buffer. Failures are swallowed + warned so a stats-write hiccup
 * never blocks /api/test/run. Relies on appendArchetypeSnapshots'
 * writeChain to serialize concurrent callers.
 */
export async function recordCompactionRun(
  removedRows: number,
  timestamp: string = new Date().toISOString(),
): Promise<void> {
  const safeRemoved = Number.isFinite(removedRows) && removedRows >= 0
    ? Math.round(removedRows)
    : 0;
  const previous = readCompactionStats();
  const previousRuns = previous?.recentRuns ?? [];
  const newRun: CompactionRunRecord = { at: timestamp, removed: safeRemoved };
  const recentRuns = [...previousRuns, newRun].slice(-MAX_RECENT_RUNS);

  const next: CompactionStats = {
    lastCompactedAt: timestamp,
    lastRemovedCount: safeRemoved,
    recentRuns,
  };
  const p = statsPath();
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    const file: PersistedStats = {
      version: 1,
      lastCompactedAt: next.lastCompactedAt,
      lastRemovedCount: next.lastRemovedCount,
      recentRuns: next.recentRuns,
    };
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
    await fs.rename(tmp, p);
    cached = next;
    cachedFromPath = p;
  } catch (err) {
    console.warn(
      `[archetype-history-stats] failed to write ${p} (${(err as Error)?.message ?? "unknown"}); compaction stats will not be visible to the dashboard`,
    );
  }
}

export const __testing = {
  statsPath,
  MAX_RECENT_RUNS,
  resetCache: () => {
    cached = undefined;
    cachedFromPath = null;
  },
};
