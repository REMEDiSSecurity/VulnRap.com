// Task #984 — Pure-logic tests for the shadow drift monitor.
//
// Covers threshold + dedup behaviour analogous to
// `score-stability-monitor.test.ts`. Tests inject a pre-computed
// `summary` so no DB / no fetch is needed — the suite stays offline
// and runs on every CI sweep regardless of DATABASE_URL availability.
//
// Key semantics validated:
//   - Lookback-window aggregation (not single-day).
//   - Legit↔slop tier-flip threshold (not all tier divergences).
//   - Divergence-rate threshold.
//   - Dedup by window key.
//   - Webhook-missing / dispatch-failure handling.

import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  dispatchShadowDriftAlertIfNeeded,
  __testing,
  type ShadowDriftSummary,
  type ShadowDriftAlertPayload,
  type ShadowDriftDispatcher,
} from "./shadow-drift-monitor";

const STATE_PATH_ENV = "SHADOW_DRIFT_ALERT_STATE_PATH";
const WEBHOOK_ENV = "AVRI_DRIFT_WEBHOOK_URL";

describe("bucketForTier", () => {
  it("classifies legit tiers", () => {
    expect(__testing.bucketForTier("Clean")).toBe("legit");
    expect(__testing.bucketForTier("Likely Human")).toBe("legit");
  });
  it("classifies slop tiers", () => {
    expect(__testing.bucketForTier("Slop")).toBe("slop");
    expect(__testing.bucketForTier("Likely Slop")).toBe("slop");
  });
  it("classifies middle tier", () => {
    expect(__testing.bucketForTier("Questionable")).toBe("middle");
  });
  it("classifies unknown tiers", () => {
    expect(__testing.bucketForTier("totally-unknown")).toBe("unknown");
  });
});

describe("isLegitSlopFlip", () => {
  it("returns true for legit→slop", () => {
    expect(__testing.isLegitSlopFlip("Clean", "Slop")).toBe(true);
    expect(__testing.isLegitSlopFlip("Likely Human", "Likely Slop")).toBe(true);
  });
  it("returns true for slop→legit", () => {
    expect(__testing.isLegitSlopFlip("Slop", "Clean")).toBe(true);
    expect(__testing.isLegitSlopFlip("Likely Slop", "Likely Human")).toBe(true);
  });
  it("returns false for non-legit↔slop transitions", () => {
    expect(__testing.isLegitSlopFlip("Clean", "Questionable")).toBe(false);
    expect(__testing.isLegitSlopFlip("Questionable", "Slop")).toBe(false);
    expect(__testing.isLegitSlopFlip("Clean", "Clean")).toBe(false);
  });
});

