// Task #445 — targeted contract tests for the multi-run, failure-aware
// disagreement-floor audit on GET /api/test/run?withLlm=1&runs=N.
//
// The default route-level test in test-fixtures.route.test.ts deliberately
// does NOT touch the LLM (no API key in CI), so it can only verify the
// heuristic-only collapse. These tests vi.mock("../lib/llm-slop") so we
// can drive both the success and the failure paths deterministically:
//
//   1. Multi-run success path: every fixture × run draw returns "ok".
//      Asserts that perRunFloorFireCount/SuccessCount have length === runs,
//      attemptCount === fixtureCount * runs, llmFailureCount === 0, and
//      sampledCount + variance/distribution buckets are internally
//      consistent.
//
//   2. Failure path: every LLM call returns {kind:"failed",error}. Asserts
//      llmFailureCount === attemptCount, sampledCount === 0, no failures
//      leak into floor-fire counters, and per-fixture buckets stay zero
//      (failures are tracked separately, NOT folded into "no LLM signal"
//      which is what Task #445 explicitly required).
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import express from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";

// Mocks must be declared before the dynamic import in beforeAll so the
// route module picks up the mocked versions of isLLMAvailable +
// analyzeSlopWithLLMDetailed.
vi.mock("../lib/llm-slop", async () => {
  // Pull in the real module so we keep the production evaluateLlmGate /
  // gate reasons / cost-guard / shouldCallLLM exports untouched. Only the
  // two LLM-firing entry points are replaced.
  const actual =
    await vi.importActual<Record<string, unknown>>("../lib/llm-slop");
  return {
    ...actual,
    isLLMAvailable: () =>
      (globalThis as unknown as { __mockLlmAvailable?: boolean })
        .__mockLlmAvailable ?? false,
    analyzeSlopWithLLM: vi.fn(async () => null),
    analyzeSlopWithLLMDetailed: vi.fn(
      async (_text: string, _opts?: { bypassCache?: boolean }) => {
        const mode =
          (globalThis as unknown as { __mockLlmMode?: string }).__mockLlmMode ??
          "fail";
        if (mode === "ok") {
          return {
            kind: "ok" as const,
            cached: false,
            attempts: 1,
            result: {
              llmSlopScore: 35,
              llmFeedback: ["mock"],
              llmBreakdown: {
                technicalAccuracy: 70,
                specificity: 60,
                evidenceQuality: 55,
                actionability: 50,
                redFlags: [],
                validityScore: 65,
                verdict: "PROBABLY VALID",
              },
              llmRedFlags: [],
              llmTriageGuidance: undefined,
              llmReproRecipe: undefined,
              llmClaims: undefined,
              llmSubstance: 65,
            },
          };
        }
        return { kind: "failed" as const, error: "mock_failure", attempts: 2 };
      },
    ),
  };
});

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
const previousNodeEnv = process.env.NODE_ENV;
const previousHistoryPath = process.env.ARCHETYPE_HISTORY_PATH;
const previousHistoryConfigPath = process.env.ARCHETYPE_HISTORY_CONFIG_PATH;
const previousHistoryStatsPath = process.env.ARCHETYPE_HISTORY_STATS_PATH;
const previousDatasetHistoryPath = process.env.DATASET_HISTORY_PATH;
const previousDatasetHistoryConfigPath =
  process.env.DATASET_HISTORY_CONFIG_PATH;
const previousDatasetHistoryStatsPath = process.env.DATASET_HISTORY_STATS_PATH;
const previousDatasetsDir = process.env.VULNRAP_DATASETS_DIR;
const previousCalibrationToken = process.env.CALIBRATION_TOKEN;

