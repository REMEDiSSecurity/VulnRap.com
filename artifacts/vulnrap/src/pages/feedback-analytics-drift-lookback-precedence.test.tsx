// Task #381 — Component-level coverage for the AVRI drift lookback URL ↔
// localStorage precedence rules inside `AvriDriftSection`.
//
// Task #270 already pinned the small helpers (`isValidDriftLookback`,
// `parseDriftLookback`, `readStoredDriftLookback`) but the precedence logic
// that *combines* them at the top of `AvriDriftSection` — and the
// first-render effect that normalizes the URL — was only verified manually
// in the browser. The four contracts locked here are:
//
//   - URL present + valid     -> URL wins (a shared link beats local state).
//   - URL present + invalid   -> fall back to the DEFAULT (8), NOT to
//                                storage, so a garbled link can't surface
//                                reviewer-specific behaviour. Bad query
//                                param is also stripped from the URL.
//   - URL absent + storage    -> storage wins, and the URL is rewritten
//                                so the address bar matches what's on
//                                screen (shareable).
//   - URL absent + no storage -> default (8), URL stays clean.
//
// We mount the real `FeedbackAnalytics` page (the same pattern used by
// `avri-drift-cooldown.test.tsx`) and add a `<URLSpy>` so we can read
// `useSearchParams` from outside the section under test.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import FeedbackAnalytics, {
  AVRI_DRIFT_LOOKBACK_STORAGE_KEY,
} from "./feedback-analytics";

// ---------------------------------------------------------------------------
// Minimal API payloads — exactly enough that FeedbackAnalytics renders the
// AvriDriftSection (i.e. it doesn't fall into the "no feedback yet" empty
// state). Mirrors the fixtures in avri-drift-cooldown.test.tsx.

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

function makeDriftReport(weeksRequested: number) {
  return {
    generatedAt: "2026-04-29T00:00:00.000Z",
    weeksRequested,
    totalReportsScanned: 0,
    cohort: "avri_on_only" as const,
    bucketingNote: "noop",
    thresholds: { gapWarn: 45, familyShiftWarn: 5, minBucketSize: 3 },
    weeks: [],
    flags: [],
    runbookPath: "docs/avri-drift-runbook.md",
  };
}

const AVRI_DRIFT_NOTIFICATIONS = { notified: [], total: 0 };
const AVRI_DRIFT_REARM_HISTORY = { entries: [], total: 0 };
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

function installFetchMock(): {
  spy: ReturnType<typeof vi.spyOn>;
  // Captures every URL used to fetch the AVRI drift report, including
  // the `?weeks=N` query string. Tests assert against this so the
  // precedence contract is locked at *both* the visible chrome (active
  // radio) and the API call (which `weeks` we actually fetched).
  driftReportUrls: string[];
} {
  const driftReportUrls: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes("/api/feedback/calibration/auth-status")) {
      // No reviewer token in these tests; the calibration card stays in
      // its read-only state. AvriDriftSection still renders the chooser
      // and the URL/storage precedence logic runs regardless.
      return jsonResponse({
        serverRequiresToken: true,
        tokenPresented: false,
        tokenValid: false,
        mutationsAllowed: false,
      });
    }
    // Order matters — the more specific calibration sub-routes have to
    // win against the broader /api/feedback/calibration matcher below.
    if (url.includes("/api/feedback/calibration/avri-drift/notifications")) {
      return jsonResponse(AVRI_DRIFT_NOTIFICATIONS);
    }
    if (url.includes("/api/feedback/calibration/avri-drift/rearm-history")) {
      return jsonResponse(AVRI_DRIFT_REARM_HISTORY);
    }
    if (url.includes("/api/feedback/calibration/avri-drift/scheduler-status")) {
      return jsonResponse(AVRI_DRIFT_SCHEDULER_STATUS);
    }
    if (url.includes("/api/feedback/calibration/avri-drift")) {
      driftReportUrls.push(url);
      // Return a payload whose `weeksRequested` echoes the requested
      // window so any "default-vs-26 mix-up" would also surface in the
      // visible chrome ("· last Nw").
      const m = url.match(/[?&]weeks=(\d+)/);
      const weeks = m ? Number(m[1]) : 8;
      return jsonResponse(makeDriftReport(weeks));
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
  return { spy, driftReportUrls };
}

// Reads the current router search string from inside the same MemoryRouter
// that hosts AvriDriftSection, so we can assert what its first-render effect
// did to the URL. Everything after the "?" — order-independent and free of a
// leading "?".
function URLSpy() {
  const [searchParams] = useSearchParams();
  return (
    <span data-testid="drift-lookback-url-spy">{searchParams.toString()}</span>
  );
}

