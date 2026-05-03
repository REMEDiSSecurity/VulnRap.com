// Task #509 — Render coverage for the URL ↔ localStorage ↔ chooser cycle
// of the warn-threshold selector inside `DatasetCohortMeansSection`
// (added by Task #363). The unit tests in `feedback-analytics.test.tsx`
// already pin the parser/validator/storage helpers in isolation, but the
// state-machine that combines them at the top of the section was only
// covered manually. The contracts locked here mirror the AVRI drift
// lookback selector tests (`feedback-analytics-drift-lookback-precedence.test.tsx`):
//
//   - Clicking each of the 4 chooser options keeps the URL, localStorage
//     and the visible "|Δ| > Npt" copy in sync.
//   - Switching back to the 5pt default DROPS `?cohortDeltaWarn=` from
//     the URL (rather than leaving the redundant param behind).
//   - storage is written synchronously on click — i.e. the chooser does
//     NOT snap back to the previous stored value on the immediate
//     re-render after a click.
//   - A garbled URL value (e.g. `?cohortDeltaWarn=99`) falls back to the
//     DEFAULT (5), NOT to the value sitting in storage, so a bad/shared
//     link can't leak reviewer-specific behaviour. The bad query param
//     is also stripped from the URL on first render.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  DatasetCohortMeansSection,
  COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY,
} from "./feedback-analytics";

// Minimal /api/test/run payload — enough that DatasetCohortMeansSection
// renders the chooser AND surfaces the rolled-up "|Δ| > Npt" warning so
// every flip changes both the active radio AND the visible copy. The
// T2 cohort's dataset mean is 12pt above its synthetic-fixture mean, so
// |Δ|=12 trips the "divergent" treatment for every option in the
// chooser (3 / 5 / 8 / 10) — the warning copy follows the chosen N.
const TEST_RUN_RESPONSE = {
  archetypes: [],
  summary: [
    { tier: "T1_LEGIT", compositeMean: 80 },
    { tier: "T2_BORDERLINE", compositeMean: 38 },
    { tier: "T3_SLOP", compositeMean: 20 },
  ],
  datasetSamples: {
    available: true,
    sourcePath: "/mnt/vulnrap/data/vuln_reports_dataset_v2.json.gz",
    sampleDateKey: "2026-04-29",
    sampleSizeRequestedPerLabel: 25,
    sampleCount: 1,
    legitMean: 80,
    slopMean: 20,
    gap: 60,
    gapTarget: 15,
    gapMeetsTarget: true,
    cohorts: [
      {
        tier: "T1_LEGIT",
        label: "Legit",
        count: 0,
        compositeMean: 80,
        compositeMin: 80,
        compositeMax: 80,
        engine2Mean: 80,
      },
      {
        tier: "T2_BORDERLINE",
        label: "Borderline",
        count: 1,
        compositeMean: 50,
        compositeMin: 50,
        compositeMax: 50,
        engine2Mean: 50,
      },
      {
        tier: "T3_SLOP",
        label: "Slop",
        count: 0,
        compositeMean: 20,
        compositeMin: 20,
        compositeMax: 20,
        engine2Mean: 20,
      },
    ],
    samples: [],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchMock(): ReturnType<typeof vi.spyOn> {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    if (url.includes("/api/test/run")) {
      return jsonResponse(TEST_RUN_RESPONSE);
    }
    // Anything else (dataset-history, report-feed, …) gets a benign empty
    // body so a missed mock doesn't throw an unhandled rejection in the
    // test. The section degrades gracefully when these are empty.
    return jsonResponse({});
  });
  return spy;
}

// Reads the current router search string from inside the same MemoryRouter
// hosting DatasetCohortMeansSection so we can assert what its first-render
// effect — and the click handler's setSearchParams — did to the URL.
function URLSpy() {
  const [searchParams] = useSearchParams();
  return (
    <span data-testid="cohort-warn-url-spy">{searchParams.toString()}</span>
  );
}

function renderSection(initialUrl: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialUrl]}>
        <URLSpy />
        <DatasetCohortMeansSection />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function getActiveWarnThreshold(): string {
  // Scope to the chooser radiogroup specifically — DatasetCohortMeansSection
  // shares the page with other radio groups elsewhere, so a top-level
  // `getAllByRole("radio")` would be brittle if the page composition
  // changes. Returns just the number (e.g. "5") for clean asserts.
  const group = screen.getByRole("radiogroup", {
    name: /Warn threshold for dataset-vs-fixture delta/i,
  });
  const radios = within(group).getAllByRole("radio");
  const active = radios.find(
    (r) => r.getAttribute("aria-checked") === "true",
  );
  if (!active) {
    throw new Error(
      `No active warn-threshold radio found. Saw: ${radios
        .map((r) => `${r.textContent}=${r.getAttribute("aria-checked")}`)
        .join(", ")}`,
    );
  }
  return (active.textContent ?? "").replace(/pt$/, "").trim();
}

function getUrlSearch(): string {
  return screen.getByTestId("cohort-warn-url-spy").textContent ?? "";
}

function getStoredWarn(): string | null {
  return window.localStorage.getItem(COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY);
}