beforeAll(async () => {
  delete process.env.NODE_ENV;
  delete process.env.CALIBRATION_TOKEN;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-runs-"));
  process.env.ARCHETYPE_HISTORY_PATH = path.join(tmpDir, "ah.json");
  process.env.ARCHETYPE_HISTORY_CONFIG_PATH = path.join(
    tmpDir,
    "ah-config.json",
  );
  process.env.ARCHETYPE_HISTORY_STATS_PATH = path.join(tmpDir, "ah-stats.json");
  process.env.DATASET_HISTORY_PATH = path.join(tmpDir, "dh.json");
  process.env.DATASET_HISTORY_CONFIG_PATH = path.join(tmpDir, "dh-config.json");
  process.env.DATASET_HISTORY_STATS_PATH = path.join(tmpDir, "dh-stats.json");
  const datasetDir = path.join(tmpDir, "datasets");
  await fs.mkdir(datasetDir, { recursive: true });
  process.env.VULNRAP_DATASETS_DIR = datasetDir;

  const { default: testFixturesRouter } = await import("./test-fixtures");
  const app = express();
  app.use(express.json());
  app.use("/api", testFixturesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
  if (previousHistoryPath === undefined)
    delete process.env.ARCHETYPE_HISTORY_PATH;
  else process.env.ARCHETYPE_HISTORY_PATH = previousHistoryPath;
  if (previousHistoryConfigPath === undefined)
    delete process.env.ARCHETYPE_HISTORY_CONFIG_PATH;
  else process.env.ARCHETYPE_HISTORY_CONFIG_PATH = previousHistoryConfigPath;
  if (previousHistoryStatsPath === undefined)
    delete process.env.ARCHETYPE_HISTORY_STATS_PATH;
  else process.env.ARCHETYPE_HISTORY_STATS_PATH = previousHistoryStatsPath;
  if (previousDatasetHistoryPath === undefined)
    delete process.env.DATASET_HISTORY_PATH;
  else process.env.DATASET_HISTORY_PATH = previousDatasetHistoryPath;
  if (previousDatasetHistoryConfigPath === undefined)
    delete process.env.DATASET_HISTORY_CONFIG_PATH;
  else
    process.env.DATASET_HISTORY_CONFIG_PATH = previousDatasetHistoryConfigPath;
  if (previousDatasetHistoryStatsPath === undefined)
    delete process.env.DATASET_HISTORY_STATS_PATH;
  else process.env.DATASET_HISTORY_STATS_PATH = previousDatasetHistoryStatsPath;
  if (previousDatasetsDir === undefined)
    delete process.env.VULNRAP_DATASETS_DIR;
  else process.env.VULNRAP_DATASETS_DIR = previousDatasetsDir;
  if (previousCalibrationToken === undefined)
    delete process.env.CALIBRATION_TOKEN;
  else process.env.CALIBRATION_TOKEN = previousCalibrationToken;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

interface ValidityFusionAggregate {
  runs: number;
  fixtureCount: number;
  attemptCount: number;
  llmFailureCount: number;
  sampledCount: number;
  floorAppliedCount: number;
  floorAppliedRate: number;
  perRunFloorFireCount: number[];
  perRunSuccessCount: number[];
  perRunFloorFireRate: number[];
  fixtureFloorFireDistribution: {
    alwaysFired: number;
    neverFired: number;
    sometimesFired: number;
  };
  variance: {
    floorFireCountMean: number | null;
    floorFireCountMin: number | null;
    floorFireCountMax: number | null;
    floorFireCountStdDev: number | null;
    rangeAcrossRuns: number;
  };
  note: string;
}

function fetchJson<T>(urlPath: string): Promise<T> {
  return new Promise((resolve, reject) => {
    http
      .get(`${baseUrl}${urlPath}`, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
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

describe("GET /api/test/run?withLlm=1&runs=N — Task #445 multi-run audit", () => {
  it("samples N runs per fixture and exposes per-run + variance fields", async () => {
    (
      globalThis as unknown as { __mockLlmAvailable: boolean }
    ).__mockLlmAvailable = true;
    (globalThis as unknown as { __mockLlmMode: string }).__mockLlmMode = "ok";
    try {
      const body = await fetchJson<{
        auditTelemetry: { validityFusion: ValidityFusionAggregate };
      }>("/api/test/run?withLlm=1&runs=2");
      const fusion = body.auditTelemetry.validityFusion;

      // runs honors the query param, attemptCount is exactly fixtureCount × runs.
      expect(fusion.runs).toBe(2);
      expect(fusion.fixtureCount).toBeGreaterThan(0);
      expect(fusion.attemptCount).toBe(fusion.fixtureCount * fusion.runs);

      // All draws were "ok" in this scenario, so failures stay at zero and
      // every attempt should land in sampledCount.
      expect(fusion.llmFailureCount).toBe(0);
      expect(fusion.sampledCount).toBe(fusion.attemptCount);

      // Per-run arrays have length === runs and the per-run success counts
      // sum to sampledCount.
      expect(fusion.perRunFloorFireCount.length).toBe(fusion.runs);
      expect(fusion.perRunSuccessCount.length).toBe(fusion.runs);
      expect(fusion.perRunFloorFireRate.length).toBe(fusion.runs);
      const perRunSuccessSum = fusion.perRunSuccessCount.reduce(
        (a, b) => a + b,
        0,
      );
      expect(perRunSuccessSum).toBe(fusion.sampledCount);
      const perRunFireSum = fusion.perRunFloorFireCount.reduce(
        (a, b) => a + b,
        0,
      );
      expect(perRunFireSum).toBe(fusion.floorAppliedCount);

      // Each per-run rate matches its fires/successes ratio.
      for (let i = 0; i < fusion.runs; i++) {
        const fires = fusion.perRunFloorFireCount[i];
        const succ = fusion.perRunSuccessCount[i];
        const expectedRate = succ === 0 ? 0 : Number((fires / succ).toFixed(2));
        expect(fusion.perRunFloorFireRate[i]).toBeCloseTo(expectedRate, 2);
      }

      // Fixture stability buckets sum to fixtureCount (every sampled
      // fixture lands in exactly one bucket since all runs succeeded).
      const distSum =
        fusion.fixtureFloorFireDistribution.alwaysFired +
        fusion.fixtureFloorFireDistribution.neverFired +
        fusion.fixtureFloorFireDistribution.sometimesFired;
      expect(distSum).toBe(fusion.fixtureCount);

      // Variance bounds are coherent — min ≤ mean ≤ max and rangeAcrossRuns
      // = max − min.
      expect(fusion.variance.floorFireCountMin).not.toBeNull();
      expect(fusion.variance.floorFireCountMax).not.toBeNull();
      expect(fusion.variance.floorFireCountMean).not.toBeNull();
      expect(fusion.variance.floorFireCountMin!).toBeLessThanOrEqual(
        fusion.variance.floorFireCountMean!,
      );
      expect(fusion.variance.floorFireCountMean!).toBeLessThanOrEqual(
        fusion.variance.floorFireCountMax!,
      );
      expect(fusion.variance.rangeAcrossRuns).toBe(
        fusion.variance.floorFireCountMax! - fusion.variance.floorFireCountMin!,
      );

      // Note copy for the live-LLM path must explicitly call out which
      // numbers are stable and which vary across runs.
      expect(fusion.note).toMatch(/Stable counters/);
      expect(fusion.note).toMatch(/Variable counters/);
    } finally {
      (
        globalThis as unknown as { __mockLlmAvailable: boolean }
      ).__mockLlmAvailable = false;
    }
  }, 120_000);

  it("counts LLM failures in llmFailureCount instead of folding into 'no LLM signal'", async () => {
    (
      globalThis as unknown as { __mockLlmAvailable: boolean }
    ).__mockLlmAvailable = true;
    (globalThis as unknown as { __mockLlmMode: string }).__mockLlmMode = "fail";
    try {
      const body = await fetchJson<{
        auditTelemetry: { validityFusion: ValidityFusionAggregate };
      }>("/api/test/run?withLlm=1&runs=2");
      const fusion = body.auditTelemetry.validityFusion;

      expect(fusion.runs).toBe(2);
      expect(fusion.fixtureCount).toBeGreaterThan(0);
      expect(fusion.attemptCount).toBe(fusion.fixtureCount * fusion.runs);

      // Every draw failed: failures soak the entire attemptCount, NO
      // failed sample contributes to sampledCount or floorAppliedCount.
      // This is the explicit Task #445 requirement — failures must not
      // be silently collapsed into the "no LLM signal" path.
      expect(fusion.llmFailureCount).toBe(fusion.attemptCount);
      expect(fusion.sampledCount).toBe(0);
      expect(fusion.floorAppliedCount).toBe(0);
      expect(fusion.floorAppliedRate).toBe(0);

      // Per-run arrays still have length === runs even when every run failed.
      expect(fusion.perRunFloorFireCount.length).toBe(fusion.runs);
      expect(fusion.perRunSuccessCount.length).toBe(fusion.runs);
      for (let i = 0; i < fusion.runs; i++) {
        expect(fusion.perRunSuccessCount[i]).toBe(0);
        expect(fusion.perRunFloorFireCount[i]).toBe(0);
        expect(fusion.perRunFloorFireRate[i]).toBe(0);
      }

      // Fixtures with all-failed LLM calls are excluded from the
      // stability buckets — they are tracked under llmFailureCount, not
      // smuggled into "neverFired" (which would lie about a negative
      // signal we don't have).
      expect(fusion.fixtureFloorFireDistribution).toEqual({
        alwaysFired: 0,
        neverFired: 0,
        sometimesFired: 0,
      });
    } finally {
      (
        globalThis as unknown as { __mockLlmAvailable: boolean }
      ).__mockLlmAvailable = false;
    }
  }, 120_000);

  it("clamps ?runs to [1..10] and defaults to 3 on invalid input", async () => {
    (
      globalThis as unknown as { __mockLlmAvailable: boolean }
    ).__mockLlmAvailable = true;
    (globalThis as unknown as { __mockLlmMode: string }).__mockLlmMode = "fail";
    try {
      // ?runs=0 is invalid → default 3.
      const zero = await fetchJson<{
        auditTelemetry: { validityFusion: ValidityFusionAggregate };
      }>("/api/test/run?withLlm=1&runs=0");
      expect(zero.auditTelemetry.validityFusion.runs).toBe(3);

      // ?runs=99 is out of range → default 3.
      const huge = await fetchJson<{
        auditTelemetry: { validityFusion: ValidityFusionAggregate };
      }>("/api/test/run?withLlm=1&runs=99");
      expect(huge.auditTelemetry.validityFusion.runs).toBe(3);

      // ?runs=garbage is non-numeric → default 3.
      const garbage = await fetchJson<{
        auditTelemetry: { validityFusion: ValidityFusionAggregate };
      }>("/api/test/run?withLlm=1&runs=abc");
      expect(garbage.auditTelemetry.validityFusion.runs).toBe(3);

      // ?runs=1 is valid (lower bound).
      const one = await fetchJson<{
        auditTelemetry: { validityFusion: ValidityFusionAggregate };
      }>("/api/test/run?withLlm=1&runs=1");
      expect(one.auditTelemetry.validityFusion.runs).toBe(1);
    } finally {
      (
        globalThis as unknown as { __mockLlmAvailable: boolean }
      ).__mockLlmAvailable = false;
    }
  }, 180_000);
});
