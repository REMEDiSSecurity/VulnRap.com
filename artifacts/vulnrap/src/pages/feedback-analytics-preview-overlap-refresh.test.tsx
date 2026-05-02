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

const OVERLAP_PHRASE = "do not have a reproducer";
const OTHER_PHRASE = "synergistic threat surface";
const CANDIDATE_PHRASE = "do not have a reproducer";

// Internal mock state — mutated by the DELETE handler so subsequent GETs
// and the post-remove dry-run reflect the curated list AFTER the remove.
let activePhrases: HandwavyMarker[] = [];

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
    if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
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
      // GET: return the current active list.
      return jsonResponse({
        phrases: activePhrases,
        total: activePhrases.length,
        history: [],
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
    // + Task #314's refreshOpenPreviewAfterRemoval().
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
