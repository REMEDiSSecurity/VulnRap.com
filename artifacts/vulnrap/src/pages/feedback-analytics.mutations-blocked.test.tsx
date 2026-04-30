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
  CalibrationSuggestion,
  HandwavyMarker,
  HandwavyHistoryEntry,
  HandwavyPhrasesList,
  HandwavyPhraseRemovalBatchesList,
} from "@workspace/api-client-react";
import { HandwavyPhrasesAdmin, SuggestionCard } from "./feedback-analytics";

// Task #291 — focused unit coverage for the `mutationsAllowed` prop wiring on
// every mutating control inside the FLAT hand-wavy admin panel + the
// CalibrationSuggestion `Apply` button. The companion e2e suite
// (`e2e/handwavy-mutations-blocked.spec.ts`) only spot-checks a handful of
// these buttons; the unit-level matrix here iterates the FULL list so a
// future refactor that drops the `|| !mutationsAllowed` clause on a single
// button regresses LOUDLY at the closest possible scope.
//
// Two slices of assertion:
//   * Mutating buttons -> disabled + carry the shared MUTATIONS_BLOCKED_TITLE
//     tooltip (asserted via the `title` attribute) when mutationsAllowed is
//     false.
//   * Cancel / dismiss buttons -> stay enabled (and DO NOT carry the
//     blocked-mutations title) so reviewers can always back out of an open
//     dialog or preview even when the server is rejecting their token.
//
// We verify both halves on the SAME rendered tree where possible: dialog
// confirms (handwavy-edit-save, handwavy-revert-confirm-confirm, etc.) are
// only mounted while their parent dialog is open, so we drive the UI with
// mutationsAllowed=true to open them, then `rerender` with the prop flipped
// to assert the gated state. React state survives the prop-only rerender so
// the open dialog stays open across the flip.

const MUTATIONS_BLOCKED_TITLE =
  "Calibration mutations are blocked: the reviewer token is missing or invalid (see the warning banner above the calibration card).";

// ---------- fixture data ---------------------------------------------------

// Two reviewer-added phrases inside their 5-minute undo window. Two so that
// the panel-level "Undo last N adds" button (which only renders when
// `undoCandidates.size >= 2`) is present in the DOM. One of them carries an
// `edits` log so the per-row Edit-history <details> exposes the
// `handwavy-revert-edit` button. The other carries thrash history (>=2
// completed remove+reinstate cycles) so the per-row Remove button opens the
// high-thrash AlertDialog (handwavy-remove-confirm-go).
const RECENT_ISO = new Date(Date.now() - 30_000).toISOString();
const RECENT_ISO_2 = new Date(Date.now() - 45_000).toISOString();

const PHRASE_WITH_EDIT: HandwavyMarker = {
  phrase: "comprehensive zero-trust posture",
  category: "buzzword",
  addedBy: "reviewer-a@example.com",
  addedAt: RECENT_ISO,
  rationale: "Original rationale",
  edits: [
    {
      // before/after blocks must use the {from, to} shape from the API
      // schema (HandwavyEditEntryCategory / HandwavyEditEntryRationale).
      // We make sure the `from` values DO NOT match the current marker
      // state so revertWouldBeNoop() returns false and the Revert button
      // stays clickable.
      category: { from: "absence", to: "buzzword" },
      rationale: { from: "Older rationale", to: "Original rationale" },
      editedBy: "reviewer-a@example.com",
      editedAt: new Date(Date.now() - 60_000).toISOString(),
    },
  ],
};

const PHRASE_WITH_THRASH: HandwavyMarker = {
  phrase: "synergistic threat surface",
  category: "hedging",
  addedBy: "reviewer-b@example.com",
  addedAt: RECENT_ISO_2,
  rationale: "Recent reviewer add",
};

const PHRASES: HandwavyMarker[] = [PHRASE_WITH_EDIT, PHRASE_WITH_THRASH];

