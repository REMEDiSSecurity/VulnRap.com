// Task #92 — unit tests for the older-snapshot compaction pass.
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendArchetypeSnapshots,
  compactSnapshots,
  readArchetypeHistory,
  readArchetypeHistoryFileStats,
  type ArchetypeSnapshot,
} from "./archetype-history";
import {
  __testing as statsTesting,
  readCompactionStats,
} from "./archetype-history-stats";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("compactSnapshots", () => {
  it("rolls older snapshots into one row per (UTC day, archetype) and preserves recent rows", () => {
    const now = new Date("2026-04-22T12:00:00.000Z");
    // Three snapshots on the same old UTC day for archetype A,
    // two on a different old day for archetype B,
    // and two recent rows that must be preserved verbatim.
    const oldDay1 = new Date(now.getTime() - 60 * DAY_MS); // > 30d
    const oldDay2 = new Date(now.getTime() - 45 * DAY_MS);
    const recent = new Date(now.getTime() - 1 * DAY_MS);

    const oldDay1Iso = (h: number) =>
      new Date(
        Date.UTC(
          oldDay1.getUTCFullYear(),
          oldDay1.getUTCMonth(),
          oldDay1.getUTCDate(),
          h,
        ),
      ).toISOString();
    const oldDay2Iso = (h: number) =>
      new Date(
        Date.UTC(
          oldDay2.getUTCFullYear(),
          oldDay2.getUTCMonth(),
          oldDay2.getUTCDate(),
          h,
        ),
      ).toISOString();

    const snaps: ArchetypeSnapshot[] = [
      {
        timestamp: oldDay1Iso(2),
        archetype: "A",
        count: 2,
        avriOnMean: 10,
        avriOnMax: 12,
        minDistanceToCeiling: 23,
        ceiling: 35,
      },
      {
        timestamp: oldDay1Iso(8),
        archetype: "A",
        count: 2,
        avriOnMean: 14,
        avriOnMax: 18,
        minDistanceToCeiling: 17,
        ceiling: 35,
      },
      {
        timestamp: oldDay1Iso(20),
        archetype: "A",
        count: 2,
        avriOnMean: 12,
        avriOnMax: 15,
        minDistanceToCeiling: 20,
        ceiling: 35,
      },
      {
        timestamp: oldDay2Iso(3),
        archetype: "B",
        count: 1,
        avriOnMean: 8,
        avriOnMax: 9,
        minDistanceToCeiling: 26,
        ceiling: 35,
      },
      {
        timestamp: oldDay2Iso(15),
        archetype: "B",
        count: 1,
        avriOnMean: 16,
        avriOnMax: 22,
        minDistanceToCeiling: 13,
        ceiling: 35,
      },
      {
        timestamp: recent.toISOString(),
        archetype: "A",
        count: 2,
        avriOnMean: 11,
        avriOnMax: 14,
        minDistanceToCeiling: 21,
        ceiling: 35,
      },
      {
        timestamp: recent.toISOString(),
        archetype: "B",
        count: 1,
        avriOnMean: 9,
        avriOnMax: 10,
        minDistanceToCeiling: 25,
        ceiling: 35,
      },
    ];

    const out = compactSnapshots(snaps, now, 30);
    // 2 aggregated daily rows (A on day1, B on day2) + 2 recent raw rows.
    expect(out.length).toBe(4);
    const agg = out.filter((s) => s.aggregated === true);
    const raw = out.filter((s) => s.aggregated !== true);
    expect(agg.length).toBe(2);
    expect(raw.length).toBe(2);

    const aggA = agg.find((s) => s.archetype === "A")!;
    expect(aggA.timestamp.endsWith("T00:00:00.000Z")).toBe(true);
    expect(aggA.avriOnMax).toBeCloseTo(18, 5);
    // Weighted mean by count (all 2): (10+14+12)/3 = 12.0
    expect(aggA.avriOnMean).toBeCloseTo(12, 5);
    expect(aggA.minDistanceToCeiling).toBeCloseTo(35 - 18, 5);
    expect(aggA.count).toBe(6);

    const aggB = agg.find((s) => s.archetype === "B")!;
    expect(aggB.avriOnMax).toBeCloseTo(22, 5);
    expect(aggB.avriOnMean).toBeCloseTo(12, 5); // (8+16)/2
    expect(aggB.minDistanceToCeiling).toBeCloseTo(13, 5);

    // Recent rows preserved unchanged.
    for (const r of raw) {
      expect(r.timestamp).toBe(recent.toISOString());
    }

    // Output is chronologically ordered (aggregated days first, then recent).
    const ts = out.map((s) => Date.parse(s.timestamp));
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
  });

  it("is a no-op when no snapshots are older than the window", () => {
    const now = new Date("2026-04-22T12:00:00.000Z");
    const snaps: ArchetypeSnapshot[] = [
      {
        timestamp: new Date(now.getTime() - 5 * DAY_MS).toISOString(),
        archetype: "A",
        count: 1,
        avriOnMean: 5,
        avriOnMax: 5,
        minDistanceToCeiling: 30,
        ceiling: 35,
      },
    ];
    const out = compactSnapshots(snaps, now, 30);
    expect(out).toEqual(snaps);
  });

  it("is idempotent — re-running compaction on already-aggregated rows preserves their numbers", () => {
    const now = new Date("2026-04-22T12:00:00.000Z");
    const snaps: ArchetypeSnapshot[] = [
      {
        timestamp: "2026-01-10T00:00:00.000Z",
        archetype: "A",
        count: 4,
        avriOnMean: 10,
        avriOnMax: 18,
        minDistanceToCeiling: 17,
        ceiling: 35,
        aggregated: true,
      },
    ];
    const out = compactSnapshots(snaps, now, 30);
    expect(out.length).toBe(1);
    expect(out[0]!.avriOnMax).toBeCloseTo(18, 5);
    expect(out[0]!.avriOnMean).toBeCloseTo(10, 5);
    expect(out[0]!.aggregated).toBe(true);
  });
});

