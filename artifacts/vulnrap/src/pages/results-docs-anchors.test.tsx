import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MatrixInputsWidget, TriageCard } from "./results";
import type {
  TriageRecommendation,
  TriageMatrixInputs,
} from "@workspace/api-client-react";

const noopToast = (() => {}) as unknown as Parameters<
  typeof TriageCard
>[0]["toast"];

const matrixInputs: TriageMatrixInputs = {
  compositeScore: 72,
  engine2Score: 65,
  verificationRatio: 0.6,
  strongEvidenceCount: 4,
};

const baseTriage: TriageRecommendation = {
  action: "PRIORITIZE",
  reason: "Strong substance signals across the rubric.",
  note: "Promote to a senior reviewer for confirmation.",
  challengeQuestions: [],
  temporalSignals: [],
  templateMatch: null,
  matrixInputs,
  revision: null,
};

describe("results page docs anchor links (Task 374)", () => {
  it("Triage Recommendation card links to /changelog#triage-recommendation", () => {
    render(
      <MemoryRouter>
        <TriageCard
          triage={baseTriage}
          challengeQuestions={[]}
          temporalSignals={[]}
          templateMatch={null}
          revision={null}
          toast={noopToast}
        />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole("link", { name: /learn more/i });
    const triageLink = links.find(
      (a) => a.getAttribute("href") === "/changelog#triage-recommendation",
    );
    expect(triageLink).toBeDefined();
  });

  it("Matrix Inputs widget links to /changelog#triage-matrix-inputs", () => {
    render(
      <MemoryRouter>
        <TriageCard
          triage={baseTriage}
          challengeQuestions={[]}
          temporalSignals={[]}
          templateMatch={null}
          revision={null}
          toast={noopToast}
        />
      </MemoryRouter>,
    );
    const links = screen.getAllByRole("link", { name: /learn more/i });
    const matrixLink = links.find(
      (a) => a.getAttribute("href") === "/changelog#triage-matrix-inputs",
    );
    expect(matrixLink).toBeDefined();
  });

  it("MatrixInputsWidget rendered standalone also surfaces the docs anchor", () => {
    render(
      <MemoryRouter>
        <MatrixInputsWidget inputs={matrixInputs} />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: /learn more/i });
    expect(link.getAttribute("href")).toBe("/changelog#triage-matrix-inputs");
  });
});
