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
import type {
  HandwavyMarker,
  HandwavyHistoryEntry,
  HandwavyPhrasesList,
  HandwavyPhraseRemovalBatchesList,
} from "@workspace/api-client-react";
import { HandwavyPhrasesAdmin } from "./feedback-analytics";

// Task #314 — integration coverage for the post-remove preview refresh.
// Task #226 added a "Remove existing" quick-action to each overlap row in
// the hand-wavy add preview's overlap callout, but the live DELETE that
// fires didn't refresh the preview's `overlaps` snapshot. The just-removed
// phrase therefore stayed visible as an overlap until the reviewer
// dismissed and re-ran the preview. This test pins the new behavior: after
// the quick-action remove succeeds, the row for the just-removed phrase
// disappears from the preview without the reviewer touching the candidate
// input.
//
// Task #443 extends the same hook to the reinstate / edit-rename success
// paths so a phrase coming BACK onto the active list (per-row history
// Reinstate, batch reinstate, post-Trash Undo, "Undo this batch", and the
// applyEdit rename branch) gets reflected in the open preview's overlap
// snapshot too. The second describe block below pins the reinstate path
// specifically — it asserts that after a per-row history reinstate the
// overlap row APPEARS in the preview without the reviewer touching the
// candidate input, mirroring the post-remove coverage above.

const OVERLAP_PHRASE = "do not have a reproducer";
const OTHER_PHRASE = "synergistic threat surface";
const CANDIDATE_PHRASE = "do not have a reproducer";
// Task #443 — used by the edit-rename test below: an unrelated phrase
// that the reviewer renames TO the CANDIDATE_PHRASE, which is what
// makes the overlap row appear in the open preview after the rename.
const PHRASE_TO_RENAME = "outdated draft phrase";

// Internal mock state — mutated by the DELETE / POST-reinstate handlers so
// subsequent GETs and the post-mutation dry-run reflect the curated list
// AFTER the mutation.
let activePhrases: HandwavyMarker[] = [];
// History rows surfaced by the GET /handwavy-phrases response. Mirrors
// the audit log shape: a removed phrase keeps its row (with reinstated:
// false) until a reinstate flips the flag. The reinstate POST handler
// below mutates this in lockstep with `activePhrases`.
let activeHistory: HandwavyHistoryEntry[] = [];