describe("appendArchetypeSnapshots — compaction integration", () => {
  let tmpDir: string;
  let prevPath: string | undefined;
  let prevDays: string | undefined;
  let prevStatsPath: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "archetype-history-compact-"),
    );
    prevPath = process.env.ARCHETYPE_HISTORY_PATH;
    prevDays = process.env.ARCHETYPE_HISTORY_COMPACT_DAYS;
    prevStatsPath = process.env.ARCHETYPE_HISTORY_STATS_PATH;
    process.env.ARCHETYPE_HISTORY_PATH = path.join(tmpDir, "history.json");
    process.env.ARCHETYPE_HISTORY_COMPACT_DAYS = "30";
    process.env.ARCHETYPE_HISTORY_STATS_PATH = path.join(tmpDir, "stats.json");
    statsTesting.resetCache();
  });

  afterEach(async () => {
    if (prevPath === undefined) delete process.env.ARCHETYPE_HISTORY_PATH;
    else process.env.ARCHETYPE_HISTORY_PATH = prevPath;
    if (prevDays === undefined)
      delete process.env.ARCHETYPE_HISTORY_COMPACT_DAYS;
    else process.env.ARCHETYPE_HISTORY_COMPACT_DAYS = prevDays;
    if (prevStatsPath === undefined)
      delete process.env.ARCHETYPE_HISTORY_STATS_PATH;
    else process.env.ARCHETYPE_HISTORY_STATS_PATH = prevStatsPath;
    statsTesting.resetCache();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("compacts older entries on append while leaving recent appends intact", async () => {
    // Seed the file with many synthetic old snapshots across several days.
    // Pin each day's runs to early-UTC hours (0..5) so all 6 always land
    // in the same UTC day bucket regardless of when the test happens to
    // run — otherwise the per-day-aggregate count flips between 21 and
    // 22 depending on wall-clock time of day.
    const now = Date.now();
    const todayUtcMidnight = Math.floor(now / DAY_MS) * DAY_MS;
    const seed: ArchetypeSnapshot[] = [];
    for (let day = 60; day >= 40; day--) {
      const base = todayUtcMidnight - day * DAY_MS;
      for (let run = 0; run < 6; run++) {
        seed.push({
          timestamp: new Date(base + run * 60 * 60 * 1000).toISOString(),
          archetype: "fabricated_diff",
          count: 3,
          avriOnMean: 10 + run,
          avriOnMax: 12 + run,
          minDistanceToCeiling: 35 - (12 + run),
          ceiling: 35,
        });
      }
    }
    await fs.writeFile(
      process.env.ARCHETYPE_HISTORY_PATH!,
      JSON.stringify({ version: 1, snapshots: seed }, null, 2),
      "utf-8",
    );

    // Append a fresh "today" snapshot — this triggers compaction.
    await appendArchetypeSnapshots([
      {
        archetype: "fabricated_diff",
        count: 3,
        avriOnMean: 8,
        avriOnMax: 10,
        minDistanceToCeiling: 25,
        ceiling: 35,
      },
    ]);

    const file = await readArchetypeHistory();
    const aggregated = file.snapshots.filter((s) => s.aggregated === true);
    const raw = file.snapshots.filter((s) => s.aggregated !== true);

    // 21 distinct old days were seeded → 21 daily aggregates after compaction
    // (well below the original 21*6 = 126 raw rows).
    expect(aggregated.length).toBe(21);
    // The single fresh append remains as a raw row.
    expect(raw.length).toBe(1);
    expect(raw[0]!.avriOnMax).toBe(10);

    // File must shrink dramatically vs. the seed.
    expect(file.snapshots.length).toBeLessThan(seed.length);

    // Each aggregated row's avriOnMax should equal the per-day max from the seed (12+5=17 for 6 runs/day).
    for (const a of aggregated) {
      expect(a.avriOnMax).toBeCloseTo(17, 5);
      expect(a.archetype).toBe("fabricated_diff");
    }

    // Task #211 — the compaction pass must record its run timestamp and
    // the number of rows it collapsed so the dashboard can confirm the
    // routine is actually doing work. 21 days * 6 raw rows seeded → 21
    // aggregates + 1 fresh row = 22 rows after, vs 126 + 1 = 127 before
    // → 105 rows removed by compaction.
    const stats = readCompactionStats();
    expect(stats).not.toBeNull();
    expect(stats!.lastRemovedCount).toBe(127 - 22);
    expect(Number.isFinite(Date.parse(stats!.lastCompactedAt))).toBe(true);
  });

  // Task #288 — readArchetypeHistoryFileStats lets the calibration
  // dashboard surface "History file: 124 KB · 487 snapshots" so reviewers
  // can size storage when picking a compaction window. Returns null when
  // the file does not exist yet (fresh deploy) and a positive sizeBytes +
  // snapshot count once the routine has appended.
  it("readArchetypeHistoryFileStats returns null before any append", async () => {
    const stats = await readArchetypeHistoryFileStats();
    expect(stats).toBeNull();
  });

  it("readArchetypeHistoryFileStats reports the on-disk size and snapshot count after appends", async () => {
    await appendArchetypeSnapshots([
      {
        archetype: "fabricated_diff",
        count: 1,
        avriOnMean: 5,
        avriOnMax: 6,
        minDistanceToCeiling: 29,
        ceiling: 35,
      },
      {
        archetype: "paraphrased_cve",
        count: 1,
        avriOnMean: 7,
        avriOnMax: 9,
        minDistanceToCeiling: 26,
        ceiling: 35,
      },
    ]);
    const stats = await readArchetypeHistoryFileStats();
    expect(stats).not.toBeNull();
    expect(stats!.snapshotCount).toBe(2);
    expect(stats!.sizeBytes).toBeGreaterThan(0);
    // Cross-check against the actual file on disk so we know we're
    // reporting the same number `du` would.
    const onDisk = await fs.stat(process.env.ARCHETYPE_HISTORY_PATH!);
    expect(stats!.sizeBytes).toBe(onDisk.size);
  });

  it("records a 0-row compaction pass when nothing is old enough to roll up", async () => {
    // Task #211 — even when the pass has nothing to do, the dashboard
    // benefits from seeing "Last compacted Xs ago — removed 0 snapshots"
    // (vs. silence) as proof the routine is alive.
    await appendArchetypeSnapshots([
      {
        archetype: "fabricated_diff",
        count: 1,
        avriOnMean: 5,
        avriOnMax: 6,
        minDistanceToCeiling: 29,
        ceiling: 35,
      },
    ]);
    const stats = readCompactionStats();
    expect(stats).not.toBeNull();
    expect(stats!.lastRemovedCount).toBe(0);
    expect(Number.isFinite(Date.parse(stats!.lastCompactedAt))).toBe(true);
    // Task #289 — ring buffer always has at least the most recent run.
    expect(stats!.recentRuns).toHaveLength(1);
    expect(stats!.recentRuns[0]!.removed).toBe(0);
    expect(stats!.recentRuns[0]!.at).toBe(stats!.lastCompactedAt);
  });

  // Task #289 — recent-runs ring buffer behavior.
  it("appends each successive compaction outcome to the recentRuns ring buffer", async () => {
    for (let i = 0; i < 3; i++) {
      await appendArchetypeSnapshots([
        {
          archetype: "fabricated_diff",
          count: 1,
          avriOnMean: 5,
          avriOnMax: 6,
          minDistanceToCeiling: 29,
          ceiling: 35,
        },
      ]);
    }
    const stats = readCompactionStats();
    expect(stats).not.toBeNull();
    expect(stats!.recentRuns).toHaveLength(3);
    const timestamps = stats!.recentRuns.map((r) => Date.parse(r.at));
    for (const t of timestamps) expect(Number.isFinite(t)).toBe(true);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    // Tail mirrors the legacy "last run" fields.
    const tail = stats!.recentRuns.at(-1)!;
    expect(tail.at).toBe(stats!.lastCompactedAt);
    expect(tail.removed).toBe(stats!.lastRemovedCount);
  });

  it("caps the recentRuns buffer at MAX_RECENT_RUNS so the stats file stays bounded", async () => {
    const cap = statsTesting.MAX_RECENT_RUNS;
    for (let i = 0; i < cap + 5; i++) {
      await appendArchetypeSnapshots([
        {
          archetype: "fabricated_diff",
          count: 1,
          avriOnMean: 5,
          avriOnMax: 6,
          minDistanceToCeiling: 29,
          ceiling: 35,
        },
      ]);
    }
    const stats = readCompactionStats();
    expect(stats).not.toBeNull();
    expect(stats!.recentRuns.length).toBe(cap);
    // Cap must hold on disk too, so a process restart can't resurrect dropped entries.
    const raw = await fs.readFile(
      process.env.ARCHETYPE_HISTORY_STATS_PATH!,
      "utf-8",
    );
    const persisted = JSON.parse(raw) as { recentRuns?: unknown[] };
    expect(Array.isArray(persisted.recentRuns)).toBe(true);
    expect(persisted.recentRuns!.length).toBe(cap);
  });

  it("back-fills recentRuns from a legacy stats file that only carries the last-run fields", async () => {
    // Pre-Task-#289 stats shape (no recentRuns) must still parse and
    // back-fill so the dashboard isn't blank on first post-upgrade GET.
    const statsFile = process.env.ARCHETYPE_HISTORY_STATS_PATH!;
    await fs.writeFile(
      statsFile,
      JSON.stringify({
        version: 1,
        lastCompactedAt: "2026-04-22T12:00:00.000Z",
        lastRemovedCount: 14,
      }),
      "utf-8",
    );
    statsTesting.resetCache();
    const stats = readCompactionStats();
    expect(stats).not.toBeNull();
    expect(stats!.recentRuns).toEqual([
      { at: "2026-04-22T12:00:00.000Z", removed: 14 },
    ]);
    // Subsequent passes extend the synthesized buffer rather than restarting it.
    await appendArchetypeSnapshots([
      {
        archetype: "fabricated_diff",
        count: 1,
        avriOnMean: 5,
        avriOnMax: 6,
        minDistanceToCeiling: 29,
        ceiling: 35,
      },
    ]);
    const after = readCompactionStats();
    expect(after!.recentRuns.length).toBe(2);
    expect(after!.recentRuns[0]!.removed).toBe(14);
  });
});
