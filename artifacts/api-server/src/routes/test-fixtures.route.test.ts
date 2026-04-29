// Sprint 12 — route-level contract test for GET /api/test/run.
// Mounts the router on an isolated express app and asserts the
// `archetypes` grouping exposes the emerging slop fixtures with the
// per-fixture AVRI on/off + distance-to-ceiling fields that calibration
// consumers depend on.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface ArchetypeFixture {
  id: string;
  tier: string;
  composite: number;
  avriOnScore: number;
  avriOffScore: number | null;
  distanceToCeiling: number;
  triage: string;
  passed: boolean;
}

interface ArchetypeGroup {
  archetype: string;
  count: number;
  avriOnMean: number;
  avriOnMax: number;
  minDistanceToCeiling: number;
  ceiling: number;
  fixtures: ArchetypeFixture[];
}

interface TestRunResponse {
  fixtureCount: number;
  results: Array<{ id: string; archetype: string | null }>;
  archetypes: ArchetypeGroup[];
}

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
const previousNodeEnv = process.env.NODE_ENV;
const previousHistoryPath = process.env.ARCHETYPE_HISTORY_PATH;

beforeAll(async () => {
  delete process.env.NODE_ENV; // route 404s in production
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archetype-history-"));
  process.env.ARCHETYPE_HISTORY_PATH = path.join(tmpDir, "archetype-history.json");
  const { default: testFixturesRouter } = await import("./test-fixtures");
  const app = express();
  app.use("/api", testFixturesRouter);
  await new Promise<void>(resolve => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousHistoryPath === undefined) delete process.env.ARCHETYPE_HISTORY_PATH;
  else process.env.ARCHETYPE_HISTORY_PATH = previousHistoryPath;
  await new Promise<void>(resolve => server.close(() => resolve()));
  try { await fs.rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function fetchJson<T>(urlPath: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}${urlPath}`, res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); }
          catch (err) { reject(err); }
        });
      })
      .on("error", reject);
  });
}

function fetchTestRun(): Promise<TestRunResponse> {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}/api/test/run`, res => {
        const chunks: Buffer[] = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on("error", reject);
  });
}

describe("GET /api/test/run — Sprint 12 emerging slop archetypes", () => {
  it("groups Sprint 12 fixtures by archetype with AVRI on/off + headroom fields", async () => {
    const body = await fetchTestRun();

    expect(Array.isArray(body.archetypes)).toBe(true);
    const expected = [
      "fabricated_diff",
      "family_contradiction",
      "flat_slop_haircut",
      "narrated_curl",
      "no_gold_signals",
      "paraphrased_cve",
      "prose_poc",
      "pseudo_asan",
    ];
    const labels = body.archetypes.map(a => a.archetype).sort();
    expect(labels).toEqual(expected);

    for (const group of body.archetypes) {
      expect(group.ceiling).toBe(35);
      expect(group.count).toBeGreaterThanOrEqual(1);
      expect(group.fixtures.length).toBe(group.count);
      for (const f of group.fixtures) {
        expect(typeof f.avriOnScore).toBe("number");
        expect(typeof f.distanceToCeiling).toBe("number");
        expect(f.distanceToCeiling).toBeCloseTo(35 - f.avriOnScore, 1);
        expect(f.tier).toBe("T3_SLOP");
      }
      const maxOn = Math.max(...group.fixtures.map(f => f.avriOnScore));
      expect(group.avriOnMax).toBeCloseTo(maxOn, 1);
      expect(group.minDistanceToCeiling).toBeCloseTo(35 - maxOn, 1);
    }

    const sprint12Ids = new Set(body.archetypes.flatMap(a => a.fixtures.map(f => f.id)));
    for (const id of [
      "T3-11-fabricated-diff-no-proof",
      "T3-12-paraphrased-cve-renamed-fn",
      "T3-13-narrated-curl-no-evidence",
      "T3-14-pseudo-asan-symbolless",
      "T3-15-prose-poc-no-payload",
      // Task #77 — cross-family fabricated_diff fixtures.
      "T3-16-fabricated-diff-injection",
      "T3-17-fabricated-diff-web-client",
      "T3-18-fabricated-diff-memory-corruption",
      // Task #87 — cross-family AVRI_NO_GOLD_SIGNALS fixtures.
      "T3-19-no-gold-injection",
      "T3-20-no-gold-web-client",
      "T3-21-no-gold-memory-corruption",
      "T3-22-no-gold-authn-authz",
      // Task #87 — cross-family AVRI_FAMILY_CONTRADICTION fixtures.
      "T3-23-contradiction-injection",
      "T3-24-contradiction-web-client",
      "T3-25-contradiction-memory-corruption",
      "T3-26-contradiction-authn-authz",
      // Task #100 — cross-driver fixtures for AVRI_FLAT_SLOP_HAIRCUT.
      "T3-27-flat-slop-no-poc",
      "T3-28-flat-slop-structural-only",
      "T3-29-flat-slop-buzzword-soup",
    ]) {
      expect(sprint12Ids.has(id), `archetype groups should include ${id}`).toBe(true);
    }

    const labeledTop = body.results.filter(r => r.archetype !== null).map(r => r.id).sort();
    expect(labeledTop).toEqual(
      [
        "T3-11-fabricated-diff-no-proof",
        "T3-12-paraphrased-cve-renamed-fn",
        "T3-13-narrated-curl-no-evidence",
        "T3-14-pseudo-asan-symbolless",
        "T3-15-prose-poc-no-payload",
        // Task #77 — cross-family fabricated_diff fixtures share the
        // existing "fabricated_diff" archetype label so calibration
        // groups them next to T3-11.
        "T3-16-fabricated-diff-injection",
        "T3-17-fabricated-diff-web-client",
        "T3-18-fabricated-diff-memory-corruption",
        // Task #87 — cross-family fixtures for the other family-agnostic
        // AVRI overrides (NO_GOLD_SIGNALS and FAMILY_CONTRADICTION).
        "T3-19-no-gold-injection",
        "T3-20-no-gold-web-client",
        "T3-21-no-gold-memory-corruption",
        "T3-22-no-gold-authn-authz",
        "T3-23-contradiction-injection",
        "T3-24-contradiction-web-client",
        "T3-25-contradiction-memory-corruption",
        "T3-26-contradiction-authn-authz",
        // Task #100 — cross-driver fixtures for AVRI_FLAT_SLOP_HAIRCUT.
        "T3-27-flat-slop-no-poc",
        "T3-28-flat-slop-structural-only",
        "T3-29-flat-slop-buzzword-soup",
      ].sort(),
    );
  }, 60_000);
});

describe("GET /api/test/archetype-history — Sprint 13 trend persistence", () => {
  interface HistoryRow {
    timestamp: string;
    archetype: string;
    count: number;
    avriOnMean: number;
    avriOnMax: number;
    minDistanceToCeiling: number;
    ceiling: number;
  }
  interface HistoryResponse {
    totalSnapshots: number;
    archetypes: Array<{ archetype: string; snapshots: HistoryRow[] }>;
  }

  it("appends one snapshot per archetype on each /api/test/run and exposes the time series", async () => {
    const before = await fetchJson<HistoryResponse>("/api/test/archetype-history");
    const baselineCount = before.totalSnapshots;

    await fetchTestRun();
    await fetchTestRun();

    const after = await fetchJson<HistoryResponse>("/api/test/archetype-history");
    expect(after.totalSnapshots).toBe(baselineCount + after.archetypes.length * 2);

    for (const a of after.archetypes) {
      expect(a.snapshots.length).toBeGreaterThanOrEqual(2);
      const last = a.snapshots[a.snapshots.length - 1]!;
      expect(last.archetype).toBe(a.archetype);
      expect(last.ceiling).toBe(35);
      expect(typeof last.minDistanceToCeiling).toBe("number");
      expect(typeof last.avriOnMean).toBe("number");
      expect(typeof last.avriOnMax).toBe("number");
      // Timestamps in chronological order.
      const ts = a.snapshots.map(s => Date.parse(s.timestamp));
      const sorted = [...ts].sort((x, y) => x - y);
      expect(ts).toEqual(sorted);
    }
  }, 90_000);
});

// Task #47 — when the curated dataset isn't mounted (the default in CI/dev)
// the response must still expose a `datasetSamples` block so consumers can
// branch on `available`. When it is mounted, the block must include a
// per-cohort summary and the T1−T3 mean gap.
describe("GET /api/test/run — Task #47 dataset samples block", () => {
  interface DatasetCohort {
    tier: string;
    label: string;
    count: number;
    compositeMean: number | null;
    compositeMin: number | null;
    compositeMax: number | null;
    engine2Mean: number | null;
  }
  interface DatasetSamplesAbsent { available: false }
  interface DatasetSamplesPresent {
    available: true;
    sourcePath: string;
    sampleSizeRequestedPerLabel: number;
    sampleCount: number;
    cohorts: DatasetCohort[];
    legitMean: number | null;
    slopMean: number | null;
    gap: number | null;
    gapTarget: number;
    gapMeetsTarget: boolean;
    samples: Array<{
      id: string; label: string; tier: string;
      composite: number; e1: number | null; e2: number | null; e3: number | null;
      triage: string;
    }>;
  }
  type DatasetSamples = DatasetSamplesAbsent | DatasetSamplesPresent;

  it("always includes the datasetSamples block and matches its declared shape", async () => {
    const body = await fetchJson<{ datasetSamples: DatasetSamples }>("/api/test/run");
    expect(body.datasetSamples).toBeDefined();
    const ds = body.datasetSamples;
    if (!ds.available) {
      // Default in CI/dev: dataset is not mounted, block reports unavailability.
      expect(ds).toEqual({ available: false });
      return;
    }
    // When mounted, the block must expose the cohort-level shape.
    expect(typeof ds.sourcePath).toBe("string");
    expect(ds.sampleSizeRequestedPerLabel).toBeGreaterThan(0);
    expect(ds.sampleCount).toBe(ds.samples.length);
    expect(ds.cohorts.map(c => c.tier).sort()).toEqual(
      ["T1_LEGIT", "T2_BORDERLINE", "T3_SLOP"],
    );
    for (const c of ds.cohorts) {
      // Each cohort caps at the requested sample size.
      expect(c.count).toBeLessThanOrEqual(ds.sampleSizeRequestedPerLabel);
      // Cross-check that the per-label slice in `samples` also obeys the
      // cap — c.count is computed from `samples`, but we want a direct
      // assertion in case the cohort-summary path ever drifts.
      const perLabelSamples = ds.samples.filter(s => s.label === c.label);
      expect(perLabelSamples.length).toBeLessThanOrEqual(
        ds.sampleSizeRequestedPerLabel,
      );
      expect(perLabelSamples.length).toBe(c.count);
    }
    expect(ds.gapTarget).toBeGreaterThan(0);
    if (ds.legitMean != null && ds.slopMean != null) {
      expect(ds.gap).toBeCloseTo(
        Number((ds.legitMean - ds.slopMean).toFixed(1)),
        1,
      );
      expect(ds.gapMeetsTarget).toBe(ds.gap! >= ds.gapTarget);
    }
    // Per-fixture asserts are intentionally absent on dataset samples — only
    // the engine output is reported so cohort drift can be observed without
    // conflating with synthetic-fixture pass/fail accounting.
    for (const s of ds.samples) {
      expect(["T1_LEGIT", "T2_BORDERLINE", "T3_SLOP"]).toContain(s.tier);
      expect(typeof s.composite).toBe("number");
    }
  }, 60_000);
});