function makeMarker(phrase: string): HandwavyMarker {
  return {
    phrase,
    category: "absence",
    addedBy: "reviewer-a@example.com",
    addedAt: "2026-04-01T10:00:00.000Z",
    rationale: "seed",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_AUTH_STATUS = {
  serverRequiresToken: true,
  tokenPresented: true,
  tokenValid: true,
  mutationsAllowed: true,
};

const EMPTY_DRY_RUN_MATCHES = {
  total: 0,
  byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
  falsePositives: 0,
  corpusSize: 0,
  sampleMatches: [],
  warning: null,
  oldestCreatedAt: null,
  newestCreatedAt: null,
};

const ZERO_IMPACT_BLOCK = {
  total: 0,
  byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
  validDetectionsLost: 0,
  falsePositivesDropped: 0,
  corpusSize: 0,
  sampleMatches: [],
  warning: null,
  oldestCreatedAt: null,
  newestCreatedAt: null,
};

const SINGLE_ZERO_IMPACT = {
  corpus: ZERO_IMPACT_BLOCK,
  production: null,
  productionError: null,
  productionLimit: 2000,
};

const REMOVAL_BATCHES: HandwavyPhraseRemovalBatchesList = {
  limit: 50,
  totalBatches: 0,
  batches: [],
};

// Build the dry-run add response from the CURRENT curated list so the
// `dryRunOverlaps` block shrinks naturally as the DELETE handler mutates
// `activePhrases`. The test uses `equal`-relation overlaps (the candidate
// is identical to the existing phrase).
function buildAddDryRunResponse(candidate: string) {
  const matches = activePhrases
    .filter((p) => p.phrase === candidate)
    .map((p) => ({
      phrase: p.phrase,
      category: p.category,
      relation: "equal" as const,
    }));
  return {
    phrase: candidate,
    category: "absence" as const,
    total: activePhrases.length,
    phrases: activePhrases,
    dryRun: true,
    dryRunMatches: EMPTY_DRY_RUN_MATCHES,
    dryRunMatchesProduction: EMPTY_DRY_RUN_MATCHES,
    dryRunMatchesProductionError: null,
    dryRunMatchesProductionLimit: 2000,
    dryRunOverlaps: {
      total: matches.length,
      matches,
    },
  };
}

function installFetchMock(): ReturnType<typeof vi.spyOn> {
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
    // Task #443 — single-phrase reinstate POST. Mutates `activePhrases`
    // and flips the matching `activeHistory` row's `reinstated` flag so
    // the post-reinstate `refreshOpenAddPreview` dry-run sees the phrase
    // back on the active list. Routed BEFORE the `/handwavy-phrases`
    // catch-all because the reinstate URL also contains that prefix.
    if (
      url.includes("/api/feedback/calibration/handwavy-phrases/reinstate") &&
      !url.includes("/reinstate-batch") &&
      method === "POST"
    ) {
      let body: { phrase?: string; removedAt?: string } = {};
      try {
        body = JSON.parse((init?.body as string) ?? "{}");
      } catch {
        /* fall through */
      }
      const targetPhrase = body.phrase ?? "";
      const targetRemovedAt = body.removedAt ?? "";
      // Add the phrase back if it isn't already on the active list — the
      // server's reinstate is idempotent against the active list, but
      // the mock keeps the same shape for clarity.
      if (!activePhrases.some((p) => p.phrase === targetPhrase)) {
        activePhrases = [...activePhrases, makeMarker(targetPhrase)];
      }
      // Flip the matching history row to reinstated=true so the
      // refreshed history list won't render a duplicate Reinstate
      // button after refresh.
      activeHistory = activeHistory.map((h) =>
        h.phrase === targetPhrase && String(h.removedAt) === targetRemovedAt
          ? {
              ...h,
              reinstated: true,
              reinstatedBy: "reviewer-a@example.com",
              reinstatedAt: new Date().toISOString(),
            }
          : h,
      );
      return jsonResponse({
        reinstated: true,
        phrase: targetPhrase,
        category: "absence",
        total: activePhrases.length,
        phrases: activePhrases,
        history: activeHistory,
      });
    }
    if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
      // Task #443 — edit-rename PATCH. Mutates `activePhrases` so the
      // post-rename `refreshOpenAddPreview` dry-run reflects the swapped
      // entry. Category/rationale-only edits (no `newPhrase` in the body
      // or a `newPhrase` that normalizes equal to `phrase`) are still
      // accepted but leave the active list untouched, mirroring the
      // server's contract.
      if (method === "PATCH") {
        let body: {
          phrase?: string;
          newPhrase?: string;
          category?: "absence" | "hedging" | "buzzword";
          rationale?: string;
        } = {};
        try {
          body = JSON.parse((init?.body as string) ?? "{}");
        } catch {
          /* fall through */
        }
        const original = body.phrase ?? "";
        const next = body.newPhrase
          ?.toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        const originalNorm = original
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
        const renamed = !!next && next.length > 0 && next !== originalNorm;
        if (renamed) {
          activePhrases = activePhrases
            .filter((p) => p.phrase !== original)
            .concat([
              {
                ...makeMarker(next!),
                category: body.category ?? "absence",
                rationale: body.rationale ?? "seed",
              },
            ]);
        }
        return jsonResponse({
          edited: true,
          phrase: renamed ? next! : originalNorm,
          category: body.category ?? "absence",
          total: activePhrases.length,
          phrases: activePhrases,
        });
      }
      if (method === "POST") {
        // Add-phrase dry-run preview. The candidate is read off the body so
        // the same handler serves both the initial "Preview impact" click
        // and the post-remove refresh dry-run that Task #314 added.
        let candidate = CANDIDATE_PHRASE;
        try {
          const parsed = JSON.parse((init?.body as string) ?? "{}");
          if (typeof parsed.phrase === "string") candidate = parsed.phrase;
        } catch {
          /* fall through with default */
        }
        return jsonResponse(buildAddDryRunResponse(candidate));
      }
      if (method === "DELETE") {
        let body: { phrase?: string; dryRun?: boolean } = {};
        try {
          body = JSON.parse((init?.body as string) ?? "{}");
        } catch {
          /* fall through */
        }
        const targetPhrase = body.phrase ?? "";
        const isDryRun = body.dryRun === true;
        if (isDryRun) {
          // Zero-impact dry-run keeps the per-row Trash flow on its
          // one-click path so the live DELETE fires without an extra
          // confirmation dialog (which the test would otherwise have to
          // dismiss before reaching the refresh step).
          return jsonResponse({
            dryRun: true,
            batch: false,
            wouldRemove: 1,
            notFound: 0,
            duplicateInBatch: 0,
            phrase: targetPhrase,
            raw: targetPhrase,
            removed: true,
            total: activePhrases.length,
            projectedTotal: Math.max(activePhrases.length - 1, 0),
            results: [{ raw: targetPhrase, phrase: targetPhrase, removed: true }],
            dryRunImpact: SINGLE_ZERO_IMPACT,
            phrases: activePhrases,
          });
        }
        // Live DELETE: mutate the shared mock state so the refetched
        // GET — and the post-remove add dry-run that Task #314 fires —
        // both reflect the new curated list.
        activePhrases = activePhrases.filter(
          (p) => p.phrase !== targetPhrase,
        );
        return jsonResponse({
          removed: true,
          phrase: targetPhrase,
          category: "absence",
          total: activePhrases.length,
          phrases: activePhrases,
          historyEntry: {
            phrase: targetPhrase,
            category: "absence",
            addedBy: "reviewer-a@example.com",
            addedAt: "2026-04-01T10:00:00.000Z",
            rationale: "seed",
            removedBy: "reviewer-a@example.com",
            removedAt: new Date().toISOString(),
            reinstated: false,
          },
          history: [],
        });
      }
      // GET: return the current active list plus the (possibly mutated)
      // history so the audit-trail UI reflects the latest reinstate
      // state after refresh().
      return jsonResponse({
        phrases: activePhrases,
        total: activePhrases.length,
        history: activeHistory,
      } satisfies HandwavyPhrasesList);
    }
    // Anything else (calibration report, scoring config, analytics, ...)
    // gets a benign empty payload so a missed mock doesn't surface as an
    // unhandled rejection.
    return jsonResponse({});
  });
  return spy;
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

