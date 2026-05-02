// Task #469 — pin the wrong-token cooldown gate at the helper level inside
// `confirmBulkRemove` itself, so any future caller is automatically
// protected without having to remember the per-call dance.
//
// Background: Task #335 fixed one specific entry point (the "Retry failed"
// button on the bulk-results banner) that was calling `confirmBulkRemove`
// directly and silently skipping the wrong-token cooldown. The root cause
// was that `confirmBulkRemove` itself did NOT call `bailOnCooldown` — the
// gate lived in each caller. This file pins the centralized version so a
// future third caller can't reintroduce the bug class.
//
// Two slices of coverage:
//   1. SOURCE-LEVEL invariant — the body of `confirmBulkRemove` must
//      contain a `bailOnCooldown(...)` call BEFORE the first
//      `setBusy("bulk-remove")` side-effect. This is the load-bearing
//      "any new caller is automatically protected" guarantee — drop the
//      central bail and this assertion fails immediately at the closest
//      possible scope, no UI plumbing required.
//   2. DOM-LEVEL invariant — drive a real bulk-remove with a mixed
//      outcome (1 removed + 1 error) so the Retry-failed button mounts,
//      then trip the cooldown via `applyRateLimitNotice` and assert the
//      button flips to disabled with the shared `Cooldown — Ns` label
//      and the `data-cooldown-active="true"` flag. Forcing a click on
//      the disabled button must NOT issue any further DELETE — both
//      halves of the gate (`disabled={... || cooldown.active}` AND the
//      central `bailOnCooldown("Bulk removal")` inside
//      `confirmBulkRemove`) are exercised here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCalibrationToken } from "@workspace/api-client-react";
import type {
  HandwavyMarker,
  HandwavyPhrasesList,
  HandwavyPhraseRemovalBatchesList,
} from "@workspace/api-client-react";
import { HandwavyPhrasesAdmin } from "./feedback-analytics";
import {
  applyRateLimitNotice,
  resetCalibrationCooldown,
} from "@/lib/calibration-cooldown";

// ---------- fixtures -------------------------------------------------------

const PHRASES: HandwavyMarker[] = [
  {
    phrase: "comprehensive zero-trust posture",
    category: "buzzword",
    addedBy: "reviewer-a@example.com",
    addedAt: "2026-04-01T10:00:00.000Z",
    rationale: "seed",
  },
  {
    phrase: "synergistic threat surface",
    category: "hedging",
    addedBy: "reviewer-b@example.com",
    addedAt: "2026-04-02T10:00:00.000Z",
    rationale: "seed",
  },
];

const TRANSIENT_PHRASE = PHRASES[1].phrase;

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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface MockHandle {
  spy: ReturnType<typeof vi.spyOn>;
  // Real (non-dry-run) DELETE counts split by phrase so the test can
  // pin "Retry must not have triggered another DELETE for the
  // transient phrase while cooldown is active".
  realDeletes: { all: number; transient: number };
  // First real DELETE for `TRANSIENT_PHRASE` returns 500 so the bulk
  // batch ends with mixed outcomes. The second one would normally
  // succeed, but the test never lets it run — cooldown trips first.
  transientFailUsed: { value: boolean };
}

