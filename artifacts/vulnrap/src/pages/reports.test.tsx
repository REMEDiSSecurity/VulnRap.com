import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Reports from "./reports";

// Task #198 — Verify the reports feed list surfaces the FAKE_RAW_HTTP and
// STRIPPED_CRASH_TRACE chips when the underlying row carries the matching
// boolean (plumbed onto the feed by the API server from
// signalBreakdown.avri.rawHttp.isFake / .crashTrace.isStripped). Reviewers
// triaging the queue should be able to spot fabricated-raw-HTTP and
// stripped-trace reports without opening each diagnostics panel.

const FEED_URL_FRAGMENT = "/api/reports/feed";

type FeedRow = {
  id: number;
  reportCode: string;
  slopScore: number;
  slopTier: string;
  matchCount: number;
  contentMode: "full" | "similarity_only";
  createdAt: string;
  avriFamily: string | null;
  fakeRawHttp: boolean;
  strippedCrashTrace: boolean;
  inferredCwe?: string | null;
  inferredCweName?: string | null;
};

const SAMPLE_REPORTS: FeedRow[] = [
  {
    id: 4001,
    reportCode: "RPT-FAKE-HTTP",
    slopScore: 78,
    slopTier: "Likely Slop",
    matchCount: 0,
    contentMode: "full",
    createdAt: "2026-04-29T10:00:00.000Z",
    avriFamily: "REQUEST_SMUGGLING",
    fakeRawHttp: true,
    strippedCrashTrace: false,
    inferredCwe: null,
    inferredCweName: null,
  },
  {
    id: 4002,
    reportCode: "RPT-STRIPPED-TRACE",
    slopScore: 62,
    slopTier: "Questionable",
    matchCount: 0,
    contentMode: "full",
    createdAt: "2026-04-29T11:00:00.000Z",
    avriFamily: "MEMORY_CORRUPTION",
    fakeRawHttp: false,
    strippedCrashTrace: true,
    inferredCwe: null,
    inferredCweName: null,
  },
  {
    id: 4003,
    reportCode: "RPT-CLEAN",
    slopScore: 12,
    slopTier: "Likely Human",
    matchCount: 0,
    contentMode: "full",
    createdAt: "2026-04-29T12:00:00.000Z",
    avriFamily: "INJECTION",
    fakeRawHttp: false,
    strippedCrashTrace: false,
    inferredCwe: null,
    inferredCweName: null,
  },
];

const SAMPLE_FEED = {
  reports: SAMPLE_REPORTS,
  total: SAMPLE_REPORTS.length,
  hasMore: false,
  summary: {
    totalPublic: SAMPLE_REPORTS.length,
    avgScore: 50,
    tierCounts: { "Likely Slop": 1, Questionable: 1, "Likely Human": 1 },
    familyCounts: { REQUEST_SMUGGLING: 1, MEMORY_CORRUPTION: 1, INJECTION: 1 },
  },
};

function renderReports() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/reports"]}>
        <Reports />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Reports feed — Task #198 fake-raw-HTTP & stripped-crash-trace badges", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes(FEED_URL_FRAGMENT)) {
        return new Response(JSON.stringify(SAMPLE_FEED), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders FAKE_RAW_HTTP on rows where the feed row's fakeRawHttp flag is true", async () => {
    renderReports();

    await waitFor(() => {
      expect(screen.getByText("RPT-FAKE-HTTP")).toBeInTheDocument();
    });

    // The fake-raw-HTTP row should carry the matching chip.
    const fakeRow = screen.getByText("RPT-FAKE-HTTP").closest("a");
    expect(fakeRow).not.toBeNull();
    expect(within(fakeRow as HTMLElement).getByTestId("badge-fake-raw-http")).toHaveTextContent(
      "FAKE_RAW_HTTP",
    );
    // …and should NOT carry the stripped-crash-trace chip — they're independent
    // signals plumbed from different AVRI sub-blocks.
    expect(
      within(fakeRow as HTMLElement).queryByTestId("badge-stripped-crash-trace"),
    ).not.toBeInTheDocument();
  });

  it("renders STRIPPED_CRASH_TRACE on rows where the feed row's strippedCrashTrace flag is true", async () => {
    renderReports();

    await waitFor(() => {
      expect(screen.getByText("RPT-STRIPPED-TRACE")).toBeInTheDocument();
    });

    const strippedRow = screen.getByText("RPT-STRIPPED-TRACE").closest("a");
    expect(strippedRow).not.toBeNull();
    expect(
      within(strippedRow as HTMLElement).getByTestId("badge-stripped-crash-trace"),
    ).toHaveTextContent("STRIPPED_CRASH_TRACE");
    expect(
      within(strippedRow as HTMLElement).queryByTestId("badge-fake-raw-http"),
    ).not.toBeInTheDocument();
  });

  it("does not render either chip on clean rows where both flags are false", async () => {
    renderReports();

    await waitFor(() => {
      expect(screen.getByText("RPT-CLEAN")).toBeInTheDocument();
    });

    const cleanRow = screen.getByText("RPT-CLEAN").closest("a");
    expect(cleanRow).not.toBeNull();
    expect(
      within(cleanRow as HTMLElement).queryByTestId("badge-fake-raw-http"),
    ).not.toBeInTheDocument();
    expect(
      within(cleanRow as HTMLElement).queryByTestId("badge-stripped-crash-trace"),
    ).not.toBeInTheDocument();
  });
});

