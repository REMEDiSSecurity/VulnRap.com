// Task #187 — persisted curated-dataset cohort means time series.
//
// Companion to archetype-history.ts. Each /api/test/run invocation that
// finds the curated dataset mounted appends one row per cohort
// (T1_LEGIT, T2_BORDERLINE, T3_SLOP) to a JSON file alongside the
// existing archetype history. The calibration UI reads this file via
// GET /api/test/dataset-history and renders the per-cohort composite
// mean over time so reviewers can see week-over-week drift on the
// 25-per-label real-report sample without having to diff individual
// runs.
//
// We deliberately mirror the archetype-history shape (small typed
// schema, single JSON file written via tmp + rename, MAX_SNAPSHOTS cap,
// serialized writes) rather than introducing a new persistence layer:
// it keeps the on-disk format easy to reason about and lets the
// dashboard reuse the same sparkline rendering pattern.
//
// Task #264 — to keep the trend window growing without ballooning the
// file, snapshots older than COMPACT_AFTER_DAYS are down-sampled to one
// row per (UTC day, tier) on every append. Aggregated rows carry
// `aggregated: true` so the dashboard can render them with a different
// stroke than the raw recent points. Without this pass the 2 000-row
// MAX_SNAPSHOTS cap would just truncate the oldest detail abruptly
// after several months of runs instead of preserving the long-tail
// trend at coarser resolution.
//
// Task #378 — the effective window now resolves through
// dataset-history-config.ts (env var > persisted JSON > built-in
// default) so reviewers can tune the trend-resolution / storage
// tradeoff from the calibration dashboard without a redeploy. The
// DATASET_HISTORY_COMPACT_DAYS env var still wins so deploy-time
// policy can pin the value when it needs to.
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DEFAULT_COMPACT_AFTER_DAYS as CONFIG_DEFAULT_COMPACT_AFTER_DAYS,
  getEffectiveCompactAfterDays,
} from "./dataset-history-config";
import { recordDatasetCompactionRun } from "./dataset-history-stats";

export interface DatasetCohortSnapshot {
  /** ISO-8601 timestamp of the test run that produced this snapshot. */
  timestamp: string;
  /** Tier label (T1_LEGIT, T2_BORDERLINE, T3_SLOP). */
  tier: string;
  /** Dataset label that produced this row (human_authentic, borderline, ai_slop). */
  label: string;
  /** Number of curated samples that contributed to this row. */
  count: number;
  /** Cohort composite mean (null when the cohort had no samples that run). */
  compositeMean: number | null;
  /**
   * Task #362 — synthetic-fixture composite mean for the same tier on
   * the same run. Persisted alongside `compositeMean` so the dashboard
   * can reconstruct the per-tier dataset-vs-fixture delta series
   * (datasetMean − fixtureMean) over time without having to join
   * back into the live /api/test/run summary. Null when the run
   * didn't produce a synthetic mean for this tier (older deploys may
   * also leave it `undefined` on rows persisted before this field
   * existed; consumers must treat both as "no fixture mean").
   */
  fixtureMean?: number | null;
  /**
   * T1−T3 composite mean gap for the run that produced this snapshot.
   * Repeated on every cohort row of that run so the dashboard can chart
   * the gap directly without joining rows. Null when either side is
   * missing for the run.
   */
  gap: number | null;
  /**
   * True when this row is a daily roll-up of multiple original
   * snapshots produced by the older-than-window compaction pass.
   * Absent (undefined) for raw per-run snapshots so the dashboard can
   * style aggregated rows differently (e.g. dashed stroke, or a
   * tooltip explaining "rolled up from N runs that day").
   */
  aggregated?: boolean;
  /**
   * Task #358 — UTC slice key (YYYY-MM-DD) of the curated cohort that
   * contributed to this snapshot. Mirrors the `sampleDateKey` returned
   * on the live `datasetSamples` block in /api/test/run so reviewers
   * looking at the persisted trend can tell which day's slice the
   * cohort means came from. The slice rotates daily, so two adjacent
   * snapshots whose mean jumps but whose `sampleDateKey` differs
   * indicate a slice rotation rather than real model drift.
   *
   * Optional because (a) the field was added after Task #187's initial
   * shape so older on-disk rows won't have it, and (b) the persistence
   * call is wrapped in try/catch so we'd rather record a snapshot
   * without the key than fail the smoke endpoint.
   */
  sampleDateKey?: string;
}

