// Task #727 — render-once-then-axe assertion for the report-feedback form.
//
// FeedbackForm is the heaviest reused interactive surface on the
// /results/:id page (radios, ratings, free-text comment, captcha).
// We render it under the providers it actually depends on at runtime
// (router + react-query) and assert no `serious`/`critical` axe
// violations. See artifacts/vulnrap/src/test/axe.ts for the helper
// contract and docs/accessibility.md for the severity policy.
import { describe, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import FeedbackForm from "./feedback-form";
import { expectNoSeriousA11yViolations } from "@/test/axe";

function renderForm() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeedbackForm reportId={1} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("FeedbackForm — a11y", () => {
  it("has no serious or critical axe violations on initial render", async () => {
    const { container } = renderForm();
    await expectNoSeriousA11yViolations(container, "FeedbackForm");
  });
});
