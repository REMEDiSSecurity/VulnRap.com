// Task #418 — NotifiedFlagsPanel must keep its rows on screen across
// every tick of an active wrong-token cooldown countdown, even if the
// dedup query gets invalidated mid-countdown and a refetch lands a
// transiently-empty payload.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
} from "@tanstack/react-query";
import {
  setCalibrationToken,
  getGetAvriDriftNotificationsQueryKey,
} from "@workspace/api-client-react";
import {
  applyRateLimitNotice,
  resetCalibrationCooldown,
} from "@/lib/calibration-cooldown";
import FeedbackAnalytics from "./feedback-analytics";

const SERVER_TOKEN = "server-side-reviewer-token";

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

const NOTIFIED = [
  {
    key: "GAP_BELOW_45::2026-04-13",
    weekStart: "2026-04-13",
    kind: "GAP_BELOW_45" as const,
    notifiedAt: "2026-04-14T09:00:00.000Z",
    detail: "T1−T3 gap of 41pt is below the 45pt warn line.",
  },
  {
    key: "FAMILY_MEAN_SHIFT::2026-04-20::xss",
    weekStart: "2026-04-20",
    kind: "FAMILY_MEAN_SHIFT" as const,
    notifiedAt: "2026-04-21T10:30:00.000Z",
    detail: "xss family mean shifted by 6pt week-over-week.",
  },
];

const HANDWAVY_PHRASES = { phrases: [], total: 0 };
const REMOVAL_BATCHES = { batches: [], total: 0, hasMore: false };
const REARM_HISTORY = { history: [], total: 0 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface MockHandle {
  spy: ReturnType<typeof vi.spyOn>;
  notifiedFetchCount: { value: number };
  // When true, the GET dedup endpoint serves an empty list — used to
  // simulate a transient empty refetch landing during the cooldown.
  serveEmpty: { value: boolean };
}

function installFetchMock(): MockHandle {
  const notifiedFetchCount = { value: 0 };
  const serveEmpty = { value: false };
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/api/feedback/calibration/auth-status")) {
      return jsonResponse({
        serverRequiresToken: true,
        tokenPresented: true,
        tokenValid: true,
        mutationsAllowed: true,
      });
    }
    if (
      url.includes(
        "/api/feedback/calibration/avri-drift/notifications/rearm-history",
      )
    ) {
      return jsonResponse(REARM_HISTORY);
    }
    if (
      url.includes("/api/feedback/calibration/avri-drift/notifications/rearm")
    ) {
      return jsonResponse({
        rearmed: 0,
        notFound: [],
        remaining: NOTIFIED.length,
        removed: [],
        notified: NOTIFIED,
      });
    }
    if (url.includes("/api/feedback/calibration/avri-drift/notifications")) {
      if (method === "GET") {
        notifiedFetchCount.value += 1;
        if (serveEmpty.value) {
          return jsonResponse({ notified: [], total: 0 });
        }
      }
      return jsonResponse({ notified: NOTIFIED, total: NOTIFIED.length });
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
  return { spy, notifiedFetchCount, serveEmpty };
}

function renderPage(): { client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/feedback-analytics"]}>
        <FeedbackAnalytics />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client };
}

async function waitForRowsToRender() {
  await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });
  for (const r of NOTIFIED) {
    await screen.findByTestId(
      `notified-flag-checkbox-${r.key}`,
      {},
      { timeout: 5_000 },
    );
  }
}

