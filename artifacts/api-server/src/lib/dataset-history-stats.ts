// Task #379 — persisted stats about the dataset-history compaction pass:
// the last-run timestamp + rows removed. Mirrors the archetype-history
// stats file (Task #211) so the calibration dashboard can surface
// "Last compacted Xh ago — removed N snapshots" on the curated-dataset
// trend panel as proof the older-than-window roll-up routine added in
// Task #264 is alive — even when a pass had nothing old enough to
// roll up, we still record a 0-row outcome.
//
// Stats live in a sibling file (not the dataset-history JSON itself) so
// the high-frequency snapshot writer can't race the stats writer and
// vice versa, matching the pattern archetype-history-stats uses.
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";

export interface DatasetCompactionStats {
  /** ISO-8601 timestamp of the most recent dataset-history compaction pass. */
  lastCompactedAt: string;
  /**
   * Number of dataset-history rows the most recent pass collapsed (raw
   * rows before minus rows after compaction). Zero when the pass ran but
   * had nothing to roll up — still useful to surface so reviewers can see
   * the routine is alive on a quiet runner.
   */
  lastRemovedCount: number;
}

interface PersistedStats {
  version: 1;
  lastCompactedAt: string;
  lastRemovedCount: number;
}

const DEFAULT_STATS_PATH = path.resolve(
  process.cwd(),
  "artifacts/api-server/data/dataset-history-stats.json",
);

function statsPath(): string {
  return process.env.DATASET_HISTORY_STATS_PATH ?? DEFAULT_STATS_PATH;
}

// Cached so the GET /api/test/dataset-history handler (called on every
// dashboard refresh) doesn't pay a synchronous disk read. Keyed by
// resolved path so a test that overrides the env var cannot read another
// test's value. `undefined` means "unloaded"; `null` means "loaded, no
// stats yet" (the routine has not run on this deployment).
let cached: DatasetCompactionStats | null | undefined;
let cachedFromPath: string | null = null;

function isValidStats(parsed: unknown): parsed is PersistedStats {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Partial<PersistedStats>;
  if (typeof p.lastCompactedAt !== "string") return false;
  if (!Number.isFinite(Date.parse(p.lastCompactedAt))) return false;
  if (typeof p.lastRemovedCount !== "number") return false;
  if (!Number.isFinite(p.lastRemovedCount) || p.lastRemovedCount < 0) return false;
  return true;
}

export function readDatasetCompactionStats(): DatasetCompactionStats | null {
  const p = statsPath();
  if (cached !== undefined && cachedFromPath === p) return cached;
  try {
    const raw = fsSync.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (isValidStats(parsed)) {
      cached = {
        lastCompactedAt: parsed.lastCompactedAt,
        lastRemovedCount: Math.round(parsed.lastRemovedCount),
      };
    } else {
      cached = null;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(
        `[dataset-history-stats] failed to read ${p} (${code ?? (err as Error)?.message ?? "unknown"}); ignoring persisted compaction stats`,
      );
    }
    cached = null;
  }
  cachedFromPath = p;
  return cached;
}

/**
 * Persist a dataset-history compaction-pass outcome. Failures are
 * swallowed + warned so a stats-write hiccup never blocks /api/test/run
 * — `appendDatasetCohortSnapshots` already wraps its persistence call
 * in try/catch for the same reason. Relies on the caller's writeChain
 * to serialize concurrent passes.
 */
export async function recordDatasetCompactionRun(
  removedRows: number,
  timestamp: string = new Date().toISOString(),
): Promise<void> {
  const safeRemoved = Number.isFinite(removedRows) && removedRows >= 0
    ? Math.round(removedRows)
    : 0;
  const next: DatasetCompactionStats = {
    lastCompactedAt: timestamp,
    lastRemovedCount: safeRemoved,
  };
  const p = statsPath();
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    const file: PersistedStats = {
      version: 1,
      lastCompactedAt: next.lastCompactedAt,
      lastRemovedCount: next.lastRemovedCount,
    };
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
    await fs.rename(tmp, p);
    cached = next;
    cachedFromPath = p;
  } catch (err) {
    console.warn(
      `[dataset-history-stats] failed to write ${p} (${(err as Error)?.message ?? "unknown"}); compaction stats will not be visible to the dashboard`,
    );
  }
}

export const __testing = {
  statsPath,
  resetCache: () => {
    cached = undefined;
    cachedFromPath = null;
  },
};
