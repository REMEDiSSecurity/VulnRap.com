import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-search">{loc.search}</div>;
}

const PRESET_LIBRARY_FIXTURE = {
  version: "1.0.0",
  presets: [
    {
      id: "psirt-aggressive",
      name: "PSIRT Aggressive",
      description: "Tuned for PSIRT inboxes.",
      audience: "PSIRT teams",
      sensitivity: "strict" as const,
      slopThresholdLow: 15,
      slopThresholdHigh: 60,
      engineWeights: { linguistic: 1.2, factual: 1.6, template: 1.5, llm: 1.1 },
    },
    {
      id: "bounty-triage-conservative",
      name: "Bounty Triage Conservative",
      description: "Balanced calibration for paid-bounty triage.",
      audience: "Bug bounty triagers",
      sensitivity: "balanced" as const,
      slopThresholdLow: 25,
      slopThresholdHigh: 75,
      engineWeights: { linguistic: 0.8, factual: 1.2, template: 1.0, llm: 1.0 },
    },
  ],
};

const mockSaveSettings = vi.fn();
const mockGetSettings = vi.fn(() => ({
  slopThresholdLow: 20,
  slopThresholdHigh: 75,
  similarityThreshold: 80,
  sensitivityPreset: "balanced" as const,
}));

vi.mock("@/lib/settings", async () => {
  const actual = await vi.importActual<typeof import("@/lib/settings")>(
    "@/lib/settings",
  );
  return {
    ...actual,
    getSettings: (...args: unknown[]) => mockGetSettings(...args),
    saveSettings: (...args: unknown[]) => mockSaveSettings(...args),
  };
});

vi.mock("@/lib/history", () => ({
  addHistoryEntry: vi.fn(),
}));

let mockPresetData: typeof PRESET_LIBRARY_FIXTURE | undefined =
  PRESET_LIBRARY_FIXTURE;

vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/api-client-react")
  >("@workspace/api-client-react");
  return {
    ...actual,
    useCheckReport: (opts: {
      mutation?: { onSuccess?: (data: unknown) => void };
    }) => ({
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
      data: undefined,
      error: null,
      reset: vi.fn(),
    }),
    useListPresets: (_opts?: unknown) => ({
      data: mockPresetData,
      isLoading: false,
      isError: false,
      error: null,
    }),
    getListPresetsQueryKey: () => ["presets"],
  };
});

import Check from "./check";

function renderCheck(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/check"
          element={
            <TooltipProvider>
              <Check />
              <LocationProbe />
            </TooltipProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("Check page preset deep-link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPresetData = PRESET_LIBRARY_FIXTURE;
    mockGetSettings.mockReturnValue({
      slopThresholdLow: 20,
      slopThresholdHigh: 75,
      similarityThreshold: 80,
      sensitivityPreset: "balanced",
    });
  });

  it("applies psirt-aggressive preset settings and clears the query param", async () => {
    renderCheck("/check?preset=psirt-aggressive");

    await waitFor(() => {
      expect(mockSaveSettings).toHaveBeenCalledWith({
        sensitivityPreset: "strict",
        slopThresholdLow: 15,
        slopThresholdHigh: 60,
      });
    });

    await waitFor(() => {
      const search = screen.getByTestId("location-search").textContent ?? "";
      expect(search).not.toContain("preset=");
    });
  });

  it("applies bounty-triage-conservative preset and clears the query param", async () => {
    renderCheck("/check?preset=bounty-triage-conservative");

    await waitFor(() => {
      expect(mockSaveSettings).toHaveBeenCalledWith({
        sensitivityPreset: "balanced",
        slopThresholdLow: 25,
        slopThresholdHigh: 75,
      });
    });

    await waitFor(() => {
      const search = screen.getByTestId("location-search").textContent ?? "";
      expect(search).not.toContain("preset=");
    });
  });

  it("does not call saveSettings when no preset query param is present", async () => {
    renderCheck("/check");

    await new Promise((r) => setTimeout(r, 50));
    expect(mockSaveSettings).not.toHaveBeenCalled();
  });

  it("clears query param for an unknown preset without saving settings", async () => {
    renderCheck("/check?preset=does-not-exist");

    await waitFor(() => {
      const search = screen.getByTestId("location-search").textContent ?? "";
      expect(search).not.toContain("preset=");
    });

    expect(mockSaveSettings).not.toHaveBeenCalled();
  });
});