describe("Task #314 — preview overlap refresh after a quick-action remove", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    // Reset shared mock state for each test. Two phrases so the active
    // list isn't empty after the OVERLAP_PHRASE is removed (a stricter
    // empty-list state would hide unrelated UI affordances and make
    // mismatches harder to localize).
    activePhrases = [makeMarker(OVERLAP_PHRASE), makeMarker(OTHER_PHRASE)];
    activeHistory = [];
    setCalibrationToken("test-token");
    fetchSpy = installFetchMock();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    setCalibrationToken(null);
  });

  it("drops the overlap row for the just-removed phrase from the open preview without the reviewer touching the candidate input", async () => {
    renderAdmin();

    // Wait for the active list to load so the candidate input is enabled.
    await waitFor(() => {
      expect(screen.getByTestId("handwavy-input")).not.toBeDisabled();
    });

    // Type the candidate (an exact duplicate of an existing phrase so the
    // dry-run preview's `dryRunOverlaps` returns one `equal` match).
    fireEvent.change(screen.getByTestId("handwavy-input"), {
      target: { value: CANDIDATE_PHRASE },
    });

    // Open the preview. The dry-run POST returns one overlap row.
    fireEvent.click(screen.getByTestId("handwavy-add"));

    const overlapsBlock = await screen.findByTestId(
      "handwavy-preview-overlaps",
    );
    const initialRows = within(overlapsBlock).getAllByTestId(
      "handwavy-preview-overlap-row",
    );
    expect(initialRows).toHaveLength(1);
    expect(initialRows[0]).toHaveAttribute(
      "data-handwavy-overlap-phrase",
      OVERLAP_PHRASE,
    );

    // Click the "Remove existing" quick-action for the overlap row.
    // Routes through requestRemove -> requestRemoveWithImpactPreview ->
    // (zero-impact dry-run) -> handleRemove -> live DELETE -> refresh()
    // + Task #314's refreshOpenAddPreview() (renamed from
    // `refreshOpenPreviewAfterRemoval` in Task #443 once the same
    // helper started covering reinstate / edit-rename too).
    fireEvent.click(
      within(initialRows[0]).getByTestId("handwavy-preview-overlap-remove"),
    );

    // The overlap row for the just-removed phrase must disappear from the
    // open preview without any further reviewer interaction. We also
    // assert the preview panel itself is STILL open — a future regression
    // that "fixed" the stale-overlap symptom by simply dismissing the
    // preview on remove would also drop the row, but for the wrong
    // reasons; pinning the panel-open assertion makes that drift visible.
    await waitFor(() => {
      expect(
        screen.queryByTestId("handwavy-preview-overlap-row"),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("handwavy-preview-confirm")).toBeInTheDocument();

    // The candidate input must NOT have been touched: its value still
    // matches what the reviewer typed.
    expect(screen.getByTestId("handwavy-input")).toHaveValue(CANDIDATE_PHRASE);

    // And a fresh add dry-run POST must have fired AFTER the live DELETE
    // — that's the actual mechanism Task #314 added. Asserting this
    // anchors the test to the refresh hook itself rather than to the
    // downstream symptom (the row disappearing), so a future refactor
    // that achieves the same UI by some other means still trips this
    // test if it skipped the documented re-issue.
    type FetchCall = { url: string; method: string; body: { dryRun?: boolean } };
    const calls: FetchCall[] =
      fetchSpy?.mock.calls.map(
        ([input, init]: [RequestInfo | URL, RequestInit?]) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : (input as Request).url;
          const method = ((init?.method ?? "GET") as string).toUpperCase();
          let body: { dryRun?: boolean } = {};
          if (typeof init?.body === "string") {
            try {
              body = JSON.parse(init.body);
            } catch {
              /* fall through */
            }
          }
          return { url, method, body };
        },
      ) ?? [];
    const phrasesCalls = calls.filter((c: FetchCall) =>
      c.url.includes("/api/feedback/calibration/handwavy-phrases"),
    );
    // Live DELETE is the one WITHOUT `dryRun: true` (the zero-impact
    // dry-run check fires first, then the real DELETE).
    const liveDeleteIdx = phrasesCalls.findIndex(
      (c: FetchCall) => c.method === "DELETE" && c.body.dryRun !== true,
    );
    expect(liveDeleteIdx).toBeGreaterThanOrEqual(0);
    const postsAfterLiveDelete = phrasesCalls
      .slice(liveDeleteIdx + 1)
      .filter((c: FetchCall) => c.method === "POST");
    expect(postsAfterLiveDelete.length).toBeGreaterThanOrEqual(1);
  });
});