// History log:
//   * One single-phrase removal (drives `handwavy-reinstate`).
//   * Two reinstated single-phrase removals on `synergistic threat surface`
//     (drives the high-thrash gate so `handwavy-remove` -> opens the
//     AlertDialog with `handwavy-remove-confirm-go`).
//   * One batch removal (drives `handwavy-reinstate-batch` +
//     `handwavy-reinstate-batch-preview`).
const HISTORY: HandwavyHistoryEntry[] = [
  {
    phrase: "removed-phrase-for-reinstate",
    category: "absence",
    addedBy: "reviewer-c@example.com",
    addedAt: "2026-04-01T10:00:00.000Z",
    rationale: "Was active until last week",
    removedBy: "reviewer-c@example.com",
    removedAt: "2026-04-20T10:00:00.000Z",
    reinstated: false,
  },
  {
    phrase: PHRASE_WITH_THRASH.phrase,
    category: "hedging",
    addedBy: "reviewer-b@example.com",
    addedAt: "2026-03-01T10:00:00.000Z",
    rationale: "first add",
    removedBy: "reviewer-d@example.com",
    removedAt: "2026-03-10T10:00:00.000Z",
    reinstated: true,
    reinstatedBy: "reviewer-b@example.com",
    reinstatedAt: "2026-03-15T10:00:00.000Z",
  },
  {
    phrase: PHRASE_WITH_THRASH.phrase,
    category: "hedging",
    addedBy: "reviewer-b@example.com",
    addedAt: "2026-03-15T10:00:00.000Z",
    rationale: "second add",
    removedBy: "reviewer-d@example.com",
    removedAt: "2026-03-20T10:00:00.000Z",
    reinstated: true,
    reinstatedBy: "reviewer-b@example.com",
    reinstatedAt: "2026-03-25T10:00:00.000Z",
  },
  {
    removedBy: "reviewer-e@example.com",
    removedAt: "2026-04-25T10:00:00.000Z",
    reinstated: false,
    phrases: [
      {
        phrase: "batch-phrase-one",
        category: "buzzword",
        addedBy: "reviewer-e@example.com",
        addedAt: "2026-04-10T10:00:00.000Z",
        rationale: "batch member",
      },
      {
        phrase: "batch-phrase-two",
        category: "buzzword",
        addedBy: "reviewer-e@example.com",
        addedAt: "2026-04-12T10:00:00.000Z",
        rationale: "batch member",
      },
    ],
  },
];

const HANDWAVY_PHRASES: HandwavyPhrasesList = {
  phrases: PHRASES,
  total: PHRASES.length,
  history: HISTORY,
};

const REMOVAL_BATCHES: HandwavyPhraseRemovalBatchesList = {
  limit: 50,
  totalBatches: 1,
  batches: [
    {
      removedAt: "2026-04-25T10:00:00.000Z",
      removedBy: "reviewer-e@example.com",
      phraseCount: 2,
      reinstated: false,
      samplePhrases: ["batch-phrase-one", "batch-phrase-two"],
    },
  ],
};

const INVALID_AUTH_STATUS = {
  serverRequiresToken: true,
  tokenPresented: true,
  tokenValid: false,
  mutationsAllowed: false,
};

const VALID_AUTH_STATUS = {
  serverRequiresToken: true,
  tokenPresented: true,
  tokenValid: true,
  mutationsAllowed: true,
};

const SUGGESTION: CalibrationSuggestion = {
  parameter: "tierThresholds.high",
  currentValue: 66,
  suggestedValue: 70,
  reason: "Recent feedback suggests raising the high-tier cutoff",
  confidence: "high",
  basedOnCount: 42,
};

// Every mutating data-testid that this admin panel renders WITHOUT having to
// open a dialog first. These are the ones the matrix iterates with the
// component freshly rendered at mutationsAllowed=false.
const ALWAYS_RENDERED_MUTATING_TESTIDS = [
  "handwavy-add",
  "handwavy-edit",
  "handwavy-remove",
  "handwavy-undo",
  "handwavy-undo-all",
  "handwavy-bulk-remove",
  "handwavy-reinstate",
  "handwavy-reinstate-batch",
  "handwavy-reinstate-batch-preview",
  "handwavy-revert-edit",
] as const;

