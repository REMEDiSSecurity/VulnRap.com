// Task #727 — render-once-then-axe assertion for the dashboard-style
// engine card. TriageEngineCard is repeated several times on the
// /results/:id page (one card per detection engine), so a regression
// here multiplies across the whole page.
import { describe, it } from "vitest";
import { render } from "@testing-library/react";

import { TriageEngineCard } from "./triage-engine-card";
import { expectNoSeriousA11yViolations } from "@/test/axe";

describe("TriageEngineCard — a11y", () => {
  it("has no serious or critical axe violations with a populated engine", async () => {
    const { container } = render(
      <TriageEngineCard
        engine={{
          engine: "perplexity",
          score: 73,
          verdict: "RED",
          confidence: "HIGH",
          note: "Linguistic markers consistent with auto-generated prose.",
          triggeredIndicators: [
            {
              signal: "bigram-entropy",
              explanation: "Bigram entropy 7.21 above threshold 6.5.",
              strength: "HIGH",
            },
            {
              signal: "function-word-rate",
              explanation: "Function-word rate 42.1% within fabricated-text band.",
              strength: "MEDIUM",
            },
          ],
        }}
      />,
    );
    await expectNoSeriousA11yViolations(container, "TriageEngineCard");
  });
});
