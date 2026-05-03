import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCalibrationToken } from "@workspace/api-client-react";
import { HandwavyPhrasesAdmin } from "./feedback-analytics";
import type {
  HandwavyMarker,
  HandwavyPhrasesList,
  HandwavyPhraseRemovalBatchesList,
} from "@workspace/api-client-react";

// Task #463 — render coverage for the coverage-gap banner that Task #323
// added inside the bulk-removal preview's production block. The
// `archiveTotal` threading from the calibration dry-run route is already
// covered at the unit level on the server side; this file pins the
// UI-side `showCoverageGap` threshold so a future tweak to the bulk
// preview panel can't silently regress the warning.
//
// Three cases, all driven through a real bulk-remove dry-run:
//   1. archiveTotal >> productionLimit (8400 vs 100) → banner renders.
//   2. archiveTotal within coverage (150 vs 100, so productionLimit*2 >
//      archiveTotal) → banner does NOT render.
//   3. archiveTotal === null → banner does NOT render.

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

// Zero-impact body keeps the bulk-preview confirm gating off the
// requires-ack path so the panel mounts cleanly without extra dialogs.
// `oldestCreatedAt` / `newestCreatedAt` are kept null so the production
// block's optional scan-range and stale-production sub-blocks stay out of
// the way of the coverage-gap assertion.
function makeImpactBlock(archiveTotal: number | null) {
  return {
    total: 0,
    byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
    validDetectionsLost: 0,
    falsePositivesDropped: 0,
    corpusSize: archiveTotal == null ? 0 : Math.min(archiveTotal, 100),
    sampleMatches: [] as Array<never>,
    warning: null,
    oldestCreatedAt: null,
    newestCreatedAt: null,
    archiveTotal,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type DryRunImpactConfig = {
  productionLimit: number;
  // The `archiveTotal` value placed on the production impact block. The
  // production block itself is always returned — passing `null` here
  // exercises the `archiveTotal != null` short-circuit in
  // `showCoverageGap` rather than the "production scan skipped" branch.
  productionArchiveTotal: number | null;
};

function installFetchMock(
  config: DryRunImpactConfig,
): ReturnType<typeof vi.spyOn> {
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
      // Bulk-remove dry-run preview. The component discriminates between
      // single and batch removal by inspecting the `phrases` array on the
      // request body — we only care about the bulk path here, so route
      // every DELETE to the bulk-shaped response.
      if (method === "DELETE") {
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
          dryRunImpact: {
            corpus: makeImpactBlock(null),
            production: makeImpactBlock(config.productionArchiveTotal),
            productionError: null,
            productionLimit: config.productionLimit,
          },
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

async function openBulkPreview() {
  // Wait until at least one active-list row has rendered so the
  // select-all toolbar is interactive.
  await waitFor(() => {
    expect(screen.getAllByTestId("handwavy-row").length).toBeGreaterThan(0);
  });
  fireEvent.click(screen.getByTestId("handwavy-select-all"));
  fireEvent.click(screen.getByTestId("handwavy-bulk-remove"));
  // Confirm the preview panel mounted before any banner-presence
  // assertion runs.
  await waitFor(() => {
    expect(
      screen.getByTestId("handwavy-bulk-preview-confirm"),
    ).toBeInTheDocument();
  });
  // The production-block container also has to render before we can
  // assert the banner is (or isn't) inside the preview — without it the
  // banner literally cannot be rendered.
  await waitFor(() => {
    expect(
      screen.getByTestId("handwavy-bulk-preview-production"),
    ).toBeInTheDocument();
  });
}

// ---------- specs ----------------------------------------------------------

describe("Task #463 — bulk-remove preview coverage-gap banner", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    setCalibrationToken("test-token");
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
    setCalibrationToken(null);
  });

  it("renders the coverage-gap banner when archiveTotal is materially larger than the scan window (archiveTotal > productionLimit * 2)", async () => {
    // 8400 archived reports, 100-row scan window — productionLimit * 2 =
    // 200 ≤ 8400, well past the threshold. Banner MUST render.
    fetchSpy = installFetchMock({
      productionLimit: 100,
      productionArchiveTotal: 8400,
    });

    renderAdmin();
    await openBulkPreview();

    const banner = await screen.findByTestId(
      "handwavy-bulk-preview-production-coverage-gap",
    );
    expect(banner).toBeInTheDocument();
    // Anchor the assertion to the specific copy that ties the banner to
    // the chosen scan window vs the archive total — guards against a
    // future refactor that swaps the testid onto an unrelated element
    // while quietly losing the warning text.
    expect(banner.textContent ?? "").toContain("100");
    expect(banner.textContent ?? "").toContain("8,400");
    expect(banner.textContent ?? "").toMatch(/archived reports/i);
  });

  it("does NOT render the coverage-gap banner when archiveTotal is within coverage (archiveTotal <= productionLimit * 2)", async () => {
    // 150 archived reports, 100-row scan window — productionLimit * 2 =
    // 200 > 150, so the gap is not material. Banner MUST stay hidden.
    fetchSpy = installFetchMock({
      productionLimit: 100,
      productionArchiveTotal: 150,
    });

    renderAdmin();
    await openBulkPreview();

    expect(
      screen.queryByTestId("handwavy-bulk-preview-production-coverage-gap"),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the coverage-gap banner when archiveTotal is null", async () => {
    // No archive total returned by the server (e.g. production scan was
    // skipped). The threshold expression short-circuits on the
    // `archiveTotal != null` guard so the banner MUST stay hidden.
    fetchSpy = installFetchMock({
      productionLimit: 100,
      productionArchiveTotal: null,
    });

    renderAdmin();
    await openBulkPreview();

    expect(
      screen.queryByTestId("handwavy-bulk-preview-production-coverage-gap"),
    ).not.toBeInTheDocument();
  });
});
