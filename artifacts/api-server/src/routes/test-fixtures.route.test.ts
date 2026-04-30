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
const previousHistoryConfigPath = process.env.ARCHETYPE_HISTORY_CONFIG_PATH;
const previousHistoryStatsPath = process.env.ARCHETYPE_HISTORY_STATS_PATH;
const previousDatasetHistoryPath = process.env.DATASET_HISTORY_PATH;
const previousDatasetHistoryConfigPath = process.env.DATASET_HISTORY_CONFIG_PATH;
const previousDatasetsDir = process.env.VULNRAP_DATASETS_DIR;
const previousCalibrationToken = process.env.CALIBRATION_TOKEN;

beforeAll(async () => {
  delete process.env.NODE_ENV; // route 404s in production
  delete process.env.CALIBRATION_TOKEN; // PUT /test/archetype-history/config is open in single-reviewer mode
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archetype-history-"));
  process.env.ARCHETYPE_HISTORY_PATH = path.join(tmpDir, "archetype-history.json");
  process.env.ARCHETYPE_HISTORY_CONFIG_PATH = path.join(tmpDir, "archetype-history-config.json");
  // Task #211 — sibling stats file gets written on every compaction
  // pass. Point it at the per-suite tmpdir so the route test doesn't
  // pollute the repo's data directory.
  process.env.ARCHETYPE_HISTORY_STATS_PATH = path.join(tmpDir, "archetype-history-stats.json");
  process.env.DATASET_HISTORY_PATH = path.join(tmpDir, "dataset-history.json");
  // Task #378 — pin the persisted dataset-history compaction-window
  // config at a per-suite tmpdir so the new GET/PUT/DELETE endpoint
  // tests don't pollute the repo's data directory and can rely on a
  // clean "no persisted setting" starting state.
  process.env.DATASET_HISTORY_CONFIG_PATH = path.join(tmpDir, "dataset-history-config.json");
  // Task #187 — point the dataset-loader at a tmpdir that we'll *only*
  // populate inside the positive Task #187 test. The dataset-loader
  // captures DATA_ROOTS at import time, so the env var must be set
  // before the router (and its transitive dataset-loader import) loads.
  // For the rest of the suite the directory is empty, which makes
  // discover() return null exactly as in CI/dev.
  const datasetDir = path.join(tmpDir, "datasets");
  await fs.mkdir(datasetDir, { recursive: true });
  process.env.VULNRAP_DATASETS_DIR = datasetDir;
  const { default: testFixturesRouter } = await import("./test-fixtures");
  const app = express();
  // express.json() is needed for PUT /test/archetype-history/config; the
  // GET endpoints do not require it but it's harmless to mount globally.
  app.use(express.json());
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
  if (previousHistoryConfigPath === undefined) delete process.env.ARCHETYPE_HISTORY_CONFIG_PATH;
  else process.env.ARCHETYPE_HISTORY_CONFIG_PATH = previousHistoryConfigPath;
  if (previousHistoryStatsPath === undefined) delete process.env.ARCHETYPE_HISTORY_STATS_PATH;
  else process.env.ARCHETYPE_HISTORY_STATS_PATH = previousHistoryStatsPath;
  if (previousDatasetHistoryPath === undefined) delete process.env.DATASET_HISTORY_PATH;
  else process.env.DATASET_HISTORY_PATH = previousDatasetHistoryPath;
  if (previousDatasetHistoryConfigPath === undefined) delete process.env.DATASET_HISTORY_CONFIG_PATH;
  else process.env.DATASET_HISTORY_CONFIG_PATH = previousDatasetHistoryConfigPath;
  if (previousDatasetsDir === undefined) delete process.env.VULNRAP_DATASETS_DIR;
  else process.env.VULNRAP_DATASETS_DIR = previousDatasetsDir;
  if (previousCalibrationToken === undefined) delete process.env.CALIBRATION_TOKEN;
  else process.env.CALIBRATION_TOKEN = previousCalibrationToken;
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

describe("GET /api/test/run — Task #209 auditTelemetry contract", () => {
  interface AuditTelemetry {
    llmGating: {
      fixtureCount: number;
      shouldCallCount: number;
      shouldCallRate: number;
      byReason: Record<string, number>;
    };
    validityFusion: {
      sampledCount: number;
      floorAppliedCount: number;
      floorAppliedRate: number;
      meanDeltaWhenApplied: number | null;
      higherSideWhenApplied: { heuristic: number; llm: number; tied: number };
      note: string;
    };
  }

  it("exposes the auditTelemetry block with the documented shape (default run, no LLM)", async () => {
    const body = await fetchJson<{ auditTelemetry: AuditTelemetry }>("/api/test/run");
    expect(body.auditTelemetry).toBeDefined();

    const gating = body.auditTelemetry.llmGating;
    expect(typeof gating.fixtureCount).toBe("number");
    expect(gating.fixtureCount).toBeGreaterThan(0);
    expect(typeof gating.shouldCallCount).toBe("number");
    expect(gating.shouldCallCount).toBeGreaterThanOrEqual(0);
    expect(gating.shouldCallCount).toBeLessThanOrEqual(gating.fixtureCount);
    expect(gating.shouldCallRate).toBeGreaterThanOrEqual(0);
    expect(gating.shouldCallRate).toBeLessThanOrEqual(1);
    expect(typeof gating.byReason).toBe("object");
    const reasonSum = Object.values(gating.byReason).reduce((a, b) => a + b, 0);
    expect(reasonSum).toBe(gating.fixtureCount);

    const fusion = body.auditTelemetry.validityFusion;
    expect(typeof fusion.sampledCount).toBe("number");
    expect(typeof fusion.floorAppliedCount).toBe("number");
    expect(fusion.floorAppliedCount).toBeLessThanOrEqual(fusion.sampledCount);
    expect(typeof fusion.floorAppliedRate).toBe("number");
    expect(fusion.floorAppliedRate).toBeGreaterThanOrEqual(0);
    expect(fusion.floorAppliedRate).toBeLessThanOrEqual(1);
    expect(fusion.higherSideWhenApplied).toEqual({
      heuristic: expect.any(Number),
      llm: expect.any(Number),
      tied: expect.any(Number),
    });
    const sideSum =
      fusion.higherSideWhenApplied.heuristic +
      fusion.higherSideWhenApplied.llm +
      fusion.higherSideWhenApplied.tied;
    expect(sideSum).toBe(fusion.floorAppliedCount);
    expect(typeof fusion.note).toBe("string");
    expect(fusion.note.length).toBeGreaterThan(0);
    expect(fusion.sampledCount).toBe(0);
    expect(fusion.floorAppliedCount).toBe(0);
    expect(fusion.meanDeltaWhenApplied).toBeNull();
    expect(fusion.note).toMatch(/withLlm=1/);
  }, 60_000);

  // Task #311 — the per-fixture `_audit` blob is stripped from the default
  // response (it lives on the aggregate `auditTelemetry` block instead) and
  // is only re-attached when the caller passes `?debug=1`. Calibration
  // tooling depends on this contract: the audit row carries the heuristic
  // score that feeds the LLM cost-gate, and was the data source for the
  // documented decision in docs/calibration/2026-04-30-llm-cost-gate-audit.md.
  it("strips per-fixture _audit by default and includes it on ?debug=1", async () => {
    interface AuditRow {
      fixtureId: string;
      tier: string;
      heuristicScore: number;
      gateReason: string;
      gateShouldCall: boolean;
    }
    interface ResultRow { id: string; tier: string; _audit?: AuditRow }
    interface RunBody { results: ResultRow[] }

    const defaultBody = await fetchJson<RunBody>("/api/test/run");
    expect(Array.isArray(defaultBody.results)).toBe(true);
    expect(defaultBody.results.length).toBeGreaterThan(0);
    for (const r of defaultBody.results) {
      expect(r._audit).toBeUndefined();
    }

    const debugBody = await fetchJson<RunBody>("/api/test/run?debug=1");
    expect(debugBody.results.length).toBe(defaultBody.results.length);
    for (const r of debugBody.results) {
      expect(r._audit).toBeDefined();
      expect(r._audit!.fixtureId).toBe(r.id);
      expect(r._audit!.tier).toBe(r.tier);
      expect(typeof r._audit!.heuristicScore).toBe("number");
      expect(r._audit!.heuristicScore).toBeGreaterThanOrEqual(0);
      expect(r._audit!.heuristicScore).toBeLessThanOrEqual(100);
      expect(typeof r._audit!.gateReason).toBe("string");
      expect(typeof r._audit!.gateShouldCall).toBe("boolean");
    }
  }, 90_000);

  // Task #312 — the per-fixture `validityAudit` field is opt-in: it
  // only appears on `results[]` rows when the caller passes
  // `?withLlm=1` and the LLM actually produced a substance score.
  // Default heuristic-only runs must keep the row clean so the
  // dashboard never sees the internal `_audit` blob by accident.
  it("does not expose per-fixture validityAudit on default heuristic-only runs", async () => {
    const body = await fetchJson<{
      results: Array<Record<string, unknown> & { id: string }>;
    }>("/api/test/run");
    expect(body.results.length).toBeGreaterThan(0);
    for (const row of body.results) {
      expect(row).not.toHaveProperty("validityAudit");
      expect(row).not.toHaveProperty("_audit");
    }
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
    sampleDateKey: string;
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
    expect(ds.sampleDateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

// Task #99 — reviewer-tunable archetype-history compaction window.
describe("/api/test/archetype-history/config — reviewer-tunable compaction window", () => {
  interface CompactWindow {
    effectiveDays: number;
    source: "env" | "persisted" | "default";
    envOverride: number | null;
    persistedDays: number | null;
    defaultDays: number;
    min: number;
    max: number;
    // Task #211 — most recent compaction outcome (null if not run yet).
    // Task #289 — recentRuns ring buffer (oldest -> newest) for cadence.
    lastCompaction: {
      lastCompactedAt: string;
      lastRemovedCount: number;
      recentRuns: Array<{ at: string; removed: number }>;
    } | null;
    // Task #288 — on-disk size of the persisted history file plus the
    // snapshot count it currently holds, or null until the file exists.
    historyFile: { sizeBytes: number; snapshotCount: number } | null;
  }

  function deleteJson<T>(urlPath: string): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}${urlPath}`);
      const req = http.request(
        {
          method: "DELETE",
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
              resolve({ status: res.statusCode ?? 0, body: parsed as T });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function putJson<T>(urlPath: string, body: unknown): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body), "utf-8");
      const url = new URL(`${baseUrl}${urlPath}`);
      const req = http.request(
        {
          method: "PUT",
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            "content-type": "application/json",
            "content-length": String(data.length),
          },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
              resolve({ status: res.statusCode ?? 0, body: parsed as T });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  it("GET reports the default window when nothing is configured", async () => {
    // The shared beforeAll points ARCHETYPE_HISTORY_CONFIG_PATH at a fresh
    // tmpdir file that doesn't exist yet, so source must be "default".
    const cfg = await fetchJson<CompactWindow>("/api/test/archetype-history/config");
    expect(cfg.source).toBe("default");
    expect(cfg.effectiveDays).toBe(cfg.defaultDays);
    expect(cfg.envOverride).toBeNull();
    expect(cfg.persistedDays).toBeNull();
    expect(cfg.min).toBeGreaterThan(0);
    expect(cfg.max).toBeGreaterThan(cfg.min);
  });

  it("PUT persists a reviewer-supplied window and GET reflects it", async () => {
    const put = await putJson<CompactWindow>(
      "/api/test/archetype-history/config",
      { compactAfterDays: 60 },
    );
    expect(put.status).toBe(200);
    expect(put.body.effectiveDays).toBe(60);
    expect(put.body.source).toBe("persisted");
    expect(put.body.persistedDays).toBe(60);

    const get = await fetchJson<CompactWindow>("/api/test/archetype-history/config");
    expect(get.effectiveDays).toBe(60);
    expect(get.source).toBe("persisted");
  });

  // Task #210 — reviewer can clear the persisted setting from the UI
  // and the resolved source flips back to "default".
  it("DELETE clears the persisted window so the source falls back to default", async () => {
    // Seed a persisted value so we can verify it's actually removed.
    const seeded = await putJson<CompactWindow>(
      "/api/test/archetype-history/config",
      { compactAfterDays: 90 },
    );
    expect(seeded.status).toBe(200);
    expect(seeded.body.persistedDays).toBe(90);
    expect(seeded.body.source).toBe("persisted");

    const del = await deleteJson<CompactWindow>("/api/test/archetype-history/config");
    expect(del.status).toBe(200);
    expect(del.body.persistedDays).toBeNull();
    expect(del.body.source).toBe("default");
    expect(del.body.effectiveDays).toBe(del.body.defaultDays);

    // GET reflects the cleared state, and a follow-up DELETE on an
    // already-cleared config is a no-op (no ENOENT bleeding through).
    const get = await fetchJson<CompactWindow>("/api/test/archetype-history/config");
    expect(get.persistedDays).toBeNull();
    expect(get.source).toBe("default");

    const delAgain = await deleteJson<CompactWindow>("/api/test/archetype-history/config");
    expect(delAgain.status).toBe(200);
    expect(delAgain.body.source).toBe("default");
  });

  it("PUT rejects out-of-range values with a 400 and a helpful error message", async () => {
    const tooLow = await putJson<{ error: string }>(
      "/api/test/archetype-history/config",
      { compactAfterDays: 1 },
    );
    expect(tooLow.status).toBe(400);
    expect(tooLow.body.error).toMatch(/between/i);

    const tooHigh = await putJson<{ error: string }>(
      "/api/test/archetype-history/config",
      { compactAfterDays: 10_000 },
    );
    expect(tooHigh.status).toBe(400);

    const notNumber = await putJson<{ error: string }>(
      "/api/test/archetype-history/config",
      { compactAfterDays: "abc" },
    );
    expect(notNumber.status).toBe(400);
  });

  // Task #211 — the config response surfaces the most recent compaction
  // outcome so the dashboard can render "Last compacted Xh ago — removed
  // N snapshots". The earlier "/api/test/archetype-history" describe
  // block has already triggered several /api/test/run calls (each of
  // which appends snapshots and runs the compaction pass), so by the
  // time this test executes the stats file must be populated even
  // though no rows are old enough to be rolled up yet.
  it("GET surfaces the most recent compaction pass timestamp + rows-removed count", async () => {
    const cfg = await fetchJson<CompactWindow>("/api/test/archetype-history/config");
    expect(cfg.lastCompaction).not.toBeNull();
    const stats = cfg.lastCompaction!;
    expect(typeof stats.lastCompactedAt).toBe("string");
    expect(Number.isFinite(Date.parse(stats.lastCompactedAt))).toBe(true);
    expect(typeof stats.lastRemovedCount).toBe("number");
    expect(stats.lastRemovedCount).toBeGreaterThanOrEqual(0);
    // The fixture battery only seeds fresh "now" snapshots, so nothing
    // is older than the default 30-day window — the most recent pass
    // must report zero rolled-up rows. (If this ever flips to non-zero
    // it means the compaction pass started misclassifying recent rows.)
    expect(stats.lastRemovedCount).toBe(0);
  });

  // Task #289 — recentRuns ring buffer surfaced via the config endpoint.
  // Earlier describe blocks have already triggered multiple /api/test/run
  // calls, so the buffer must contain >1 entry (proving append, not overwrite).
  it("GET surfaces a bounded recentRuns history with at least the most recent passes", async () => {
    const cfg = await fetchJson<CompactWindow>("/api/test/archetype-history/config");
    expect(cfg.lastCompaction).not.toBeNull();
    const stats = cfg.lastCompaction!;
    expect(Array.isArray(stats.recentRuns)).toBe(true);
    expect(stats.recentRuns.length).toBeGreaterThan(1);
    for (const run of stats.recentRuns) {
      expect(typeof run.at).toBe("string");
      expect(Number.isFinite(Date.parse(run.at))).toBe(true);
      expect(typeof run.removed).toBe("number");
      expect(run.removed).toBeGreaterThanOrEqual(0);
    }
    const order = stats.recentRuns.map(r => Date.parse(r.at));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Tail mirrors the legacy last-run fields so the indicator and the list agree.
    const tail = stats.recentRuns.at(-1)!;
    expect(tail.at).toBe(stats.lastCompactedAt);
    expect(tail.removed).toBe(stats.lastRemovedCount);
  });

  // Task #288 — the config response also surfaces the persisted history
  // file's on-disk size + snapshot count so the dashboard can render
  // "History file: 124 KB · 487 snapshots" next to the compaction
  // controls. By the time this test runs the earlier
  // "/api/test/archetype-history" describe block has already triggered
  // /api/test/run, so the history file must exist and have a positive
  // size + snapshot count.
  it("GET surfaces the persisted history file's on-disk size and snapshot count", async () => {
    const cfg = await fetchJson<CompactWindow>("/api/test/archetype-history/config");
    expect(cfg.historyFile).not.toBeNull();
    const file = cfg.historyFile!;
    expect(typeof file.sizeBytes).toBe("number");
    expect(file.sizeBytes).toBeGreaterThan(0);
    expect(Number.isInteger(file.sizeBytes)).toBe(true);
    expect(typeof file.snapshotCount).toBe("number");
    expect(Number.isInteger(file.snapshotCount)).toBe(true);
    expect(file.snapshotCount).toBeGreaterThan(0);
  });

  // Task #288 — PUT must mirror the GET shape so the dashboard can drop
  // the response straight into its query cache without a follow-up GET
  // to learn the on-disk file size.
  it("PUT response includes the persisted history file's size + snapshot count", async () => {
    const put = await putJson<CompactWindow>(
      "/api/test/archetype-history/config",
      { compactAfterDays: 45 },
    );
    expect(put.status).toBe(200);
    expect(put.body.historyFile).not.toBeNull();
    expect(put.body.historyFile!.sizeBytes).toBeGreaterThan(0);
    expect(put.body.historyFile!.snapshotCount).toBeGreaterThan(0);
  });
});

// Task #187 — persisted curated-dataset cohort means time series.
describe("GET /api/test/dataset-history — Task #187 cohort drift persistence", () => {
  interface DatasetHistoryRow {
    timestamp: string;
    tier: string;
    label: string;
    count: number;
    compositeMean: number | null;
    /**
     * Task #362 — synthetic-fixture composite mean for the same tier on
     * the same run, persisted so the dashboard can chart drift over time.
     */
    fixtureMean?: number | null;
    gap: number | null;
    sampleDateKey?: string;
  }
  interface DatasetHistoryResponse {
    totalSnapshots: number;
    cohorts: Array<{ tier: string; snapshots: DatasetHistoryRow[] }>;
  }

  it("exposes a stable empty shape when the dataset isn't mounted", async () => {
    // /api/test/run has already been called by earlier specs in this file.
    // Without the curated dataset mounted, no cohort rows should have been
    // persisted — the endpoint must still return a well-formed response.
    const body = await fetchJson<DatasetHistoryResponse>("/api/test/dataset-history");
    expect(body.totalSnapshots).toBe(0);
    expect(body.cohorts).toEqual([]);
  });

  it("appends one row per cohort on /api/test/run when the dataset IS mounted", async () => {
    // beforeAll already pointed VULNRAP_DATASETS_DIR at an empty tmpdir
    // so the dataset-loader picked it up at import time. Drop a synthetic
    // curated v2 file in there so discover() now finds a path and the
    // route walks the dataset persistence path.
    const datasetDir = process.env.VULNRAP_DATASETS_DIR!;
    const datasetFile = path.join(datasetDir, "vuln_reports_dataset_v2.json");
    const buildReport = (id: string, label: string) => ({
      id,
      // The loader requires text length >= 50 chars to yield the row.
      text: `Synthetic curated report ${id} for cohort drift persistence smoke test.`,
      label,
      cwes: [] as string[],
    });
    const reports = [
      buildReport("syn-h-1", "human_authentic"),
      buildReport("syn-h-2", "human_authentic"),
      buildReport("syn-b-1", "borderline"),
      buildReport("syn-b-2", "borderline"),
      buildReport("syn-s-1", "ai_slop"),
      buildReport("syn-s-2", "ai_slop"),
    ];
    await fs.writeFile(datasetFile, JSON.stringify(reports), "utf-8");

    try {
      const before = await fetchJson<DatasetHistoryResponse>("/api/test/dataset-history");
      const baselineCount = before.totalSnapshots;

      // Capture the expected UTC date key right before the request so the
      // assertion isn't sensitive to a midnight boundary crossing during
      // the run.
      const expectedDateKey = new Date().toISOString().slice(0, 10);
      const runBody = await fetchJson<{
        datasetSamples:
          | { available: false }
          | {
              available: true;
              sampleDateKey: string;
              cohorts: Array<{ tier: string }>;
            };
      }>("/api/test/run");
      // Sanity check: with the synthetic dataset wired up the run must
      // observe it as mounted, otherwise the persistence path is skipped.
      expect(runBody.datasetSamples.available).toBe(true);
      if (runBody.datasetSamples.available) {
        // The slice key must be the YYYY-MM-DD captured just above (or, if
        // the request straddled a UTC midnight, the next day) so reviewers
        // can correlate cohort drift with the daily slice rotation.
        const tomorrowDateKey = new Date(Date.parse(expectedDateKey) + 86_400_000)
          .toISOString()
          .slice(0, 10);
        expect([expectedDateKey, tomorrowDateKey]).toContain(
          runBody.datasetSamples.sampleDateKey,
        );
      }

      const after = await fetchJson<DatasetHistoryResponse>("/api/test/dataset-history");
      // Three cohorts (T1/T2/T3) → three rows appended on this single run.
      expect(after.totalSnapshots).toBe(baselineCount + 3);
      const tiers = after.cohorts.map(c => c.tier).sort();
      expect(tiers).toEqual(["T1_LEGIT", "T2_BORDERLINE", "T3_SLOP"]);
      // Task #358 — every persisted cohort row must carry the same
      // slice key the live block returned, so the dashboard's trend can
      // distinguish daily-slice rotations from real cohort drift.
      const liveSampleDateKey = runBody.datasetSamples.available
        ? runBody.datasetSamples.sampleDateKey
        : null;
      for (const c of after.cohorts) {
        expect(c.snapshots.length).toBeGreaterThanOrEqual(1);
        const last = c.snapshots[c.snapshots.length - 1]!;
        expect(last.tier).toBe(c.tier);
        expect(typeof last.count).toBe("number");
        expect(typeof last.timestamp).toBe("string");
        // compositeMean and gap may be null if a cohort came back empty,
        // but for our seeded dataset every cohort has 2 samples so they're
        // numeric.
        expect(typeof last.compositeMean).toBe("number");
        expect(last.sampleDateKey).toBe(liveSampleDateKey);
        // Task #362 — fixtureMean is persisted on every appended row so
        // the dashboard can reconstruct the (datasetMean − fixtureMean)
        // delta series over time. Synthetic fixtures always cover the
        // T1/T2/T3 tiers so this run is guaranteed to produce numeric
        // values for each cohort.
        expect(typeof last.fixtureMean).toBe("number");
      }
      // The gap must match across cohort rows of the same run, since it's
      // a per-run statistic repeated on every cohort row.
      const lastTimestamps = after.cohorts.map(
        c => c.snapshots[c.snapshots.length - 1]!.timestamp,
      );
      expect(new Set(lastTimestamps).size).toBe(1);
      const gaps = after.cohorts.map(
        c => c.snapshots[c.snapshots.length - 1]!.gap,
      );
      expect(new Set(gaps).size).toBe(1);
    } finally {
      // Remove the file so any later /api/test/run calls in this process
      // see an empty dataset dir again. A leftover file would let the
      // dataset-loader cache poison sibling specs.
      await fs.rm(datasetFile, { force: true });
    }
  }, 60_000);
});

// Task #378 — reviewer-tunable dataset-history compaction window.
// Mirrors the archetype-history/config coverage above so the dashboard
// can rely on the same GET/PUT/DELETE shape and validation behaviour
// for both knobs.
describe("/api/test/dataset-history/config — reviewer-tunable compaction window", () => {
  interface CompactWindow {
    effectiveDays: number;
    source: "env" | "persisted" | "default";
    envOverride: number | null;
    persistedDays: number | null;
    defaultDays: number;
    min: number;
    max: number;
  }

  function deleteJson<T>(urlPath: string): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`${baseUrl}${urlPath}`);
      const req = http.request(
        {
          method: "DELETE",
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
        },
        res => {
          const chunks: Buffer[] = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
              resolve({ status: res.statusCode ?? 0, body: parsed as T });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  function putJson<T>(urlPath: string, body: unknown): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body), "utf-8");
      const url = new URL(`${baseUrl}${urlPath}`);
      const req = http.request(
        {
          method: "PUT",
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          headers: {
            "content-type": "application/json",
            "content-length": String(data.length),
          },
        },
        res => {
          const chunks: Buffer[] = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
              resolve({ status: res.statusCode ?? 0, body: parsed as T });
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.on("error", reject);
      req.write(data);
      req.end();
    });
  }

  it("GET reports the default window when nothing is configured", async () => {
    // Sibling specs have only persisted via PUT below, and afterEach DELETEs
    // them again, so when this test runs first the source must be "default".
    const cfg = await fetchJson<CompactWindow>("/api/test/dataset-history/config");
    expect(cfg.source).toBe("default");
    expect(cfg.effectiveDays).toBe(cfg.defaultDays);
    expect(cfg.envOverride).toBeNull();
    expect(cfg.persistedDays).toBeNull();
    expect(cfg.min).toBeGreaterThan(0);
    expect(cfg.max).toBeGreaterThan(cfg.min);
  });

  it("PUT persists a reviewer-supplied window and GET reflects it", async () => {
    const put = await putJson<CompactWindow>(
      "/api/test/dataset-history/config",
      { compactAfterDays: 60 },
    );
    expect(put.status).toBe(200);
    expect(put.body.effectiveDays).toBe(60);
    expect(put.body.source).toBe("persisted");
    expect(put.body.persistedDays).toBe(60);

    const get = await fetchJson<CompactWindow>("/api/test/dataset-history/config");
    expect(get.effectiveDays).toBe(60);
    expect(get.source).toBe("persisted");

    // Clean up so the "GET reports the default" test order isn't load-bearing
    // and downstream specs in this file don't see a non-default starting state.
    await deleteJson<CompactWindow>("/api/test/dataset-history/config");
  });

  it("DELETE clears the persisted window so the source falls back to default", async () => {
    const seeded = await putJson<CompactWindow>(
      "/api/test/dataset-history/config",
      { compactAfterDays: 90 },
    );
    expect(seeded.status).toBe(200);
    expect(seeded.body.persistedDays).toBe(90);
    expect(seeded.body.source).toBe("persisted");

    const del = await deleteJson<CompactWindow>("/api/test/dataset-history/config");
    expect(del.status).toBe(200);
    expect(del.body.persistedDays).toBeNull();
    expect(del.body.source).toBe("default");
    expect(del.body.effectiveDays).toBe(del.body.defaultDays);

    const get = await fetchJson<CompactWindow>("/api/test/dataset-history/config");
    expect(get.persistedDays).toBeNull();
    expect(get.source).toBe("default");

    // A second DELETE on an already-cleared config is a no-op (no ENOENT
    // bleeding through to the response).
    const delAgain = await deleteJson<CompactWindow>("/api/test/dataset-history/config");
    expect(delAgain.status).toBe(200);
    expect(delAgain.body.source).toBe("default");
  });

  it("PUT rejects out-of-range values with a 400 and a helpful error message", async () => {
    const tooLow = await putJson<{ error: string }>(
      "/api/test/dataset-history/config",
      { compactAfterDays: 1 },
    );
    expect(tooLow.status).toBe(400);
    expect(tooLow.body.error).toMatch(/between/i);

    const tooHigh = await putJson<{ error: string }>(
      "/api/test/dataset-history/config",
      { compactAfterDays: 10_000 },
    );
    expect(tooHigh.status).toBe(400);

    const notNumber = await putJson<{ error: string }>(
      "/api/test/dataset-history/config",
      { compactAfterDays: "abc" },
    );
    expect(notNumber.status).toBe(400);
  });
});
