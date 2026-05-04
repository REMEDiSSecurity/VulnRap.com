// Task #620 — Pure-logic tests for the score-stability monitor.
//
// Covers the deterministic surface that does NOT touch the DB:
//   - flipDirection bucket math (the chart's legend depends on this).
//   - dispatchScoreStabilityAlertIfNeeded threshold + dedup behaviour
//     against an injected `summary` (no DB / no fetch).
//   - Persistence + dedup via a temp state file (mirrors the AVRI
//     drift-notifications test pattern).
//
// `runScoreStabilityRescorePass` and `computeScoreStabilitySummary`
// hit the live DB and are exercised by the route-level tests; this
// suite stays offline so it runs on every CI sweep regardless of
// DATABASE_URL availability.

import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bucketForTier,
  flipDirection,
  dispatchScoreStabilityAlertIfNeeded,
  __testing,
  type ScoreStabilitySummary,
  type ScoreStabilityAlertPayload,
  type ScoreStabilityDispatcher,
} from "./score-stability-monitor";

const STATE_PATH_ENV = "SCORE_STABILITY_ALERT_STATE_PATH";
const WEBHOOK_ENV = "AVRI_DRIFT_WEBHOOK_URL";
const RUNBOOK_ENV = "SCORE_STABILITY_RUNBOOK_URL";

describe("bucketForTier", () => {
  it("collapses the five raw tiers into legit/middle/slop", () => {
    expect(bucketForTier("Clean")).toBe("legit");
    expect(bucketForTier("Likely Human")).toBe("legit");
    expect(bucketForTier("Questionable")).toBe("middle");
    expect(bucketForTier("Likely Slop")).toBe("slop");
    expect(bucketForTier("Slop")).toBe("slop");
    expect(bucketForTier("totally-unknown")).toBe("unknown");
  });
});

describe("flipDirection", () => {
  it("returns none when tiers match", () => {
    expect(flipDirection("Clean", "Clean")).toBe("none");
  });
  it("calls out the headline directions reviewers care about", () => {
    expect(flipDirection("Clean", "Slop")).toBe("legit_to_slop");
    expect(flipDirection("Likely Human", "Likely Slop")).toBe("legit_to_slop");
    expect(flipDirection("Slop", "Clean")).toBe("slop_to_legit");
    expect(flipDirection("Likely Slop", "Likely Human")).toBe("slop_to_legit");
  });
  it("classifies one-step moves as tightened/loosened", () => {
    expect(flipDirection("Clean", "Questionable")).toBe("tightened");
    expect(flipDirection("Questionable", "Slop")).toBe("tightened");
    expect(flipDirection("Slop", "Questionable")).toBe("loosened");
    expect(flipDirection("Questionable", "Clean")).toBe("loosened");
  });
  it("falls back to lateral for unrecognised transitions", () => {
    expect(flipDirection("totally-unknown", "Slop")).toBe("lateral");
  });
});