// Task #443 — mirror coverage for the OTHER side of the curated-list
// edit: a per-row history Reinstate puts the phrase BACK on the active
// list, which means the previewed candidate's `dryRunOverlaps` snapshot
// MUST gain the just-reinstated row without the reviewer touching the
// candidate input. The Task #314 helper was already structured to be
// reusable; this test pins the wiring into `handleReinstate`'s success
// path.
describe("Task #443 — preview overlap refresh after a per-row reinstate", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
  // Stable history identifier — must match between the seeded history
  // row, the per-row Reinstate button's `removedAt` payload, and the
  // mock POST handler that flips `reinstated: true`.
  const REMOVED_AT = "2026-04-15T09:30:00.000Z";

  beforeEach(() => {
    // Initial state: OVERLAP_PHRASE is NOT on the active list — it sits
    // in the history as a removed row instead. So the open preview
    // starts with zero overlap rows for the candidate (which equals
    // OVERLAP_PHRASE), and the reinstate is what makes the overlap
    // appear. OTHER_PHRASE is kept on the active list so unrelated UI
    // affordances (input enablement, history toggle visibility, etc.)
    // remain in their normal state.
    activePhrases = [makeMarker(OTHER_PHRASE)];
    activeHistory = [
      {
        phrase: OVERLAP_PHRASE,
        category: "absence",
        addedBy: "reviewer-a@example.com",
        addedAt: "2026-04-01T10:00:00.000Z",
        rationale: "seed",
        removedBy: "reviewer-a@example.com",
        removedAt: REMOVED_AT,
        reinstated: false,
      },
    ];
    setCalibrationToken("test-token");
    fetchSpy = installFetchMock();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    setCalibrationToken(null);
  });

  it("adds the overlap row for the just-reinstated phrase to the open preview without the reviewer touching the candidate input", async () => {
    renderAdmin();

    // Wait for the active list to load so the candidate input is enabled.
    await waitFor(() => {
      expect(screen.getByTestId("handwavy-input")).not.toBeDisabled();
    });

    // Type the candidate (which equals the REMOVED phrase still sitting
    // in the history). The dry-run overlap snapshot at this point should
    // contain ZERO rows because the curated list does not yet include
    // OVERLAP_PHRASE.
    fireEvent.change(screen.getByTestId("handwavy-input"), {
      target: { value: CANDIDATE_PHRASE },
    });

    // Open the preview. The dry-run POST returns no overlap rows because
    // OVERLAP_PHRASE isn't on the active list yet.
    fireEvent.click(screen.getByTestId("handwavy-add"));

    // Wait for the preview confirm button to appear (preview is open).
    await screen.findByTestId("handwavy-preview-confirm");
    // No overlap row exists at this point — the overlaps block is only
    // rendered when there is at least one match, so we assert directly
    // on the absence of a row.
    expect(
      screen.queryByTestId("handwavy-preview-overlap-row"),
    ).not.toBeInTheDocument();

    // Expand the removal-history panel so the per-row Reinstate button
    // becomes reachable. The toggle is collapsed by default.
    fireEvent.click(screen.getByTestId("handwavy-history-toggle"));
    const historyList = await screen.findByTestId("handwavy-history-list");

    // Click the Reinstate button on the OVERLAP_PHRASE history row. This
    // opens the confirmation dialog rather than reinstating directly —
    // mirrors the production path so we don't bypass the gate.
    const historyRow = within(historyList)
      .getAllByTestId("handwavy-history-row")
      .find(
        (row) =>
          row.getAttribute("data-handwavy-history-phrase") === OVERLAP_PHRASE,
      );
    expect(historyRow).toBeDefined();
    fireEvent.click(within(historyRow!).getByTestId("handwavy-reinstate"));

    // Confirm the reinstate. Routes through handleReinstate -> live POST
    // /reinstate -> refresh() + Task #443's refreshOpenAddPreview().
    const confirmDialog = await screen.findByTestId(
      "handwavy-reinstate-confirm",
    );
    fireEvent.click(
      within(confirmDialog).getByTestId("handwavy-reinstate-confirm-confirm"),
    );

    // The overlap row for the just-reinstated phrase MUST appear in the
    // open preview without any further reviewer interaction. We pin
    // both the row's presence and the panel-still-open assertion so a
    // future regression that "fixed" the stale-overlap symptom by
    // dismissing the panel on reinstate is also flagged.
    await waitFor(() => {
      const row = screen.queryByTestId("handwavy-preview-overlap-row");
      expect(row).toBeInTheDocument();
      expect(row).toHaveAttribute(
        "data-handwavy-overlap-phrase",
        OVERLAP_PHRASE,
      );
    });
    expect(screen.getByTestId("handwavy-preview-confirm")).toBeInTheDocument();

    // The candidate input must NOT have been touched: its value still
    // matches what the reviewer typed.
    expect(screen.getByTestId("handwavy-input")).toHaveValue(CANDIDATE_PHRASE);

    // And a fresh add dry-run POST must have fired AFTER the live
    // /reinstate POST — that's the actual mechanism Task #443 added.
    // Anchoring the test to the refresh hook itself (rather than just
    // the downstream symptom of the row appearing) ensures a future
    // refactor that achieves the same UI by some other means still
    // trips this test if it skipped the documented re-issue.
    type FetchCallSummary = { url: string; method: string };
    const calls: FetchCallSummary[] =
      fetchSpy?.mock.calls.map(
        ([input, init]: [RequestInfo | URL, RequestInit | undefined]) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : (input as Request).url;
          const method = ((init?.method ?? "GET") as string).toUpperCase();
          return { url, method };
        },
      ) ?? [];
    const reinstateIdx = calls.findIndex(
      (c: FetchCallSummary) =>
        c.method === "POST" &&
        c.url.includes(
          "/api/feedback/calibration/handwavy-phrases/reinstate",
        ) &&
        !c.url.includes("/reinstate-batch"),
    );
    expect(reinstateIdx).toBeGreaterThanOrEqual(0);
    // After the live /reinstate POST landed, an add-phrase dry-run POST
    // must have fired. The add-phrase URL is the bare `/handwavy-phrases`
    // endpoint (no `/reinstate` or `/reinstate-batch` suffix) with a POST
    // method — distinguish carefully so a stray `/reinstate` POST doesn't
    // satisfy the assertion.
    const dryRunPostsAfterReinstate = calls
      .slice(reinstateIdx + 1)
      .filter(
        (c: FetchCallSummary) =>
          c.method === "POST" &&
          c.url.includes("/api/feedback/calibration/handwavy-phrases") &&
          !c.url.includes("/reinstate"),
      );
    expect(dryRunPostsAfterReinstate.length).toBeGreaterThanOrEqual(1);
  });
});