// Push pending microtasks (React Query + React commit phase) through.
async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("NotifiedFlagsPanel — pinned data while a cooldown ticks (Task #418)", () => {
  let mock: MockHandle;

  beforeEach(() => {
    setCalibrationToken(SERVER_TOKEN);
    resetCalibrationCooldown();
  });

  afterEach(() => {
    setCalibrationToken(null);
    resetCalibrationCooldown();
    mock?.spy.mockRestore();
    vi.useRealTimers();
  });

  it("keeps every row on screen for the full 7-second cooldown countdown", async () => {
    mock = installFetchMock();
    const { client } = renderPage();
    await waitForRowsToRender();

    const baselineFetchCount = mock.notifiedFetchCount.value;
    expect(baselineFetchCount).toBeGreaterThan(0);

    const notificationsQueryKey: QueryKey =
      getGetAvriDriftNotificationsQueryKey();

    // Switch to fake timers AFTER the initial render + initial data fetch
    // have settled so the React Query bootstrap isn't blocked on a frozen
    // clock. From here on every timer tick is driven explicitly.
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const cooldownStart = Date.UTC(2026, 3, 30, 12, 0, 0);
    vi.setSystemTime(cooldownStart);

    // Fire the 429 the same way the shared API client would after a
    // wrong-token POST. retryAfterMs of 8s gives us a full 7s window
    // to walk while the cooldown is still active (the deadline tick
    // itself clears the cooldown so we stop just before it lands).
    act(() => {
      applyRateLimitNotice({
        method: "POST",
        url: "/api/feedback/calibration/avri-drift/notifications/rearm",
        status: 429,
        retryAfterMs: 8_000,
        resetAt: cooldownStart + 8_000,
        limit: 4,
        remaining: 0,
        body: {
          error: "Too many failed calibration auth attempts. Try again later.",
        },
        headers: new Headers(),
      });
    });

    // Flip the dedup endpoint to serve `{notified: []}` so any refetch
    // we trigger during the cooldown would, on main, replace the rows
    // with the "no previously-notified flags" placeholder.
    mock.serveEmpty.value = true;

    // Walk the 7-second countdown in 500ms steps (matching the
    // useCalibrationCooldown interval). At every tick the row checkboxes
    // must still be in the document, and the "no previously-notified
    // flags" empty placeholder must never replace them. Mid-countdown
    // we also force two dedup-query invalidations to land empty refetch
    // responses against the panel.
    let getsAfterFlip = 0;
    for (let stepMs = 500; stepMs <= 7_000; stepMs += 500) {
      act(() => {
        vi.advanceTimersByTime(500);
      });
      await flushMicrotasks();

      if (stepMs === 2_000 || stepMs === 4_000) {
        const before = mock.notifiedFetchCount.value;
        await act(async () => {
          await client.invalidateQueries({
            queryKey: notificationsQueryKey,
          });
        });
        await flushMicrotasks();
        // Sanity: invalidateQueries must actually have caused a GET so
        // the "transient empty refetch lands during cooldown" race is
        // genuinely exercised, not silently skipped.
        expect(
          mock.notifiedFetchCount.value,
          `invalidateQueries at elapsed=${stepMs}ms must trigger a refetch`,
        ).toBeGreaterThan(before);
        getsAfterFlip += mock.notifiedFetchCount.value - before;
      }

      for (const r of NOTIFIED) {
        expect(
          screen.queryByTestId(`notified-flag-checkbox-${r.key}`),
          `row ${r.key} must stay rendered at countdown elapsed=${stepMs}ms`,
        ).toBeInTheDocument();
      }
      expect(
        screen.queryByText(/No previously-notified flags/i),
        `empty placeholder must not appear at elapsed=${stepMs}ms`,
      ).not.toBeInTheDocument();
    }

    // We forced two invalidations after flipping serveEmpty, so at least
    // two empty payloads must have landed against the panel without ever
    // unmounting the rows.
    expect(getsAfterFlip).toBeGreaterThanOrEqual(2);

    // Background refetches must stay paused for the cooldown's lifetime.
    // The only new GETs should be the two we explicitly forced via
    // invalidateQueries. A regression that re-armed the periodic poll
    // (refetchInterval still 5 minutes) wouldn't add fetches inside this
    // 7-second window, but a sub-second poll would; the cap catches it.
    const totalGets = mock.notifiedFetchCount.value - baselineFetchCount;
    expect(totalGets).toBeLessThanOrEqual(2);
  });
});
