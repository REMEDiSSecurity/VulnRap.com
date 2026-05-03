// Task #727 — Shared axe-core helper for vitest unit tests.
//
// We deliberately do NOT depend on `vitest-axe` here: it adds a
// custom matcher and pulls a transitive lock on a specific axe-core
// minor. Calling axe-core's `run()` directly against the rendered
// DOM keeps the helper tiny and avoids a second axe-core copy.
//
// Severity contract mirrors the Playwright helper: only `serious`
// and `critical` violations fail the test. `moderate` / `minor` are
// surfaced via console output for visibility but do not block CI.
// See docs/accessibility.md for the rationale and triage process.
import axe, { type AxeResults, type Result, type RunOptions } from "axe-core";
import { expect } from "vitest";

const DEFAULT_RUN_OPTIONS: RunOptions = {
  // WCAG 2.1 AA — the project's documented target.
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
  rules: {
    // happy-dom does not implement enough of the layout/colour APIs
    // for axe to compute contrast reliably; covered by the manual
    // sweep + the Playwright suite (which also disables it for the
    // oklch reason documented there).
    "color-contrast": { enabled: false },
  },
};

export async function runAxe(
  container: Element,
  overrides: RunOptions = {},
): Promise<AxeResults> {
  const options: RunOptions = {
    ...DEFAULT_RUN_OPTIONS,
    ...overrides,
    rules: { ...DEFAULT_RUN_OPTIONS.rules, ...(overrides.rules ?? {}) },
  };
  // axe-core's typing of `runOnly` is slightly looser than what we use here;
  // cast through unknown to keep the call site readable.
  return (await axe.run(container, options)) as AxeResults;
}

export async function expectNoSeriousA11yViolations(
  container: Element,
  label: string,
  overrides: RunOptions = {},
): Promise<void> {
  const results = await runAxe(container, overrides);
  const blocking: Result[] = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  if (results.violations.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[a11y:${label}] ${results.violations.length} violation(s) (${blocking.length} blocking):`,
      results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.length,
      })),
    );
  }
  expect(
    blocking,
    `serious/critical a11y violations on ${label}: ${blocking
      .map((v) => `${v.id} (${v.impact})`)
      .join(", ")}`,
  ).toEqual([]);
}