describe("dispatchShadowDriftAlertIfNeeded", () => {
  let tmpDir: string;
  let statePath: string;
  let envSnap: Record<string, string | undefined>;

  function snapEnv() {
    envSnap = {
      state: process.env[STATE_PATH_ENV],
      webhook: process.env[WEBHOOK_ENV],
      publicUrl: process.env.PUBLIC_URL,
      divThreshold: process.env.SHADOW_DRIFT_DIVERGENCE_THRESHOLD,
      flipThreshold: process.env.SHADOW_DRIFT_TIER_FLIP_THRESHOLD,
      lookback: process.env.SHADOW_DRIFT_LOOKBACK_DAYS,
    };
  }
  function restoreEnv() {
    for (const [k, v] of [
      [STATE_PATH_ENV, envSnap.state],
      [WEBHOOK_ENV, envSnap.webhook],
      ["PUBLIC_URL", envSnap.publicUrl],
      ["SHADOW_DRIFT_DIVERGENCE_THRESHOLD", envSnap.divThreshold],
      ["SHADOW_DRIFT_TIER_FLIP_THRESHOLD", envSnap.flipThreshold],
      ["SHADOW_DRIFT_LOOKBACK_DAYS", envSnap.lookback],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  beforeEach(() => {
    snapEnv();
    tmpDir = mkdtempSync(path.join(tmpdir(), "shadow-drift-test-"));
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

  function makeSummary(
    overrides: Partial<ShadowDriftSummary> = {},
  ): ShadowDriftSummary {
    const total = overrides.total ?? 1000;
    const divergent = overrides.divergent ?? 50;
    const legitToSlop = overrides.legitToSlop ?? 5;
    const slopToLegit = overrides.slopToLegit ?? 5;
    const legitSlopFlips =
      overrides.legitSlopFlips ?? legitToSlop + slopToLegit;
    const divergenceRate =
      overrides.divergenceRate ??
      (total > 0 ? Math.round((divergent / total) * 10000) / 10000 : 0);
    return {
      lookbackDays: overrides.lookbackDays ?? 7,
      windowStart: overrides.windowStart ?? "2026-04-27",
      windowEnd: overrides.windowEnd ?? "2026-05-04",
      total,
      divergent,
      legitSlopFlips,
      divergenceRate,
      legitToSlop,
      slopToLegit,
    };
  }

  function recorder(): {
    dispatch: ShadowDriftDispatcher;
    calls: Array<{ url: string; payload: ShadowDriftAlertPayload }>;
  } {
    const calls: Array<{ url: string; payload: ShadowDriftAlertPayload }> = [];
    return {
      calls,
      dispatch: async (url, payload) => {
        calls.push({ url, payload });
        return { ok: true, status: 200 };
      },
    };
  }

  it("does not dispatch when divergence rate and legit↔slop flips are below thresholds", async () => {
    const rec = recorder();
    const outcome = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 1000,
        divergent: 50,
        legitToSlop: 3,
        slopToLegit: 2,
        legitSlopFlips: 5,
        divergenceRate: 0.05,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(false);
    expect(outcome.triggeredBy).toBe("none");
    expect(outcome.dispatched).toBe(false);
    expect(rec.calls).toHaveLength(0);
    expect(existsSync(statePath)).toBe(false);
  });

  it("dispatches when divergence rate exceeds threshold", async () => {
    const rec = recorder();
    const outcome = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 1000,
        divergent: 150,
        legitToSlop: 3,
        slopToLegit: 2,
        legitSlopFlips: 5,
        divergenceRate: 0.15,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(true);
    expect(outcome.triggeredBy).toBe("divergence_rate");
    expect(outcome.dispatched).toBe(true);
    expect(outcome.alreadyAlerted).toBe(false);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toBe("https://example.com/hook");
    expect(rec.calls[0]!.payload.event).toBe(
      "shadow_drift_threshold_exceeded",
    );
    expect(rec.calls[0]!.payload.triggeredBy).toBe("divergence_rate");
    expect(rec.calls[0]!.payload.lookbackDays).toBe(7);
    expect(rec.calls[0]!.payload.windowStart).toBe("2026-04-27");
    expect(rec.calls[0]!.payload.windowEnd).toBe("2026-05-04");
    expect(rec.calls[0]!.payload.reviewerPanelUrl).toBe(
      "https://vulnrap.example.com/feedback-analytics",
    );

    expect(existsSync(statePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      alertedWindows: string[];
    };
    expect(persisted.alertedWindows).toEqual(["2026-04-27..2026-05-04"]);
  });

  it("dispatches when legit↔slop tier flip count exceeds threshold", async () => {
    const rec = recorder();
    const outcome = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 1000,
        divergent: 50,
        legitToSlop: 15,
        slopToLegit: 10,
        legitSlopFlips: 25,
        divergenceRate: 0.05,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(true);
    expect(outcome.triggeredBy).toBe("tier_flip_count");
    expect(outcome.dispatched).toBe(true);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.payload.triggeredBy).toBe("tier_flip_count");
    expect(rec.calls[0]!.payload.legitSlopFlips).toBe(25);
  });

  it("does NOT alert on non-legit↔slop tier flips alone", async () => {
    const rec = recorder();
    const outcome = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 1000,
        divergent: 50,
        legitToSlop: 5,
        slopToLegit: 5,
        legitSlopFlips: 10,
        divergenceRate: 0.05,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(false);
    expect(outcome.triggeredBy).toBe("none");
    expect(rec.calls).toHaveLength(0);
  });

  it("reports 'both' when both thresholds are exceeded", async () => {
    const rec = recorder();
    const outcome = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 1000,
        divergent: 200,
        legitToSlop: 20,
        slopToLegit: 10,
        legitSlopFlips: 30,
        divergenceRate: 0.2,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(true);
    expect(outcome.triggeredBy).toBe("both");
    expect(outcome.dispatched).toBe(true);
    expect(rec.calls[0]!.payload.triggeredBy).toBe("both");
  });

  it("does not re-page reviewers for an already-alerted window", async () => {
    const rec = recorder();
    const summary = makeSummary({
      total: 1000,
      divergent: 200,
      legitSlopFlips: 30,
      divergenceRate: 0.2,
    });
    await dispatchShadowDriftAlertIfNeeded({
      summary,
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    const second = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 1000,
        divergent: 300,
        legitSlopFlips: 50,
        divergenceRate: 0.3,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(second.exceeded).toBe(true);
    expect(second.dispatched).toBe(false);
    expect(second.alreadyAlerted).toBe(true);
    expect(rec.calls).toHaveLength(1);
  });

  it("alerts again for a different window key", async () => {
    const rec = recorder();
    await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        windowStart: "2026-04-27",
        windowEnd: "2026-05-04",
        total: 1000,
        divergent: 200,
        legitSlopFlips: 30,
        divergenceRate: 0.2,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    const second = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        windowStart: "2026-04-28",
        windowEnd: "2026-05-05",
        total: 1000,
        divergent: 200,
        legitSlopFlips: 30,
        divergenceRate: 0.2,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(second.exceeded).toBe(true);
    expect(second.dispatched).toBe(true);
    expect(second.alreadyAlerted).toBe(false);
    expect(rec.calls).toHaveLength(2);
  });

  it("records the window as alerted even when no webhook is configured", async () => {
    delete process.env[WEBHOOK_ENV];
    const rec = recorder();
    const outcome = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 1000,
        divergent: 200,
        legitSlopFlips: 30,
        divergenceRate: 0.2,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(true);
    expect(outcome.dispatched).toBe(false);
    expect(outcome.webhookSkipped).toBe(true);
    expect(rec.calls).toHaveLength(0);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      alertedWindows: string[];
    };
    expect(persisted.alertedWindows).toEqual(["2026-04-27..2026-05-04"]);
  });

  it("does not persist dedup when dispatch fails (so the next pass retries)", async () => {
    const failing: ShadowDriftDispatcher = async () => ({
      ok: false,
      status: 500,
      error: "HTTP 500",
    });
    const outcome = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 1000,
        divergent: 200,
        legitSlopFlips: 30,
        divergenceRate: 0.2,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: failing,
    });
    expect(outcome.exceeded).toBe(true);
    expect(outcome.dispatched).toBe(false);
    expect(outcome.dispatchResult?.ok).toBe(false);
    expect(existsSync(statePath)).toBe(false);
  });

  it("returns exceeded=false when the window has zero volume", async () => {
    const rec = recorder();
    const outcome = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 0,
        divergent: 0,
        legitSlopFlips: 0,
        divergenceRate: 0,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(false);
    expect(rec.calls).toHaveLength(0);
  });

  it("does not dispatch when rate equals threshold exactly (strict >)", async () => {
    const rec = recorder();
    const outcome = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 1000,
        divergent: 100,
        legitSlopFlips: 10,
        divergenceRate: 0.1,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(false);
    expect(rec.calls).toHaveLength(0);
  });

  it("does not dispatch when legit↔slop flips equal threshold exactly (strict >)", async () => {
    const rec = recorder();
    const outcome = await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        total: 1000,
        divergent: 50,
        legitSlopFlips: 20,
        divergenceRate: 0.05,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(outcome.exceeded).toBe(false);
    expect(rec.calls).toHaveLength(0);
  });

  it("includes lookback window info in the payload", async () => {
    const rec = recorder();
    await dispatchShadowDriftAlertIfNeeded({
      summary: makeSummary({
        lookbackDays: 14,
        windowStart: "2026-04-20",
        windowEnd: "2026-05-04",
        total: 1000,
        divergent: 200,
        legitSlopFlips: 30,
        divergenceRate: 0.2,
      }),
      divergenceThreshold: 0.1,
      tierFlipThreshold: 20,
      dispatch: rec.dispatch,
    });
    expect(rec.calls).toHaveLength(1);
    const payload = rec.calls[0]!.payload;
    expect(payload.lookbackDays).toBe(14);
    expect(payload.windowStart).toBe("2026-04-20");
    expect(payload.windowEnd).toBe("2026-05-04");
  });
});

describe("__testing.readDivergenceThreshold", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.SHADOW_DRIFT_DIVERGENCE_THRESHOLD;
    delete process.env.SHADOW_DRIFT_DIVERGENCE_THRESHOLD;
  });
  afterEach(() => {
    if (original === undefined)
      delete process.env.SHADOW_DRIFT_DIVERGENCE_THRESHOLD;
    else process.env.SHADOW_DRIFT_DIVERGENCE_THRESHOLD = original;
  });

  it("falls back when env is missing or unparseable", () => {
    expect(__testing.readDivergenceThreshold(0.1)).toBe(0.1);
    process.env.SHADOW_DRIFT_DIVERGENCE_THRESHOLD = "not-a-number";
    expect(__testing.readDivergenceThreshold(0.1)).toBe(0.1);
    process.env.SHADOW_DRIFT_DIVERGENCE_THRESHOLD = "-0.5";
    expect(__testing.readDivergenceThreshold(0.1)).toBe(0.1);
    process.env.SHADOW_DRIFT_DIVERGENCE_THRESHOLD = "1.5";
    expect(__testing.readDivergenceThreshold(0.1)).toBe(0.1);
  });

  it("accepts a valid override in (0, 1]", () => {
    process.env.SHADOW_DRIFT_DIVERGENCE_THRESHOLD = "0.05";
    expect(__testing.readDivergenceThreshold(0.1)).toBe(0.05);
  });
});

describe("__testing.readTierFlipThreshold", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.SHADOW_DRIFT_TIER_FLIP_THRESHOLD;
    delete process.env.SHADOW_DRIFT_TIER_FLIP_THRESHOLD;
  });
  afterEach(() => {
    if (original === undefined)
      delete process.env.SHADOW_DRIFT_TIER_FLIP_THRESHOLD;
    else process.env.SHADOW_DRIFT_TIER_FLIP_THRESHOLD = original;
  });

  it("falls back when env is missing or unparseable", () => {
    expect(__testing.readTierFlipThreshold(20)).toBe(20);
    process.env.SHADOW_DRIFT_TIER_FLIP_THRESHOLD = "not-a-number";
    expect(__testing.readTierFlipThreshold(20)).toBe(20);
    process.env.SHADOW_DRIFT_TIER_FLIP_THRESHOLD = "-5";
    expect(__testing.readTierFlipThreshold(20)).toBe(20);
    process.env.SHADOW_DRIFT_TIER_FLIP_THRESHOLD = "0";
    expect(__testing.readTierFlipThreshold(20)).toBe(20);
  });

  it("accepts a valid positive integer override", () => {
    process.env.SHADOW_DRIFT_TIER_FLIP_THRESHOLD = "50";
    expect(__testing.readTierFlipThreshold(20)).toBe(50);
  });
});

