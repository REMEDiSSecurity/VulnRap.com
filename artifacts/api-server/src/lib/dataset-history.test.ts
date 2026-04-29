// Task #187 — unit tests for the curated-dataset cohort means
// persistence helpers. Covers append + read round-trips and the
// MAX_SNAPSHOTS rollover so the file can't grow without bound.
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  appendDatasetCohortSnapshots,
  readDatasetHistory,
} from "./dataset-history";

let tmpDir: string;
let prevPath: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dataset-history-"));
  prevPath = process.env.DATASET_HISTORY_PATH;
  process.env.DATASET_HISTORY_PATH = path.join(tmpDir, "dataset-history.json");
});

afterEach(async () => {
  if (prevPath === undefined) delete process.env.DATASET_HISTORY_PATH;
  else process.env.DATASET_HISTORY_PATH = prevPath;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("appendDatasetCohortSnapshots", () => {
  it("returns an empty file when nothing has been written yet", async () => {
    const file = await readDatasetHistory();
    expect(file.snapshots).toEqual([]);
    expect(file.version).toBe(1);
  });

  it("appends one row per cohort with the supplied timestamp and persists across reads", async () => {
    const ts1 = "2026-04-22T12:00:00.000Z";
    await appendDatasetCohortSnapshots(
      [
        { tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 72.4, gap: 18.2 },
        { tier: "T2_BORDERLINE", label: "borderline", count: 25, compositeMean: 58.1, gap: 18.2 },
        { tier: "T3_SLOP", label: "ai_slop", count: 25, compositeMean: 54.2, gap: 18.2 },
      ],
      ts1,
    );

    const ts2 = "2026-04-29T12:00:00.000Z";
    await appendDatasetCohortSnapshots(
      [
        { tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 70.0, gap: 14.5 },
        { tier: "T2_BORDERLINE", label: "borderline", count: 25, compositeMean: 56.0, gap: 14.5 },
        { tier: "T3_SLOP", label: "ai_slop", count: 25, compositeMean: 55.5, gap: 14.5 },
      ],
      ts2,
    );

    const file = await readDatasetHistory();
    expect(file.snapshots.length).toBe(6);
    // Each row carries the run's timestamp, so the dashboard can chart
    // either the per-cohort mean or the gap directly.
    const t1 = file.snapshots.filter(s => s.tier === "T1_LEGIT");
    expect(t1.map(s => s.timestamp)).toEqual([ts1, ts2]);
    expect(t1.map(s => s.compositeMean)).toEqual([72.4, 70.0]);
    // The gap is repeated across cohort rows of the same run so the
    // dashboard never has to join rows to render it.
    for (const s of file.snapshots.filter(s => s.timestamp === ts2)) {
      expect(s.gap).toBe(14.5);
    }
  });

  it("caps the persisted history at MAX_SNAPSHOTS rows", async () => {
    const cap = __testing.MAX_SNAPSHOTS;
    // Seed slightly over the cap with synthetic single-cohort rows so we
    // can verify the oldest entries are dropped on the next append.
    const seed = Array.from({ length: cap + 5 }, (_, i) => ({
      timestamp: new Date(2026, 0, 1, 0, i).toISOString(),
      tier: "T1_LEGIT",
      label: "human_authentic",
      count: 25,
      compositeMean: 70 + (i % 5),
      gap: 18,
    }));
    await fs.writeFile(
      process.env.DATASET_HISTORY_PATH!,
      JSON.stringify({ version: 1, snapshots: seed }, null, 2),
      "utf-8",
    );

    await appendDatasetCohortSnapshots(
      [{ tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 99, gap: 20 }],
      "2099-01-01T00:00:00.000Z",
    );

    const file = await readDatasetHistory();
    expect(file.snapshots.length).toBe(cap);
    // The freshest append must be retained; the very oldest seed rows are dropped.
    expect(file.snapshots.at(-1)!.compositeMean).toBe(99);
  });
});
