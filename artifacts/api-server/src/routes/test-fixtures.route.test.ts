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
    // Task #211 — most recent compaction pass outcome, or null if the
    // routine has not run yet on this deployment.
    lastCompaction: { lastCompactedAt: string; lastRemovedCount: number } | null;
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
});

// Task #187 — persisted curated-dataset cohort means time series.
describe("GET /api/test/dataset-history — Task #187 cohort drift persistence", () => {
  interface DatasetHistoryRow {
    timestamp: string;
    tier: string;
    label: string;
    count: number;
    compositeMean: number | null;
    gap: number | null;
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

      const runBody = await fetchJson<{
        datasetSamples:
          | { available: false }
          | { available: true; cohorts: Array<{ tier: string }> };
      }>("/api/test/run");
      // Sanity check: with the synthetic dataset wired up the run must
      // observe it as mounted, otherwise the persistence path is skipped.
      expect(runBody.datasetSamples.available).toBe(true);

      const after = await fetchJson<DatasetHistoryResponse>("/api/test/dataset-history");
      // Three cohorts (T1/T2/T3) → three rows appended on this single run.
      expect(after.totalSnapshots).toBe(baselineCount + 3);
      const tiers = after.cohorts.map(c => c.tier).sort();
      expect(tiers).toEqual(["T1_LEGIT", "T2_BORDERLINE", "T3_SLOP"]);
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
