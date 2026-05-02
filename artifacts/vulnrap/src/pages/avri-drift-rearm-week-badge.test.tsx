// Unit coverage for the per-week "re-armed N times" badge in the AVRI
// drift drilldown and the RearmHistoryPanel's week-filter chip:
// per-week count visibility, click-to-filter behavior, and the
// trimmed-record case (audit entry preserved on a week not in the
// recent-weeks window).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCalibrationToken } from "@workspace/api-client-react";
import FeedbackAnalytics from "./feedback-analytics";
import { resetCalibrationCooldown } from "@/lib/calibration-cooldown";

const SERVER_TOKEN = "server-side-reviewer-token";

// Minimal feedback payload — enough that FeedbackAnalytics doesn't fall
// into its EmptyState branch. Mirrors the fixture shape in
// avri-drift-cooldown.test.tsx.
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

function makeDriftReport() {
  return {
    generatedAt: "2026-04-29T00:00:00.000Z",
    weeksRequested: 8,
    totalReportsScanned: 9,
    cohort: "avri_on_only" as const,
    bucketingNote: "noop",
    thresholds: { gapWarn: 45, familyShiftWarn: 5, minBucketSize: 3 },
    weeks: [
      {
        weekStart: "2026-04-13",
        reportCount: 3,
        t1: { mean: 70, count: 2 },
        t3: { mean: 30, count: 1 },
        gap: 40,
        gapEligible: true,
        perFamily: { t1: [], t3: [] },
      },
      {
        weekStart: "2026-04-20",
        reportCount: 4,
        t1: { mean: 72, count: 2 },
        t3: { mean: 30, count: 2 },
        gap: 42,
        gapEligible: true,
        perFamily: { t1: [], t3: [] },
      },
      {
        weekStart: "2026-04-27",
        reportCount: 2,
        t1: { mean: 75, count: 1 },
        t3: { mean: 25, count: 1 },
        gap: 50,
        gapEligible: true,
        perFamily: { t1: [], t3: [] },
      },
    ],
    flags: [],
    runbookPath: "docs/avri-drift-runbook.md",
  };
}

const AVRI_DRIFT_NOTIFICATIONS = { notified: [], total: 0 };

// 2x for 2026-04-13, 1x for 2026-04-20, 1x for 2026-03-30 (which is
// outside the recent-weeks window in makeDriftReport).
const AVRI_DRIFT_REARM_HISTORY = {
  history: [
    {
      key: "GAP_BELOW_45::2026-04-13",
      weekStart: "2026-04-13",
      kind: "GAP_BELOW_45" as const,
      originalNotifiedAt: "2026-04-14T09:00:00.000Z",
      originalDetail: "T1−T3 gap of 41pt is below the 45pt warn line.",
      rearmedAt: "2026-04-15T10:00:00.000Z",
      rearmedBy: "alice",
    },
    {
      key: "GAP_BELOW_45::2026-04-13",
      weekStart: "2026-04-13",
      kind: "GAP_BELOW_45" as const,
      originalNotifiedAt: "2026-04-14T09:00:00.000Z",
      originalDetail: "T1−T3 gap of 41pt is below the 45pt warn line.",
      rearmedAt: "2026-04-16T11:00:00.000Z",
      rearmedBy: "bob",
    },
    {
      key: "FAMILY_MEAN_SHIFT::2026-04-20::xss",
      weekStart: "2026-04-20",
      kind: "FAMILY_MEAN_SHIFT" as const,
      originalNotifiedAt: "2026-04-21T10:30:00.000Z",
      originalDetail: "xss family mean shifted by 6pt week-over-week.",
      rearmedAt: "2026-04-22T12:00:00.000Z",
    },
    {
      key: "GAP_BELOW_45::2026-03-30",
      weekStart: "2026-03-30",
      kind: "GAP_BELOW_45" as const,
      originalNotifiedAt: "2026-03-31T09:00:00.000Z",
      originalDetail: "Older entry whose dedup record was already trimmed.",
      rearmedAt: "2026-04-01T09:00:00.000Z",
    },
  ],
  total: 4,
};

const AVRI_DRIFT_SCHEDULER_STATUS = {
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
};