function installFetchMock(): MockHandle {
  const realDeletes = { all: 0, transient: 0 };
  const transientFailUsed = { value: false };
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
        // the preview panel before kicking off the real batch.
        if (body.dryRun && Array.isArray(body.phrases)) {
          return jsonResponse({
            dryRun: true,
            batch: true,
            wouldRemove: PHRASES.length,
            notFound: 0,
            duplicateInBatch: 0,
            total: PHRASES.length,
            projectedTotal: 0,
            results: PHRASES.map((p) => ({
              raw: p.phrase,
              phrase: p.phrase,
              removed: true,
            })),
            dryRunImpact: BULK_DRY_RUN_IMPACT,
            phrases: PHRASES,
          });
        }
        // Real (non-dry-run) per-phrase DELETE issued by
        // `confirmBulkRemove`. The first call for the transient phrase
        // returns 500 so the resulting banner has 1 removed + 1 error,
        // which is what mounts the Retry-failed button.
        realDeletes.all += 1;
        if (body.phrase === TRANSIENT_PHRASE) {
          realDeletes.transient += 1;
          if (!transientFailUsed.value) {
            transientFailUsed.value = true;
            return jsonResponse(
              { error: "Synthetic transient failure" },
              500,
            );
          }
          // If a regression lets a second real DELETE for the transient
          // phrase escape past the cooldown gate, surface it as a
          // generic success so the test's "no further DELETE" counter
          // assertion catches it cleanly.
          return jsonResponse({
            phrase: TRANSIENT_PHRASE,
            removed: true,
          });
        }
        return jsonResponse({
          phrase: body.phrase ?? "?",
          removed: true,
        });
      }
      return jsonResponse(HANDWAVY_PHRASES);
    }
    // Anything else (calibration report, scoring config, analytics, ...)
    // gets a benign empty payload so a missed mock doesn't surface as an
    // unhandled rejection.
    return jsonResponse({});
  });
  return { spy, realDeletes, transientFailUsed };
}

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

// ---------- specs ----------------------------------------------------------

