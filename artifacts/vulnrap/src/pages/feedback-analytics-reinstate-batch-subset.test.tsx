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
import { HandwavyPhrasesAdmin } from "./feedback-analytics";
import type {
  HandwavyMarker,
  HandwavyHistoryEntry,
  HandwavyPhrasesList,
  HandwavyPhraseRemovalBatchesList,
} from "@workspace/api-client-react";

// Task #507 — end-to-end coverage for the "drop a row, then click Reinstate
// batch" flow inside the FLAT hand-wavy admin panel. The engine + route tests
// already exercise the server-side behaviour of the new `phrases` allow-list
// (Task #360); this test wires the dialog (`handleReinstateBatchSubset`) to
// real DOM interactions to make sure the partial-batch path actually
// collapses to a single round-trip with the kept phrases — and that the
// dropped phrase stays visible in the removal-history view.

// ---------- fixture data ---------------------------------------------------

const PHRASES: HandwavyMarker[] = [
  {
    phrase: "comprehensive zero-trust posture",
    category: "buzzword",
    addedBy: "reviewer-a@example.com",
    addedAt: "2026-04-01T10:00:00.000Z",
    rationale: "Some active phrase",
  },
];

const BATCH_REMOVED_AT = "2026-04-25T10:00:00.000Z";
const KEPT_PHRASE = "batch-phrase-one";
const DROPPED_PHRASE = "batch-phrase-two";

const HISTORY: HandwavyHistoryEntry[] = [
  {
    removedBy: "reviewer-e@example.com",
    removedAt: BATCH_REMOVED_AT,
    reinstated: false,
    phrases: [
      {
        phrase: KEPT_PHRASE,
        category: "buzzword",
        addedBy: "reviewer-e@example.com",
        addedAt: "2026-04-10T10:00:00.000Z",
        rationale: "batch member",
      },
      {
        phrase: DROPPED_PHRASE,
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
      removedAt: BATCH_REMOVED_AT,
      removedBy: "reviewer-e@example.com",
      phraseCount: 2,
      reinstated: false,
      samplePhrases: [KEPT_PHRASE, DROPPED_PHRASE],
    },
  ],
};

const VALID_AUTH_STATUS = {
  serverRequiresToken: true,
  tokenPresented: true,
  tokenValid: true,
  mutationsAllowed: true,
};

// ---------- helpers --------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ReinstateBatchCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetchMock(): {
  spy: ReturnType<typeof vi.spyOn>;
  reinstateBatchCalls: ReinstateBatchCall[];
} {
  const reinstateBatchCalls: ReinstateBatchCall[] = [];
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
    // Reinstate-batch — match BEFORE the general /handwavy-phrases route.
    // We capture every call here so the test can assert call count + body.
    if (
      url.includes("/api/feedback/calibration/handwavy-phrases/reinstate-batch")
    ) {
      let parsedBody: unknown = null;
      try {
        parsedBody = JSON.parse((init?.body as string) ?? "{}");
      } catch {
        parsedBody = null;
      }
      reinstateBatchCalls.push({ url, method, body: parsedBody });
      return jsonResponse({
        batch: true,
        removedAt: BATCH_REMOVED_AT,
        reinstatedCount: 1,
        skipped: 0,
        total: PHRASES.length + 1,
        results: [{ phrase: KEPT_PHRASE, reinstated: true }],
        historyEntry: HISTORY[0],
        phrases: PHRASES,
        history: HISTORY,
      });
    }
    if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
      return jsonResponse(HANDWAVY_PHRASES);
    }
    return jsonResponse({});
  });
  return { spy, reinstateBatchCalls };
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

async function expandHistory() {
  const toggle = await screen.findByTestId("handwavy-history-toggle");
  if (toggle.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(toggle);
  }
  await waitFor(() =>
    expect(screen.getByTestId("handwavy-history-list")).toBeInTheDocument(),
  );
}

// ---------- spec -----------------------------------------------------------

