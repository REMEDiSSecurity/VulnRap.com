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
import { promises as fs } from "node:fs";
import path from "node:path";

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
   * T1−T3 composite mean gap for the run that produced this snapshot.
   * Repeated on every cohort row of that run so the dashboard can chart
   * the gap directly without joining rows. Null when either side is
   * missing for the run.
   */
  gap: number | null;
}

export interface DatasetHistoryFile {
  version: 1;
  snapshots: DatasetCohortSnapshot[];
}

const MAX_SNAPSHOTS = 2_000;
const DEFAULT_PATH = path.resolve(
  process.cwd(),
  "artifacts/api-server/data/dataset-history.json",
);

function historyPath(): string {
  return process.env.DATASET_HISTORY_PATH ?? DEFAULT_PATH;
}

async function readFromDisk(p: string): Promise<DatasetHistoryFile> {
  try {
    const raw = await fs.readFile(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<DatasetHistoryFile>;
    if (parsed && Array.isArray(parsed.snapshots)) {
      return { version: 1, snapshots: parsed.snapshots as DatasetCohortSnapshot[] };
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

export async function readDatasetHistory(): Promise<DatasetHistoryFile> {
  return readFromDisk(historyPath());
}

export const __testing = {
  MAX_SNAPSHOTS,
  historyPath,
};