describe("__testing.readLookbackDays", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.SHADOW_DRIFT_LOOKBACK_DAYS;
    delete process.env.SHADOW_DRIFT_LOOKBACK_DAYS;
  });
  afterEach(() => {
    if (original === undefined)
      delete process.env.SHADOW_DRIFT_LOOKBACK_DAYS;
    else process.env.SHADOW_DRIFT_LOOKBACK_DAYS = original;
  });

  it("falls back when env is missing or unparseable", () => {
    expect(__testing.readLookbackDays(7)).toBe(7);
    process.env.SHADOW_DRIFT_LOOKBACK_DAYS = "not-a-number";
    expect(__testing.readLookbackDays(7)).toBe(7);
    process.env.SHADOW_DRIFT_LOOKBACK_DAYS = "-5";
    expect(__testing.readLookbackDays(7)).toBe(7);
    process.env.SHADOW_DRIFT_LOOKBACK_DAYS = "0";
    expect(__testing.readLookbackDays(7)).toBe(7);
    process.env.SHADOW_DRIFT_LOOKBACK_DAYS = "91";
    expect(__testing.readLookbackDays(7)).toBe(7);
  });

  it("accepts a valid override in [1, 90]", () => {
    process.env.SHADOW_DRIFT_LOOKBACK_DAYS = "14";
    expect(__testing.readLookbackDays(7)).toBe(14);
  });
});
