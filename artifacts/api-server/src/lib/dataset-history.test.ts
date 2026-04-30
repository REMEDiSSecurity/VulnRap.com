// Task #187 — unit tests for the curated-dataset cohort means
// persistence helpers. Covers append + read round-trips and the
// MAX_SNAPSHOTS rollover so the file can't grow without bound.
//
// Task #264 — additionally covers the older-than-window compaction
// pass that down-samples per-run rows into one row per (UTC day, tier)
// so the file stays small over many months of runs.
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __testing,
  appendDatasetCohortSnapshots,
  compactSnapshots,
  readDatasetHistory,
  type DatasetCohortSnapshot,
} from "./dataset-history";

const DAY_MS = 24 * 60 * 60 * 1000;

let tmpDir: string;
let prevPath: string | undefined;
let prevDays: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dataset-history-"));
  prevPath = process.env.DATASET_HISTORY_PATH;
  prevDays = process.env.DATASET_HISTORY_COMPACT_DAYS;
  process.env.DATASET_HISTORY_PATH = path.join(tmpDir, "dataset-history.json");
});

afterEach(async () => {
  if (prevPath === undefined) delete process.env.DATASET_HISTORY_PATH;
  else process.env.DATASET_HISTORY_PATH = prevPath;
  if (prevDays === undefined) delete process.env.DATASET_HISTORY_COMPACT_DAYS;
  else process.env.DATASET_HISTORY_COMPACT_DAYS = prevDays;
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
        { tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 72.4, gap: 18.2, sampleDateKey: "2026-04-22" },
        { tier: "T2_BORDERLINE", label: "borderline", count: 25, compositeMean: 58.1, gap: 18.2, sampleDateKey: "2026-04-22" },
        { tier: "T3_SLOP", label: "ai_slop", count: 25, compositeMean: 54.2, gap: 18.2, sampleDateKey: "2026-04-22" },
      ],
      ts1,
    );

    const ts2 = "2026-04-29T12:00:00.000Z";
    await appendDatasetCohortSnapshots(
      [
        { tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 70.0, gap: 14.5, sampleDateKey: "2026-04-29" },
        { tier: "T2_BORDERLINE", label: "borderline", count: 25, compositeMean: 56.0, gap: 14.5, sampleDateKey: "2026-04-29" },
        { tier: "T3_SLOP", label: "ai_slop", count: 25, compositeMean: 55.5, gap: 14.5, sampleDateKey: "2026-04-29" },
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
    // Task #358 — every persisted row carries the run's slice key so
    // the dashboard can mark daily-slice rotations on the trend.
    expect(t1.map(s => s.sampleDateKey)).toEqual(["2026-04-22", "2026-04-29"]);
    // The gap is repeated across cohort rows of the same run so the
    // dashboard never has to join rows to render it.
    for (const s of file.snapshots.filter(s => s.timestamp === ts2)) {
      expect(s.gap).toBe(14.5);
      expect(s.sampleDateKey).toBe("2026-04-29");
    }
    // Recent rows are not flagged as aggregated.
    for (const s of file.snapshots) {
      expect(s.aggregated).toBeUndefined();
    }
  });

  it("preserves rows that pre-date the sampleDateKey field by leaving the field undefined", async () => {
    // Older on-disk rows from before Task #358 won't have a
    // `sampleDateKey`. Appending a fresh row mustn't synthesise one for
    // them retroactively — the field must stay undefined so the
    // dashboard doesn't surface a fabricated slice annotation on a
    // historical point.
    const tsOld = "2026-04-15T12:00:00.000Z";
    await appendDatasetCohortSnapshots(
      [
        { tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 70, gap: 18 },
      ],
      tsOld,
    );
    const tsNew = "2026-04-22T12:00:00.000Z";
    await appendDatasetCohortSnapshots(
      [
        { tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 71, gap: 19, sampleDateKey: "2026-04-22" },
      ],
      tsNew,
    );

    const file = await readDatasetHistory();
    expect(file.snapshots.length).toBe(2);
    const oldRow = file.snapshots.find(s => s.timestamp === tsOld)!;
    const newRow = file.snapshots.find(s => s.timestamp === tsNew)!;
    expect(oldRow.sampleDateKey).toBeUndefined();
    expect(newRow.sampleDateKey).toBe("2026-04-22");
  });

  it("caps the persisted history at MAX_SNAPSHOTS rows", async () => {
    // Disable compaction for this test so the seeded "ancient" timestamps
    // don't get rolled into a single daily row before the cap kicks in —
    // we're specifically asserting MAX_SNAPSHOTS truncation here.
    process.env.DATASET_HISTORY_COMPACT_DAYS = String(365 * 100);
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

describe("compactSnapshots", () => {
  it("rolls older snapshots into one row per (UTC day, tier) and preserves recent rows", () => {
    const now = new Date("2026-04-22T12:00:00.000Z");
    const oldDay1 = new Date(now.getTime() - 60 * DAY_MS); // > 30d
    const oldDay2 = new Date(now.getTime() - 45 * DAY_MS);
    const recent = new Date(now.getTime() - 1 * DAY_MS);

    const oldDay1Iso = (h: number) =>
      new Date(Date.UTC(
        oldDay1.getUTCFullYear(), oldDay1.getUTCMonth(), oldDay1.getUTCDate(), h,
      )).toISOString();
    const oldDay2Iso = (h: number) =>
      new Date(Date.UTC(
        oldDay2.getUTCFullYear(), oldDay2.getUTCMonth(), oldDay2.getUTCDate(), h,
      )).toISOString();

    // Two runs on oldDay1 → 6 rows (3 cohorts × 2 runs).
    // One run on oldDay2 → 3 rows.
    // One recent run → 3 raw rows that must survive unchanged.
    const snaps: DatasetCohortSnapshot[] = [
      // oldDay1, run A (gap = 20)
      { timestamp: oldDay1Iso(2),  tier: "T1_LEGIT",     label: "human_authentic", count: 25, compositeMean: 70, gap: 20 },
      { timestamp: oldDay1Iso(2),  tier: "T2_BORDERLINE", label: "borderline",     count: 25, compositeMean: 58, gap: 20 },
      { timestamp: oldDay1Iso(2),  tier: "T3_SLOP",       label: "ai_slop",        count: 25, compositeMean: 50, gap: 20 },
      // oldDay1, run B (gap = 16)
      { timestamp: oldDay1Iso(20), tier: "T1_LEGIT",     label: "human_authentic", count: 25, compositeMean: 74, gap: 16 },
      { timestamp: oldDay1Iso(20), tier: "T2_BORDERLINE", label: "borderline",     count: 25, compositeMean: 60, gap: 16 },
      { timestamp: oldDay1Iso(20), tier: "T3_SLOP",       label: "ai_slop",        count: 25, compositeMean: 58, gap: 16 },
      // oldDay2, single run
      { timestamp: oldDay2Iso(8),  tier: "T1_LEGIT",     label: "human_authentic", count: 25, compositeMean: 71, gap: 17 },
      { timestamp: oldDay2Iso(8),  tier: "T2_BORDERLINE", label: "borderline",     count: 25, compositeMean: 59, gap: 17 },
      { timestamp: oldDay2Iso(8),  tier: "T3_SLOP",       label: "ai_slop",        count: 25, compositeMean: 54, gap: 17 },
      // Recent run
      { timestamp: recent.toISOString(), tier: "T1_LEGIT",     label: "human_authentic", count: 25, compositeMean: 73, gap: 19 },
      { timestamp: recent.toISOString(), tier: "T2_BORDERLINE", label: "borderline",     count: 25, compositeMean: 57, gap: 19 },
      { timestamp: recent.toISOString(), tier: "T3_SLOP",       label: "ai_slop",        count: 25, compositeMean: 54, gap: 19 },
    ];

    const out = compactSnapshots(snaps, now, 30);
    // 3 aggregated rows (1 per tier) for oldDay1 + 3 for oldDay2 + 3 raw recent = 9.
    expect(out.length).toBe(9);
    const agg = out.filter(s => s.aggregated === true);
    const raw = out.filter(s => s.aggregated !== true);
    expect(agg.length).toBe(6);
    expect(raw.length).toBe(3);

    // oldDay1, T1_LEGIT bucket: weighted mean (counts equal) of 70 and 74 = 72.
    const day1T1 = agg.find(s => s.tier === "T1_LEGIT" && s.timestamp.startsWith(oldDay1.toISOString().slice(0, 10)))!;
    expect(day1T1.timestamp.endsWith("T00:00:00.000Z")).toBe(true);
    expect(day1T1.label).toBe("human_authentic");
    expect(day1T1.compositeMean).toBeCloseTo(72, 5);
    // gap weighted mean (equal counts) of 20 and 16 = 18.
    expect(day1T1.gap).toBeCloseTo(18, 5);
    // count is summed across the two runs.
    expect(day1T1.count).toBe(50);

    // oldDay2 single-run bucket should preserve its values exactly.
    const day2T3 = agg.find(s => s.tier === "T3_SLOP" && s.timestamp.startsWith(oldDay2.toISOString().slice(0, 10)))!;
    expect(day2T3.compositeMean).toBeCloseTo(54, 5);
    expect(day2T3.gap).toBeCloseTo(17, 5);
    expect(day2T3.count).toBe(25);

    // Recent rows preserved unchanged with no aggregated flag.
    for (const r of raw) {
      expect(r.timestamp).toBe(recent.toISOString());
      expect(r.aggregated).toBeUndefined();
    }

    // Output is chronologically ordered (aggregated days first, then recent).
    const ts = out.map(s => Date.parse(s.timestamp));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("propagates null compositeMean and gap when no contributing row has a finite value", () => {
    const now = new Date("2026-04-22T12:00:00.000Z");
    const oldDay = new Date(now.getTime() - 60 * DAY_MS);
    const oldIso = (h: number) =>
      new Date(Date.UTC(
        oldDay.getUTCFullYear(), oldDay.getUTCMonth(), oldDay.getUTCDate(), h,
      )).toISOString();

    const snaps: DatasetCohortSnapshot[] = [
      { timestamp: oldIso(1), tier: "T1_LEGIT", label: "human_authentic", count: 0, compositeMean: null, gap: null },
      { timestamp: oldIso(5), tier: "T1_LEGIT", label: "human_authentic", count: 0, compositeMean: null, gap: null },
    ];
    const out = compactSnapshots(snaps, now, 30);
    expect(out.length).toBe(1);
    expect(out[0]!.compositeMean).toBeNull();
    expect(out[0]!.gap).toBeNull();
    expect(out[0]!.aggregated).toBe(true);
    expect(out[0]!.count).toBe(0);
  });

  it("is a no-op when no snapshots are older than the window", () => {
    const now = new Date("2026-04-22T12:00:00.000Z");
    const snaps: DatasetCohortSnapshot[] = [
      {
        timestamp: new Date(now.getTime() - 5 * DAY_MS).toISOString(),
        tier: "T1_LEGIT",
        label: "human_authentic",
        count: 25,
        compositeMean: 70,
        gap: 18,
      },
    ];
    const out = compactSnapshots(snaps, now, 30);
    expect(out).toEqual(snaps);
  });

  it("propagates the latest run's sampleDateKey onto rolled-up daily rows", () => {
    // Task #358 — when several runs in one UTC day get folded into a
    // single aggregated row, the slice key from the most recent run in
    // that bucket is what survives. That keeps the dashboard's
    // "rotation marker" honest: a daily aggregate represents the slice
    // that was active by end-of-day.
    const now = new Date("2026-04-22T12:00:00.000Z");
    const oldDay = new Date(now.getTime() - 60 * DAY_MS);
    const oldIso = (h: number) =>
      new Date(Date.UTC(
        oldDay.getUTCFullYear(), oldDay.getUTCMonth(), oldDay.getUTCDate(), h,
      )).toISOString();
    const oldDayKey = oldDay.toISOString().slice(0, 10);

    const snaps: DatasetCohortSnapshot[] = [
      // First run that day landed before the slice rotated to the same UTC day.
      { timestamp: oldIso(1), tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 70, gap: 18, sampleDateKey: "2026-02-20" },
      // Later runs that day saw the rotated slice.
      { timestamp: oldIso(10), tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 72, gap: 18, sampleDateKey: oldDayKey },
      { timestamp: oldIso(20), tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 74, gap: 18, sampleDateKey: oldDayKey },
    ];
    const out = compactSnapshots(snaps, now, 30);
    expect(out.length).toBe(1);
    expect(out[0]!.aggregated).toBe(true);
    expect(out[0]!.sampleDateKey).toBe(oldDayKey);
  });

  it("omits sampleDateKey from rolled-up rows when none of the contributing snapshots carried one", () => {
    // Pre-Task-#358 rows on disk won't have a slice key, so a bucket
    // made entirely of those legacy rows must produce an aggregate
    // without the field — synthesising a value would mislead the
    // dashboard into drawing a phantom rotation marker.
    const now = new Date("2026-04-22T12:00:00.000Z");
    const oldDay = new Date(now.getTime() - 60 * DAY_MS);
    const oldIso = (h: number) =>
      new Date(Date.UTC(
        oldDay.getUTCFullYear(), oldDay.getUTCMonth(), oldDay.getUTCDate(), h,
      )).toISOString();

    const snaps: DatasetCohortSnapshot[] = [
      { timestamp: oldIso(1), tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 70, gap: 18 },
      { timestamp: oldIso(5), tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 72, gap: 18 },
    ];
    const out = compactSnapshots(snaps, now, 30);
    expect(out.length).toBe(1);
    expect(out[0]!.aggregated).toBe(true);
    expect(out[0]!.sampleDateKey).toBeUndefined();
  });

  it("is idempotent — re-running compaction on already-aggregated rows preserves their numbers", () => {
    const now = new Date("2026-04-22T12:00:00.000Z");
    const snaps: DatasetCohortSnapshot[] = [
      {
        timestamp: "2026-01-10T00:00:00.000Z",
        tier: "T1_LEGIT",
        label: "human_authentic",
        count: 50,
        compositeMean: 72,
        gap: 18,
        aggregated: true,
      },
    ];
    const out = compactSnapshots(snaps, now, 30);
    expect(out.length).toBe(1);
    expect(out[0]!.compositeMean).toBeCloseTo(72, 5);
    expect(out[0]!.gap).toBeCloseTo(18, 5);
    expect(out[0]!.count).toBe(50);
    expect(out[0]!.aggregated).toBe(true);
  });
});

describe("appendDatasetCohortSnapshots — compaction integration", () => {
  it("compacts older entries on append while leaving fresh appends intact", async () => {
    process.env.DATASET_HISTORY_COMPACT_DAYS = "30";

    // Seed several days of multi-run history beyond the 30-day window.
    // Each "day" gets 4 runs × 3 cohorts = 12 rows. Pin every run to
    // early-UTC hours so they always land in the same UTC day bucket
    // regardless of when the test happens to execute.
    const now = Date.now();
    const todayUtcMidnight = Math.floor(now / DAY_MS) * DAY_MS;
    const seed: DatasetCohortSnapshot[] = [];
    const oldDays = 10;
    for (let day = 60; day > 60 - oldDays; day--) {
      const base = todayUtcMidnight - day * DAY_MS;
      for (let run = 0; run < 4; run++) {
        const ts = new Date(base + run * 60 * 60 * 1000).toISOString();
        seed.push(
          { timestamp: ts, tier: "T1_LEGIT",     label: "human_authentic", count: 25, compositeMean: 70 + run, gap: 18 },
          { timestamp: ts, tier: "T2_BORDERLINE", label: "borderline",     count: 25, compositeMean: 58 + run, gap: 18 },
          { timestamp: ts, tier: "T3_SLOP",       label: "ai_slop",        count: 25, compositeMean: 52 + run, gap: 18 },
        );
      }
    }
    await fs.writeFile(
      process.env.DATASET_HISTORY_PATH!,
      JSON.stringify({ version: 1, snapshots: seed }, null, 2),
      "utf-8",
    );

    // Fresh "today" append — triggers compaction.
    await appendDatasetCohortSnapshots([
      { tier: "T1_LEGIT",     label: "human_authentic", count: 25, compositeMean: 71, gap: 17 },
      { tier: "T2_BORDERLINE", label: "borderline",     count: 25, compositeMean: 59, gap: 17 },
      { tier: "T3_SLOP",       label: "ai_slop",        count: 25, compositeMean: 54, gap: 17 },
    ]);

    const file = await readDatasetHistory();
    const aggregated = file.snapshots.filter(s => s.aggregated === true);
    const raw = file.snapshots.filter(s => s.aggregated !== true);

    // 10 distinct old days × 3 tiers = 30 daily aggregates after compaction
    // (well below the original 10 × 4 × 3 = 120 raw rows).
    expect(aggregated.length).toBe(oldDays * 3);
    // The 3 fresh appends remain as raw rows.
    expect(raw.length).toBe(3);
    expect(file.snapshots.length).toBeLessThan(seed.length);

    // Each aggregated row carries summed counts (4 runs × 25) and the
    // weighted mean of compositeMean across the day's runs.
    for (const a of aggregated) {
      expect(a.count).toBe(100);
      // Equal counts → unweighted mean of run values 0..3 added to the tier base.
      const base = a.tier === "T1_LEGIT" ? 70 : a.tier === "T2_BORDERLINE" ? 58 : 52;
      expect(a.compositeMean).toBeCloseTo(base + 1.5, 5);
      expect(a.gap).toBeCloseTo(18, 5);
      expect(a.timestamp.endsWith("T00:00:00.000Z")).toBe(true);
    }

    // Aggregated rows come before the raw recent rows chronologically.
    const ts = file.snapshots.map(s => Date.parse(s.timestamp));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });
});

describe("compactAfterDays env override", () => {
  it("falls back to the built-in default when the env var is missing or invalid", () => {
    delete process.env.DATASET_HISTORY_COMPACT_DAYS;
    expect(__testing.compactAfterDays()).toBe(__testing.DEFAULT_COMPACT_AFTER_DAYS);
    process.env.DATASET_HISTORY_COMPACT_DAYS = "not-a-number";
    expect(__testing.compactAfterDays()).toBe(__testing.DEFAULT_COMPACT_AFTER_DAYS);
    process.env.DATASET_HISTORY_COMPACT_DAYS = "0";
    expect(__testing.compactAfterDays()).toBe(__testing.DEFAULT_COMPACT_AFTER_DAYS);
  });

  it("honors a positive override", () => {
    process.env.DATASET_HISTORY_COMPACT_DAYS = "14";
    expect(__testing.compactAfterDays()).toBe(14);
  });
});