describe("Task #507 — partial reinstate-batch end-to-end via the confirm dialog", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let reinstateBatchCalls: ReinstateBatchCall[];

  beforeEach(() => {
    setCalibrationToken("test-token");
    const installed = installFetchMock();
    fetchSpy = installed.spy;
    reinstateBatchCalls = installed.reinstateBatchCalls;
  });

  afterEach(() => {
    setCalibrationToken(null);
    fetchSpy.mockRestore();
  });

  it("drops a row in the confirm dialog, fires ONE /reinstate-batch with the kept phrase, and leaves the dropped row in the history view", async () => {
    renderAdmin();

    // Wait for the panel + removal-batches data to load, then expand the
    // collapsed history list so the per-batch "Reinstate all" button is
    // queryable.
    await expandHistory();

    // Open the reinstate-batch confirm dialog from the batch header row.
    const reinstateBatchButtons = await screen.findAllByTestId(
      "handwavy-reinstate-batch",
    );
    expect(reinstateBatchButtons.length).toBeGreaterThan(0);
    fireEvent.click(reinstateBatchButtons[0]);

    // Both inner phrases show up as rows in the dialog summary list.
    const summary = await screen.findByTestId(
      "handwavy-reinstate-batch-confirm-summary",
    );
    const initialDropButtons = within(summary).getAllByTestId(
      "handwavy-reinstate-batch-confirm-drop",
    );
    expect(initialDropButtons).toHaveLength(2);

    // Drop one of the inner phrases. The DOM keeps `data-phrase` so the
    // test can pick a specific row deterministically.
    const dropButton = initialDropButtons.find(
      (b) => b.getAttribute("data-phrase") === DROPPED_PHRASE,
    );
    expect(
      dropButton,
      "expected a drop button for the dropped phrase",
    ).toBeTruthy();
    fireEvent.click(dropButton!);

    // After the drop, only the kept phrase remains in the summary list and
    // the "X will stay on the removal-history list" note appears.
    await waitFor(() => {
      const remaining = within(
        screen.getByTestId("handwavy-reinstate-batch-confirm-summary"),
      ).getAllByTestId("handwavy-reinstate-batch-confirm-drop");
      expect(remaining).toHaveLength(1);
      expect(remaining[0].getAttribute("data-phrase")).toBe(KEPT_PHRASE);
    });
    expect(
      screen.getByTestId("handwavy-reinstate-batch-confirm-dropped-note"),
    ).toBeInTheDocument();

    // Confirm the partial reinstate.
    fireEvent.click(
      screen.getByTestId("handwavy-reinstate-batch-confirm-confirm"),
    );

    // Exactly ONE round-trip to /reinstate-batch, carrying the kept rows
    // through the new `phrases` allow-list (Task #360). Wait for the
    // mutating call to land before asserting so the test isn't racy.
    await waitFor(() => {
      expect(reinstateBatchCalls.length).toBe(1);
    });
    const call = reinstateBatchCalls[0];
    expect(call.method).toBe("POST");
    expect(call.body).toMatchObject({
      removedAt: BATCH_REMOVED_AT,
      phrases: [KEPT_PHRASE],
    });
    // Make sure no `dryRun` flag snuck in — this is the live mutating call,
    // not the Task #177 preview.
    expect((call.body as { dryRun?: unknown }).dryRun).toBeUndefined();

    // Dialog closes after confirm.
    await waitFor(() => {
      expect(
        screen.queryByTestId("handwavy-reinstate-batch-confirm-summary"),
      ).not.toBeInTheDocument();
    });

    // The dropped phrase stays visible in the removal-history list as a
    // removed row. The mock returns the original history payload after
    // refresh, so both inner rows are still rendered; we assert the
    // dropped phrase is among them.
    const historyList = screen.getByTestId("handwavy-history-list");
    const historyRows = within(historyList).getAllByTestId(
      "handwavy-history-row",
    );
    const phrasesInHistory = historyRows.map(
      (r) => r.getAttribute("data-handwavy-history-phrase") ?? "",
    );
    expect(phrasesInHistory).toContain(DROPPED_PHRASE);
  });
});
