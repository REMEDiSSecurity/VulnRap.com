// Task #417 — unit tests for the report-submit cooldown banner wrapper.
//
// The banner is a thin specialisation of `RateLimitCooldownBanner`
// (its generic behaviour is exercised in
// `rate-limit-cooldown-banner.test.tsx`). These specs pin the
// page-specific contract: the testId stem the home page expects, the
// "too many requests" headline lead-in, the per-page fallback
// explainer that names the submit limiter, and the per-IP hint.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { ReportSubmitCooldownBanner } from "./report-submit-cooldown-banner";
import type { ReportSubmitCooldownState } from "@/lib/report-submit-cooldown";

function makeState(
  overrides: Partial<ReportSubmitCooldownState> = {},
): ReportSubmitCooldownState {
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

describe("ReportSubmitCooldownBanner", () => {
  it("renders nothing when the cooldown is inactive", () => {
    const { container } = render(
      <ReportSubmitCooldownBanner state={makeState({ active: false })} />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByTestId("report-submit-cooldown-banner"),
    ).not.toBeInTheDocument();
  });

  it("uses the report-submit testId stem so the home page can target it", () => {
    render(
      <ReportSubmitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
        })}
      />,
    );
    expect(
      screen.getByTestId("report-submit-cooldown-banner"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("report-submit-cooldown-headline"),
    ).toHaveTextContent("Too many requests — try again in 5 seconds");
    // Critically, the calibration testId must NOT be reused — the home
    // page may eventually mount both banners, and they have to be
    // independently targetable in tests.
    expect(
      screen.queryByTestId("calibration-cooldown-banner"),
    ).not.toBeInTheDocument();
  });

  it("renders the canned submit-limiter explainer when the server omits a message", () => {
    render(
      <ReportSubmitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          serverMessage: null,
        })}
      />,
    );
    expect(
      screen.getByText(/report submission rate limit/i),
    ).toBeInTheDocument();
  });

  it("quotes the server message verbatim when present", () => {
    render(
      <ReportSubmitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          serverMessage: "Too many requests. Please try again later.",
        })}
      />,
    );
    expect(
      screen.getByText(/Too many requests\. Please try again later\./),
    ).toBeInTheDocument();
  });

  it("renders the limit hint with the request unit", () => {
    render(
      <ReportSubmitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
          limit: 30,
        })}
      />,
    );
    expect(
      screen.getByText(/limit is 30 requests per window/i),
    ).toBeInTheDocument();
  });

  it("includes the per-IP guidance hint so submitters know what to do next", () => {
    render(
      <ReportSubmitCooldownBanner
        state={makeState({
          active: true,
          secondsRemaining: 5,
          resetAt: Date.now() + 5000,
        })}
      />,
    );
    expect(screen.getByText(/per-IP/i)).toBeInTheDocument();
  });
});
