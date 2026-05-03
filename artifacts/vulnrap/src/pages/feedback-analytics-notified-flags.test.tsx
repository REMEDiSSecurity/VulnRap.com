// Task #408 — Fast unit coverage for the bulk re-arm bar inside
// NotifiedFlagsPanel on the Feedback Analytics page.
//
// Task #280's bulk re-arm flow is exercised end-to-end in
// `artifacts/vulnrap/e2e/notified-flags-bulk-rearm.spec.ts`, which is
// slow (browser boot + api-server build) and overkill for the pure
// component bookkeeping the panel is doing — selection set membership,
// the count-aware "Re-arm selected (N)" label, the hide-when-empty bulk
// bar, "Clear selection" not firing any request, the single batched
// POST on submit, and the auto-prune of stale selection keys when the
// per-row Re-arm finishes.
//
// These specs render the real FeedbackAnalytics page against a mocked
// fetch (same pattern as feedback-analytics-auth.test.tsx and
// avri-drift-cooldown.test.tsx) so a future refactor that breaks any of
// the above lights up the Vitest pass instead of waiting for the
// Playwright suite.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCalibrationToken } from "@workspace/api-client-react";
import FeedbackAnalytics from "./feedback-analytics";

const SERVER_TOKEN = "server-side-reviewer-token";

// Minimal payload — exactly enough that FeedbackAnalytics doesn't fall
// into its EmptyState branch (which would skip rendering the entire
// CalibrationSection / AvriDriftSection that owns NotifiedFlagsPanel).
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

const HANDWAVY_PHRASES = { phrases: [], total: 0 };
const REMOVAL_BATCHES = { batches: [], total: 0, hasMore: false };
const REARM_HISTORY = { history: [], total: 0 };

interface NotifiedRecord {
  key: string;
  weekStart: string;
  kind: "GAP_BELOW_45" | "FAMILY_MEAN_SHIFT";
  notifiedAt: string;
  detail: string;
}

