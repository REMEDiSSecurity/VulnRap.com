// Task #637 — coverage for the pre-submit quality grader.
//
// Pins both the pure helper (computeQualityPreview) and the rendered
// component so future tweaks to scoring weights don't silently flip a
// row from green to red without a test failure.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  QualityPreviewSidebar,
  computeQualityPreview,
} from "./quality-preview-sidebar";

function renderSidebar(text: string) {
  return render(
    <MemoryRouter>
      <QualityPreviewSidebar text={text} />
    </MemoryRouter>,
  );
}

describe("computeQualityPreview", () => {
  it("returns zeroed counts and empty-friendly checks for empty input", () => {
    const p = computeQualityPreview("");
    expect(p.wordCount).toBe(0);
    expect(p.urlCount).toBe(0);
    expect(p.stepwiseCount).toBe(0);
    expect(p.hasCodeBlock).toBe(false);
    expect(p.estimatedScore).toBeLessThan(40);
  });

  it("flags every required signal as failing for a one-liner", () => {
    const p = computeQualityPreview("found a bug");
    const map = Object.fromEntries(p.checks.map((c) => [c.id, c.status]));
    expect(map["word-count"]).toBe("fail");
    expect(map["code-block"]).toBe("fail");
    expect(map["urls"]).toBe("fail");
    expect(map["steps"]).toBe("fail");
  });

  it("rewards a well-formed report with a high score and all-pass checks", () => {
    const text =
      "This is a reflected XSS in the search endpoint of the example app. " +
      "The vulnerability allows an attacker to execute arbitrary JavaScript " +
      "in the context of any user who clicks a crafted link, leading to " +
      "session hijacking and account takeover for any signed-in customer. " +
      "The affected component is the search query parser, which fails to " +
      "escape the q parameter before reflecting it into the rendered HTML " +
      "response. The bug was introduced in release 4.2.0 and remains " +
      "present in the current main branch as of the date of this report. " +
      "Mitigation requires either properly encoding the reflected query " +
      "string before rendering or moving the search results page to a " +
      "stricter content security policy that disallows inline script. " +
      "See https://example.com/advisory and " +
      "https://nvd.nist.gov/vuln/detail/CVE-2024-12345 for additional " +
      "context on the impacted releases and the planned upstream fix.\n\n" +
      "Reproduction:\n" +
      "1. Open the application in a browser.\n" +
      "2. Navigate to the /search page.\n" +
      "3. Submit the payload below and observe the alert dialog.\n\n" +
      "```http\nGET /search?q=<script>alert(1)</script> HTTP/1.1\nHost: example.com\n```\n";
    const p = computeQualityPreview(text);
    const map = Object.fromEntries(p.checks.map((c) => [c.id, c.status]));
    expect(map["word-count"]).toBe("pass");
    expect(map["code-block"]).toBe("pass");
    expect(map["urls"]).toBe("pass");
    expect(map["steps"]).toBe("pass");
    expect(map["caps"]).toBe("pass");
    expect(p.estimatedScore).toBeGreaterThanOrEqual(70);
  });

  it("penalises all-caps prose only once there is enough text to judge", () => {
    const shortCaps = computeQualityPreview("RCE!");
    expect(shortCaps.capsRatio).toBe(0);

    const longCaps = computeQualityPreview(
      "THIS IS A CRITICAL REMOTE CODE EXECUTION FOUND IN THE LOGIN ENDPOINT OF THE APPLICATION RIGHT NOW",
    );
    const capsCheck = longCaps.checks.find((c) => c.id === "caps");
    expect(capsCheck?.status).toBe("fail");
  });

  it("clamps the estimated score to the 0-100 band", () => {
    const p = computeQualityPreview("A".repeat(500));
    expect(p.estimatedScore).toBeGreaterThanOrEqual(0);
    expect(p.estimatedScore).toBeLessThanOrEqual(100);
  });
});

describe("<QualityPreviewSidebar />", () => {
  it("renders the score, every checklist row, and the docs link", () => {
    renderSidebar("found a bug");
    expect(screen.getByTestId("quality-preview-sidebar")).toBeTruthy();
    expect(screen.getByTestId("quality-preview-score-value")).toBeTruthy();
    expect(screen.getByTestId("quality-check-word-count")).toBeTruthy();
    expect(screen.getByTestId("quality-check-code-block")).toBeTruthy();
    expect(screen.getByTestId("quality-check-urls")).toBeTruthy();
    expect(screen.getByTestId("quality-check-steps")).toBeTruthy();
    expect(screen.getByTestId("quality-check-caps")).toBeTruthy();
    const link = screen.getByTestId(
      "quality-preview-docs-link",
    ) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/docs/good-report");
  });

  it("shows an em-dash placeholder for the score when input is empty", () => {
    renderSidebar("");
    expect(screen.getByTestId("quality-preview-score-value").textContent).toBe(
      "—",
    );
  });
});