describe("Task #469 — confirmBulkRemove centralizes the wrong-token cooldown bail", () => {
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

  // --- (1) Source-level invariant: any new caller is auto-protected. ------
  // This is the load-bearing "the gate lives inside the helper" test. A
  // future refactor that drops the central bail (or moves it back below
  // `setBusy`) regresses LOUDLY here, no UI plumbing required.
  it("source: `confirmBulkRemove` calls `bailOnCooldown(...)` BEFORE `setBusy(\"bulk-remove\")`", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(
      path.join(here, "feedback-analytics.tsx"),
      "utf8",
    );
    // Anchor on the unique const declaration so we don't accidentally
    // pick up `confirmBulkRemoveFromPreview`. Slice from there to the
    // first `setBusy("bulk-remove")` (inclusive) — that prefix is the
    // window where the central bail must live.
    const startIdx = source.indexOf("const confirmBulkRemove = async (");
    expect(
      startIdx,
      "expected `confirmBulkRemove` declaration to exist in feedback-analytics.tsx",
    ).toBeGreaterThan(-1);
    const setBusyIdx = source.indexOf('setBusy("bulk-remove")', startIdx);
    expect(
      setBusyIdx,
      'expected `setBusy("bulk-remove")` somewhere in `confirmBulkRemove`',
    ).toBeGreaterThan(startIdx);
    // Strip both `// …` and `/* … */` comments so the regex below only
    // matches an EXECUTABLE call to `bailOnCooldown`. A previous version
    // matched the raw source slice and could false-pass off a stale
    // comment that still mentioned `bailOnCooldown(...)` even after the
    // real call had been removed — exactly the "regression tripwire"
    // weakness the Task #469 code review called out.
    const prefixRaw = source.slice(startIdx, setBusyIdx);
    const prefixCodeOnly = prefixRaw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    // Match the actual `if (bailOnCooldown(<label>)) return;` early-bail
    // statement — same shape every other gated handler in this file uses
    // — so a "rename to differentBail()" or "drop the if-guard" refactor
    // both fail loudly here even if a stale doc-comment still references
    // the old name.
    expect(
      prefixCodeOnly,
      "Task #469: `confirmBulkRemove` must call `bailOnCooldown(...)` BEFORE `setBusy(\"bulk-remove\")` so any new caller is automatically protected from the wrong-token throttle (mirrors `handleUndoBulkBatch`).",
    ).toMatch(/if\s*\(\s*bailOnCooldown\s*\([^)]*\)\s*\)\s*return\s*;/);
  });

  // --- (2) DOM-level invariant: cooldown disables the Retry button and ----
  //         a forced click issues no further DELETE for the transient phrase.
  it("DOM: with cooldown active, the Retry-failed button disables and a forced click issues no further DELETE", async () => {
    mock = installFetchMock();

    renderAdmin();

    // Wait for both data hooks to land before driving the toolbar.
    await waitFor(() => {
      expect(screen.getAllByTestId("handwavy-row").length).toBe(
        PHRASES.length,
      );
    });

    // Select every active row and open the bulk-remove preview.
    fireEvent.click(screen.getByTestId("handwavy-select-all"));
    fireEvent.click(screen.getByTestId("handwavy-bulk-remove"));

    // Wait for the preview's confirm button (mounted only after the
    // dry-run DELETE resolves).
    await waitFor(() => {
      expect(
        screen.getByTestId("handwavy-bulk-preview-confirm"),
      ).toBeInTheDocument();
    });

    // Confirm the destructive batch — the mock returns 500 for the
    // transient phrase and success for the other, so the resulting
    // banner has 1 removed + 1 error and the Retry-failed button shows.
    fireEvent.click(screen.getByTestId("handwavy-bulk-preview-confirm"));

    const banner = await screen.findByTestId("handwavy-bulk-results");
    await waitFor(() => {
      expect(
        within(banner).getByTestId("handwavy-bulk-retry-failed"),
      ).toBeInTheDocument();
    });

    // Sanity: the initial bulk-remove pass issued exactly the two real
    // DELETEs we expect (one success + one transient failure). Pinning
    // this baseline makes the post-cooldown assertion below unambiguous.
    expect(mock.realDeletes.all).toBe(2);
    expect(mock.realDeletes.transient).toBe(1);
    expect(mock.transientFailUsed.value).toBe(true);

    const retryBtn = within(banner).getByTestId("handwavy-bulk-retry-failed");
    expect(retryBtn).not.toBeDisabled();
    expect(retryBtn.getAttribute("data-cooldown-active")).toBe("false");
    expect(retryBtn.textContent ?? "").toMatch(/Retry failed \(1\)/);

    const deletesBeforeCooldown = mock.realDeletes.all;

    // Trip the calibration cooldown the same way the shared API client
    // would when a 429 lands on a calibration mutation route. The
    // `useCalibrationCooldown` hook re-renders synchronously on the
    // next React tick, so the Retry button flips to disabled +
    // cooldown-labelled.
    act(() => {
      applyRateLimitNotice({
        method: "DELETE",
        url: "/api/feedback/calibration/handwavy-phrases",
        status: 429,
        retryAfterMs: 7_000,
        resetAt: Date.now() + 7_000,
        limit: 4,
        remaining: 0,
        body: {
          error:
            "Too many failed calibration auth attempts. Try again later.",
        },
        headers: new Headers(),
      });
    });

    await waitFor(() => {
      const live = within(banner).getByTestId("handwavy-bulk-retry-failed");
      expect(live).toBeDisabled();
      expect(live.getAttribute("data-cooldown-active")).toBe("true");
      expect(live.textContent ?? "").toMatch(/Cooldown\s+—\s+\d+s/);
    });

    // Defense-in-depth: even firing a click event at the now-disabled
    // button must NOT issue another DELETE for the transient phrase.
    // Two halves of the gate are pinned here:
    //   * `disabled={retryBusy || cooldown.active || !mutationsAllowed}`
    //     on the button suppresses the React onClick handler entirely.
    //   * The central `bailOnCooldown("Bulk removal")` at the top of
    //     `confirmBulkRemove` (Task #469) is the safety net that any
    //     future caller of the helper would hit even if their wrapper
    //     forgot to disable the button. The companion e2e test
    //     (handwavy-bulk-retry-failed.spec.ts, "honors the calibration
    //     cooldown after a 429 lands mid-batch") force-clicks the
    //     button to exercise that second half end-to-end.
    fireEvent.click(within(banner).getByTestId("handwavy-bulk-retry-failed"));
    await new Promise((r) => setTimeout(r, 50));
    expect(mock.realDeletes.all).toBe(deletesBeforeCooldown);
    expect(mock.realDeletes.transient).toBe(1);
  });
});