function clickWarn(opt: 3 | 5 | 8 | 10) {
  const btn = screen.getByTestId(`dataset-cohort-warn-threshold-${opt}`);
  act(() => {
    btn.click();
  });
}

describe("DatasetCohortMeansSection — warn-threshold chooser persistence (Task #509)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.localStorage.removeItem(COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    window.localStorage.removeItem(COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY);
  });

  it("clicking each of the 4 chooser options keeps the URL, localStorage and the visible '|Δ| > Npt' copy in sync (and switching back to 5pt drops the param)", async () => {
    fetchSpy = installFetchMock();

    renderSection("/feedback-analytics");

    // Wait for the chooser to mount (the section is gated on the
    // /api/test/run query resolving).
    await screen.findByTestId(
      "dataset-cohort-warn-threshold-chooser",
      {},
      { timeout: 5_000 },
    );

    // Default state: 5pt active, URL clean, rolled-up warning reads "5pt".
    expect(getActiveWarnThreshold()).toBe("5");
    expect(getUrlSearch()).toBe("");
    const warning = await screen.findByTestId(
      "dataset-cohort-fixture-divergence-warning",
    );
    expect(warning).toHaveTextContent(/\|Δ\|\s*>\s*5pt/);

    // Click 3pt — non-default value goes into the URL AND localStorage,
    // and the rolled-up warning copy follows.
    clickWarn(3);
    await waitFor(() => {
      expect(getActiveWarnThreshold()).toBe("3");
    });
    expect(getUrlSearch()).toBe("cohortDeltaWarn=3");
    expect(getStoredWarn()).toBe("3");
    expect(
      screen.getByTestId("dataset-cohort-fixture-divergence-warning"),
    ).toHaveTextContent(/\|Δ\|\s*>\s*3pt/);

    // Click 8pt — URL param updates in place, storage follows.
    clickWarn(8);
    await waitFor(() => {
      expect(getActiveWarnThreshold()).toBe("8");
    });
    expect(getUrlSearch()).toBe("cohortDeltaWarn=8");
    expect(getStoredWarn()).toBe("8");
    expect(
      screen.getByTestId("dataset-cohort-fixture-divergence-warning"),
    ).toHaveTextContent(/\|Δ\|\s*>\s*8pt/);

    // Click 10pt — same dance, biggest option in the set.
    clickWarn(10);
    await waitFor(() => {
      expect(getActiveWarnThreshold()).toBe("10");
    });
    expect(getUrlSearch()).toBe("cohortDeltaWarn=10");
    expect(getStoredWarn()).toBe("10");
    expect(
      screen.getByTestId("dataset-cohort-fixture-divergence-warning"),
    ).toHaveTextContent(/\|Δ\|\s*>\s*10pt/);

    // Switch back to 5pt — the default. The query param MUST be dropped
    // from the URL (otherwise shared links carry a redundant
    // `?cohortDeltaWarn=5` even though it equals the default), but
    // localStorage still tracks the explicit choice so the rolled-up
    // warning copy keeps reading "5pt".
    clickWarn(5);
    await waitFor(() => {
      expect(getActiveWarnThreshold()).toBe("5");
    });
    expect(getUrlSearch()).toBe("");
    expect(getStoredWarn()).toBe("5");
    expect(
      screen.getByTestId("dataset-cohort-fixture-divergence-warning"),
    ).toHaveTextContent(/\|Δ\|\s*>\s*5pt/);

    // Belt-and-braces against the "snap back to a stale stored value
    // because storage isn't written synchronously on click" regression
    // called out in the task: re-clicking a non-default option after a
    // round-trip through the default should still land where we asked,
    // not where storage was a moment earlier.
    clickWarn(8);
    await waitFor(() => {
      expect(getActiveWarnThreshold()).toBe("8");
    });
    expect(getUrlSearch()).toBe("cohortDeltaWarn=8");
    expect(getStoredWarn()).toBe("8");
  });

  it("garbled URL value falls back to the default (5pt), ignoring storage, and strips the bad query param", async () => {
    // Storage holds "10" — a previous reviewer's local choice — but the
    // URL carries a garbled value that doesn't match any of the 4 valid
    // options. The bad URL must NOT fall through to storage (which would
    // let a shared link silently produce reviewer-specific behaviour);
    // instead it falls back to the 5pt default, and the bad param is
    // stripped from the URL so the address bar matches the visible state.
    window.localStorage.setItem(COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY, "10");
    fetchSpy = installFetchMock();

    renderSection("/feedback-analytics?cohortDeltaWarn=99");

    await screen.findByTestId(
      "dataset-cohort-warn-threshold-chooser",
      {},
      { timeout: 5_000 },
    );

    expect(getActiveWarnThreshold()).toBe("5");
    // First-render effect strips the malformed value from the URL.
    await waitFor(() => {
      expect(getUrlSearch()).toBe("");
    });
    // Rolled-up warning copy reflects the default, NOT the stored "10".
    expect(
      screen.getByTestId("dataset-cohort-fixture-divergence-warning"),
    ).toHaveTextContent(/\|Δ\|\s*>\s*5pt/);
  });
});