const SEEDED_NOTIFIED: NotifiedRecord[] = [
  {
    key: "GAP_BELOW_45::2026-04-13",
    weekStart: "2026-04-13",
    kind: "GAP_BELOW_45",
    notifiedAt: "2026-04-14T09:00:00.000Z",
    detail: "T1−T3 gap of 41pt is below the 45pt warn line.",
  },
  {
    key: "FAMILY_MEAN_SHIFT::2026-04-20::xss",
    weekStart: "2026-04-20",
    kind: "FAMILY_MEAN_SHIFT",
    notifiedAt: "2026-04-21T10:30:00.000Z",
    detail: "T1 family xss mean shifted by +6pt week-over-week.",
  },
  {
    key: "FAMILY_MEAN_SHIFT::2026-04-20::injection",
    weekStart: "2026-04-20",
    kind: "FAMILY_MEAN_SHIFT",
    notifiedAt: "2026-04-21T10:31:00.000Z",
    detail: "T1 family injection mean shifted by +5pt week-over-week.",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RearmCall {
  keys: string[];
  reviewer?: string;
  rationale?: string;
}

interface MockHandle {
  spy: ReturnType<typeof vi.spyOn>;
  notified: NotifiedRecord[];
  rearmCalls: RearmCall[];
}

function installFetchMock(): MockHandle {
  // Mutable so a successful POST .../notifications/rearm shrinks the GET
  // list on the next refetch — that's what drives the auto-prune of
  // stale selection keys after a per-row re-arm finishes.
  const notified: NotifiedRecord[] = [...SEEDED_NOTIFIED];
  const rearmCalls: RearmCall[] = [];

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

    // Most-specific calibration sub-routes first. The bulk-rearm POST
    // mutates the shared notified[] so a subsequent GET reflects the
    // shrunken dedup state.
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
      const body = init?.body
        ? (JSON.parse(init.body as string) as {
            keys?: string[];
            reviewer?: string;
            rationale?: string;
          })
        : {};
      const keys = Array.isArray(body.keys) ? body.keys : [];
      rearmCalls.push({
        keys: [...keys],
        reviewer: body.reviewer,
        rationale: body.rationale,
      });
      const removed: NotifiedRecord[] = [];
      const notFound: string[] = [];
      for (const k of keys) {
        const idx = notified.findIndex((n) => n.key === k);
        if (idx >= 0) {
          removed.push(notified[idx]!);
          notified.splice(idx, 1);
        } else {
          notFound.push(k);
        }
      }
      return jsonResponse({
        rearmed: removed.length,
        notFound,
        remaining: notified.length,
        removed,
        notified: [...notified],
      });
    }
    if (url.includes("/api/feedback/calibration/avri-drift/notifications")) {
      if (method === "GET") {
        return jsonResponse({
          notified: [...notified],
          total: notified.length,
        });
      }
      return jsonResponse({ notified: [...notified], total: notified.length });
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
  return { spy, notified, rearmCalls };
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

async function waitForRowsToRender() {
  // The bulk-rearm button only exists once at least one row is ticked,
  // but the per-row checkboxes appear as soon as NotifiedFlagsPanel is
  // past its loading skeleton.
  await screen.findByText(/AVRI Drift Dashboard/i, {}, { timeout: 5_000 });
  for (const r of SEEDED_NOTIFIED) {
    await screen.findByTestId(
      `notified-flag-checkbox-${r.key}`,
      {},
      { timeout: 5_000 },
    );
  }
}

describe("NotifiedFlagsPanel — bulk re-arm bar (Task #408 / #280)", () => {
  let mock: MockHandle;

  beforeEach(() => {
    setCalibrationToken(SERVER_TOKEN);
  });

  afterEach(() => {
    setCalibrationToken(null);
    mock?.spy.mockRestore();
  });

  it("hides the bulk bar until at least one checkbox is ticked", async () => {
    mock = installFetchMock();
    const user = userEvent.setup();
    renderPage();
    await waitForRowsToRender();

    // No selection → no bulk bar at all.
    expect(
      screen.queryByTestId("notified-flags-bulk-bar"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("notified-flags-bulk-rearm"),
    ).not.toBeInTheDocument();

    // First tick brings the bar in.
    await user.click(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`),
    );
    expect(
      await screen.findByTestId("notified-flags-bulk-bar"),
    ).toBeInTheDocument();
  });

  it("updates the selected count and the 'Re-arm selected (N)' label as checkboxes toggle", async () => {
    mock = installFetchMock();
    const user = userEvent.setup();
    renderPage();
    await waitForRowsToRender();

    const cb0 = screen.getByTestId(
      `notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`,
    );
    const cb1 = screen.getByTestId(
      `notified-flag-checkbox-${SEEDED_NOTIFIED[1]!.key}`,
    );
    const cb2 = screen.getByTestId(
      `notified-flag-checkbox-${SEEDED_NOTIFIED[2]!.key}`,
    );

    await user.click(cb0);
    const bar = await screen.findByTestId("notified-flags-bulk-bar");
    // The bar contains both the standalone "<N> selected" count text and
    // the "Re-arm selected (N)" button — match the count text directly
    // so the assertion can't accidentally pass on the button label.
    expect(within(bar).getByText("1")).toBeInTheDocument();
    expect(bar).toHaveTextContent(/1\s+selected/);
    expect(screen.getByTestId("notified-flags-bulk-rearm")).toHaveTextContent(
      /Re-arm selected \(1\)/,
    );

    await user.click(cb1);
    await waitFor(() => {
      expect(
        within(screen.getByTestId("notified-flags-bulk-bar")).getByText("2"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("notified-flags-bulk-rearm")).toHaveTextContent(
      /Re-arm selected \(2\)/,
    );

    await user.click(cb2);
    await waitFor(() => {
      expect(
        within(screen.getByTestId("notified-flags-bulk-bar")).getByText("3"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("notified-flags-bulk-rearm")).toHaveTextContent(
      /Re-arm selected \(3\)/,
    );

    // Untick one → count + label drop back to 2 (no off-by-one in the
    // toggle path, no stale count after an unselect).
    await user.click(cb1);
    await waitFor(() => {
      expect(
        within(screen.getByTestId("notified-flags-bulk-bar")).getByText("2"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("notified-flags-bulk-rearm")).toHaveTextContent(
      /Re-arm selected \(2\)/,
    );
  });

  it("'Clear selection' hides the bulk bar without firing any rearm request", async () => {
    mock = installFetchMock();
    const user = userEvent.setup();
    renderPage();
    await waitForRowsToRender();

    await user.click(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`),
    );
    await user.click(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[1]!.key}`),
    );
    expect(
      await screen.findByTestId("notified-flags-bulk-bar"),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("notified-flags-bulk-clear"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("notified-flags-bulk-bar"),
      ).not.toBeInTheDocument();
    });

    // Both checkboxes should be back to unchecked, with the dedup list
    // still fully intact, and crucially: zero POSTs to the rearm
    // endpoint — Clear is purely a client-side reset.
    expect(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`),
    ).not.toBeChecked();
    expect(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[1]!.key}`),
    ).not.toBeChecked();
    expect(mock.rearmCalls).toHaveLength(0);
  });

  it("submits a single batched re-arm request containing every ticked key", async () => {
    mock = installFetchMock();
    const user = userEvent.setup();
    renderPage();
    await waitForRowsToRender();

    await user.click(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`),
    );
    await user.click(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[2]!.key}`),
    );

    await user.click(await screen.findByTestId("notified-flags-bulk-rearm"));

    await waitFor(() => {
      expect(mock.rearmCalls).toHaveLength(1);
    });
    expect(mock.rearmCalls[0]!.keys.sort()).toEqual(
      [SEEDED_NOTIFIED[0]!.key, SEEDED_NOTIFIED[2]!.key].sort(),
    );

    // After the batched POST the two re-armed rows should leave the
    // list and the bulk bar — having no live selection left — should
    // disappear too.
    await waitFor(() => {
      expect(
        screen.queryByTestId(
          `notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`,
        ),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.queryByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[2]!.key}`),
    ).not.toBeInTheDocument();
    // The middle row was never selected, so it must still be visible.
    expect(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[1]!.key}`),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByTestId("notified-flags-bulk-bar"),
      ).not.toBeInTheDocument();
    });
  });

  it("forwards the trimmed reviewer + rationale on the bulk re-arm POST and clears the rationale after success (Task #740)", async () => {
    mock = installFetchMock();
    const user = userEvent.setup();
    renderPage();
    await waitForRowsToRender();

    const reviewerInput = await screen.findByTestId(
      "avri-drift-rearm-reviewer",
    );
    const rationaleInput = await screen.findByTestId(
      "avri-drift-rearm-rationale",
    );
    // Surrounding whitespace must be stripped before the field is sent;
    // the per-row path already does this and the bulk path is expected
    // to mirror it so audit log entries are attributable in the same
    // shape regardless of which button the reviewer used.
    await user.type(reviewerInput, "  alice@example.com  ");
    await user.type(rationaleInput, "  fix-by date passed, re-paging  ");

    await user.click(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`),
    );
    await user.click(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[1]!.key}`),
    );

    await user.click(await screen.findByTestId("notified-flags-bulk-rearm"));

    await waitFor(() => {
      expect(mock.rearmCalls).toHaveLength(1);
    });
    const call = mock.rearmCalls[0]!;
    expect(call.keys.sort()).toEqual(
      [SEEDED_NOTIFIED[0]!.key, SEEDED_NOTIFIED[1]!.key].sort(),
    );
    expect(call.reviewer).toBe("alice@example.com");
    expect(call.rationale).toBe("fix-by date passed, re-paging");

    // The shared rationale must clear after a successful bulk submit so
    // a stale note from the previous batch can't silently attach itself
    // to the next action — the per-row path has the same behaviour.
    await waitFor(() => {
      expect(rationaleInput).toHaveValue("");
    });
    // Reviewer is persisted between sessions, so the bulk submit should
    // leave it untouched (cleared rationale only).
    expect(reviewerInput).toHaveValue("alice@example.com");
  });

  it("omits reviewer + rationale fields when both inputs are blank (Task #740)", async () => {
    mock = installFetchMock();
    const user = userEvent.setup();
    renderPage();
    await waitForRowsToRender();

    await user.click(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`),
    );
    await user.click(await screen.findByTestId("notified-flags-bulk-rearm"));

    await waitFor(() => {
      expect(mock.rearmCalls).toHaveLength(1);
    });
    // Both fields are optional; sending an empty string would land an
    // empty audit-log column instead of a clean "no reviewer" gap, so
    // the UI must omit them entirely when blank — same contract as the
    // per-row path.
    expect(mock.rearmCalls[0]!.reviewer).toBeUndefined();
    expect(mock.rearmCalls[0]!.rationale).toBeUndefined();
  });

  it("auto-prunes a ticked key from the selection when the per-row Re-arm finishes", async () => {
    mock = installFetchMock();
    const user = userEvent.setup();
    renderPage();
    await waitForRowsToRender();

    // Tick two entries so the bulk bar shows "2 selected".
    await user.click(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`),
    );
    await user.click(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[1]!.key}`),
    );
    expect(
      await screen.findByTestId("notified-flags-bulk-rearm"),
    ).toHaveTextContent(/Re-arm selected \(2\)/);

    // Click the per-row "Re-arm" button on the first ticked row. The
    // request body should be that single key, NOT the full ticked set.
    const row0 = screen
      .getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`)
      .closest("li") as HTMLElement;
    expect(row0).not.toBeNull();
    await user.click(within(row0).getByRole("button", { name: /^Re-arm$/ }));

    await waitFor(() => {
      expect(mock.rearmCalls).toHaveLength(1);
    });
    expect(mock.rearmCalls[0]!.keys).toEqual([SEEDED_NOTIFIED[0]!.key]);

    // Row 0 leaves the list (server returned shrunken dedup state), and
    // its selection key should auto-prune so the bulk count drops to 1.
    // The OTHER ticked row (row 1) must stay both visible AND ticked.
    await waitFor(() => {
      expect(
        screen.queryByTestId(
          `notified-flag-checkbox-${SEEDED_NOTIFIED[0]!.key}`,
        ),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByTestId(`notified-flag-checkbox-${SEEDED_NOTIFIED[1]!.key}`),
    ).toBeChecked();
    await waitFor(() => {
      expect(screen.getByTestId("notified-flags-bulk-rearm")).toHaveTextContent(
        /Re-arm selected \(1\)/,
      );
    });
  });
});