export interface DatasetHistoryFile {
  version: 1;
  snapshots: DatasetCohortSnapshot[];
}

const MAX_SNAPSHOTS = 2_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Re-exported under the local name so the existing __testing surface
// (and any external consumers that compare against it) keep working
// even though the resolution itself moved into dataset-history-config.
const DEFAULT_COMPACT_AFTER_DAYS = CONFIG_DEFAULT_COMPACT_AFTER_DAYS;
const DEFAULT_PATH = path.resolve(
  process.cwd(),
  "artifacts/api-server/data/dataset-history.json",
);

function historyPath(): string {
  return process.env.DATASET_HISTORY_PATH ?? DEFAULT_PATH;
}

// Task #378 — kept as a thin pass-through so the existing __testing
// surface continues to work and any in-tree caller that imported the
// helper directly still gets the effective value (env > persisted >
// default) instead of the bare env-var read.
function compactAfterDays(): number {
  return getEffectiveCompactAfterDays();
}

async function readFromDisk(p: string): Promise<DatasetHistoryFile> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DatasetHistoryFile>;
    if (parsed && Array.isArray(parsed.snapshots)) {
      return {
        version: 1,
        snapshots: parsed.snapshots as DatasetCohortSnapshot[],
      };
    }
    return { version: 1, snapshots: [] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { version: 1, snapshots: [] };
    // Corrupt JSON or unreadable file — start fresh rather than crash the
    // dev-only endpoint, but warn loudly so a silent reset is debuggable.
    console.warn(
      `[dataset-history] failed to read ${p} (${code ?? (err as Error)?.message ?? "unknown"}); starting from empty history`,
    );
    return { version: 1, snapshots: [] };
  }
}

async function writeToDisk(p: string, file: DatasetHistoryFile): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf-8");
  await fs.rename(tmp, p);
}

/** UTC day key (YYYY-MM-DD) for an ISO timestamp. */
function dayKey(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso.slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Weighted mean of a numeric field across `bucket`, weighted by sample
 * `count` (clamped to ≥1 so a count-of-zero row still contributes).
 * Returns null when no row has a finite value for the field, so a
 * cohort with no samples that day stays explicitly null in the rolled
 * up row instead of silently turning into 0. Two decimals match the
 * archetype-history rounding so the on-disk file stays readable.
 */
function weightedMean(
  bucket: DatasetCohortSnapshot[],
  pick: (s: DatasetCohortSnapshot) => number | null,
): number | null {
  let totalWeight = 0;
  let weightedSum = 0;
  for (const s of bucket) {
    const v = pick(s);
    if (v == null || !Number.isFinite(v)) continue;
    const w = Math.max(1, s.count);
    weightedSum += v * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return null;
  return Number((weightedSum / totalWeight).toFixed(2));
}

/**
 * Roll up snapshots older than `now - windowDays` into one row per
 * (UTC day, tier). Recent snapshots are preserved unchanged. The pass
 * is idempotent: a previously-aggregated row simply lands in a bucket
 * of size 1 and is re-emitted with the same numbers. Tier (not label)
 * is the bucketing key because the dashboard charts one series per
 * tier; the tier→label mapping is stable, so we copy the bucket's
 * label through unchanged.
 */
export function compactSnapshots(
  snaps: DatasetCohortSnapshot[],
  now: Date,
  windowDays: number,
): DatasetCohortSnapshot[] {
  const cutoff = now.getTime() - windowDays * DAY_MS;
  const old: DatasetCohortSnapshot[] = [];
  const recent: DatasetCohortSnapshot[] = [];
  for (const s of snaps) {
    const t = Date.parse(s.timestamp);
    if (Number.isFinite(t) && t < cutoff) old.push(s);
    else recent.push(s);
  }
  if (old.length === 0) return snaps;

  // Bucket by day, then by tier, to avoid relying on a separator
  // character that could collide with tier names.
  const byDay = new Map<string, Map<string, DatasetCohortSnapshot[]>>();
  for (const s of old) {
    const day = dayKey(s.timestamp);
    let perTier = byDay.get(day);
    if (!perTier) {
      perTier = new Map();
      byDay.set(day, perTier);
    }
    let bucket = perTier.get(s.tier);
    if (!bucket) {
      bucket = [];
      perTier.set(s.tier, bucket);
    }
    bucket.push(s);
  }

  const aggregated: DatasetCohortSnapshot[] = [];
  for (const [day, perTier] of byDay) {
    for (const [tier, bucket] of perTier) {
      // Task #358 — propagate the slice key onto the rolled-up row so
      // the dashboard can still annotate the day-bucket on the trend.
      // Pick the latest run's key in the bucket (which corresponds to
      // the most recent observation for that UTC day); rows without a
      // key are skipped so a single run with the field set still wins
      // over older history that pre-dates the field.
      const sortedByTime = bucket
        .slice()
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      let sampleDateKey: string | undefined;
      for (let i = sortedByTime.length - 1; i >= 0; i--) {
        const k = sortedByTime[i]!.sampleDateKey;
        if (typeof k === "string" && k.length > 0) {
          sampleDateKey = k;
          break;
        }
      }
      aggregated.push({
        timestamp: `${day}T00:00:00.000Z`,
        tier,
        // Tier→label is stable across runs, so copy through.
        label: bucket[0]!.label,
        // Sum of contributing fixture-counts so the UI can show "N
        // samples rolled into this day" if it wants to. For a single
        // per-run snapshot this stays equal to the original count.
        count: bucket.reduce((a, b) => a + b.count, 0),
        compositeMean: weightedMean(bucket, (b) => b.compositeMean),
        // Task #362 — fold the per-tier synthetic-fixture mean across
        // the day's runs the same way as compositeMean so the dashboard
        // can reconstruct (datasetMean − fixtureMean) on aggregated
        // rows. Buckets containing only legacy rows that lack a
        // fixtureMean produce a null aggregated value (treated as "no
        // delta point" by the consumer).
        fixtureMean: weightedMean(bucket, (b) => b.fixtureMean ?? null),
        // The gap is repeated across cohort rows of the same run, so
        // averaging it weighted by count gives a representative
        // run-day value while still folding multi-run days correctly.
        gap: weightedMean(bucket, (b) => b.gap),
        aggregated: true,
        ...(sampleDateKey !== undefined ? { sampleDateKey } : {}),
      });
    }
  }

  aggregated.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.tier.localeCompare(b.tier);
  });

  return [...aggregated, ...recent];
}

