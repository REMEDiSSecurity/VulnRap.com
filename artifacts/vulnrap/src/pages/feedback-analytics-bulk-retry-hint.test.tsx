// Task #475 — render-test coverage for the post-retry banner hint
// (`handwavy-bulk-retry-hint`) on the bulk-results banner.
//
// Background:
//   * Task #238 introduced the "Retry failed" affordance on the bulk-results
//     banner so reviewers can re-run only the rows that hit a retryable
//     failure (error / auth-failed) without re-ticking the active list (for
//     remove batches) or chasing the history panel one by one (for undo
//     batches).
//   * Task #336 stamped a small italic caption underneath the banner header
//     ("Retried N rows from the previous {remove|undo} batch.") so the
//     reviewer can tell at a glance that this banner is the result of a
//     retry, not a fresh top-level batch. The hint is set ONLY by
//     `handleRetryFailedBulkResults` via the `retried` field on
//     `BulkResultsState`; a fresh batch (whether all-success or first
//     mixed-outcome) leaves it unset and the caption never renders.
//
// Neither feature had a render-test in `artifacts/vulnrap/src/pages` until
// this file: existing component tests like
// `feedback-analytics.mutations-blocked.test.tsx` only matrix-iterate the
// disabled-state plumbing, and the cooldown-gate test only confirms the
// Retry button itself disables under throttle. None drive a partial-failure
// batch THROUGH the retry button to assert the resulting banner stamps
// `handwavy-bulk-retry-hint` with the right `data-parent-kind` /
// `data-retried-count` / text content, and none confirm the hint is absent
// on the initial batch banner so the all-success path stays uncluttered.
//
// Three slices of coverage:
//   1. REMOVE retry — drive a 2-phrase bulk-remove with one failing row,
//      assert the initial banner has NO hint, click Retry failed, then
//      assert the resulting banner stamps the hint with the expected
//      count + parent-kind text + data attributes.
//   2. ALL-SUCCESS sanity — drive a 2-phrase bulk-remove where every row
//      succeeds, assert no hint AND no Retry button (so the all-success
//      path is verifiably uncluttered).
//   3. UNDO retry — drive a 2-phrase bulk-remove (all success) → click
//      "Undo this batch" with one reinstate failing → assert no hint on
//      the initial undo banner → click Retry failed → assert the banner
//      hint says "previous undo batch" (parent-kind=undo, count=1).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCalibrationToken } from "@workspace/api-client-react";
import { resetCalibrationCooldown } from "@/lib/calibration-cooldown";
import { HandwavyPhrasesAdmin } from "./feedback-analytics";
import type {
  HandwavyMarker,
  HandwavyPhrasesList,
  HandwavyPhraseRemovalBatchesList,
} from "@workspace/api-client-react";

// ---------- fixtures -------------------------------------------------------

// Two seed phrases. `PHRASE_FLAKY` is the row whose first DELETE / first
// reinstate the mock fails with a 500 so the resulting banner has a
// retryable failure (status: "error") and the Retry-failed button mounts.
// `PHRASE_GOOD` always succeeds, so each "1 removed + 1 error" /
// "1 reinstated + 1 error" mixed-outcome banner is exactly what the task
// asks for.
const PHRASE_GOOD = "comprehensive zero-trust posture";
const PHRASE_FLAKY = "synergistic threat surface";

const PHRASES: HandwavyMarker[] = [
  {
    phrase: PHRASE_GOOD,
    category: "buzzword",
    addedBy: "reviewer-a@example.com",
    addedAt: "2026-04-01T10:00:00.000Z",
    rationale: "seed",
  },
  {
    phrase: PHRASE_FLAKY,
    category: "hedging",
    addedBy: "reviewer-b@example.com",
    addedAt: "2026-04-02T10:00:00.000Z",
    rationale: "seed",
  },
];

const HANDWAVY_PHRASES: HandwavyPhrasesList = {
  phrases: PHRASES,
  total: PHRASES.length,
  history: [],
};

const REMOVAL_BATCHES: HandwavyPhraseRemovalBatchesList = {
  limit: 50,
  totalBatches: 0,
  batches: [],
};

