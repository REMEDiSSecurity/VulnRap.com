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
}

export interface ArchetypeHistoryFile {
  version: 1;
  snapshots: ArchetypeSnapshot[];
}

const MAX_SNAPSHOTS = 2_000;
const DEFAULT_PATH = path.resolve(
  process.cwd(),
  "artifacts/api-server/data/archetype-history.json",
);

function historyPath(): string {
  return process.env.ARCHETYPE_HISTORY_PATH ?? DEFAULT_PATH;
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
  historyPath,
};
