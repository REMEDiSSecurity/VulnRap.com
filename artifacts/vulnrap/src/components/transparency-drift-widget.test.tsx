// Task #617 — Cover the public drift transparency widget in both its
// empty (no aggregate yet) and populated states. The widget is mounted
// on the public `/transparency` page so neither test installs a
// reviewer token; both rely solely on the public-safe DTO returned by
// `GET /api/public/drift-summary`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TransparencyDriftWidget } from "./transparency-drift-widget";

const EMPTY_SUMMARY = {
  generatedAt: "2026-04-30T12:00:00.000Z",
  weeks: [],
  currentSpread: null,
  previousSpread: null,
  delta: null,
  hasCurrentWeek: false,
};

const POPULATED_SUMMARY = {
  generatedAt: "2026-04-30T12:00:00.000Z",
  weeks: [
    { weekStart: "2026-02-02", spread: 52 },
    { weekStart: "2026-02-09", spread: 54 },
    { weekStart: "2026-02-16", spread: 50 },
    { weekStart: "2026-04-20", spread: 48 },
    { weekStart: "2026-04-27", spread: 51 },
  ],
  currentSpread: 51,
  previousSpread: 48,
  delta: 3,
  hasCurrentWeek: true,
};

function renderWidget() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TransparencyDriftWidget />
    </QueryClientProvider>,
  );
}

describe("TransparencyDriftWidget", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("renders the empty state when no weekly aggregate is available yet", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify(EMPTY_SUMMARY), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    renderWidget();

    // The h2 is the section's identifying heading and must always render.
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: /Calibration Drift Self-Check/i,
      }),
    ).toBeInTheDocument();

    const empty = await screen.findByTestId("empty-drift-widget");
    expect(empty).toBeInTheDocument();
    expect(empty.textContent).toMatch(/hasn't been computed yet/i);

    expect(
      screen.queryByTestId("populated-drift-widget"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("text-drift-current-spread"),
    ).not.toBeInTheDocument();
  });

  it("renders the sparkline + current/previous/delta when populated", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify(POPULATED_SUMMARY), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    renderWidget();

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/public/drift-summary"),
        expect.anything(),
      );
    });

    expect(
      await screen.findByTestId("populated-drift-widget"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("text-drift-current-spread").textContent).toMatch(
      /51\.0/,
    );
    expect(
      screen.getByTestId("text-drift-previous-spread").textContent,
    ).toMatch(/48\.0/);
    const delta = screen.getByTestId("badge-drift-delta");
    expect(delta.textContent).toMatch(/\+3\.0pt vs last week/i);
    // hasCurrentWeek=true so the awaiting badge must not render.
    expect(
      screen.queryByTestId("badge-drift-awaiting"),
    ).not.toBeInTheDocument();
    // Plain-English caption (no jargon) must be present.
    expect(screen.getByText(/strongest reports/i)).toBeInTheDocument();
  });
});