describe("dispatchScoreStabilityAlertIfNeeded", () => {
  let tmpDir: string;
  let statePath: string;
  let envSnap: Record<string, string | undefined>;

  function snapEnv() {
    envSnap = {
      state: process.env[STATE_PATH_ENV],
      webhook: process.env[WEBHOOK_ENV],
      runbook: process.env[RUNBOOK_ENV],
      publicUrl: process.env.PUBLIC_URL,
    };
  }
  function restoreEnv() {
    for (const [k, v] of [
      [STATE_PATH_ENV, envSnap.state],
      [WEBHOOK_ENV, envSnap.webhook],
      [RUNBOOK_ENV, envSnap.runbook],
      ["PUBLIC_URL", envSnap.publicUrl],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(() => {
    snapEnv();
    tmpDir = mkdtempSync(path.join(tmpdir(), "score-stability-test-"));
    statePath = path.join(tmpDir, "state.json");
    process.env[STATE_PATH_ENV] = statePath;
    process.env[WEBHOOK_ENV] = "https://example.com/hook";
    process.env.PUBLIC_URL = "https://vulnrap.example.com";
    __testing.resetAlertState();
  });
  afterEach(() => {
    restoreEnv();
    __testing.resetAlertState();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function summaryWith(
    date: string,
    total: number,
    flips: number,
  ): ScoreStabilitySummary {
    const flipRate =
      total > 0 ? Math.round((flips / total) * 10000) / 10000 : 0;
    return {
      generatedAt: "2026-05-03T00:00:00.000Z",
      lookbackDays: 7,
      alertThreshold: 0.02,
      daily: [
        {
          date,
          total,
          flips,
          legitToSlop: flips,
          slopToLegit: 0,
          tightened: 0,
          loosened: 0,
          lateral: 0,
          flipRate,
        },
      ],
      totals: {
        total,
        flips,
        legitToSlop: flips,
        slopToLegit: 0,
        tightened: 0,
        loosened: 0,
        lateral: 0,
        flipRate,
      },
    };
  }

  function recorder(): {
    dispatch: ScoreStabilityDispatcher;
    calls: Array<{ url: string; payload: ScoreStabilityAlertPayload }>;
  } {
    const calls: Array<{ url: string; payload: ScoreStabilityAlertPayload }> =
      [];
    return {
      calls,
      dispatch: async (url, payload) => {
        calls.push({ url, payload });
        return { ok: true, status: 200 };
      },
    };
  }

  it("does not dispatch when flip-rate is at or below the threshold", async () => {
    const rec = recorder();
    const outcome = await dispatchScoreStabilityAlertIfNeeded({
      summary: summaryWith("2026-05-02", 1000, 20), // exactly 2 %
      evaluateDate: "2026-05-02",
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(false);
    expect(outcome.dispatched).toBe(false);
    expect(rec.calls).toHaveLength(0);
    expect(existsSync(statePath)).toBe(false);
  });

  it("dispatches and records dedup when threshold is exceeded", async () => {
    const rec = recorder();
    const outcome = await dispatchScoreStabilityAlertIfNeeded({
      summary: summaryWith("2026-05-02", 1000, 30), // 3 %
      evaluateDate: "2026-05-02",
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(true);
    expect(outcome.dispatched).toBe(true);
    expect(outcome.alreadyAlerted).toBe(false);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toBe("https://example.com/hook");
    expect(rec.calls[0]!.payload.event).toBe(
      "score_stability_flip_rate_exceeded",
    );
    expect(rec.calls[0]!.payload.date).toBe("2026-05-02");
    expect(rec.calls[0]!.payload.flipRate).toBeCloseTo(0.03, 4);
    expect(rec.calls[0]!.payload.alertThreshold).toBe(0.02);
    expect(rec.calls[0]!.payload.calibrationUrl).toBe(
      "https://vulnrap.example.com/feedback-analytics",
    );
    expect(rec.calls[0]!.payload.runbookUrl).toBe(
      "https://vulnrap.example.com/docs/score-stability-runbook.md",
    );

    expect(existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      alertedDays: string[];
    };
    expect(persisted.alertedDays).toEqual(["2026-05-02"]);
  });

  it("does not re-page reviewers for an already-alerted day", async () => {
    const rec = recorder();
    await dispatchScoreStabilityAlertIfNeeded({
      summary: summaryWith("2026-05-02", 1000, 30),
      evaluateDate: "2026-05-02",
      dispatch: rec.dispatch,
    });
    const second = await dispatchScoreStabilityAlertIfNeeded({
      summary: summaryWith("2026-05-02", 1000, 50),
      evaluateDate: "2026-05-02",
      dispatch: rec.dispatch,
    });
    expect(second.exceeded).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(second.alreadyAlerted).toBe(true);
    expect(rec.calls).toHaveLength(1);
  });

  it("records the day as alerted even when no webhook is configured", async () => {
    delete process.env[WEBHOOK_ENV];
    const rec = recorder();
    const outcome = await dispatchScoreStabilityAlertIfNeeded({
      summary: summaryWith("2026-05-02", 1000, 30),
      evaluateDate: "2026-05-02",
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(true);
    expect(outcome.dispatched).toBe(false);
    expect(outcome.webhookSkipped).toBe(true);
    expect(rec.calls).toHaveLength(0);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      alertedDays: string[];
    };
    expect(persisted.alertedDays).toEqual(["2026-05-02"]);
  });

  it("does not persist dedup when dispatch fails (so the next pass retries)", async () => {
    const failing: ScoreStabilityDispatcher = async () => ({
      ok: false,
      status: 500,
      error: "HTTP 500",
    });
    const outcome = await dispatchScoreStabilityAlertIfNeeded({
      summary: summaryWith("2026-05-02", 1000, 30),
      evaluateDate: "2026-05-02",
      dispatch: failing,
    });
    expect(outcome.exceeded).toBe(true);
    expect(outcome.dispatched).toBe(false);
    expect(outcome.dispatchResult?.ok).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  it("returns exceeded=false when the day has zero volume", async () => {
    const rec = recorder();
    const outcome = await dispatchScoreStabilityAlertIfNeeded({
      summary: summaryWith("2026-05-02", 0, 0),
      evaluateDate: "2026-05-02",
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(false);
    expect(rec.calls).toHaveLength(0);
  });

  // Task #1117 — writeAlertState must use atomicWriteJsonFileSync so a
  // crash mid-write leaves no stale .tmp sibling and no corrupt JSON.
  it("leaves no .tmp siblings after writing alert state", async () => {
    const rec = recorder();
    await dispatchScoreStabilityAlertIfNeeded({
      summary: summaryWith("2026-05-02", 1000, 50), // 5 % — above threshold
      evaluateDate: "2026-05-02",
      dispatch: rec.dispatch,
    });
    const entries = readdirSync(tmpDir);
    expect(entries).toEqual(["state.json"]);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      alertedDays: string[];
    };
    expect(persisted.alertedDays).toContain("2026-05-02");
  });
});

describe("__testing.readFlipRateThreshold", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.SCORE_STABILITY_FLIP_RATE_THRESHOLD;
    delete process.env.SCORE_STABILITY_FLIP_RATE_THRESHOLD;
  });
  afterEach(() => {
    if (original === undefined)
      delete process.env.SCORE_STABILITY_FLIP_RATE_THRESHOLD;
    else process.env.SCORE_STABILITY_FLIP_RATE_THRESHOLD = original;
  });

  it("falls back when env is missing or unparseable", () => {
    expect(__testing.readFlipRateThreshold(0.02)).toBe(0.02);
    process.env.SCORE_STABILITY_FLIP_RATE_THRESHOLD = "not-a-number";
    expect(__testing.readFlipRateThreshold(0.02)).toBe(0.02);
    process.env.SCORE_STABILITY_FLIP_RATE_THRESHOLD = "-0.5";
    expect(__testing.readFlipRateThreshold(0.02)).toBe(0.02);
    process.env.SCORE_STABILITY_FLIP_RATE_THRESHOLD = "1.5";
    expect(__testing.readFlipRateThreshold(0.02)).toBe(0.02);
  });

  it("accepts a valid override in (0, 1]", () => {
    process.env.SCORE_STABILITY_FLIP_RATE_THRESHOLD = "0.05";
    expect(__testing.readFlipRateThreshold(0.02)).toBe(0.05);
  });
});
