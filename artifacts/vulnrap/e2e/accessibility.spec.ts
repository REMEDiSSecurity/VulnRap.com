// Task #727 — Automated WCAG 2.1 AA scans on every major route.
//
// We use @axe-core/playwright to run an axe-core scan after each route
// has settled, and fail the test if any violation is classed as
// `serious` or `critical`. `moderate` / `minor` findings are surfaced
// via console output but do not block CI — see docs/accessibility.md
// for the rationale and the triage process.
//
// One spec per major route (per the task brief): landing, results,
// check, verify, stats, developers, privacy. Each spec navigates to
// the route, waits for the obvious "loaded" state, and runs the
// shared scan helper. Routes that need real data (results, verify)
// seed a report through the api-server first so the page is not in
// its empty state.
//
// This file lives under e2e/ so it gets picked up by the diff-aware
// selector in scripts/vulnrap-e2e-select-specs.mjs automatically:
// a change to the spec only reruns this file; a change to any shared
// frontend file fires the FULL_SUITE_PATTERNS rule and reruns it
// alongside the existing suite.
import { test, expect, request, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;

const SAMPLE_REPORT_TEXT = [
  "Title: Reflected XSS in /search",
  "Severity: medium",
  "Steps to reproduce:",
  "1. Navigate to https://example.com/search?q=<script>alert(1)</script>",
  "2. Observe that the alert popup confirms script execution.",
  "Impact: An attacker can execute arbitrary JavaScript in the victim's browser context,",
  "stealing session cookies or performing actions on behalf of the user.",
  "Expected: input should be HTML-escaped before being reflected back to the page.",
  "Affected component: search handler in /search route — see search.controller.ts:42.",
  "Reproduced on: Chrome 124, Firefox 125 (Linux + macOS).",
].join("\n");

interface SubmitResponse {
  id: number;
}

/**
 * Run an axe-core scan against the current page state and assert no
 * `serious` or `critical` violations.
 *
 * Tags: WCAG 2.1 AA per the project target (docs/accessibility.md).
 * `wcag2a` + `wcag2aa` + `wcag21a` + `wcag21aa` is the canonical axe
 * tag set for "WCAG 2.1 AA"; see https://github.com/dequelabs/axe-core/
 * blob/develop/doc/API.md#axe-core-tags.
 *
 * Disabled rules:
 * - `color-contrast` is disabled here only because the headless
 *   chromium used in CI cannot render Tailwind 4 oklch() colours
 *   reliably and produces false positives. Colour contrast is
 *   covered manually (Lighthouse + DevTools axe panel) and tracked
 *   in docs/accessibility.md. Re-enable once axe-core supports
 *   oklch() natively without the chromium rendering quirk.
 */
async function scanPage(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .disableRules(["color-contrast"])
    .analyze();

  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );

  if (results.violations.length > 0) {
    // Surface every finding (including non-blocking) so reviewers see
    // the full picture in the test log without polluting CI signal.
    // eslint-disable-next-line no-console
    console.log(
      `[a11y:${label}] ${results.violations.length} violation(s) (${blocking.length} blocking):`,
      JSON.stringify(
        results.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.length,
        })),
        null,
        2,
      ),
    );
  }

  expect(
    blocking,
    `serious/critical a11y violations on ${label}: ${blocking
      .map((v) => `${v.id} (${v.impact})`)
      .join(", ")}`,
  ).toEqual([]);
}

async function seedReport(): Promise<number> {
  const apiCtx = await request.newContext({ baseURL: API_BASE });
  try {
    const res = await apiCtx.post("/api/reports", {
      form: {
        rawText: SAMPLE_REPORT_TEXT,
        skipLlm: "true",
        skipRedaction: "true",
        showInFeed: "true",
      },
    });
    expect(res.ok(), `seed POST /api/reports failed: ${res.status()}`).toBeTruthy();
    const body = (await res.json()) as SubmitResponse;
    expect(typeof body.id).toBe("number");
    return body.id;
  } finally {
    await apiCtx.dispose();
  }
}

test.describe("a11y — WCAG 2.1 AA scan per major route", () => {
  test("landing (/)", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/`, { waitUntil: "networkidle" });
    await expect(page.locator("main, [role='main'], body")).toBeVisible();
    await scanPage(page, "/");
  });

  test("check (/check)", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/check`, { waitUntil: "networkidle" });
    await scanPage(page, "/check");
  });

  test("stats (/stats)", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/stats`, { waitUntil: "networkidle" });
    await scanPage(page, "/stats");
  });

  test("developers (/developers)", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/developers`, { waitUntil: "networkidle" });
    await scanPage(page, "/developers");
  });

  test("privacy (/privacy)", async ({ page, baseURL }) => {
    await page.goto(`${baseURL}/privacy`, { waitUntil: "networkidle" });
    await scanPage(page, "/privacy");
  });

  test("results (/results/:id) — loaded state", async ({ page, baseURL }) => {
    const id = await seedReport();
    await page.goto(`${baseURL}/results/${id}`, { waitUntil: "networkidle" });
    await scanPage(page, "/results/:id");
  });

  test("verify (/verify/:id) — loaded state", async ({ page, baseURL }) => {
    const id = await seedReport();
    await page.goto(`${baseURL}/verify/${id}`, { waitUntil: "networkidle" });
    await scanPage(page, "/verify/:id");
  });
});
