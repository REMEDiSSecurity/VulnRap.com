// Task #615 — render coverage for the cohort baseline ribbon.
//
// Mocks `@workspace/api-client-react`'s `useGetCohortBaseline` hook so we
// can drive the ribbon through its loading / empty-cohort / populated /
// CWE-family-paired states without touching the network. Also pins the
// pure `percentileFromBins` helper so the UI math can't silently drift
// from the server-side helper that backs the percentile label.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  CohortBaselineRibbon,
  percentileFromBins,
} from "./cohort-baseline-ribbon";

const useGetCohortBaselineMock = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useGetCohortBaseline: (params: unknown, opts: unknown) =>
    useGetCohortBaselineMock(params, opts),
  getGetCohortBaselineQueryKey: (params?: {
    cwe?: string;
    metric?: string;
  }) => ["/api/cohort/baseline", params ?? {}] as const,
}));

interface QueryReturn {
  data?: unknown;
  isLoading?: boolean;
  isError?: boolean;
}

function setQueryReturns(platform: QueryReturn, family?: QueryReturn) {
  useGetCohortBaselineMock.mockReset();
  useGetCohortBaselineMock.mockImplementation(
    (params: { cwe?: string } | undefined) => {
      if (params && params.cwe) {
        return family ?? { data: undefined, isLoading: false, isError: false };
      }
      return platform;
    },
  );
}

function makeBins(counts: number[]) {
  return counts.map((count, i) => ({ min: i * 10, max: (i + 1) * 10, count }));
}

describe("percentileFromBins", () => {
  it("returns 0 for an empty cohort", () => {
    expect(
      percentileFromBins(50, makeBins([0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    ).toBe(0);
  });

  it("uses mid-rank: a tied bucket of 4 reports sits at 50% by convention", () => {
    const bins = makeBins([0, 0, 0, 0, 0, 4, 0, 0, 0, 0]);
    expect(percentileFromBins(55, bins)).toBe(50);
  });

  it("matches the documented example: 78 below, score in a 22-count bucket → 89%", () => {
    const bins = makeBins([30, 24, 24, 0, 0, 0, 22, 0, 0, 0]);
    expect(percentileFromBins(65, bins)).toBe(89);
  });
});

describe("CohortBaselineRibbon", () => {
  it("renders a skeleton band while the platform cohort is loading", () => {
    setQueryReturns({ data: undefined, isLoading: true, isError: false });
    render(<CohortBaselineRibbon score={62} />);
    expect(screen.getByTestId("cohort-baseline-ribbon-loading")).toBeTruthy();
    expect(screen.queryByTestId("cohort-baseline-ribbon")).toBeNull();
  });

  it("renders nothing when the platform fetch errored — rest of the page stays untouched", () => {
    setQueryReturns({ data: undefined, isLoading: false, isError: true });
    const { container } = render(<CohortBaselineRibbon score={62} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows a 'no baseline yet' label when the cohort has zero reports and hides the marker", () => {
    setQueryReturns({
      data: {
        cwe: null,
        windowDays: 7,
        totalReports: 0,
        median: null,
        bins: makeBins([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      },
      isLoading: false,
      isError: false,
    });
    render(<CohortBaselineRibbon score={62} />);
    expect(screen.getByTestId("cohort-baseline-ribbon")).toBeTruthy();
    expect(
      screen.getByTestId("cohort-baseline-ribbon-percentile-label").textContent,
    ).toMatch(/No cohort baseline yet/i);
    expect(screen.queryByTestId("cohort-baseline-ribbon-marker")).toBeNull();
  });

  it("renders the sparkline, the marker, and the percentile label for a populated cohort", () => {
    setQueryReturns({
      data: {
        cwe: null,
        windowDays: 7,
        totalReports: 100,
        median: 55,
        bins: makeBins([30, 24, 24, 0, 0, 0, 22, 0, 0, 0]),
      },
      isLoading: false,
      isError: false,
    });
    render(<CohortBaselineRibbon score={65} />);

    expect(screen.getByTestId("cohort-baseline-ribbon-sparkline")).toBeTruthy();
    // 10 bars in the sparkline, one per bucket.
    for (let i = 0; i < 10; i++) {
      expect(
        screen.getByTestId(`cohort-baseline-ribbon-bar-${i}`),
      ).toBeTruthy();
    }
    const marker = screen.getByTestId("cohort-baseline-ribbon-marker");
    // Marker position is left=score% so a 65 score sits at 65%.
    expect((marker as HTMLElement).style.left).toBe("65%");
    expect(
      screen.getByTestId("cohort-baseline-ribbon-percentile-label").textContent,
    ).toMatch(/Higher than 89% of reports scored this week/);
    expect(
      screen.getByTestId("cohort-baseline-ribbon-window").textContent,
    ).toMatch(/last 7d · n=100/);
  });

  it("renders the second-line CWE family median when one is supplied", () => {
    setQueryReturns(
      {
        data: {
          cwe: null,
          windowDays: 7,
          totalReports: 100,
          median: 55,
          bins: makeBins([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]),
        },
        isLoading: false,
        isError: false,
      },
      {
        data: {
          cwe: "INJECTION",
          windowDays: 7,
          totalReports: 12,
          median: 42,
          bins: makeBins([0, 0, 0, 0, 6, 6, 0, 0, 0, 0]),
        },
        isLoading: false,
        isError: false,
      },
    );
    render(<CohortBaselineRibbon score={62} cwe="INJECTION" />);
    const family = screen.getByTestId("cohort-baseline-ribbon-family");
    expect(family.textContent).toMatch(/INJECTION/);
    expect(family.textContent).toMatch(/median/);
    expect(family.textContent).toMatch(/42/);
    expect(family.textContent).toMatch(/n=12/);
  });

  // Task #933 — the same ribbon UI is reused on the legacy AI Detection
  // Score card with metric="slop". The fetch must include metric=slop, the
  // CWE family overlay must NOT render (composite-only), and the testid
  // suffix changes so both ribbons can coexist on the same results page.
  it("fetches the slop cohort and renders a slop-flavoured label when metric=slop", () => {
    const seenParams: Array<unknown> = [];
    useGetCohortBaselineMock.mockReset();
    useGetCohortBaselineMock.mockImplementation((params: unknown) => {
      seenParams.push(params);
      return {
        data: {
          cwe: null,
          windowDays: 7,
          totalReports: 80,
          median: 48,
          bins: makeBins([20, 10, 10, 10, 10, 10, 5, 3, 1, 1]),
        },
        isLoading: false,
        isError: false,
      };
    });
    render(
      <CohortBaselineRibbon
        score={62}
        cwe="INJECTION"
        metric="slop"
        compact
      />,
    );
    expect(seenParams.some((p) => (p as { metric?: string })?.metric === "slop")).toBe(
      true,
    );
    // Family overlay is composite-only — never request the per-CWE cohort
    // when metric=slop.
    expect(seenParams.some((p) => (p as { cwe?: string })?.cwe)).toBe(false);
    expect(screen.getByTestId("cohort-baseline-ribbon-slop")).toBeTruthy();
    expect(screen.queryByTestId("cohort-baseline-ribbon")).toBeNull();
    expect(screen.queryByTestId("cohort-baseline-ribbon-family")).toBeNull();
    expect(
      screen.getByTestId("cohort-baseline-ribbon-percentile-label").textContent,
    ).toMatch(/AI-likelihood/i);
    expect(
      screen.getByTestId("cohort-baseline-ribbon-slop-window").textContent,
    ).toMatch(/7d median 48/);
  });
});
