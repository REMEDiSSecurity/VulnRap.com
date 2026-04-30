import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCalibrationToken } from "@workspace/api-client-react";
import FeedbackAnalytics, { buildRearmHistoryCsv } from "./feedback-analytics";

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

const AVRI_DRIFT_NOTIFICATIONS = { notified: [], total: 0 };
const HANDWAVY_PHRASES = { phrases: [], total: 0 };
const REMOVAL_BATCHES = { batches: [], total: 0, hasMore: false };

const REARM_HISTORY_TWO = {
  history: [
    {
      key: "GAP_BELOW_45::2026-04-13",
      weekStart: "2026-04-13",
      kind: "GAP_BELOW_45" as const,
      originalNotifiedAt: "2026-04-14T09:00:00.000Z",
      originalDetail: "T1−T3 gap of 41pt is below the 45pt warn line.",
      rearmedAt: "2026-04-15T12:00:00.000Z",
      rearmedBy: "alice",
      rationale: "investigated, want to re-fire next week",
    },
    {
      key: "FAMILY_SHIFT::2026-04-20::xss",
      weekStart: "2026-04-20",
      kind: "FAMILY_SHIFT" as const,
      originalNotifiedAt: "2026-04-21T10:30:00.000Z",
      originalDetail: 'xss family mean shifted by 6pt, comma "quoted"\nsecond line.',
      rearmedAt: "2026-04-22T08:15:00.000Z",
      rearmedBy: undefined,
      rationale: undefined,
    },
  ],
  total: 2,
};

