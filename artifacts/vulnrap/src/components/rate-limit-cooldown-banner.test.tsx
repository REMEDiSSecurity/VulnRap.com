// Task #417 — unit tests for the generic `RateLimitCooldownBanner`.
//
// The banner is what every per-page cooldown banner (calibration,
// report-submit) renders under the hood. The per-page wrappers' own
// tests (e.g. `calibration-cooldown-banner.test.tsx`) pin down their
// page-specific copy + testIds; these specs pin the generic
// parameters: testId stems, headline pluralisation, the singular/plural
// limit unit, and the optional hint slot.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { RateLimitCooldownBanner } from "./rate-limit-cooldown-banner";
import type { RateLimitCooldownState } from "@/lib/rate-limit-cooldown";

function makeState(
  overrides: Partial<RateLimitCooldownState> = {},
): RateLimitCooldownState {
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

describe("RateLimitCooldownBanner", () => {
  it("renders nothing when the cooldown is inactive", () => {
    const { container } = render(
      <RateLimitCooldownBanner
        state={makeState({ active: false })}
        headlineLead="Too many requests"
        fallbackDetail="The limiter has tripped."
        testIdBase="generic-cooldown"
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("generic-cooldown-banner")).not.toBeInTheDocument();
  });

  it("uses the supplied testIdBase for both the card and the headline", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
        })}
        headlineLead="Too many requests"
        fallbackDetail="The limiter has tripped."
        testIdBase="report-submit-cooldown"
      />,
    );
    expect(
      screen.getByTestId("report-submit-cooldown-banner"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("report-submit-cooldown-headline"),
    ).toBeInTheDocument();
    // The same component should NOT leak the calibration testId.
    expect(
      screen.queryByTestId("calibration-cooldown-banner"),
    ).not.toBeInTheDocument();
  });

  it("composes the headline from the lead-in and singular second", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 1,
          resetAt: Date.now() + 1000,
        })}
        headlineLead="Too many requests"
        fallbackDetail="x"
        testIdBase="t"
      />,
    );
    expect(screen.getByTestId("t-headline")).toHaveTextContent(
      "Too many requests — try again in 1 second",
    );
  });

  it("composes the headline from the lead-in and plural seconds", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 12,
          resetAt: Date.now() + 12_000,
        })}
        headlineLead="Too many failed attempts"
        fallbackDetail="x"
        testIdBase="t"
      />,
    );
    expect(screen.getByTestId("t-headline")).toHaveTextContent(
      "Too many failed attempts — try again in 12 seconds",
    );
  });

  it("floors the displayed countdown at 1 second so the banner never reads '0 seconds'", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 0,
          resetAt: Date.now() + 100,
        })}
        headlineLead="Too many requests"
        fallbackDetail="x"
        testIdBase="t"
      />,
    );
    expect(screen.getByTestId("t-headline")).toHaveTextContent(
      "try again in 1 second",
    );
  });

  it("quotes the server-supplied message when available", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          serverMessage: "Server said: cool it.",
        })}
        headlineLead="Too many requests"
        fallbackDetail="should-not-appear"
        testIdBase="t"
      />,
    );
    expect(screen.getByText(/Server said: cool it\./i)).toBeInTheDocument();
    expect(screen.queryByText(/should-not-appear/)).not.toBeInTheDocument();
  });

  it("falls back to the supplied detail when the server omitted a message", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          serverMessage: null,
        })}
        headlineLead="Too many requests"
        fallbackDetail="The submit limiter has tripped."
        testIdBase="t"
      />,
    );
    expect(
      screen.getByText(/The submit limiter has tripped\./),
    ).toBeInTheDocument();
  });

  it("renders the limit hint with custom singular unit", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          limit: 1,
        })}
        headlineLead="Too many failed attempts"
        fallbackDetail="x"
        limitUnitSingular="failed attempt"
        limitUnitPlural="failed attempts"
        testIdBase="t"
      />,
    );
    expect(
      screen.getByText(/limit is 1 failed attempt per window/i),
    ).toBeInTheDocument();
  });

  it("renders the limit hint with custom plural unit", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          limit: 5,
        })}
        headlineLead="Too many failed attempts"
        fallbackDetail="x"
        limitUnitSingular="failed attempt"
        limitUnitPlural="failed attempts"
        testIdBase="t"
      />,
    );
    expect(
      screen.getByText(/limit is 5 failed attempts per window/i),
    ).toBeInTheDocument();
  });

  it("defaults the plural unit to `${singular}s` when not supplied", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          limit: 30,
        })}
        headlineLead="Too many requests"
        fallbackDetail="x"
        testIdBase="t"
      />,
    );
    expect(
      screen.getByText(/limit is 30 requests per window/i),
    ).toBeInTheDocument();
  });

  it("omits the limit hint entirely when the server didn't report one", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          limit: null,
        })}
        headlineLead="Too many requests"
        fallbackDetail="x"
        testIdBase="t"
      />,
    );
    expect(screen.queryByText(/per window/i)).not.toBeInTheDocument();
  });

  it("renders the optional hint when supplied", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
        })}
        headlineLead="Too many requests"
        fallbackDetail="x"
        hint={<span>Confirm the reviewer token before retrying.</span>}
        testIdBase="t"
      />,
    );
    expect(
      screen.getByText(/Confirm the reviewer token before retrying\./),
    ).toBeInTheDocument();
  });

  it("omits the hint paragraph when no hint is supplied", () => {
    const { container } = render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
        })}
        headlineLead="Too many requests"
        fallbackDetail="The limiter has tripped."
        testIdBase="t"
      />,
    );
    // Three paragraph slots when a hint is supplied (headline div +
    // detail + hint); without a hint we should have just the headline
    // div and the detail paragraph.
    expect(container.querySelectorAll("p").length).toBe(1);
  });

  it("marks the banner as a live alert region", () => {
    render(
      <RateLimitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
        })}
        headlineLead="Too many requests"
        fallbackDetail="x"
        testIdBase="t"
      />,
    );
    expect(screen.getByTestId("t-banner")).toHaveAttribute("role", "alert");
  });
});
