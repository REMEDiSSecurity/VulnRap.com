// Task #296 — UI integration coverage for the wrong-token cooldown banner +
// re-arm-button gating on the AVRI drift admin (NotifiedFlagsPanel inside
// AvriDriftSection).
//
// Task #212 already wires the banner + button-disable pattern into the
// calibration dashboard and handwavy admin. The AVRI drift admin still
// surfaced the raw "HTTP 429" toast on its re-arm button when the per-IP
// wrong-token throttle (Task #116) tripped, even though the shared
// `useCalibrationCooldown` hook already had every piece of state it
// needed. Task #296 mounts the banner inside AvriDriftSection and gates
// the re-arm button on `cooldown.active` — these specs pin that down so
// a future refactor can't silently regress the AVRI screen back to the
// raw-toast experience.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCalibrationToken } from "@workspace/api-client-react";
import FeedbackAnalytics from "./feedback-analytics";
import {
  applyRateLimitNotice,
  resetCalibrationCooldown,
} from "@/lib/calibration-cooldown";

const SERVER_TOKEN = "server-side-reviewer-token";

// Minimal payload — exactly enough that FeedbackAnalytics doesn't fall
// into its EmptyState branch (which would skip rendering CalibrationSection
// + AvriDriftSection entirely).
const FEEDBACK_ANALYTICS = {
  summary: {
    totalFeedback: 12,
    avgRating: 4.2,
    helpfulCount: 9,
    notHelpfulCount: 3,
    helpfulnessRate: 75,
    withComments: 5,
    linkedToReport: 8,
  },
  ratingDistribution: { "1": 0, "2": 1, "3": 2, "4": 4, "5": 5 },
  dailyTrend: [],
  scoreCorrelation: [],
  outliers: [],
  recentFeedback: [],
};

const SCORING_CONFIG_ITEM = {
  version: "v0.0.1",
  createdAt: "2026-04-29T00:00:00.000Z",
  prior: 50,
  floor: 0,
  ceiling: 100,
  axisThresholds: {},
  tierThresholds: { low: 33, high: 66 },
  fabricationBoost: 0,
  description: "test fixture",
};

const CALIBRATION_REPORT = {
  currentConfig: SCORING_CONFIG_ITEM,
  totalFeedbackAnalyzed: 12,
  bucketAnalysis: [],
  suggestions: [],
  overallHealth: "good" as const,
  minFeedbackThreshold: 10,
};

const SCORING_CONFIG_RESPONSE = {
  current: SCORING_CONFIG_ITEM,
  history: [],
};

const AVRI_DRIFT_REPORT = {
  generatedAt: "2026-04-29T00:00:00.000Z",
  weeksRequested: 8,
  totalReportsScanned: 0,
  cohort: "avri_on_only" as const,
  bucketingNote: "noop",
  thresholds: { gapWarn: 45, familyShiftWarn: 5, minBucketSize: 3 },
  weeks: [],
  flags: [],
  runbookPath: "docs/avri-drift-runbook.md",
};

// Two notified flags so the panel renders two re-arm buttons — that lets
// us assert the disable behaviour applies to every row, not just the first
// (a cooldown gate that only flipped one row would miss the next one a
// reviewer clicked).
const AVRI_DRIFT_NOTIFICATIONS = {
  notified: [
    {
      key: "GAP_BELOW_45::2026-04-13",
      weekStart: "2026-04-13",
      kind: "GAP_BELOW_45" as const,
      notifiedAt: "2026-04-14T09:00:00.000Z",
      detail: "T1−T3 gap of 41pt is below the 45pt warn line.",
    },
    {
      key: "FAMILY_SHIFT::2026-04-20::xss",
      weekStart: "2026-04-20",
      kind: "FAMILY_SHIFT" as const,
      notifiedAt: "2026-04-21T10:30:00.000Z",
      detail: "xss family mean shifted by 6pt week-over-week.",
    },
  ],
  total: 2,
};