let writeChain: Promise<unknown> = Promise.resolve();

export function appendDatasetCohortSnapshots(
  rows: Omit<DatasetCohortSnapshot, "timestamp">[],
  timestamp: string = new Date().toISOString(),
): Promise<DatasetHistoryFile> {
  const next = writeChain.then(async () => {
    const p = historyPath();
    const file = await readFromDisk(p);
    for (const row of rows) {
      file.snapshots.push({ timestamp, ...row });
    }
    // Down-sample older entries before applying the hard MAX_SNAPSHOTS
    // cap so we trim raw points (not freshly-aggregated daily rows).
    // Task #379 — record how many rows the compaction pass collapsed so
    // the dataset trend panel can confirm the routine is alive and
    // surface its effect ("Last compacted 2h ago — removed 14
    // snapshots"), mirroring the archetype-history Task #211 pattern.
    // We only count compaction-driven removal here, not the hard
    // MAX_SNAPSHOTS truncation below — those are conceptually separate
    // (eviction vs. roll-up) and reviewers care about the latter. A
    // 0-row pass is still recorded so reviewers can see the routine
    // ran on a quiet runner instead of assuming it stopped.
    const beforeCompact = file.snapshots.length;
    file.snapshots = compactSnapshots(
      file.snapshots,
      new Date(),
      compactAfterDays(),
    );
    const removedByCompaction = beforeCompact - file.snapshots.length;
    if (file.snapshots.length > MAX_SNAPSHOTS) {
      file.snapshots.splice(0, file.snapshots.length - MAX_SNAPSHOTS);
    }
    await writeToDisk(p, file);
    // Stats write is best-effort: recordDatasetCompactionRun swallows +
    // warns on failure so a stats-file hiccup never breaks /api/test/run.
    // We still await it so the next dashboard GET sees the fresh value
    // rather than the cached stale one from before this append.
    await recordDatasetCompactionRun(removedByCompaction);
    return file;
  });
  // Keep the chain alive even if a write rejects so subsequent appends still run.
  writeChain = next.catch(() => undefined);
  return next;
}

export async function readDatasetHistory(): Promise<DatasetHistoryFile> {
  return readFromDisk(historyPath());
}

export const __testing = {
  MAX_SNAPSHOTS,
  DEFAULT_COMPACT_AFTER_DAYS,
  historyPath,
  compactAfterDays,
};

export { DEFAULT_COMPACT_AFTER_DAYS };