const HANDWAVY_PHRASES = { phrases: [], total: 0 };
const REMOVAL_BATCHES = { batches: [], total: 0, hasMore: false };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock(
  rearmHistoryOverride?: unknown,
): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes("/api/feedback/calibration/auth-status")) {
      return jsonResponse({
        serverRequiresToken: true,
        tokenPresented: true,
        tokenValid: true,
        mutationsAllowed: true,
      });
    }
    // Order matters: the rearm-history route is mounted under the
    // notifications path, so its matcher must win against the broader
    // notifications matcher below.
    if (
      url.includes(
        "/api/feedback/calibration/avri-drift/notifications/rearm-history",
      )
    ) {
      return jsonResponse(rearmHistoryOverride ?? AVRI_DRIFT_REARM_HISTORY);
    }
    if (url.includes("/api/feedback/calibration/avri-drift/notifications")) {
      return jsonResponse(AVRI_DRIFT_NOTIFICATIONS);
    }
    if (url.includes("/api/feedback/calibration/avri-drift/scheduler-status")) {
      return jsonResponse(AVRI_DRIFT_SCHEDULER_STATUS);
    }
    if (url.includes("/api/feedback/calibration/avri-drift")) {
      return jsonResponse(makeDriftReport());
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

describe("AvriDriftSection — per-week re-arm badge + audit filter", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setCalibrationToken(SERVER_TOKEN);
    resetCalibrationCooldown();
    // happy-dom doesn't implement scrollIntoView.
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    setCalibrationToken(null);
    resetCalibrationCooldown();
    fetchSpy?.mockRestore();
  });

  it("renders a badge per week with a matching audit entry, with the right count, and skips weeks with no history", async () => {
    fetchSpy = installFetchMock();
    renderPage();

    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });
    const badges = await screen.findAllByTestId(
      "avri-drift-week-rearm-badge",
      {},
      { timeout: 5_000 },
    );

    expect(badges).toHaveLength(2);

    const byWeek = new Map<string, HTMLElement>();
    for (const b of badges) {
      const week = b.getAttribute("data-week-start");
      if (week) byWeek.set(week, b);
    }
    expect(byWeek.has("2026-04-13")).toBe(true);
    expect(byWeek.has("2026-04-20")).toBe(true);
    expect(byWeek.has("2026-04-27")).toBe(false);

    expect(byWeek.get("2026-04-13")).toHaveAttribute("data-rearm-count", "2");
    expect(byWeek.get("2026-04-13")).toHaveTextContent(/re-armed 2 times/);
    expect(byWeek.get("2026-04-20")).toHaveAttribute("data-rearm-count", "1");
    expect(byWeek.get("2026-04-20")).toHaveTextContent(/re-armed 1 time$/);
  });

  it("clicking a badge filters the Recently re-armed panel to that week and Clear filter restores the full feed", async () => {
    fetchSpy = installFetchMock();
    renderPage();

    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });
    const badges = await screen.findAllByTestId(
      "avri-drift-week-rearm-badge",
      {},
      { timeout: 5_000 },
    );
    const badge2026_04_13 = badges.find(
      (b) => b.getAttribute("data-week-start") === "2026-04-13",
    );
    expect(badge2026_04_13).toBeDefined();

    const panel = screen.getByTestId("avri-drift-rearm-history-panel");
    expect(
      within(panel).queryByTestId("avri-drift-rearm-history-filter-chip"),
    ).toBeNull();
    expect(within(panel).getByText(/week 2026-04-20/)).toBeTruthy();

    act(() => {
      fireEvent.click(badge2026_04_13!);
    });

    const chip = await within(panel).findByTestId(
      "avri-drift-rearm-history-filter-chip",
    );
    expect(chip).toHaveAttribute("data-week-filter", "2026-04-13");
    expect(chip).toHaveTextContent(/Filtered to week 2026-04-13/);
    expect(chip).toHaveTextContent(/2 of 4/);

    expect(within(panel).queryByText(/week 2026-04-20/)).toBeNull();
    expect(within(panel).getAllByText(/week 2026-04-13/).length).toBe(2);

    act(() => {
      fireEvent.click(
        within(panel).getByTestId("avri-drift-rearm-history-filter-clear"),
      );
    });
    expect(
      within(panel).queryByTestId("avri-drift-rearm-history-filter-chip"),
    ).toBeNull();
    expect(within(panel).getByText(/week 2026-04-20/)).toBeTruthy();
  });

  it("does not render a badge for audit entries whose week is outside the recent-weeks window, but still surfaces them in the unfiltered feed", async () => {
    fetchSpy = installFetchMock({
      history: [
        {
          key: "FAMILY_MEAN_SHIFT::2026-04-20::xss",
          weekStart: "2026-04-20",
          kind: "FAMILY_MEAN_SHIFT" as const,
          originalNotifiedAt: "2026-04-21T10:30:00.000Z",
          originalDetail: "xss family mean shifted by 6pt week-over-week.",
          rearmedAt: "2026-04-22T12:00:00.000Z",
        },
        // weekStart isn't in the report's recent-weeks list — simulates
        // an audit entry whose dedup record was already trimmed.
        {
          key: "GAP_BELOW_45::2026-03-30",
          weekStart: "2026-03-30",
          kind: "GAP_BELOW_45" as const,
          originalNotifiedAt: "2026-03-31T09:00:00.000Z",
          originalDetail:
            "Older entry whose dedup record was already trimmed.",
          rearmedAt: "2026-04-01T09:00:00.000Z",
        },
      ],
      total: 2,
    });
    renderPage();

    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });
    const badges = await screen.findAllByTestId(
      "avri-drift-week-rearm-badge",
      {},
      { timeout: 5_000 },
    );

    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveAttribute("data-week-start", "2026-04-20");
    expect(badges[0]).toHaveAttribute("data-rearm-count", "1");

    const panel = screen.getByTestId("avri-drift-rearm-history-panel");
    expect(within(panel).getByText(/week 2026-03-30/)).toBeTruthy();
    expect(within(panel).getByText(/week 2026-04-20/)).toBeTruthy();
  });
});