// ---------- helpers --------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Minimal dry-run shapes. The component fails closed without `dryRun` /
// `dryRunMatches` / `dryRunImpact` / `batch`, so each fixture includes them.
const DRY_RUN_MATCHES = {
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

// validDetectionsLost > 0 forces the rename path to open its preview panel
// instead of short-circuiting to the silent PATCH.
const NONZERO_IMPACT_BLOCK = {
  ...ZERO_IMPACT_BLOCK,
  validDetectionsLost: 1,
  total: 1,
};

// Single rename: needs non-zero impact or `handleSaveEdit` short-circuits.
// Bulk: zero impact keeps `requiresAck` off so we don't have to tick ack.
const SINGLE_DRY_RUN_IMPACT = {
  corpus: NONZERO_IMPACT_BLOCK,
  production: null,
  productionError: null,
  productionLimit: 2000,
};
const BULK_DRY_RUN_IMPACT = {
  corpus: ZERO_IMPACT_BLOCK,
  production: null,
  productionError: null,
  productionLimit: 2000,
};

function installFetchMock(
  authStatus = INVALID_AUTH_STATUS,
): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes("/api/feedback/calibration/auth-status")) {
      return jsonResponse(authStatus);
    }
    if (
      url.includes("/api/feedback/calibration/handwavy-phrases/removal-batches")
    ) {
      return jsonResponse(REMOVAL_BATCHES);
    }
    // Reinstate-batch dry-run — match BEFORE the general /handwavy-phrases
    // route so this suffix isn't swallowed by it.
    if (
      url.includes(
        "/api/feedback/calibration/handwavy-phrases/reinstate-batch",
      )
    ) {
      return jsonResponse({
        dryRun: true,
        batch: true,
        removedAt: REMOVAL_BATCHES.batches[0].removedAt,
        reinstatedCount: 2,
        skipped: 0,
        total: PHRASES.length + 2,
        results: [
          { phrase: "batch-phrase-one", reinstated: true },
          { phrase: "batch-phrase-two", reinstated: true },
        ],
        historyEntry: HISTORY[3],
        phrases: PHRASES,
        history: HISTORY,
      });
    }
    if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
      const method = (init?.method ?? "GET").toUpperCase();
      // Add-phrase dry-run preview (POST with dryRun:true).
      if (method === "POST") {
        return jsonResponse({
          phrase: "comprehensive zero-trust assessment",
          category: "buzzword",
          total: PHRASES.length,
          phrases: PHRASES,
          dryRunMatches: DRY_RUN_MATCHES,
        });
      }
      // Single-phrase / bulk removal dry-run preview (DELETE with
      // dryRun:true). The component reads `batch` to discriminate; bulk
      // requests pass `phrases: [...]`, single requests pass `phrase: ...`.
      if (method === "DELETE") {
        let isBatch = false;
        try {
          const parsed = JSON.parse((init?.body as string) ?? "{}");
          isBatch = Array.isArray(parsed.phrases);
        } catch {
          // fall through with isBatch=false
        }
        if (isBatch) {
          return jsonResponse({
            dryRun: true,
            batch: true,
            wouldRemove: 1,
            notFound: 0,
            duplicateInBatch: 0,
            total: PHRASES.length,
            projectedTotal: PHRASES.length - 1,
            results: [
              { raw: PHRASES[0].phrase, phrase: PHRASES[0].phrase, removed: true },
            ],
            dryRunImpact: BULK_DRY_RUN_IMPACT,
            phrases: PHRASES,
          });
        }
        return jsonResponse({
          dryRun: true,
          batch: false,
          wouldRemove: 1,
          notFound: 0,
          duplicateInBatch: 0,
          phrase: PHRASES[0].phrase,
          raw: PHRASES[0].phrase,
          removed: true,
          total: PHRASES.length,
          projectedTotal: PHRASES.length - 1,
          results: [
            { raw: PHRASES[0].phrase, phrase: PHRASES[0].phrase, removed: true },
          ],
          dryRunImpact: SINGLE_DRY_RUN_IMPACT,
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
  return spy;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderAdmin(mutationsAllowed: boolean) {
  const client = makeQueryClient();
  const utils = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/feedback-analytics"]}>
        <HandwavyPhrasesAdmin mutationsAllowed={mutationsAllowed} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const rerender = (next: boolean) =>
    utils.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/feedback-analytics"]}>
          <HandwavyPhrasesAdmin mutationsAllowed={next} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  return { ...utils, rerender, client };
}

function renderSuggestionCard(mutationsAllowed: boolean, applying = false) {
  const onApply = vi.fn();
  const utils = render(
    <SuggestionCard
      suggestion={SUGGESTION}
      onApply={onApply}
      applying={applying}
      cooldownActive={false}
      cooldownSecondsRemaining={0}
      mutationsAllowed={mutationsAllowed}
    />,
  );
  return { ...utils, onApply };
}

async function waitForPanelReady() {
  // Both data hooks (phrases + removal-batches) need to resolve before the
  // matrix-iterated buttons appear. The presence of the per-row Edit button
  // is the latest of the two render branches we care about.
  await waitFor(() => {
    expect(screen.getAllByTestId("handwavy-edit").length).toBeGreaterThan(0);
  });
  // The removal-history list is collapsed by default behind the
  // `handwavy-history-toggle` button. Expand it so per-row reinstate /
  // reinstate-batch / reinstate-batch-preview buttons are queryable from
  // the matrix.
  const toggle = screen.queryByTestId("handwavy-history-toggle");
  if (toggle && toggle.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.getByTestId("handwavy-history-list")).toBeInTheDocument(),
    );
  }
}

function expectBlocked(el: HTMLElement, label: string) {
  expect(el, `${label} must be disabled when mutations are blocked`).toBeDisabled();
  expect(
    el.getAttribute("title"),
    `${label} must carry the MUTATIONS_BLOCKED_TITLE tooltip`,
  ).toBe(MUTATIONS_BLOCKED_TITLE);
  expect(
    el.getAttribute("data-mutations-blocked"),
    `${label} must flag itself with data-mutations-blocked="true"`,
  ).toBe("true");
}

function expectEnabledCancel(el: HTMLElement, label: string) {
  expect(
    el,
    `${label} must stay enabled so reviewers can always dismiss the dialog`,
  ).not.toBeDisabled();
  expect(
    el.getAttribute("title") ?? "",
    `${label} must NOT carry the MUTATIONS_BLOCKED_TITLE tooltip`,
  ).not.toBe(MUTATIONS_BLOCKED_TITLE);
}

// ---------- specs ----------------------------------------------------------

describe("Task #291 — calibration mutation buttons honour mutationsAllowed=false", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setCalibrationToken(null);
    fetchSpy = installFetchMock();
  });

  afterEach(() => {
    setCalibrationToken(null);
    fetchSpy.mockRestore();
  });

  it("SuggestionCard: Apply button is disabled with the MUTATIONS_BLOCKED_TITLE tooltip", () => {
    const { onApply } = renderSuggestionCard(false);
    const apply = screen.getByTestId("calibration-suggestion-apply");
    expectBlocked(apply, "calibration-suggestion-apply");
    fireEvent.click(apply);
    expect(
      onApply,
      "Apply must NOT fire while disabled (defense in depth)",
    ).not.toHaveBeenCalled();
  });

  it("SuggestionCard: Apply button stays enabled when mutationsAllowed=true (sanity)", () => {
    renderSuggestionCard(true);
    const apply = screen.getByTestId("calibration-suggestion-apply");
    expect(apply).not.toBeDisabled();
    expect(apply.getAttribute("title") ?? "").not.toBe(MUTATIONS_BLOCKED_TITLE);
    expect(apply.getAttribute("data-mutations-blocked")).toBe("false");
  });

  it("HandwavyPhrasesAdmin: every always-rendered mutating button is disabled with the shared tooltip", async () => {
    renderAdmin(false);
    await waitForPanelReady();

    // For each testid we may have multiple instances (per-row Edit, per-row
    // Remove, multiple Reinstate rows, etc). Every instance must be blocked
    // — the per-button matrix is pointless if a single straggler sneaks
    // through with a hard-coded `disabled={false}`.
    for (const testId of ALWAYS_RENDERED_MUTATING_TESTIDS) {
      const matches = screen.queryAllByTestId(testId);
      expect(
        matches.length,
        `expected at least one rendered '${testId}' button so the matrix actually verifies it`,
      ).toBeGreaterThan(0);
      matches.forEach((el, idx) => {
        expectBlocked(el, `${testId}[${idx}]`);
      });
    }
  });

  it("HandwavyPhrasesAdmin: edit dialog (handwavy-edit-save disabled, handwavy-edit-cancel enabled)", async () => {
    const { rerender } = renderAdmin(true);
    await waitForPanelReady();

    fireEvent.click(screen.getAllByTestId("handwavy-edit")[0]);
    // Save renders inside the row's edit-mode subtree; sanity-check it shows
    // up before flipping the prop.
    await waitFor(() =>
      expect(screen.getByTestId("handwavy-edit-save")).toBeInTheDocument(),
    );

    rerender(false);

    expectBlocked(screen.getByTestId("handwavy-edit-save"), "handwavy-edit-save");
    expectEnabledCancel(
      screen.getByTestId("handwavy-edit-cancel"),
      "handwavy-edit-cancel",
    );
  });

  it("HandwavyPhrasesAdmin: revert-edit confirm dialog (handwavy-revert-confirm-confirm disabled, -cancel enabled)", async () => {
    const { rerender } = renderAdmin(true);
    await waitForPanelReady();

    // Per-row revert-edit lives inside the <details> edit-history block. The
    // <details> element starts collapsed but the button is still in the DOM,
    // so getByTestId resolves it.
    fireEvent.click(screen.getAllByTestId("handwavy-revert-edit")[0]);
    await waitFor(() =>
      expect(
        screen.getByTestId("handwavy-revert-confirm-confirm"),
      ).toBeInTheDocument(),
    );

    rerender(false);

    expectBlocked(
      screen.getByTestId("handwavy-revert-confirm-confirm"),
      "handwavy-revert-confirm-confirm",
    );
    expectEnabledCancel(
      screen.getByTestId("handwavy-revert-confirm-cancel"),
      "handwavy-revert-confirm-cancel",
    );
  });

  it("HandwavyPhrasesAdmin: reinstate confirm dialog (handwavy-reinstate-confirm-confirm disabled, -cancel enabled)", async () => {
    const { rerender } = renderAdmin(true);
    await waitForPanelReady();

    fireEvent.click(screen.getAllByTestId("handwavy-reinstate")[0]);
    await waitFor(() =>
      expect(
        screen.getByTestId("handwavy-reinstate-confirm-confirm"),
      ).toBeInTheDocument(),
    );

    rerender(false);

    expectBlocked(
      screen.getByTestId("handwavy-reinstate-confirm-confirm"),
      "handwavy-reinstate-confirm-confirm",
    );
    expectEnabledCancel(
      screen.getByTestId("handwavy-reinstate-confirm-cancel"),
      "handwavy-reinstate-confirm-cancel",
    );
  });

  it("HandwavyPhrasesAdmin: undo-all confirm dialog (handwavy-undo-all-confirm-confirm disabled, -cancel enabled)", async () => {
    const { rerender } = renderAdmin(true);
    await waitForPanelReady();

    fireEvent.click(screen.getByTestId("handwavy-undo-all"));
    await waitFor(() =>
      expect(
        screen.getByTestId("handwavy-undo-all-confirm-confirm"),
      ).toBeInTheDocument(),
    );

    rerender(false);

    expectBlocked(
      screen.getByTestId("handwavy-undo-all-confirm-confirm"),
      "handwavy-undo-all-confirm-confirm",
    );
    expectEnabledCancel(
      screen.getByTestId("handwavy-undo-all-confirm-cancel"),
      "handwavy-undo-all-confirm-cancel",
    );
  });

  it("HandwavyPhrasesAdmin: reinstate-batch confirm dialog (handwavy-reinstate-batch-confirm-confirm disabled, -cancel enabled)", async () => {
    const { rerender } = renderAdmin(true);
    await waitForPanelReady();

    fireEvent.click(screen.getAllByTestId("handwavy-reinstate-batch")[0]);
    await waitFor(() =>
      expect(
        screen.getByTestId("handwavy-reinstate-batch-confirm-confirm"),
      ).toBeInTheDocument(),
    );

    rerender(false);

    expectBlocked(
      screen.getByTestId("handwavy-reinstate-batch-confirm-confirm"),
      "handwavy-reinstate-batch-confirm-confirm",
    );
    expectEnabledCancel(
      screen.getByTestId("handwavy-reinstate-batch-confirm-cancel"),
      "handwavy-reinstate-batch-confirm-cancel",
    );
  });

  it("HandwavyPhrasesAdmin: add-phrase preview dialog (handwavy-preview-confirm disabled, -cancel enabled)", async () => {
    const { rerender } = renderAdmin(true);
    await waitForPanelReady();

    // Type a phrase + click Add — mocked POST returns dryRunMatches and the
    // preview panel mounts with the gated confirm button.
    fireEvent.change(screen.getByTestId("handwavy-input"), {
      target: { value: "comprehensive zero-trust assessment" },
    });
    fireEvent.click(screen.getByTestId("handwavy-add"));
    await waitFor(() =>
      expect(screen.getByTestId("handwavy-preview-confirm")).toBeInTheDocument(),
    );

    rerender(false);

    expectBlocked(
      screen.getByTestId("handwavy-preview-confirm"),
      "handwavy-preview-confirm",
    );
    expectEnabledCancel(
      screen.getByTestId("handwavy-preview-cancel"),
      "handwavy-preview-cancel",
    );
  });

  it("HandwavyPhrasesAdmin: bulk-remove preview dialog (handwavy-bulk-preview-confirm disabled, -cancel enabled)", async () => {
    const { rerender } = renderAdmin(true);
    await waitForPanelReady();

    // Select-all + bulk Remove fires the dry-run DELETE that opens the bulk
    // preview panel. Zero-impact mock keeps `requiresAck` false so the
    // confirm button's disabled state collapses to `!mutationsAllowed`.
    fireEvent.click(screen.getByTestId("handwavy-select-all"));
    fireEvent.click(screen.getByTestId("handwavy-bulk-remove"));
    await waitFor(() =>
      expect(
        screen.getByTestId("handwavy-bulk-preview-confirm"),
      ).toBeInTheDocument(),
    );

    rerender(false);

    expectBlocked(
      screen.getByTestId("handwavy-bulk-preview-confirm"),
      "handwavy-bulk-preview-confirm",
    );
    expectEnabledCancel(
      screen.getByTestId("handwavy-bulk-preview-cancel"),
      "handwavy-bulk-preview-cancel",
    );
  });

  it("HandwavyPhrasesAdmin: rename preview dialog (handwavy-edit-preview-confirm disabled, -cancel enabled)", async () => {
    const { rerender } = renderAdmin(true);
    await waitForPanelReady();

    // Open edit, rename to a new normalized form (rename branch), click Save.
    // Non-zero single-DELETE mock makes `setEditPreview` open the rename-
    // impact panel instead of silently PATCHing.
    fireEvent.click(screen.getAllByTestId("handwavy-edit")[0]);
    await waitFor(() =>
      expect(screen.getByTestId("handwavy-edit-phrase")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("handwavy-edit-phrase"), {
      target: { value: "freshly-renamed phrase for preview" },
    });
    fireEvent.click(screen.getByTestId("handwavy-edit-save"));
    await waitFor(() =>
      expect(
        screen.getByTestId("handwavy-edit-preview-confirm"),
      ).toBeInTheDocument(),
    );

    rerender(false);

    expectBlocked(
      screen.getByTestId("handwavy-edit-preview-confirm"),
      "handwavy-edit-preview-confirm",
    );
    expectEnabledCancel(
      screen.getByTestId("handwavy-edit-preview-cancel"),
      "handwavy-edit-preview-cancel",
    );
  });

  it("HandwavyPhrasesAdmin: reinstate-batch preview dialog (handwavy-reinstate-batch-preview-confirm disabled, -cancel enabled)", async () => {
    const { rerender } = renderAdmin(true);
    await waitForPanelReady();

    // Click the per-batch Preview; mocked dry-run returns reinstatedCount=2,
    // so the preview panel mounts gated only by `!mutationsAllowed`.
    fireEvent.click(screen.getAllByTestId("handwavy-reinstate-batch-preview")[0]);
    await waitFor(() =>
      expect(
        screen.getByTestId("handwavy-reinstate-batch-preview-confirm"),
      ).toBeInTheDocument(),
    );

    rerender(false);

    expectBlocked(
      screen.getByTestId("handwavy-reinstate-batch-preview-confirm"),
      "handwavy-reinstate-batch-preview-confirm",
    );
    expectEnabledCancel(
      screen.getByTestId("handwavy-reinstate-batch-preview-cancel"),
      "handwavy-reinstate-batch-preview-cancel",
    );
  });

  it("HandwavyPhrasesAdmin: high-thrash remove dialog (handwavy-remove-confirm-go disabled, -cancel enabled)", async () => {
    const { rerender } = renderAdmin(true);
    await waitForPanelReady();

    // PHRASE_WITH_THRASH carries 2 reinstated history entries, routing its
    // Remove through the high-thrash AlertDialog. The phrase also appears in
    // the expanded history list, so disambiguate via the `handwavy-row`
    // container (history rows use a different testid).
    const rows = screen.getAllByTestId("handwavy-row");
    const thrashRow = rows.find((r) =>
      r.textContent?.includes(PHRASE_WITH_THRASH.phrase),
    );
    expect(thrashRow, "expected an active-list row for the thrashed phrase").toBeDefined();
    const removeBtn = within(thrashRow as HTMLElement).getByTestId(
      "handwavy-remove",
    );
    fireEvent.click(removeBtn);

    await waitFor(() =>
      expect(
        screen.getByTestId("handwavy-remove-confirm-go"),
      ).toBeInTheDocument(),
    );

    rerender(false);

    expectBlocked(
      screen.getByTestId("handwavy-remove-confirm-go"),
      "handwavy-remove-confirm-go",
    );
    expectEnabledCancel(
      screen.getByTestId("handwavy-remove-confirm-cancel"),
      "handwavy-remove-confirm-cancel",
    );
  });
});