const VALID_AUTH_STATUS = {
  serverRequiresToken: true,
  tokenPresented: true,
  tokenValid: true,
  mutationsAllowed: true,
};

// Zero-impact bulk preview keeps `requiresAck` off so the test doesn't
// have to tick the destructive ack checkbox before clicking confirm.
const ZERO_IMPACT_BLOCK = {
  total: 0,
  byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
  validDetectionsLost: 0,
  falsePositivesDropped: 0,
  corpusSize: 0,
  sampleMatches: [] as Array<never>,
  warning: null,
  oldestCreatedAt: null,
  newestCreatedAt: null,
};

const BULK_DRY_RUN_IMPACT = {
  corpus: ZERO_IMPACT_BLOCK,
  production: null,
  productionError: null,
  productionLimit: 2000,
};

// Stable per-phrase history identifiers so the undo flow has the
// `removedAt` it needs to call /reinstate per row.
function removedAtFor(phrase: string): string {
  return `2026-04-25T10:00:0${phrase === PHRASE_GOOD ? "0" : "1"}.000Z`;
}

// ---------- mock fetch ------------------------------------------------------

type FailureSpec = {
  // Number of times the next call against this phrase should fail with 500
  // before falling through to a success response. Decremented per call.
  deleteFailures?: number;
  reinstateFailures?: number;
};

interface MockHandle {
  spy: ReturnType<typeof vi.spyOn>;
  // Per-phrase REAL (non-dry-run) DELETE counts so each test can pin the
  // exact retry behaviour (e.g. "Retry must have re-issued exactly one
  // DELETE for the flaky phrase").
  realDeletes: Record<string, number>;
  // Per-phrase /reinstate counts on the same lines for the undo flow.
  reinstates: Record<string, number>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock(failures: Record<string, FailureSpec>): MockHandle {
  const realDeletes: Record<string, number> = {};
  const reinstates: Record<string, number> = {};
  // Snapshot the failure counters so we can mutate them in-place per call
  // without leaking between tests (each `installFetchMock` creates a fresh
  // map from the caller's spec).
  const remaining: Record<string, FailureSpec> = {};
  for (const [phrase, spec] of Object.entries(failures)) {
    remaining[phrase] = {
      deleteFailures: spec.deleteFailures ?? 0,
      reinstateFailures: spec.reinstateFailures ?? 0,
    };
  }

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
      return jsonResponse(VALID_AUTH_STATUS);
    }
    if (
      url.includes("/api/feedback/calibration/handwavy-phrases/removal-batches")
    ) {
      return jsonResponse(REMOVAL_BATCHES);
    }
    // Single-phrase /reinstate POST — used by the bulk-undo flow
    // (handleUndoBulkBatch issues one POST per row through
    // reinstateHandwavyPhrase). Match BEFORE the general handwavy-phrases
    // route so this suffix isn't swallowed by it.
    if (url.includes("/api/feedback/calibration/handwavy-phrases/reinstate")) {
      let body: { phrase?: string; removedAt?: string } = {};
      try {
        body = JSON.parse((init?.body as string) ?? "{}");
      } catch {
        // fall through with empty body
      }
      const phrase = body.phrase ?? "?";
      reinstates[phrase] = (reinstates[phrase] ?? 0) + 1;
      const spec = remaining[phrase];
      if (spec && (spec.reinstateFailures ?? 0) > 0) {
        spec.reinstateFailures = (spec.reinstateFailures ?? 0) - 1;
        return jsonResponse(
          { error: "Synthetic transient reinstate failure" },
          500,
        );
      }
      return jsonResponse({
        phrase,
        category: "buzzword",
        total: PHRASES.length,
        phrases: PHRASES,
      });
    }
    if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
      if (method === "DELETE") {
        let body: { dryRun?: boolean; phrase?: string; phrases?: string[] } =
          {};
        try {
          body = JSON.parse((init?.body as string) ?? "{}");
        } catch {
          // fall through
        }
        // Bulk-remove dry-run preview (DELETE with dryRun:true and a
        // `phrases` array). Always succeeds — the test confirms via
        // the preview panel before kicking off the real batch. Echo
        // back exactly what was requested so the preview's per-phrase
        // outcomes line up with the selection (the panel passes the
        // failed-row subset on retry, but retry skips the preview and
        // calls confirmBulkRemove directly, so this branch only runs
        // for the initial batch).
        if (body.dryRun && Array.isArray(body.phrases)) {
          const requested = body.phrases;
          return jsonResponse({
            dryRun: true,
            batch: true,
            wouldRemove: requested.length,
            notFound: 0,
            duplicateInBatch: 0,
            total: PHRASES.length,
            projectedTotal: Math.max(0, PHRASES.length - requested.length),
            results: requested.map((p) => ({
              raw: p,
              phrase: p,
              removed: true,
            })),
            dryRunImpact: BULK_DRY_RUN_IMPACT,
            phrases: PHRASES,
          });
        }
        // Real (non-dry-run) per-phrase DELETE issued by
        // `confirmBulkRemove`. Per-phrase failure counters drive the
        // mixed-outcome banners; once a phrase's deleteFailures is
        // exhausted the request returns success with a `historyEntry`
        // so the banner captures `removedAt` and the undo flow has
        // something to reinstate against.
        const phrase = body.phrase ?? "?";
        realDeletes[phrase] = (realDeletes[phrase] ?? 0) + 1;
        const spec = remaining[phrase];
        if (spec && (spec.deleteFailures ?? 0) > 0) {
          spec.deleteFailures = (spec.deleteFailures ?? 0) - 1;
          return jsonResponse(
            { error: "Synthetic transient delete failure" },
            500,
          );
        }
        return jsonResponse({
          phrase,
          historyEntry: {
            phrase,
            category: "buzzword",
            addedBy: "reviewer-a@example.com",
            addedAt: "2026-04-01T10:00:00.000Z",
            rationale: "seed",
            removedBy: "reviewer-a@example.com",
            removedAt: removedAtFor(phrase),
            reinstated: false,
          },
          total: PHRASES.length,
          phrases: PHRASES,
        });
      }
      return jsonResponse(HANDWAVY_PHRASES);
    }
    // Anything else (calibration report, scoring config, analytics, ...)
    // gets a benign empty payload so a missed mock doesn't surface as an
    // unhandled rejection — the panel under test only consumes the
    // endpoints above.
    return jsonResponse({});
  });
  return { spy, realDeletes, reinstates };
}

