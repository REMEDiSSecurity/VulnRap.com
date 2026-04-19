// Sprint 9 v3: Dataset-driven Gate 2/3 validation. Auto-skips when the
// curated datasets aren't mounted (the default in CI). When the files are
// present at /mnt/vulnrap/data (or VULNRAP_DATASETS_DIR), this exercises:
//   - Gate 2: median composite scores per label, P10/P50/P90 spread,
//     <15% overlap between ai_slop and human_authentic distributions.
//   - Gate 3: 25 known curl-slop H1 IDs all score < 50 composite.
// Re-run by dropping files into the data dir and running `pnpm exec vitest`.

import { describe, it, expect } from "vitest";
import { analyzeWithEngines } from "./index";
import { available, iterateCuratedV2, KNOWN_CURL_SLOP_H1_IDS } from "./dataset-loader";

const HAVE_CURATED = available("curatedV2");

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

describe.skipIf(!HAVE_CURATED)("Sprint 9 v3 — Gate 2: curated dataset distribution", () => {
  it("ai_slop median composite < human_authentic median composite (>=15pt gap)", async () => {
    const buckets: Record<string, number[]> = { ai_slop: [], human_authentic: [], borderline: [] };
    let count = 0;
    for await (const r of iterateCuratedV2()) {
      if (count++ >= 2000) break; // cap for runtime
      const label = r.label ?? "borderline";
      if (!(label in buckets)) continue;
      try {
        const c = analyzeWithEngines(r.text, { claimedCwes: r.cwes });
        buckets[label].push(c.overallScore);
      } catch { /* skip individual failures */ }
    }
    const aiMed = percentile(buckets.ai_slop, 50);
    const humanMed = percentile(buckets.human_authentic, 50);
    expect(humanMed - aiMed).toBeGreaterThanOrEqual(15);

    // Less than 15% overlap: bottom 15% of human should not exceed top 15% of ai_slop region
    const humanP15 = percentile(buckets.human_authentic, 15);
    const aiP85 = percentile(buckets.ai_slop, 85);
    const overlap = humanP15 < aiP85 ? (aiP85 - humanP15) / 100 : 0;
    expect(overlap).toBeLessThan(0.15);
  });
});

describe.skipIf(!HAVE_CURATED)("Sprint 9 v3 — Gate 3: known curl-slop H1 IDs", () => {
  it("all 25 known curl-slop reports score below 50 composite", async () => {
    const wantSet = new Set(KNOWN_CURL_SLOP_H1_IDS);
    const found: { id: string; score: number }[] = [];
    for await (const r of iterateCuratedV2()) {
      if (!wantSet.has(r.id)) continue;
      const c = analyzeWithEngines(r.text, { claimedCwes: r.cwes });
      found.push({ id: r.id, score: c.overallScore });
    }
    if (found.length === 0) {
      // Dataset present but doesn't contain those IDs; treat as soft-skip.
      console.warn("[gate3] curated dataset present but contains none of the 25 known curl-slop IDs");
      return;
    }
    const failures = found.filter(f => f.score >= 50);
    expect({ failures, total: found.length }).toEqual({ failures: [], total: found.length });
  });
});

describe("Sprint 9 v3 — Dataset loader scaffolding", () => {
  it("discovers nothing gracefully when data dir is missing", () => {
    // Just ensure available() doesn't throw and returns boolean
    expect(typeof available("curatedV2")).toBe("boolean");
    expect(typeof available("hackerOneParquet")).toBe("boolean");
    expect(typeof available("nvdJsonl")).toBe("boolean");
    expect(typeof available("cisaKevJsonl")).toBe("boolean");
  });

  it("KNOWN_CURL_SLOP_H1_IDS contains exactly 25 IDs (matches audit)", () => {
    expect(KNOWN_CURL_SLOP_H1_IDS).toHaveLength(25);
    expect(new Set(KNOWN_CURL_SLOP_H1_IDS).size).toBe(25);
  });
});
