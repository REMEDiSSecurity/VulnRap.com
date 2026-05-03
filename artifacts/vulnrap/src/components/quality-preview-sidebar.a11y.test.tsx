// Task #727 — render-once-then-axe assertion for the quality preview
// sidebar (the dashboard-style card cluster shown next to the report
// submission textarea on /check). Covers list semantics, status
// pills, and the icon-only buttons in the header.
import { describe, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { QualityPreviewSidebar } from "./quality-preview-sidebar";
import { expectNoSeriousA11yViolations } from "@/test/axe";

const SAMPLE = [
  "Title: Reflected XSS in /search",
  "",
  "Steps to reproduce:",
  "1. Visit https://example.com/search?q=<script>alert(1)</script>",
  "2. Observe the alert popup confirming script execution.",
  "",
  "```js",
  "fetch('/search?q=' + encodeURIComponent('<script>alert(1)</script>'))",
  "```",
  "",
  "Impact: arbitrary script execution in the user's browser context.",
].join("\n");

describe("QualityPreviewSidebar — a11y", () => {
  it("has no serious or critical axe violations with a representative report", async () => {
    const { container } = render(
      <MemoryRouter>
        <QualityPreviewSidebar text={SAMPLE} />
      </MemoryRouter>,
    );
    await expectNoSeriousA11yViolations(container, "QualityPreviewSidebar");
  });
});