const REARM_HISTORY_EMPTY = { history: [], total: 0 };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock(rearmHistory: unknown): ReturnType<typeof vi.spyOn> {
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
    // The rearm-history URL is `/api/feedback/calibration/avri-drift/notifications/rearm-history`,
    // so it has to be matched BEFORE the broader notifications matcher.
    if (
      url.includes(
        "/api/feedback/calibration/avri-drift/notifications/rearm-history",
      )
    ) {
      return jsonResponse(rearmHistory);
    }
    if (url.includes("/api/feedback/calibration/avri-drift/notifications")) {
      return jsonResponse(AVRI_DRIFT_NOTIFICATIONS);
    }
    if (url.includes("/api/feedback/calibration/avri-drift/scheduler-status")) {
      return jsonResponse({
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
      });
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

describe("buildRearmHistoryCsv", () => {
  it("emits the documented header row even with no entries", () => {
    expect(buildRearmHistoryCsv([])).toBe(
      "rearmedAt,rearmedBy,rationale,key,weekStart,kind,originalNotifiedAt,originalDetail",
    );
  });

  it("serialises one entry with all fields populated, in column order", () => {
    const csv = buildRearmHistoryCsv([
      {
        key: "GAP_BELOW_45::2026-04-13",
        weekStart: "2026-04-13",
        kind: "GAP_BELOW_45",
        originalNotifiedAt: "2026-04-14T09:00:00.000Z",
        originalDetail: "T1−T3 gap of 41pt is below the 45pt warn line.",
        rearmedAt: "2026-04-15T12:00:00.000Z",
        rearmedBy: "alice",
        rationale: "investigated",
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "2026-04-15T12:00:00.000Z,alice,investigated,GAP_BELOW_45::2026-04-13,2026-04-13,GAP_BELOW_45,2026-04-14T09:00:00.000Z,T1−T3 gap of 41pt is below the 45pt warn line.",
    );
  });

  it("leaves missing optional fields as empty cells (no 'undefined')", () => {
    const csv = buildRearmHistoryCsv([
      {
        key: "FAMILY_SHIFT::2026-04-20::xss",
        weekStart: "2026-04-20",
        kind: "FAMILY_SHIFT",
        originalNotifiedAt: "2026-04-21T10:30:00.000Z",
        originalDetail: "xss family mean shifted by 6pt week-over-week.",
        rearmedAt: "2026-04-22T08:15:00.000Z",
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe(
      "2026-04-22T08:15:00.000Z,,,FAMILY_SHIFT::2026-04-20::xss,2026-04-20,FAMILY_SHIFT,2026-04-21T10:30:00.000Z,xss family mean shifted by 6pt week-over-week.",
    );
    expect(csv).not.toContain("undefined");
  });

  it("RFC-4180 escapes commas, embedded quotes, and newlines in cells", () => {
    const csv = buildRearmHistoryCsv([
      {
        key: "K",
        weekStart: "2026-04-20",
        kind: "FAMILY_SHIFT",
        originalNotifiedAt: "2026-04-21T10:30:00.000Z",
        originalDetail: 'has, comma and "quoted" word\nplus newline',
        rearmedAt: "2026-04-22T08:15:00.000Z",
        rearmedBy: "bob",
        rationale: "single, line",
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe(
      '2026-04-22T08:15:00.000Z,bob,"single, line",K,2026-04-20,FAMILY_SHIFT,2026-04-21T10:30:00.000Z,"has, comma and ""quoted"" word\nplus newline"',
    );
  });
});

describe("RearmHistoryPanel — Download CSV button", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let createObjectUrlSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectUrlSpy: ReturnType<typeof vi.spyOn>;
  let originalCreateObjectURL: typeof URL.createObjectURL | undefined;
  let originalRevokeObjectURL: typeof URL.revokeObjectURL | undefined;
  let createdBlob: Blob | null;

  beforeEach(() => {
    setCalibrationToken(SERVER_TOKEN);
    createdBlob = null;
    // jsdom doesn't ship URL.createObjectURL, so polyfill before spying.
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = (() => "blob:mock") as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    createObjectUrlSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((blob: Blob | MediaSource) => {
        if (blob instanceof Blob) createdBlob = blob;
        return "blob:mock";
      });
    revokeObjectUrlSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    setCalibrationToken(null);
    fetchSpy?.mockRestore();
    createObjectUrlSpy?.mockRestore();
    revokeObjectUrlSpy?.mockRestore();
    if (originalCreateObjectURL) URL.createObjectURL = originalCreateObjectURL;
    if (originalRevokeObjectURL) URL.revokeObjectURL = originalRevokeObjectURL;
  });

  it("hides the Download CSV button when the audit log is empty", async () => {
    fetchSpy = installFetchMock(REARM_HISTORY_EMPTY);
    renderPage();

    await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });
    // Wait for the panel to settle on its empty-state copy so we know
    // the rearm-history fetch has resolved.
    await screen.findByText(
      /No flags have been re-armed yet/i,
      {},
      { timeout: 5_000 },
    );

    expect(
      screen.queryByTestId("avri-drift-rearm-history-csv"),
    ).not.toBeInTheDocument();
  });

  it("renders the Download CSV button once entries exist and serialises the loaded log when clicked", { timeout: 15_000 }, async () => {
    fetchSpy = installFetchMock(REARM_HISTORY_TWO);
    // Click on a real anchor would attempt a navigation; intercept it
    // and capture the download attribute + blob href instead.
    const anchorClicks: Array<{ download: string; href: string }> = [];
    const origAnchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function patchedClick(
      this: HTMLAnchorElement,
    ) {
      anchorClicks.push({ download: this.download, href: this.href });
    };
    try {
      renderPage();

      await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });
      const button = await screen.findByTestId(
        "avri-drift-rearm-history-csv",
        {},
        { timeout: 5_000 },
      );
      expect(button).toHaveTextContent(/Download CSV/i);

      button.click();

      await waitFor(() => {
        expect(anchorClicks.length).toBe(1);
      });
      expect(anchorClicks[0].download).toMatch(
        /^avri-drift-rearm-audit-\d{4}-\d{2}-\d{2}\.csv$/,
      );
      expect(anchorClicks[0].href).toBe("blob:mock");

      // The blob handed to URL.createObjectURL should carry the CSV
      // payload (header + both rows, newest-first by rearmedAt).
      expect(createdBlob).not.toBeNull();
      expect(createdBlob!.type).toMatch(/text\/csv/);
      const text = await createdBlob!.text();
      const lines = text.split("\r\n");
      expect(lines[0]).toBe(
        "rearmedAt,rearmedBy,rationale,key,weekStart,kind,originalNotifiedAt,originalDetail",
      );
      expect(lines).toHaveLength(3);
      // Newest-first ordering: 2026-04-22 sorts above 2026-04-15.
      expect(lines[1].startsWith("2026-04-22T08:15:00.000Z,")).toBe(true);
      expect(lines[2].startsWith("2026-04-15T12:00:00.000Z,alice,")).toBe(true);
      // The second row had embedded comma + quote + newline in
      // originalDetail; verify it ended up RFC-4180 quoted (the cell
      // begins with a leading double quote and contains escaped "").
      expect(lines[1]).toContain(',"xss family mean shifted by 6pt, comma ""quoted""');

      // The shared revoke + DOM-cleanup hygiene also runs.
      expect(revokeObjectUrlSpy).toHaveBeenCalledWith("blob:mock");
    } finally {
      HTMLAnchorElement.prototype.click = origAnchorClick;
    }
  });
});