// Task #423 — Verify the reports feed surfaces the soft-citation
// inferred CWE on the row so reviewers can scan / batch by inferred
// CWE without opening each report. The badge is sourced from the same
// signalBreakdown.softCitation / signalBreakdown.avri.softCitation
// data that the triage report panel already consumes; the API server
// extracts it server-side and exposes inferredCwe + inferredCweName on
// the feed row.
describe("Reports feed — Task #423 inferred-CWE badge", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  const INFERRED_REPORTS: FeedRow[] = [
    {
      id: 5001,
      reportCode: "RPT-INFERRED-XSS",
      slopScore: 60,
      slopTier: "Questionable",
      matchCount: 0,
      contentMode: "full",
      createdAt: "2026-04-29T13:00:00.000Z",
      avriFamily: "WEB_CLIENT",
      fakeRawHttp: false,
      strippedCrashTrace: false,
      inferredCwe: "CWE-79",
      inferredCweName: "XSS",
    },
    {
      id: 5002,
      reportCode: "RPT-NO-CITATION",
      slopScore: 12,
      slopTier: "Likely Human",
      matchCount: 0,
      contentMode: "full",
      createdAt: "2026-04-29T14:00:00.000Z",
      avriFamily: "INJECTION",
      fakeRawHttp: false,
      strippedCrashTrace: false,
      inferredCwe: null,
      inferredCweName: null,
    },
  ];

  const INFERRED_FEED = {
    reports: INFERRED_REPORTS,
    total: INFERRED_REPORTS.length,
    hasMore: false,
    summary: {
      totalPublic: INFERRED_REPORTS.length,
      avgScore: 36,
      tierCounts: { Questionable: 1, "Likely Human": 1 },
      familyCounts: { WEB_CLIENT: 1, INJECTION: 1 },
    },
  };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes(FEED_URL_FRAGMENT)) {
        return new Response(JSON.stringify(INFERRED_FEED), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders the inferred CWE badge on rows where the feed row carries inferredCwe", async () => {
    renderReports();

    await waitFor(() => {
      expect(screen.getByText("RPT-INFERRED-XSS")).toBeInTheDocument();
    });

    const row = screen.getByText("RPT-INFERRED-XSS").closest("a");
    expect(row).not.toBeNull();
    const badge = within(row as HTMLElement).getByTestId("badge-inferred-cwe");
    // The badge displays the CWE token itself so reviewers can scan
    // straight down the column without expanding tooltips.
    expect(badge).toHaveTextContent("CWE-79");
    // Tooltip pairs the friendly name with the inferred CWE so the
    // soft-citation source matches what the triage panel shows.
    expect(badge.getAttribute("title") ?? "").toContain("XSS");
    expect(badge.getAttribute("title") ?? "").toContain("CWE-79");
  });

  it("does not render the inferred CWE badge on rows where inferredCwe is null", async () => {
    renderReports();

    await waitFor(() => {
      expect(screen.getByText("RPT-NO-CITATION")).toBeInTheDocument();
    });

    const row = screen.getByText("RPT-NO-CITATION").closest("a");
    expect(row).not.toBeNull();
    expect(
      within(row as HTMLElement).queryByTestId("badge-inferred-cwe"),
    ).not.toBeInTheDocument();
  });
});
