// Sprint 13 — persisted per-archetype headroom time series.
//
// Each /api/test/run invocation appends one snapshot per archetype to a
// JSON-lines-shaped JSON file (default
// artifacts/api-server/data/archetype-history.json, override via
// ARCHETYPE_HISTORY_PATH for tests). The calibration UI reads the file
// via GET /api/test/archetype-history and draws a sparkline of
// minDistanceToCeiling per archetype so reviewers can see when rubric
// tuning is shrinking the gap to LIKELY-INVALID over time.
//
// We keep the schema deliberately small (timestamp + the three numbers
// the panel charts) and cap the file at MAX_SNAPSHOTS rows so the file
// stays small enough to ship to disk on every test run without coordination.
// Writes are serialized through a module-level promise chain so two
// concurrent /api/test/run calls cannot interleave and lose entries.
//
// Task #92 — to keep the trend window growing without ballooning the
// file, snapshots older than COMPACT_AFTER_DAYS (default 30) are
// down-sampled to one row per (UTC day, archetype) on every append.
// Aggregated rows carry `aggregated: true` so the dashboard can render
// them with a different stroke than the raw recent points.
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ArchetypeSnapshot {
  /** ISO-8601 timestamp of the test run that produced this snapshot. */
  timestamp: string;
  archetype: string;
  count: number;
  avriOnMean: number;
  avriOnMax: number;
  /** Composite-points headroom under AVRI-on (ceiling minus avriOnMax). */
  minDistanceToCeiling: number;
  ceiling: number;
  /**
   * True when this row is a daily roll-up of multiple original snapshots
   * produced by the older-than-window compaction pass. Absent (undefined)
   * for raw per-run snapshots.
   */
  aggregated?: boolean;
}

export interface ArchetypeHistoryFile {
  version: 1;
  snapshots: ArchetypeSnapshot[];
}

const MAX_SNAPSHOTS = 2_000;
const DEFAULT_COMPACT_AFTER_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PATH = path.resolve(
  process.cwd(),
  "artifacts/api-server/data/archetype-history.json",
);

function historyPath(): string {
  return process.env.ARCHETYPE_HISTORY_PATH ?? DEFAULT_PATH;
}

function compactAfterDays(): number {
  const raw = process.env.ARCHETYPE_HISTORY_COMPACT_DAYS;
  if (raw === undefined) return DEFAULT_COMPACT_AFTER_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_COMPACT_AFTER_DAYS;
}

async function readFromDisk(p: string): Promise<ArchetypeHistoryFile> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ArchetypeHistoryFile>;
    if (parsed && Array.isArray(parsed.snapshots)) {
      return { version: 1, snapshots: parsed.snapshots as ArchetypeSnapshot[] };
    }
    return { version: 1, snapshots: [] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return { version: 1, snapshots: [] };
    // Corrupt JSON or unreadable file — start fresh rather than crash the
    // dev-only endpoint, but warn loudly so a silent reset is debuggable.
    console.warn(
      `[archetype-history] failed to read ${p} (${code ?? (err as Error)?.message ?? "unknown"}); starting from empty history`,
    );
    return { version: 1, snapshots: [] };
  }
}

async function writeToDisk(p: string, file: ArchetypeHistoryFile): Promise<void> {
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
 * Roll up snapshots older than `now - windowDays` into one row per
 * (UTC day, archetype). Recent snapshots are preserved unchanged. The
 * pass is idempotent: a previously-aggregated row simply lands in a
 * bucket of size 1 and is re-emitted with the same numbers.
 */
export function compactSnapshots(
  snaps: ArchetypeSnapshot[],
  now: Date,
  windowDays: number,
): ArchetypeSnapshot[] {
  const cutoff = now.getTime() - windowDays * DAY_MS;
  const old: ArchetypeSnapshot[] = [];
  const recent: ArchetypeSnapshot[] = [];
  for (const s of snaps) {
    const t = Date.parse(s.timestamp);
    if (Number.isFinite(t) && t < cutoff) old.push(s);
    else recent.push(s);
  }
  if (old.length === 0) return snaps;

  // Bucket by day, then by archetype, to avoid relying on a separator
  // character that could collide with archetype names.
  const byDay = new Map<string, Map<string, ArchetypeSnapshot[]>>();
  for (const s of old) {
    const day = dayKey(s.timestamp);
    let perArch = byDay.get(day);
    if (!perArch) {
      perArch = new Map();
      byDay.set(day, perArch);
    }
    let bucket = perArch.get(s.archetype);
    if (!bucket) {
      bucket = [];
      perArch.set(s.archetype, bucket);
    }
    bucket.push(s);
  }

  const aggregated: ArchetypeSnapshot[] = [];
  for (const [day, perArch] of byDay) {
    for (const [archetype, bucket] of perArch) {
      // Weight the mean by the original sample count so re-aggregating an
      // already-rolled-up row preserves its representativeness.
      const weights = bucket.map(b => Math.max(1, b.count));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      const weightedMean =
        bucket.reduce((acc, b, i) => acc + b.avriOnMean * weights[i]!, 0) / totalWeight;
      const maxOn = Math.max(...bucket.map(b => b.avriOnMax));
      const ceiling = bucket[0]!.ceiling;
      aggregated.push({
        timestamp: `${day}T00:00:00.000Z`,
        archetype,
        // Sum of contributing fixture-counts, so the UI can show "N samples
        // rolled into this day" if it wants to. For a single per-run
        // snapshot this stays equal to the original count.
        count: bucket.reduce((a, b) => a + b.count, 0),
        avriOnMean: Number(weightedMean.toFixed(2)),
        avriOnMax: Number(maxOn.toFixed(2)),
        minDistanceToCeiling: Number((ceiling - maxOn).toFixed(2)),
        ceiling,
        aggregated: true,
      });
    }
  }

  aggregated.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
    return a.archetype.localeCompare(b.archetype);
  });

  return [...aggregated, ...recent];
}

let writeChain: Promise<unknown> = Promise.resolve();

export function appendArchetypeSnapshots(
  rows: Omit<ArchetypeSnapshot, "timestamp">[],
  timestamp: string = new Date().toISOString(),
): Promise<ArchetypeHistoryFile> {
  const next = writeChain.then(async () => {
    const p = historyPath();
    const file = await readFromDisk(p);
    for (const row of rows) {
      file.snapshots.push({ timestamp, ...row });
    }
    // Down-sample older entries before applying the hard MAX_SNAPSHOTS
    // cap so we trim raw points (not freshly-aggregated daily rows).
    file.snapshots = compactSnapshots(file.snapshots, new Date(), compactAfterDays());
    if (file.snapshots.length > MAX_SNAPSHOTS) {
      file.snapshots.splice(0, file.snapshots.length - MAX_SNAPSHOTS);
    }
    await writeToDisk(p, file);
    return file;
  });
  // Keep the chain alive even if a write rejects so subsequent appends still run.
  writeChain = next.catch(() => undefined);
  return next;
}

export async function readArchetypeHistory(): Promise<ArchetypeHistoryFile> {
  return readFromDisk(historyPath());
}

export const __testing = {
  MAX_SNAPSHOTS,
  DEFAULT_COMPACT_AFTER_DAYS,
  historyPath,
  compactAfterDays,
};
