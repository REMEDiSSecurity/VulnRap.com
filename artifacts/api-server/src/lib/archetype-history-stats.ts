// Task #211 — persisted stats about the most recent archetype-history
// compaction pass.
//
// The compaction routine in archetype-history.ts rolls older raw
// snapshots into one row per (UTC day, archetype) on every
// /api/test/run. Reviewers can already tune the window (Task #99) but
// previously had no way to confirm the routine was actually running or
// what it was doing. This module records "last run at" + "rows removed
// on that run" alongside the persisted config JSON so the calibration
// dashboard can render something like
//   "Last compacted 2h ago — removed 14 snapshots"
// next to the window control.
//
// The stats live in a sibling file (not inside the config JSON itself)
// so the high-frequency compaction writer cannot race the low-frequency
// reviewer-driven config writer. Both files share the same data dir
// and override env var pattern as the rest of the archetype-history
// surface.
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";

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
}

interface PersistedStats {
  version: 1;
  lastCompactedAt: string;
  lastRemovedCount: number;
}

const DEFAULT_STATS_PATH = path.resolve(
  process.cwd(),
  "artifacts/api-server/data/archetype-history-stats.json",
);

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

function isValidStats(parsed: unknown): parsed is PersistedStats {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Partial<PersistedStats>;
  if (typeof p.lastCompactedAt !== "string") return false;
  if (!Number.isFinite(Date.parse(p.lastCompactedAt))) return false;
  if (typeof p.lastRemovedCount !== "number") return false;
  if (!Number.isFinite(p.lastRemovedCount) || p.lastRemovedCount < 0) return false;
  return true;
}

export function readCompactionStats(): CompactionStats | null {
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
        `[archetype-history-stats] failed to read ${p} (${code ?? (err as Error)?.message ?? "unknown"}); ignoring persisted compaction stats`,
      );
    }
    cached = null;
  }
  cachedFromPath = p;
  return cached;
}

/**
 * Persist the most recent compaction pass's outcome. Called from
 * appendArchetypeSnapshots after the rolled-up snapshot file has been
 * written, so a stats record only ever exists for compaction work that
 * actually landed on disk. Failures are swallowed (and warned) so a
 * stats-write hiccup never blocks a /api/test/run.
 */
export async function recordCompactionRun(
  removedRows: number,
  timestamp: string = new Date().toISOString(),
): Promise<void> {
  const safeRemoved = Number.isFinite(removedRows) && removedRows >= 0
    ? Math.round(removedRows)
    : 0;
  const next: CompactionStats = {
    lastCompactedAt: timestamp,
    lastRemovedCount: safeRemoved,
  };
  const p = statsPath();
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    const file: PersistedStats = { version: 1, ...next };
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
  resetCache: () => {
    cached = undefined;
    cachedFromPath = null;
  },
};