// Task #443 — second mirror coverage: a rename via Edit removes the
// original normalized phrase from the active list and adds the new
// normalized phrase. Either side of that swap can change the open
// add-preview's `dryRunOverlaps` snapshot, so `applyEdit` (rename
// branch only — gated on `renamed && result.edited !== false`) wires
// the same `refreshOpenAddPreview()` hook in. This test pins that
// wiring: when the reviewer renames an unrelated phrase TO the
// previewed candidate, the overlap row APPEARS without touching the
// candidate input. (Category/rationale-only edits don't need this
// coverage — they don't change the active list and therefore can't
// change overlaps; the production guard skips the refresh in that
// case.)
describe("Task #443 — preview overlap refresh after an edit-rename", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    // Active list: one phrase the reviewer will rename TO the
    // candidate (PHRASE_TO_RENAME), plus an unrelated OTHER_PHRASE so
    // the list isn't pathologically small. Neither phrase equals
    // CANDIDATE_PHRASE at preview-open time, so the overlaps block
    // starts empty.
    activePhrases = [
      makeMarker(PHRASE_TO_RENAME),
      makeMarker(OTHER_PHRASE),
    ];
    activeHistory = [];
    setCalibrationToken("test-token");
    fetchSpy = installFetchMock();
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    setCalibrationToken(null);
  });

  it("adds the overlap row for the renamed phrase to the open preview without the reviewer touching the candidate input", async () => {
    renderAdmin();

    await waitFor(() => {
      expect(screen.getByTestId("handwavy-input")).not.toBeDisabled();
    });

    // Type the candidate. Since neither active-list phrase matches
    // CANDIDATE_PHRASE yet, the dry-run overlaps block stays empty.
    fireEvent.change(screen.getByTestId("handwavy-input"), {
      target: { value: CANDIDATE_PHRASE },
    });

    // Open the preview.
    fireEvent.click(screen.getByTestId("handwavy-add"));
    await screen.findByTestId("handwavy-preview-confirm");
    expect(
      screen.queryByTestId("handwavy-preview-overlap-row"),
    ).not.toBeInTheDocument();

    // Find the row for PHRASE_TO_RENAME and click its Edit affordance.
    // The HandwavyPhrasesAdmin renders one Edit button per active row;
    // we filter by the row's label to target the right phrase.
    const editButtons = await screen.findAllByTestId("handwavy-edit");
    const editButtonForRename = editButtons.find(
      (btn) =>
        btn.getAttribute("aria-label") === `Edit phrase ${PHRASE_TO_RENAME}`,
    );
    expect(editButtonForRename).toBeDefined();
    fireEvent.click(editButtonForRename!);

    // Rewrite the phrase text so the saved edit is a rename to
    // CANDIDATE_PHRASE. The handwavy-edit-phrase input only renders
    // for the row that's currently in edit mode.
    const editInput = await screen.findByTestId("handwavy-edit-phrase");
    fireEvent.change(editInput, { target: { value: CANDIDATE_PHRASE } });

    // Save. handleSaveEdit issues a zero-impact dry-run (the DELETE
    // handler returns SINGLE_ZERO_IMPACT for any phrase), so applyEdit
    // fires directly without the impact-preview gate. The PATCH then
    // mutates `activePhrases` and Task #443's refreshOpenAddPreview()
    // re-issues the add dry-run.
    fireEvent.click(screen.getByTestId("handwavy-edit-save"));

    // The overlap row for the renamed-to phrase MUST appear in the
    // open preview. We pin both the row's presence and the panel-
    // still-open assertion so a future regression that "fixed" the
    // stale-overlap symptom by simply dismissing the preview is also
    // flagged.
    await waitFor(() => {
      const row = screen.queryByTestId("handwavy-preview-overlap-row");
      expect(row).toBeInTheDocument();
      expect(row).toHaveAttribute(
        "data-handwavy-overlap-phrase",
        CANDIDATE_PHRASE,
      );
    });
    expect(screen.getByTestId("handwavy-preview-confirm")).toBeInTheDocument();

    // The candidate input must NOT have been touched.
    expect(screen.getByTestId("handwavy-input")).toHaveValue(CANDIDATE_PHRASE);

    // And a fresh add dry-run POST must have fired AFTER the live
    // PATCH — that's the actual mechanism Task #443 added on the
    // edit-rename path.
    type FetchCallSummary = { url: string; method: string };
    const calls: FetchCallSummary[] =
      fetchSpy?.mock.calls.map(
        ([input, init]: [RequestInfo | URL, RequestInit | undefined]) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : (input as Request).url;
          const method = ((init?.method ?? "GET") as string).toUpperCase();
          return { url, method };
        },
      ) ?? [];
    const patchIdx = calls.findIndex(
      (c: FetchCallSummary) =>
        c.method === "PATCH" &&
        c.url.includes("/api/feedback/calibration/handwavy-phrases"),
    );
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    const dryRunPostsAfterPatch = calls
      .slice(patchIdx + 1)
      .filter(
        (c: FetchCallSummary) =>
          c.method === "POST" &&
          c.url.includes("/api/feedback/calibration/handwavy-phrases") &&
          !c.url.includes("/reinstate"),
      );
    expect(dryRunPostsAfterPatch.length).toBeGreaterThanOrEqual(1);
  });
});