// ---------- helpers --------------------------------------------------------

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderAdmin() {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/feedback-analytics"]}>
        <HandwavyPhrasesAdmin mutationsAllowed={true} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function waitForRowsReady() {
  await waitFor(() => {
    expect(screen.getAllByTestId("handwavy-row").length).toBe(PHRASES.length);
  });
}

// Drive a bulk-remove batch with the active selection through the
// dry-run preview and the destructive confirm. The caller wires the
// per-phrase failure spec via `installFetchMock`, so the resulting
// banner's outcome shape is fully determined by the mock.
async function driveInitialBulkRemove(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId("handwavy-select-all"));
  fireEvent.click(screen.getByTestId("handwavy-bulk-remove"));
  await waitFor(() => {
    expect(
      screen.getByTestId("handwavy-bulk-preview-confirm"),
    ).toBeInTheDocument();
  });
  fireEvent.click(screen.getByTestId("handwavy-bulk-preview-confirm"));
  return await screen.findByTestId("handwavy-bulk-results");
}

// ---------- specs ----------------------------------------------------------

describe("Task #475 — bulk-results banner stamps handwavy-bulk-retry-hint after Retry failed", () => {
  let mock: MockHandle | null = null;

  beforeEach(() => {
    setCalibrationToken("test-token");
    resetCalibrationCooldown();
  });

  afterEach(() => {
    mock?.spy.mockRestore();
    mock = null;
    setCalibrationToken(null);
    resetCalibrationCooldown();
  });

  it("REMOVE: initial mixed-outcome banner has no hint; after Retry failed the banner stamps it with parent-kind=remove + count=1", async () => {
    // Flaky phrase fails its FIRST real DELETE then succeeds. Good phrase
    // always succeeds. Initial pass: 1 removed + 1 error → banner shows
    // Retry failed (1) and NO hint. After clicking Retry: the second
    // DELETE for the flaky phrase succeeds and the banner is replaced
    // with 1 removed + the retry hint.
    mock = installFetchMock({ [PHRASE_FLAKY]: { deleteFailures: 1 } });
    renderAdmin();
    await waitForRowsReady();

    const initialBanner = await driveInitialBulkRemove();
    expect(initialBanner.getAttribute("data-kind")).toBe("remove");
    expect(initialBanner.getAttribute("data-retried")).toBe("false");
    // Initial banner: hint must be absent so the all-success / first
    // mixed-outcome path stays uncluttered.
    expect(
      within(initialBanner).queryByTestId("handwavy-bulk-retry-hint"),
      "fresh-batch banner must NOT carry the post-retry hint",
    ).toBeNull();
    // Sanity: the retry button is mounted so the click in a moment
    // exercises the real handler (otherwise the assertion below would
    // pass for the wrong reason).
    const retryBtn = within(initialBanner).getByTestId(
      "handwavy-bulk-retry-failed",
    );
    expect(retryBtn.textContent ?? "").toMatch(/Retry failed \(1\)/);
    // Pin the per-phrase DELETE counters before retry so the
    // post-retry assertion is unambiguous: the retry path must
    // re-issue exactly one DELETE for the flaky phrase and zero for
    // the good one (which already succeeded).
    expect(mock.realDeletes[PHRASE_GOOD] ?? 0).toBe(1);
    expect(mock.realDeletes[PHRASE_FLAKY] ?? 0).toBe(1);

    fireEvent.click(retryBtn);

    // The post-retry banner re-uses the same `handwavy-bulk-results`
    // testid, so wait for the hint itself rather than for the banner
    // node identity to change.
    await waitFor(() => {
      expect(
        screen.getByTestId("handwavy-bulk-retry-hint"),
      ).toBeInTheDocument();
    });

    const retriedBanner = screen.getByTestId("handwavy-bulk-results");
    expect(retriedBanner.getAttribute("data-kind")).toBe("remove");
    expect(retriedBanner.getAttribute("data-retried")).toBe("true");

    const hint = within(retriedBanner).getByTestId("handwavy-bulk-retry-hint");
    expect(hint.getAttribute("data-parent-kind")).toBe("remove");
    expect(hint.getAttribute("data-retried-count")).toBe("1");
    // Singular "row" + "previous remove batch" wording is the literal
    // contract Task #336 ships and what the reviewer reads on the banner.
    expect(hint.textContent ?? "").toBe(
      "Retried 1 row from the previous remove batch.",
    );

    // Defense-in-depth: the retry must have fired exactly one DELETE for
    // the flaky phrase and left the good one untouched.
    expect(mock.realDeletes[PHRASE_FLAKY]).toBe(2);
    expect(mock.realDeletes[PHRASE_GOOD]).toBe(1);
  });

  it("REMOVE: an all-success initial banner renders neither the hint nor a Retry-failed button", async () => {
    // No failure spec → every DELETE succeeds on the first try, so the
    // banner reports 2 removed with no retryable failures. The hint
    // must NOT render and the Retry-failed button must NOT mount.
    mock = installFetchMock({});
    renderAdmin();
    await waitForRowsReady();

    const banner = await driveInitialBulkRemove();
    expect(banner.getAttribute("data-kind")).toBe("remove");
    expect(banner.getAttribute("data-retried")).toBe("false");
    expect(
      within(banner).queryByTestId("handwavy-bulk-retry-hint"),
      "all-success banner must stay uncluttered",
    ).toBeNull();
    expect(
      within(banner).queryByTestId("handwavy-bulk-retry-failed"),
      "Retry-failed button must not mount when no row is retryable",
    ).toBeNull();
    // Two real DELETEs total — one per phrase, both succeeded on the
    // first call.
    expect(mock.realDeletes[PHRASE_GOOD]).toBe(1);
    expect(mock.realDeletes[PHRASE_FLAKY]).toBe(1);
  });

  it("UNDO: a partial-failure undo batch followed by Retry stamps the banner hint with parent-kind=undo + 'previous undo batch'", async () => {
    // Initial bulk-remove: both succeed → banner kind=remove with the
    // "Undo this batch" button visible. The flaky phrase's FIRST
    // /reinstate fails 500; the second succeeds. So:
    //   * Click "Undo this batch" → undo banner: 1 reinstated + 1
    //     error → Retry failed (1), NO hint.
    //   * Click "Retry failed" → handleUndoBulkBatch runs again with
    //     just the failed row + retriedFrom={count:1, parentKind:"undo"}
    //     → undo banner: 1 reinstated → hint stamped with
    //     "previous undo batch".
    mock = installFetchMock({ [PHRASE_FLAKY]: { reinstateFailures: 1 } });
    renderAdmin();
    await waitForRowsReady();

    const removeBanner = await driveInitialBulkRemove();
    expect(removeBanner.getAttribute("data-kind")).toBe("remove");
    // Sanity: the remove banner is fresh, so the hint is absent here too.
    expect(
      within(removeBanner).queryByTestId("handwavy-bulk-retry-hint"),
    ).toBeNull();

    // "Undo this batch" lives on the same banner alongside Dismiss /
    // Retry failed; both phrases removed successfully so it mounts.
    const undoBtn = within(removeBanner).getByTestId("handwavy-bulk-undo");
    expect(undoBtn.textContent ?? "").toMatch(/Undo this batch \(2\)/);
    fireEvent.click(undoBtn);

    // Wait for the banner to flip from kind=remove to kind=undo with a
    // mixed-outcome retry pool (the flaky phrase's first reinstate
    // failed). The Retry button mounts only when retryFailedCount > 0.
    await waitFor(() => {
      const live = screen.getByTestId("handwavy-bulk-results");
      expect(live.getAttribute("data-kind")).toBe("undo");
      expect(
        within(live).getByTestId("handwavy-bulk-retry-failed"),
      ).toBeInTheDocument();
    });

    const initialUndoBanner = screen.getByTestId("handwavy-bulk-results");
    expect(initialUndoBanner.getAttribute("data-retried")).toBe("false");
    // Initial undo banner: hint absent (this is a top-level undo, not
    // the result of a Retry click).
    expect(
      within(initialUndoBanner).queryByTestId("handwavy-bulk-retry-hint"),
      "first-pass undo banner must NOT carry the post-retry hint",
    ).toBeNull();
    const undoRetryBtn = within(initialUndoBanner).getByTestId(
      "handwavy-bulk-retry-failed",
    );
    expect(undoRetryBtn.textContent ?? "").toMatch(/Retry failed \(1\)/);

    // Sanity on per-phrase reinstate counters before retry: the good
    // phrase reinstated once, the flaky phrase tried once and failed.
    expect(mock.reinstates[PHRASE_GOOD] ?? 0).toBe(1);
    expect(mock.reinstates[PHRASE_FLAKY] ?? 0).toBe(1);

    fireEvent.click(undoRetryBtn);

    // Wait for the post-retry undo banner to stamp the hint.
    await waitFor(() => {
      expect(
        screen.getByTestId("handwavy-bulk-retry-hint"),
      ).toBeInTheDocument();
    });

    const retriedUndoBanner = screen.getByTestId("handwavy-bulk-results");
    expect(retriedUndoBanner.getAttribute("data-kind")).toBe("undo");
    expect(retriedUndoBanner.getAttribute("data-retried")).toBe("true");

    const hint = within(retriedUndoBanner).getByTestId(
      "handwavy-bulk-retry-hint",
    );
    expect(hint.getAttribute("data-parent-kind")).toBe("undo");
    expect(hint.getAttribute("data-retried-count")).toBe("1");
    // Singular "row" + "previous undo batch" wording is the literal
    // contract Task #336 ships for the undo branch.
    expect(hint.textContent ?? "").toBe(
      "Retried 1 row from the previous undo batch.",
    );

    // Defense-in-depth: retry must have re-issued exactly one
    // /reinstate for the flaky phrase and left the good one alone.
    expect(mock.reinstates[PHRASE_FLAKY]).toBe(2);
    expect(mock.reinstates[PHRASE_GOOD]).toBe(1);
  });
});
