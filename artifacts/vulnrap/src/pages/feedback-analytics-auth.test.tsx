import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCalibrationToken } from "@workspace/api-client-react";
import FeedbackAnalytics from "./feedback-analytics";

// Task #216 — UI end-to-end coverage for the reviewer-token indicator
// (Task #117) on the Feedback Analytics page.
//
// The badge in the Scoring Calibration card header (and its sibling
// "calibration mutations will be rejected" banner) is driven by the
// generated `useGetCalibrationAuthStatus` hook. Backend coverage already
// pins down the auth-status endpoint's response (see
// artifacts/api-server/src/routes/calibration-auth.route.test.ts), but
// nothing on the React side asserted that the hook actually flips the badge
// text from "missing" → "configured" → "not required" based on the probe's
// payload — so a future codegen run that drifted the query key (or a hook
// rename) could silently stop the probe firing without any test failing.
//
// These specs render the real FeedbackAnalytics page against a mocked
// fetch that emulates two different api-server postures and one UI build
// posture:
//
//   1. Open mode  — server has no `CALIBRATION_TOKEN`. The page must show
//      the neutral "Reviewer token: not required" chip and MUST NOT show
//      the red "calibration mutations will be rejected" banner.
//   2. Missing mode — server requires a token but the UI build did not
//      bake `VITE_CALIBRATION_TOKEN` (so customFetch sends no
//      X-Calibration-Token header). The page must show the red
//      "Reviewer token: missing" chip AND the rejection banner.
//   3. Configured mode — server requires a token and the build supplies
//      the matching one. The page must show the green
//      "Reviewer token: configured" chip and MUST NOT show the banner.
//
// The mock decides the auth-status response based on the request headers
// it actually receives, so the assertion proves both that the probe is
// being fired AND that customFetch is correctly attaching the
// X-Calibration-Token header when `setCalibrationToken(...)` is set.

const SERVER_TOKEN = "server-side-reviewer-token";
const CORRECT_UI_TOKEN = SERVER_TOKEN;

interface AuthStatus {
  serverRequiresToken: boolean;
  tokenPresented: boolean;
  tokenValid: boolean;
  mutationsAllowed: boolean;
}

// Minimal but non-empty FeedbackAnalytics payload — the page short-circuits
// to an EmptyState when summary.totalFeedback is 0, and that branch never
// renders the CalibrationSection (which is what owns the badge + banner).
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

const HANDWAVY_PHRASES = {
  phrases: [],
  total: 0,
};

const REMOVAL_BATCHES = {
  batches: [],
  total: 0,
  hasMore: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function readHeader(
  init: RequestInit | undefined,
  name: string,
): string | null {
  if (!init?.headers) return null;
  const headers = new Headers(init.headers);
  return headers.get(name);
}

function buildAuthStatus(opts: {
  serverRequiresToken: boolean;
  presentedToken: string | null;
}): AuthStatus {
  const tokenPresented = opts.presentedToken !== null;
  const tokenValid =
    opts.serverRequiresToken &&
    tokenPresented &&
    opts.presentedToken === SERVER_TOKEN;
  const mutationsAllowed = !opts.serverRequiresToken || tokenValid;
  return {
    serverRequiresToken: opts.serverRequiresToken,
    tokenPresented,
    tokenValid,
    mutationsAllowed,
  };
}

function installFetchMock(opts: {
  serverRequiresToken: boolean;
}): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes("/api/feedback/calibration/auth-status")) {
      const presented =
        readHeader(init, "x-calibration-token") ??
        (() => {
          const auth = readHeader(init, "authorization");
          if (auth && /^Bearer\s+(.+)$/i.test(auth)) {
            return auth.replace(/^Bearer\s+/i, "");
          }
          return null;
        })();
      return jsonResponse(
        buildAuthStatus({
          serverRequiresToken: opts.serverRequiresToken,
          presentedToken: presented,
        }),
      );
    }

    // Match the most-specific calibration sub-routes BEFORE the general
    // /api/feedback/calibration so the report endpoint doesn't swallow
    // them.
    if (url.includes("/api/feedback/calibration/avri-drift/scheduler-status")) {
      // Per Task #397 the scheduler-status response is an array of
      // per-replica snapshots. The auth test only renders the chrome,
      // so a single empty placeholder replica is enough.
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

    // Anything else gets a benign 200 + empty body so a missed mock doesn't
    // throw an unhandled rejection in the test.
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

describe("FeedbackAnalytics — reviewer-token indicator (Task #216 / #117)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setCalibrationToken(null);
  });

  afterEach(() => {
    setCalibrationToken(null);
    fetchSpy?.mockRestore();
  });

  it("renders the neutral 'not required' chip (and no rejection banner) when the API server has no CALIBRATION_TOKEN configured", async () => {
    fetchSpy = installFetchMock({ serverRequiresToken: false });

    renderPage();

    const badge = await screen.findByText(
      /Reviewer token: not required/i,
      {},
      { timeout: 5_000 },
    );
    expect(badge).toBeInTheDocument();

    // The red banner only appears in "missing" / "invalid" states; "open"
    // mode must stay clean.
    expect(
      screen.queryByText(/Calibration mutations will be rejected/i),
    ).not.toBeInTheDocument();

    // Sanity: the auth-status probe must actually have fired. If a future
    // codegen run drifted the query key or renamed the hook, this would
    // catch the regression because the mock would never be called for
    // the auth-status URL.
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/feedback/calibration/auth-status"),
        expect.anything(),
      );
    });
  });

  it("renders the red 'missing' chip and the rejection banner when the server requires a token but the UI build did not supply VITE_CALIBRATION_TOKEN", async () => {
    fetchSpy = installFetchMock({ serverRequiresToken: true });
    // Simulate a UI build with no VITE_CALIBRATION_TOKEN baked in: main.tsx
    // would call setCalibrationToken(undefined), which clears the in-memory
    // token, so customFetch sends no X-Calibration-Token header.
    setCalibrationToken(undefined);

    renderPage();

    const badge = await screen.findByText(
      /Reviewer token: missing/i,
      {},
      { timeout: 5_000 },
    );
    expect(badge).toBeInTheDocument();

    // The prominent banner above the calibration UI must also be visible
    // so reviewers don't burn clicks finding out the hard way.
    expect(
      screen.getByText(/Calibration mutations will be rejected/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/VITE_CALIBRATION_TOKEN was unset at build time/i),
    ).toBeInTheDocument();
  });

  it("renders the green 'configured' chip (and no rejection banner) when the build's reviewer token matches the server's", async () => {
    fetchSpy = installFetchMock({ serverRequiresToken: true });
    // Simulate a UI build that baked the correct VITE_CALIBRATION_TOKEN —
    // customFetch will attach it as X-Calibration-Token, the auth-status
    // probe will return tokenValid=true, and the badge should flip green.
    setCalibrationToken(CORRECT_UI_TOKEN);

    renderPage();

    const badge = await screen.findByText(
      /Reviewer token: configured/i,
      {},
      { timeout: 5_000 },
    );
    expect(badge).toBeInTheDocument();

    expect(
      screen.queryByText(/Calibration mutations will be rejected/i),
    ).not.toBeInTheDocument();
  });
});
