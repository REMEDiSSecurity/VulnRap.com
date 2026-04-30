// Task #296 — unit tests for the shared `CalibrationCooldownBanner`.
//
// The banner used to live inline in `feedback-analytics.tsx` (Task #212).
// Pulling it into its own component lets every calibration screen mount
// the same visual treatment, but it also means the "active state shows
// the countdown / inactive state hides the banner" contract has to be
// pinned down in tests so a future refactor of the cooldown store can't
// silently regress it across all the screens at once.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { CalibrationCooldownBanner } from "./calibration-cooldown-banner";
import type { CalibrationCooldownState } from "@/lib/calibration-cooldown";

function makeState(overrides: Partial<CalibrationCooldownState> = {}): CalibrationCooldownState {
  return {
    active: false,
    secondsRemaining: 0,
    resetAt: null,
    serverMessage: null,
    limit: null,
    noticeId: 0,
    ...overrides,
  };
}

describe("CalibrationCooldownBanner", () => {
  it("renders nothing when the cooldown is inactive", () => {
    const { container } = render(
      <CalibrationCooldownBanner state={makeState({ active: false })} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByTestId("calibration-cooldown-banner"),
    ).not.toBeInTheDocument();
  });

  it("renders a singular-second headline when one second remains", () => {
    render(
      <CalibrationCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 1,
          resetAt: Date.now() + 1000,
        })}
      />,
    );
    const banner = screen.getByTestId("calibration-cooldown-banner");
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveAttribute("role", "alert");
    expect(
      screen.getByTestId("calibration-cooldown-headline"),
    ).toHaveTextContent("try again in 1 second");
  });

  it("renders a plural-second headline for any other remaining duration", () => {
    render(
      <CalibrationCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 12,
          resetAt: Date.now() + 12_000,
        })}
      />,
    );
    expect(
      screen.getByTestId("calibration-cooldown-headline"),
    ).toHaveTextContent("try again in 12 seconds");
  });

  it("floors the displayed countdown at 1 second so the banner never reads '0 seconds'", () => {
    // The store may briefly hand us secondsRemaining===0 between the
    // last tick and the cooldown clearing — the banner must not read
    // "try again in 0 seconds" in that race window.
    render(
      <CalibrationCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 0,
          resetAt: Date.now() + 100,
        })}
      />,
    );
    expect(
      screen.getByTestId("calibration-cooldown-headline"),
    ).toHaveTextContent("try again in 1 second");
  });

  it("quotes the server-supplied message when available", () => {
    render(
      <CalibrationCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          serverMessage: "Too many failed calibration auth attempts. Try again in 5s.",
        })}
      />,
    );
    expect(
      screen.getByText(/Too many failed calibration auth attempts/i),
    ).toBeInTheDocument();
  });

  it("falls back to the canned explainer when the server omitted a message", () => {
    render(
      <CalibrationCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          serverMessage: null,
        })}
      />,
    );
    expect(
      screen.getByText(/reviewer-token throttle has temporarily blocked/i),
    ).toBeInTheDocument();
  });

  it("renders the limit hint with correct singular/plural pluralisation", () => {
    const { rerender } = render(
      <CalibrationCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          limit: 1,
        })}
      />,
    );
    expect(
      screen.getByText(/limit is 1 failed attempt per window/i),
    ).toBeInTheDocument();

    rerender(
      <CalibrationCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          limit: 5,
        })}
      />,
    );
    expect(
      screen.getByText(/limit is 5 failed attempts per window/i),
    ).toBeInTheDocument();
  });

  it("omits the limit hint entirely when the server didn't report one", () => {
    render(
      <CalibrationCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          limit: null,
        })}
      />,
    );
    expect(screen.queryByText(/per window/i)).not.toBeInTheDocument();
  });

  it("always tells reviewers to confirm the reviewer token before retrying", () => {
    // The banner doubles as guidance — the throttle is a wrong-token
    // throttle, so the actionable next step is "check the token", not
    // "wait for the timer". Keep this hint so reviewers stop hammering
    // the limiter while the build's token is still wrong.
    render(
      <CalibrationCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
        })}
      />,
    );
    expect(
      screen.getByText(/Confirm the reviewer token/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/VITE_CALIBRATION_TOKEN/),
    ).toBeInTheDocument();
  });
});
