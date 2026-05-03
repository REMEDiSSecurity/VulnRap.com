// Task #185 — verify the curated dataset sample rotates across runs while
// staying stable within a single calendar day. The route-level test in
// `test-fixtures.route.test.ts` already covers the response shape; here we
// pin the deterministic-shuffle helpers that drive the rotation so a
// regression in either property (rotation across days, stability within a
// day, label-independent ordering) fails loudly.

import { describe, expect, it } from "vitest";
import {
  datasetSampleDateKey,
  datasetSampleSeed,
  seededShuffle,
} from "./test-fixtures";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickFirstN<T>(
  pool: readonly T[],
  dateKey: string,
  label: string,
  n: number,
): T[] {
  const seed = datasetSampleSeed(`${dateKey}|${label}`);
  return seededShuffle(pool, mulberry32(seed)).slice(0, n);
}

describe("dataset sample rotation helpers", () => {
  const pool = Array.from({ length: 200 }, (_, i) => `r${i}`);

  it("datasetSampleDateKey returns YYYY-MM-DD in UTC", () => {
    expect(datasetSampleDateKey(new Date("2026-04-29T23:59:59Z"))).toBe(
      "2026-04-29",
    );
    expect(datasetSampleDateKey(new Date("2026-04-30T00:00:00Z"))).toBe(
      "2026-04-30",
    );
  });

  it("returns the identical 25-item slice for the same (date, label)", () => {
    const a = pickFirstN(pool, "2026-04-29", "human_authentic", 25);
    const b = pickFirstN(pool, "2026-04-29", "human_authentic", 25);
    expect(a).toHaveLength(25);
    expect(a).toEqual(b);
  });

  it("rotates which reports get sampled across calendar days", () => {
    const day1 = pickFirstN(pool, "2026-04-29", "human_authentic", 25);
    const day2 = pickFirstN(pool, "2026-04-30", "human_authentic", 25);
    expect(day1).not.toEqual(day2);
    // Significant churn in the slice — at least a third of the entries
    // should differ between consecutive days. (Picking 25 of 200 with a
    // fresh shuffle gives ~22 expected new items; we floor very generously
    // so a slightly unlucky seed never flakes the assertion.)
    const day1Set = new Set(day1);
    const overlap = day2.filter((x) => day1Set.has(x)).length;
    expect(overlap).toBeLessThan(20);
  });

  it("does not just reorder the head of the file across runs", () => {
    // Without rotation the slice would always be the first 25 entries.
    const head = pool.slice(0, 25);
    const day1 = pickFirstN(pool, "2026-04-29", "human_authentic", 25);
    const day2 = pickFirstN(pool, "2026-04-30", "human_authentic", 25);
    expect(new Set(day1)).not.toEqual(new Set(head));
    expect(new Set(day2)).not.toEqual(new Set(head));
  });

  it("uses an independent shuffle order per label so cohorts don't track each other", () => {
    const legit = pickFirstN(pool, "2026-04-29", "human_authentic", 25);
    const slop = pickFirstN(pool, "2026-04-29", "ai_slop", 25);
    expect(legit).not.toEqual(slop);
  });

  it("seededShuffle is a permutation of its input", () => {
    const shuffled = seededShuffle(pool, mulberry32(42));
    expect(shuffled).toHaveLength(pool.length);
    expect([...shuffled].sort()).toEqual([...pool].sort());
  });
});