const HANDWAVY_PHRASES = { phrases: [], total: 0 };
const REMOVAL_BATCHES = { batches: [], total: 0, hasMore: false };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock(): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes("/api/feedback/calibration/auth-status")) {
      // The page is rendered with a configured reviewer token, so the
      // probe should return tokenValid: true and mutationsAllowed: true.
      // That's what unlocks NotifiedFlagsPanel's data fetch.
      return jsonResponse({
        serverRequiresToken: true,
        tokenPresented: true,
        tokenValid: true,
        mutationsAllowed: true,
      });
    }

    // Match most-specific calibration sub-routes BEFORE the general
    // /api/feedback/calibration so the report endpoint doesn't swallow
    // them. Mirrors the order in feedback-analytics-auth.test.tsx.
    if (url.includes("/api/feedback/calibration/avri-drift/notifications")) {
      return jsonResponse(AVRI_DRIFT_NOTIFICATIONS);
    }
    if (url.includes("/api/feedback/calibration/avri-drift/scheduler-status")) {
      return jsonResponse([
        {
          replicaId: "test-replica-A",
          hostname: "test-host",
          heartbeatAt: null,
          schedulerStarted: false,
          webhookConfigured: false,
          ticksCompleted: 0,
          startedAt: null,
          lastTickAt: null,
          nextTickAt: null,
          lastTickOk: null,
          lastTickRanCheck: false,
          lastTickDispatched: false,
          lastTickNewFlagCount: 0,
          intervalMs: null,
          retryIntervalMs: null,
        },
      ]);
    }
    if (url.includes("/api/feedback/calibration/avri-drift")) {
      return jsonResponse(AVRI_DRIFT_REPORT);
    }
    if (url.includes("/api/feedback/calibration/config")) {
      return jsonResponse(SCORING_CONFIG_RESPONSE);
    }
    if (
      url.includes("/api/feedback/calibration/handwavy-phrases/removal-batches")
    ) {
      return jsonResponse(REMOVAL_BATCHES);
    }
    if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
      return jsonResponse(HANDWAVY_PHRASES);
    }
    if (url.includes("/api/feedback/calibration")) {
      return jsonResponse(CALIBRATION_REPORT);
    }
    if (url.includes("/api/feedback/analytics")) {
      return jsonResponse(FEEDBACK_ANALYTICS);
    }
    return jsonResponse({});
  });
  return spy;
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/feedback-analytics"]}>
        <FeedbackAnalytics />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AvriDriftSection — calibration cooldown banner + re-arm gating (Task #296)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setCalibrationToken(SERVER_TOKEN);
    resetCalibrationCooldown();
  });

  afterEach(() => {
    setCalibrationToken(null);
    resetCalibrationCooldown();
    fetchSpy?.mockRestore();
  });

  it("does not render the cooldown banner while the throttle is idle", async () => {
    fetchSpy = installFetchMock();
    renderPage();

    // Wait for the AVRI drift section to mount + load.
    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });
    // Wait for the re-arm buttons to render so we know NotifiedFlagsPanel
    // is past its loading spinner.
    await screen.findAllByTestId(
      "avri-drift-rearm-button",
      {},
      { timeout: 5_000 },
    );

    // The banner should be entirely absent in the common idle case.
    expect(
      screen.queryAllByTestId("calibration-cooldown-banner"),
    ).toHaveLength(0);

    // Re-arm buttons should be enabled and reading "Re-arm".
    const buttons = screen.getAllByTestId("avri-drift-rearm-button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const btn of buttons) {
      expect(btn).not.toBeDisabled();
      expect(btn).toHaveAttribute("data-cooldown-active", "false");
      expect(btn).toHaveTextContent(/^Re-arm$/);
    }
  });

  it("mounts the banner above the AVRI drift card and disables every re-arm button when a calibration 429 lands", async () => {
    fetchSpy = installFetchMock();
    renderPage();

    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });
    const initialButtons = await screen.findAllByTestId(
      "avri-drift-rearm-button",
      {},
      { timeout: 5_000 },
    );
    expect(initialButtons.length).toBe(2);

    // Simulate the shared API client receiving a 429 from a calibration
    // mutation route. The cooldown store dispatches synchronously; the
    // useSyncExternalStore subscribers re-render in the next tick.
    act(() => {
      applyRateLimitNotice({
        method: "POST",
        url: "/api/feedback/calibration/avri-drift/notifications/rearm",
        status: 429,
        retryAfterMs: 7_000,
        resetAt: Date.now() + 7_000,
        limit: 4,
        remaining: 0,
        body: {
          error: "Too many failed calibration auth attempts. Try again later.",
        },
        headers: new Headers(),
      });
    });

    // The banner should pop in. Task #419 — the page-level coordinator
    // (CalibrationCooldownBannerProvider) hoists the banner so even though
    // CalibrationSection, HandwavyPhrasesAdmin, and AvriDriftSection each
    // opt-in via <CalibrationCooldownBanner>, only the topmost-in-DOM
    // instance renders the visible card. Assert exactly one is visible
    // here so a future regression that brings back the stack of three
    // identical banners gets caught.
    const banners = await screen.findAllByTestId(
      "calibration-cooldown-banner",
      {},
      { timeout: 5_000 },
    );
    expect(banners).toHaveLength(1);
    // Headlines should match the friendly copy. We don't pin the exact
    // second count here (the store rounds up against Date.now and tests
    // shouldn't depend on real-clock skew), just the headline shape.
    for (const banner of banners) {
      expect(
        within(banner).getByTestId("calibration-cooldown-headline"),
      ).toHaveTextContent(/try again in \d+ seconds?/i);
    }

    // Every re-arm button must flip to disabled + cooldown label so a
    // reviewer can't keep firing rejected requests at the limiter.
    await waitFor(() => {
      const buttons = screen.getAllByTestId("avri-drift-rearm-button");
      expect(buttons.length).toBe(2);
      for (const btn of buttons) {
        expect(btn).toBeDisabled();
        expect(btn).toHaveAttribute("data-cooldown-active", "true");
        expect(btn).toHaveTextContent(/Cooldown — \d+s/);
        expect(btn).toHaveAttribute(
          "title",
          expect.stringMatching(/Calibration cooldown active/i),
        );
      }
    });
  });

  it("ignores 429s that fire on non-calibration URLs (a /reports 429 must not gate the AVRI re-arm buttons)", async () => {
    fetchSpy = installFetchMock();
    renderPage();

    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });
    await screen.findAllByTestId(
      "avri-drift-rearm-button",
      {},
      { timeout: 5_000 },
    );

    // A 429 on a non-calibration URL must NOT trip the cooldown — that
    // throttle is its own beast (Task #92's report-submit limiter, etc.)
    // and surfaces elsewhere.
    act(() => {
      applyRateLimitNotice({
        method: "POST",
        url: "/api/reports/submit",
        status: 429,
        retryAfterMs: 60_000,
        resetAt: Date.now() + 60_000,
        limit: 10,
        remaining: 0,
        body: { error: "Submit throttle." },
        headers: new Headers(),
      });
    });

    // The banner should stay absent — the unrelated throttle is not the
    // calibration cooldown's concern.
    expect(
      screen.queryAllByTestId("calibration-cooldown-banner"),
    ).toHaveLength(0);

    // Re-arm buttons stay enabled with the normal label.
    for (const btn of screen.getAllByTestId("avri-drift-rearm-button")) {
      expect(btn).not.toBeDisabled();
      expect(btn).toHaveTextContent(/^Re-arm$/);
    }
  });
});