function renderPage(initialUrl: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <URLSpy />
        <FeedbackAnalytics />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function getActiveLookbackLabel(): string {
  // Scope the lookup to the lookback radiogroup specifically — the
  // FeedbackAnalytics page renders other radio groups (e.g. cohort
  // delta warn-threshold) and a top-level `getAllByRole("radio")` would
  // become brittle if a future radio group is added above the drift
  // section. The chooser's labels read "4w" / "8w" / "13w" / "26w" and
  // its aria-checked attribute reflects the selected weeks; this
  // helper returns just the number (e.g. "8") for clean asserts.
  const group = screen.getByRole("radiogroup", {
    name: /Lookback window \(weeks\)/i,
  });
  const radios = within(group).getAllByRole("radio");
  const active = radios.find(
    (r) => r.getAttribute("aria-checked") === "true",
  );
  if (!active) {
    throw new Error(
      `No active lookback radio found. Saw: ${radios
        .map((r) => `${r.textContent}=${r.getAttribute("aria-checked")}`)
        .join(", ")}`,
    );
  }
  return (active.textContent ?? "").replace(/w$/, "").trim();
}

function getUrlSearch(): string {
  return screen.getByTestId("drift-lookback-url-spy").textContent ?? "";
}

// Returns the `weeks=N` value extracted from the captured drift-report URL.
// We assert against both the active radio (visible state) AND the request
// URL so a future regression that sends one weeks value to the API while
// highlighting another in the chooser is caught.
function lastDriftReportWeeks(driftReportUrls: string[]): string | null {
  if (driftReportUrls.length === 0) return null;
  const last = driftReportUrls[driftReportUrls.length - 1];
  const m = last.match(/[?&]weeks=(\d+)/);
  return m ? m[1] : null;
}

describe("AvriDriftSection — URL ↔ localStorage lookback precedence (Task #381)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.removeItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    window.localStorage.removeItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY);
  });

  it("URL present + valid wins over storage (?driftWeeks=26 + storage=4 → 26)", async () => {
    // Storage holds "4" — the *previous* reviewer's local choice — but the
    // URL carries a shared link asking for 26 weeks. The link wins so the
    // shared view is what reviewers see when they click it.
    window.localStorage.setItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY, "4");
    let driftReportUrls: string[];
    ({ spy: fetchSpy, driftReportUrls } = installFetchMock());

    renderPage("/feedback-analytics?driftWeeks=26");

    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });

    expect(getActiveLookbackLabel()).toBe("26");
    // The URL is left intact — no normalization needed since the param is
    // already valid.
    expect(getUrlSearch()).toBe("driftWeeks=26");
    // And the API call also went out for 26 weeks (i.e. storage's "4"
    // didn't sneak through to the request).
    expect(lastDriftReportWeeks(driftReportUrls)).toBe("26");
  });

  it("URL present + invalid falls back to the default (?driftWeeks=abc → 8) and strips the bad query param", async () => {
    // Even with storage holding a different value, an invalid URL must NOT
    // fall through to storage — that would let a garbled link silently
    // produce reviewer-specific behaviour. We also expect the bad param to
    // be stripped from the URL on first render so the address bar matches
    // the visible state and the link, if re-shared, is sane.
    window.localStorage.setItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY, "13");
    let driftReportUrls: string[];
    ({ spy: fetchSpy, driftReportUrls } = installFetchMock());

    renderPage("/feedback-analytics?driftWeeks=abc");

    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });

    expect(getActiveLookbackLabel()).toBe("8");
    // First-render effect strips the malformed value from the URL.
    await waitFor(() => {
      expect(getUrlSearch()).toBe("");
    });
    // Belt-and-braces: the API was queried with weeks=8 (the default),
    // not weeks=13 (the value sitting in storage).
    expect(lastDriftReportWeeks(driftReportUrls)).toBe("8");
  });

  it("URL absent + storage='13' selects 13 and rewrites the URL to ?driftWeeks=13", async () => {
    // No URL param means the stored value wins. The first-render effect
    // then rewrites the URL so the address bar reflects what's on screen
    // and the view is shareable as-is.
    window.localStorage.setItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY, "13");
    let driftReportUrls: string[];
    ({ spy: fetchSpy, driftReportUrls } = installFetchMock());

    renderPage("/feedback-analytics");

    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });

    expect(getActiveLookbackLabel()).toBe("13");
    await waitFor(() => {
      expect(getUrlSearch()).toBe("driftWeeks=13");
    });
    expect(lastDriftReportWeeks(driftReportUrls)).toBe("13");
  });

  it("URL absent + empty storage selects the default (8) and leaves the URL clean", async () => {
    // The "fresh reviewer" case. The default doesn't get echoed into the
    // URL because that would clutter shared links with a redundant param
    // — only non-default values are added by the normalization effect.
    let driftReportUrls: string[];
    ({ spy: fetchSpy, driftReportUrls } = installFetchMock());

    renderPage("/feedback-analytics");

    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });

    expect(getActiveLookbackLabel()).toBe("8");
    // Give the first-render effect a chance to run; assert the URL stays
    // untouched (no driftWeeks added).
    await waitFor(() => {
      expect(getUrlSearch()).toBe("");
    });
    expect(lastDriftReportWeeks(driftReportUrls)).toBe("8");
  });
});
