// Task #611 — UI integration coverage for the structural-fabrication
// marker bullets on the instant-check page (check.tsx).
//
// The Results page (results.tsx) wires its marker bullets to a sibling
// DiagnosticsPanel that scrolls/flashes the matching AVRI structural-
// markers row (covered by diagnostics-panel.test.tsx). The instant-
// check page has no DiagnosticsPanel — it's a one-shot validator with
// no persisted report — but Task #611 still asks for click parity so
// the bullet IDs feel as "live" as the ones on Results. The check
// page's affordance is a brief yellow flash on the row itself when
// clicked. This spec pins both the click affordance and the flash.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";

// Mock useCheckReport so we can short-circuit the network path and
// drive the page's `result` state via the mutation's onSuccess
// callback. Everything else from api-client-react passes through.
vi.mock("@workspace/api-client-react", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/api-client-react")
  >("@workspace/api-client-react");
  return {
    ...actual,
    useCheckReport: (opts: {
      mutation?: { onSuccess?: (data: unknown) => void };
    }) => {
      const onSuccess = opts?.mutation?.onSuccess;
      return {
        mutate: (_input: unknown) => {
          // Immediately resolve with the fixture below so the page
          // transitions into its result-rendering branch synchronously.
          onSuccess?.(CHECK_RESULT_FIXTURE);
        },
        isPending: false,
        isSuccess: true,
        isError: false,
        data: CHECK_RESULT_FIXTURE,
        error: null,
        reset: () => {},
      };
    },
  };
});

import Check from "./check";

// Minimal CheckResultData fixture: one structural-fabrication evidence
// row carrying two markers. Everything else is the cheapest valid value
// the page accepts so we don't accidentally trip a sibling card's
// rendering path.
const CHECK_RESULT_FIXTURE = {
  slopScore: 72,
  slopTier: "high",
  qualityScore: 30,
  confidence: 80,
  breakdown: { linguistic: 20, factual: 30, template: 10 },
  evidence: [
    {
      type: "hallucination_structural_fabrication",
      description: "Crash trace contains structural fabrication markers.",
      weight: 12,
      context: {
        markers: [
          {
            id: "round_function_offsets",
            description:
              "3 frames carry round/zero function offsets (0x0, 0x100, 0x1000).",
          },
          {
            id: "implausible_thread_id",
            description:
              "Thread id `T9999` outside realistic kernel pid range.",
          },
        ],
      },
    },
  ],
  similarityMatches: [],
  sectionHashes: {},
  sectionMatches: [],
  redactionSummary: { totalRedactions: 0, categories: {} },
  feedback: [],
  previouslySubmitted: false,
};

describe("check.tsx — structural-fabrication marker click flash (Task #611)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function renderAndSubmit() {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <MemoryRouter>
        <TooltipProvider>
          <Check />
        </TooltipProvider>
      </MemoryRouter>,
    );

    // Switch to text input mode (default is "text" already, but keep
    // the assertion explicit so a default-flip won't silently break
    // the spec).
    const textArea = await screen.findByPlaceholderText(/paste/i);
    await user.type(textArea, "fixture report body");

    const submitBtn = screen.getByRole("button", { name: /check report/i });
    await user.click(submitBtn);

    return user;
  }

  it("renders each structural-fabrication marker as a clickable button", async () => {
    await renderAndSubmit();

    const btn = await screen.findByTestId(
      "check-evidence-structural-marker-implausible_thread_id",
    );
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).toHaveAttribute("type", "button");
  });

  it("flashes only the clicked row briefly and clears the flash after ~1.6s", async () => {
    const user = await renderAndSubmit();

    const targetRow = await screen.findByTestId(
      "check-evidence-structural-marker-implausible_thread_id-row",
    );
    const otherRow = await screen.findByTestId(
      "check-evidence-structural-marker-round_function_offsets-row",
    );

    // No flash before click.
    expect(targetRow.className).not.toMatch(/ring-yellow-400/);
    expect(otherRow.className).not.toMatch(/ring-yellow-400/);

    await user.click(
      screen.getByTestId(
        "check-evidence-structural-marker-implausible_thread_id",
      ),
    );

    await waitFor(() => {
      expect(targetRow.className).toMatch(/ring-yellow-400/);
    });
    // The non-clicked sibling stays unflashed — proves the flash is
    // scoped to the clicked marker only, not a global card-wide effect.
    expect(otherRow.className).not.toMatch(/ring-yellow-400/);

    // Flash auto-clears after the 1.6s timer.
    act(() => {
      vi.advanceTimersByTime(1700);
    });
    await waitFor(() => {
      expect(targetRow.className).not.toMatch(/ring-yellow-400/);
    });
  });
});
