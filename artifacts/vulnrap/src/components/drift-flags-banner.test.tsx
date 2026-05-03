import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCalibrationToken } from "@workspace/api-client-react";
import { DriftFlagsBanner } from "./drift-flags-banner";

const REPORT_NO_FLAGS = {
  generatedAt: "2026-04-29T00:00:00.000Z",
  weeksRequested: 8,
  totalReportsScanned: 12,
  cohort: "avri_on_only" as const,
  bucketingNote: "noop",
  thresholds: { gapWarn: 45, familyShiftWarn: 5, minBucketSize: 3 },
  weeks: [],
  flags: [],
  runbookPath: "docs/avri-drift-runbook.md",
};

const REPORT_WITH_FLAGS = {
  ...REPORT_NO_FLAGS,
  flags: [
    {
      weekStart: "2026-04-20",
      kind: "GAP_BELOW_45" as const,
      detail:
        "T1−T3 composite gap 38.4 < 45pt threshold (T1 n=4 mean=70, T3 n=5 mean=31.6).",
    },
    {
      weekStart: "2026-04-20",
      kind: "FAMILY_MEAN_SHIFT" as const,
      detail:
        "T3 family INJECTION mean shifted by +6.2pt vs 2026-04-13 (was 28, now 34.2).",
    },
  ],
};

function renderBanner() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DriftFlagsBanner />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("DriftFlagsBanner", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setCalibrationToken(null);
    try {
      localStorage.removeItem("vulnrap-drift-banner-dismissed");
    } catch {
      /* noop */
    }
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    setCalibrationToken(null);
    try {
      localStorage.removeItem("vulnrap-drift-banner-dismissed");
    } catch {
      /* noop */
    }
    fetchSpy.mockRestore();
  });

  it("renders nothing and does not fetch when no reviewer token is configured", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify(REPORT_WITH_FLAGS), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const { container } = renderBanner();

    // Public visitor: zero banner DOM, zero AVRI drift requests.
    expect(
      container.querySelector('[data-testid="drift-flags-banner"]'),
    ).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders nothing for a reviewer when no flags are firing", async () => {
    setCalibrationToken("reviewer-token");
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify(REPORT_NO_FLAGS), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    renderBanner();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/feedback/calibration/avri-drift"),
        expect.anything(),
      );
    });
    // After the fetch resolves, banner should still be absent because flags is [].
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("drift-flags-banner")).not.toBeInTheDocument();
  });

  it("renders a banner with calibration + runbook links when flags are firing", async () => {
    setCalibrationToken("reviewer-token");
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify(REPORT_WITH_FLAGS), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    renderBanner();

    const banner = await screen.findByTestId("drift-flags-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/AVRI calibration drift/i);
    expect(banner.textContent).toMatch(/2 flags firing/i);
    expect(banner.textContent).toMatch(/1 rubric-collapse/i);
    expect(banner.textContent).toMatch(/1 per-family weight drift/i);

    const dashboardLink = screen.getByTestId(
      "link-drift-banner-dashboard",
    ) as HTMLAnchorElement;
    expect(dashboardLink.getAttribute("href")).toBe("/feedback-analytics");

    const runbookLink = screen.getByTestId(
      "link-drift-banner-runbook",
    ) as HTMLAnchorElement;
    expect(runbookLink.href).toContain("avri-drift-runbook.md");
    expect(runbookLink.target).toBe("_blank");
  });

  it("hides the banner after dismiss and persists the dismissal across remounts for the same flag set", async () => {
    setCalibrationToken("reviewer-token");
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify(REPORT_WITH_FLAGS), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const user = userEvent.setup();

    const { unmount } = renderBanner();
    await screen.findByTestId("drift-flags-banner");
    await user.click(screen.getByTestId("button-drift-banner-dismiss"));
    expect(screen.queryByTestId("drift-flags-banner")).not.toBeInTheDocument();

    unmount();

    // Remount with the same flag set: banner should stay dismissed.
    renderBanner();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("drift-flags-banner")).not.toBeInTheDocument();
  });

  it("shows the latest flag's weekStart with a relative-time hint", async () => {
    setCalibrationToken("reviewer-token");
    // Freeze "now" so the relative-time math is deterministic. The latest
    // weekStart in REPORT_PLUS_NEWER below is 2026-04-27 (UTC midnight).
    // 2026-04-30T12:00:00Z − 2026-04-27T00:00:00Z = 3.5 days → floor = 3d.
    // Only fake `Date` so react-query's setTimeout-based scheduling still
    // resolves and `findByTestId` doesn't deadlock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-30T12:00:00.000Z"));
    try {
      const REPORT_PLUS_NEWER = {
        ...REPORT_WITH_FLAGS,
        flags: [
          ...REPORT_WITH_FLAGS.flags,
          {
            weekStart: "2026-04-27",
            kind: "GAP_BELOW_45" as const,
            detail:
              "T1−T3 composite gap 41.0 < 45pt threshold (T1 n=3 mean=66, T3 n=4 mean=25).",
          },
        ],
      };
      fetchSpy.mockImplementation(
        async () =>
          new Response(JSON.stringify(REPORT_PLUS_NEWER), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );

      renderBanner();

      const latest = await screen.findByTestId("drift-banner-latest");
      // Picks the most recent weekStart, not the first one in the array.
      expect(latest.textContent).toMatch(/2026-04-27/);
      expect(latest.textContent).toMatch(/3d ago/);
      // Make sure the older weekStart (2026-04-20) isn't what we displayed.
      expect(latest.textContent).not.toMatch(/2026-04-20/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to 'today' when only one week is present and it matches now", async () => {
    setCalibrationToken("reviewer-token");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-20T08:00:00.000Z"));
    try {
      const SINGLE_WEEK_TODAY = {
        ...REPORT_NO_FLAGS,
        flags: [
          {
            weekStart: "2026-04-20",
            kind: "GAP_BELOW_45" as const,
            detail:
              "T1−T3 composite gap 38.4 < 45pt threshold (T1 n=4 mean=70, T3 n=5 mean=31.6).",
          },
        ],
      };
      fetchSpy.mockImplementation(
        async () =>
          new Response(JSON.stringify(SINGLE_WEEK_TODAY), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );

      renderBanner();

      const latest = await screen.findByTestId("drift-banner-latest");
      expect(latest.textContent).toMatch(/2026-04-20/);
      expect(latest.textContent).toMatch(/today/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-arms the banner when a new flag appears (fingerprint changes)", async () => {
    setCalibrationToken("reviewer-token");
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify(REPORT_WITH_FLAGS), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const user = userEvent.setup();

    const { unmount } = renderBanner();
    await screen.findByTestId("drift-flags-banner");
    await user.click(screen.getByTestId("button-drift-banner-dismiss"));
    unmount();

    // Server now reports an additional flag — the dismissed fingerprint no
    // longer matches, so the banner must come back.
    const reportPlusOne = {
      ...REPORT_WITH_FLAGS,
      flags: [
        ...REPORT_WITH_FLAGS.flags,
        {
          weekStart: "2026-04-27",
          kind: "GAP_BELOW_45" as const,
          detail:
            "T1−T3 composite gap 41.0 < 45pt threshold (T1 n=3 mean=66, T3 n=4 mean=25).",
        },
      ],
    };
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify(reportPlusOne), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    renderBanner();
    const banner = await screen.findByTestId("drift-flags-banner");
    expect(banner.textContent).toMatch(/3 flags firing/i);
  });
});
