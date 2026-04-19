import { test, expect, request } from "@playwright/test";

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

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;

interface SubmitResponse {
  id: number;
  vulnrap?: { compositeScore?: number; correlationId?: string } | null;
}

interface DiagnosticsResponse {
  reportId: number;
  correlationId: string | null;
  composite: { score: number; label: string } | null;
  legacyMapping: { slopScore: number; displayMode: string } | null;
  featureFlags: Record<string, unknown>;
  trace: { stages?: Array<{ stage: string; durationMs: number }> } | null;
}

test.describe("DiagnosticsPanel — live api-server smoke test", () => {
  test("renders composite, legacy slop mapping, feature flag, and stage timing from the live endpoint", async ({
    page,
    baseURL,
  }) => {
    // 1. Seed a report directly through the api-server so the test is
    //    deterministic regardless of the homepage UI's submission flow.
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const submitRes = await apiCtx.post("/api/reports", {
      form: {
        rawText: SAMPLE_REPORT_TEXT,
        skipLlm: "true",
        skipRedaction: "true",
      },
    });
    expect(submitRes.ok(), `POST /api/reports failed: ${submitRes.status()}`)
      .toBeTruthy();
    const submitted = (await submitRes.json()) as SubmitResponse;
    expect(typeof submitted.id).toBe("number");

    // Sanity-check the diagnostics endpoint directly so a UI failure can be
    // distinguished from contract drift.
    const diagRes = await apiCtx.get(
      `/api/reports/${submitted.id}/diagnostics`,
    );
    expect(diagRes.ok()).toBeTruthy();
    const diag = (await diagRes.json()) as DiagnosticsResponse;
    expect(diag.reportId).toBe(submitted.id);
    expect(diag.composite, "composite must be populated when the new pipeline is enabled")
      .not.toBeNull();
    expect(diag.legacyMapping).not.toBeNull();
    expect(diag.featureFlags?.VULNRAP_USE_NEW_COMPOSITE).toBe(true);
    expect(diag.trace?.stages?.length ?? 0).toBeGreaterThan(0);
    const firstStage = diag.trace!.stages![0];
    await apiCtx.dispose();

    // 2. Drive the real UI: navigate to /results/:id and expand the card.
    await page.goto(`${baseURL}/results/${submitted.id}`, {
      waitUntil: "networkidle",
    });

    // The DiagnosticsPanel renders its expanded body in #diagnostics-body-<id>
    // and the toggle button carries aria-controls pointing at that id, which
    // gives us a robust per-panel selector even if other "Show" buttons appear
    // elsewhere on the results page.
    const panelBody = page.locator(`#diagnostics-body-${submitted.id}`);
    const showButton = page.locator(
      `button[aria-controls="diagnostics-body-${submitted.id}"]`,
    );
    await expect(showButton).toBeVisible({ timeout: 15_000 });
    await showButton.click();

    // 3. Composite section renders within the diagnostics body.
    await expect(panelBody).toBeVisible({ timeout: 15_000 });
    await expect(panelBody.getByText(/Composite Breakdown/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      panelBody.getByText(String(diag.composite!.score), { exact: true }).first(),
    ).toBeVisible();
    await expect(
      panelBody.getByText(diag.composite!.label, { exact: true }).first(),
    ).toBeVisible();

    // 4. Legacy slop-score mapping block.
    await expect(
      panelBody.getByText(/Legacy Slop-Score Mapping/i),
    ).toBeVisible();
    await expect(panelBody.getByText("Legacy Slop Score")).toBeVisible();
    await expect(
      panelBody
        .getByText(String(diag.legacyMapping!.slopScore), { exact: true })
        .first(),
    ).toBeVisible();
    await expect(
      panelBody.getByText(diag.legacyMapping!.displayMode, { exact: true }).first(),
    ).toBeVisible();

    // 5. Feature-flag indicator.
    await expect(
      panelBody.getByText("VULNRAP_USE_NEW_COMPOSITE", { exact: true }),
    ).toBeVisible();

    // 6. At least one pipeline stage timing rendered.
    await expect(panelBody.getByText(/Pipeline Timings/i)).toBeVisible();
    await expect(panelBody.getByText(firstStage.stage).first()).toBeVisible();
    await expect(
      panelBody
        .getByText(`${firstStage.durationMs} ms`, { exact: true })
        .first(),
    ).toBeVisible();
  });
});
