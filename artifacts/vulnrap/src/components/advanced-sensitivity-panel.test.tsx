import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

import {
  AdvancedSensitivityPanel,
  BALANCED_CONFIG,
  applyConfigToParams,
  computeAdjustedScore,
  copyTextToClipboard,
  isBalanced,
  parseConfigFromParams,
} from "./advanced-sensitivity-panel";

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="location-search">{loc.search}</div>;
}

function renderPanel({
  initialEntry = "/check",
  canonicalScore = 50,
  subScores = { engine1: 40, engine2: 60, engine3: 20, avri: 80 },
}: {
  initialEntry?: string;
  canonicalScore?: number;
  subScores?: Parameters<typeof AdvancedSensitivityPanel>[0]["subScores"];
} = {}) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/check"
          element={
            <>
              <AdvancedSensitivityPanel
                canonicalScore={canonicalScore}
                subScores={subScores}
              />
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe("computeAdjustedScore", () => {
  it("returns 0 when sensitivity is 0", () => {
    expect(
      computeAdjustedScore(BALANCED_CONFIG, {
        engine1: 100,
        engine2: 100,
        engine3: 100,
        avri: 100,
      }),
    ).toBe(100);
    expect(
      computeAdjustedScore(
        { ...BALANCED_CONFIG, sensitivity: 0 },
        { engine1: 100, engine2: 100, engine3: 100, avri: 100 },
      ),
    ).toBe(0);
  });

  it("at sensitivity 0.5 with equal weights matches the weighted mean", () => {
    expect(
      computeAdjustedScore(BALANCED_CONFIG, {
        engine1: 40,
        engine2: 60,
        engine3: 20,
        avri: 80,
      }),
    ).toBe(50);
  });

  it("doubles the weighted mean at sensitivity 1.0 and clamps to 100", () => {
    expect(
      computeAdjustedScore(
        { ...BALANCED_CONFIG, sensitivity: 1 },
        { engine1: 40, engine2: 60, engine3: 20, avri: 80 },
      ),
    ).toBe(100);
    expect(
      computeAdjustedScore(
        { ...BALANCED_CONFIG, sensitivity: 1 },
        { engine1: 10, engine2: 20, engine3: 10, avri: 20 },
      ),
    ).toBe(30);
  });

  it("ignores axes with zero weight in the weighted average", () => {
    const cfg = {
      sensitivity: 0.5,
      weights: { engine1: 0, engine2: 0, engine3: 0, avri: 1 },
    };
    expect(
      computeAdjustedScore(cfg, {
        engine1: 0,
        engine2: 0,
        engine3: 0,
        avri: 80,
      }),
    ).toBe(80);
  });

  it("treats null sub-scores as missing axes (only present axes contribute)", () => {
    expect(
      computeAdjustedScore(BALANCED_CONFIG, {
        engine1: 80,
        engine2: null,
        engine3: null,
        avri: null,
      }),
    ).toBe(80);
    expect(
      computeAdjustedScore(BALANCED_CONFIG, {
        engine1: 80,
        engine2: 0,
        engine3: null,
        avri: null,
      }),
    ).toBe(40);
  });

  it("returns 0 when every weight is zero", () => {
    const cfg = {
      sensitivity: 0.5,
      weights: { engine1: 0, engine2: 0, engine3: 0, avri: 0 },
    };
    expect(
      computeAdjustedScore(cfg, {
        engine1: 100,
        engine2: 100,
        engine3: 100,
        avri: 100,
      }),
    ).toBe(0);
  });

  it("clamps out-of-range sensitivity and weights instead of throwing", () => {
    expect(
      computeAdjustedScore(
        {
          sensitivity: 5,
          weights: { engine1: 99, engine2: 1, engine3: 1, avri: 1 },
        },
        { engine1: 50, engine2: 50, engine3: 50, avri: 50 },
      ),
    ).toBe(100);
  });
});

describe("URL roundtrip", () => {
  it("balanced config produces no URL params", () => {
    const next = applyConfigToParams(
      new URLSearchParams("foo=bar"),
      BALANCED_CONFIG,
    );
    expect(next.get("sens")).toBeNull();
    expect(next.get("wE1")).toBeNull();
    expect(next.get("foo")).toBe("bar");
    expect(isBalanced(BALANCED_CONFIG)).toBe(true);
  });

  it("custom config roundtrips through URLSearchParams", () => {
    const cfg = {
      sensitivity: 0.78,
      weights: { engine1: 1.5, engine2: 0.25, engine3: 1, avri: 2 },
    };
    const params = applyConfigToParams(new URLSearchParams(), cfg);
    expect(params.get("sens")).toBe("0.78");
    expect(params.get("wE1")).toBe("1.5");
    expect(params.get("wE2")).toBe("0.25");
    expect(params.get("wE3")).toBe("1");
    expect(params.get("wAVRI")).toBe("2");
    const parsed = parseConfigFromParams(params);
    expect(parsed.sensitivity).toBeCloseTo(0.78, 2);
    expect(parsed.weights).toEqual(cfg.weights);
  });

  it("parseConfigFromParams falls back to balanced for missing or invalid values", () => {
    const cfg = parseConfigFromParams(
      new URLSearchParams("sens=not-a-number&wE1="),
    );
    expect(cfg).toEqual(BALANCED_CONFIG);
  });

  it("clamps out-of-range URL values into [0,1] / [0,2]", () => {
    const cfg = parseConfigFromParams(
      new URLSearchParams("sens=9&wE1=-3&wAVRI=99"),
    );
    expect(cfg.sensitivity).toBe(1);
    expect(cfg.weights.engine1).toBe(0);
    expect(cfg.weights.avri).toBe(2);
  });
});

describe("AdvancedSensitivityPanel", () => {
  it("hydrates state from URL on mount and shows the custom badge", () => {
    renderPanel({
      initialEntry: "/check?sens=0.78&wE1=1.5&wE2=0.5&wE3=1&wAVRI=2",
    });
    expect(screen.getByTestId("sensitivity-value").textContent).toBe("0.78");
    expect(screen.getByTestId("weight-engine1-value").textContent).toBe(
      "1.50×",
    );
    expect(screen.getByTestId("weight-avri-value").textContent).toBe("2.00×");
    expect(
      screen.getByTestId("advanced-sensitivity-custom-badge"),
    ).toBeInTheDocument();
  });

  it("opens collapsed (and balanced) by default and writes no params", async () => {
    renderPanel();
    expect(screen.getByTestId("location-search").textContent).toBe("");
    expect(
      screen.queryByTestId("advanced-sensitivity-custom-badge"),
    ).toBeNull();
  });

  it("writes the slider value into the URL query string when changed", () => {
    renderPanel({
      initialEntry: "/check?sens=0.78&wE1=1.5&wE2=0.5&wE3=1&wAVRI=2",
    });
    const slider = screen.getByTestId("sensitivity-slider") as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "0.42" } });
    expect(screen.getByTestId("location-search").textContent).toContain(
      "sens=0.42",
    );
    expect(screen.getByTestId("sensitivity-value").textContent).toBe("0.42");
  });

  it("Reset to balanced clears every URL param and disables the button", async () => {
    const user = userEvent.setup();
    renderPanel({
      initialEntry: "/check?sens=0.78&wE1=1.5&wE2=0.5&wE3=1&wAVRI=2",
    });
    expect(screen.getByTestId("location-search").textContent).toContain(
      "sens=0.78",
    );
    await user.click(screen.getByTestId("advanced-sensitivity-reset"));
    expect(screen.getByTestId("location-search").textContent).toBe("");
    expect(screen.getByTestId("advanced-sensitivity-reset")).toBeDisabled();
    expect(screen.getByTestId("sensitivity-value").textContent).toBe("0.50");
  });

  it("renders adjusted score and delta vs canonical", () => {
    renderPanel({
      initialEntry: "/check?sens=1&wE1=1&wE2=1&wE3=1&wAVRI=1",
      canonicalScore: 50,
      subScores: { engine1: 40, engine2: 60, engine3: 20, avri: 80 },
    });
    expect(screen.getByTestId("adjusted-score").textContent).toBe("100");
    expect(screen.getByTestId("adjusted-score-delta").textContent).toBe("+50");
  });
});

describe("copyTextToClipboard", () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "clipboard",
  );
  const originalExec = (document as Document & { execCommand?: unknown })
    .execCommand;

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(
        globalThis.navigator,
        "clipboard",
        originalClipboard,
      );
    } else {
      Object.defineProperty(globalThis.navigator, "clipboard", {
        configurable: true,
        value: undefined,
      });
    }
    (document as unknown as { execCommand: unknown }).execCommand =
      originalExec as unknown;
  });

  it("uses navigator.clipboard.writeText when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const ok = await copyTextToClipboard("hello");
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to document.execCommand('copy') when navigator.clipboard is unavailable", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const execMock = vi.fn().mockReturnValue(true);
    (document as Document & { execCommand?: unknown }).execCommand = execMock;
    const ok = await copyTextToClipboard("from fallback");
    expect(ok).toBe(true);
    expect(execMock).toHaveBeenCalledWith("copy");
  });

  it("returns false when both clipboard paths fail", async () => {
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const execMock = vi.fn().mockReturnValue(false);
    (document as Document & { execCommand?: unknown }).execCommand = execMock;
    const ok = await copyTextToClipboard("nope");
    expect(ok).toBe(false);
  });
});
