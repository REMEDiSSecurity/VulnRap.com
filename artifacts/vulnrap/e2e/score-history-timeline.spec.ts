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

const MULTI_ENTRY_HISTORY = {
  reportId: 1,
  entries: [
    {
      compositeScore: 62,
      label: "NEEDS REVIEW",
      recordedAt: "2026-01-01T00:00:00.000Z",
      correlationId: "cid-orig",
      source: "original",
      mode: "original",
      codeVersion: null,
      engines: null,
    },
    {
      compositeScore: 58,
      label: "NEEDS REVIEW",
      recordedAt: "2026-02-01T00:00:00.000Z",
      correlationId: "cid-mid",
      source: "backfill-rescore",
      mode: "engine",
      codeVersion: null,
      engines: null,
    },
    {
      compositeScore: 71,
      label: "REASONABLE",
      recordedAt: "2026-03-01T00:00:00.000Z",
      correlationId: "cid-final",
      source: "backfill-rescore",
      mode: "engine",
      codeVersion: null,
      engines: [
        { engine: "Linguistic", score: 65, verdict: "GREEN", confidence: "HIGH" },
        { engine: "Structural", score: 70, verdict: "GREEN", confidence: "HIGH" },
        { engine: "Contextual", score: 78, verdict: "GREEN", confidence: "MEDIUM" },
      ],
    },
  ],
};

const SINGLE_ENTRY_HISTORY = {
  reportId: 1,
  entries: [
    {
      compositeScore: 72,
      label: "REASONABLE",
      recordedAt: "2026-01-01T00:00:00.000Z",
      correlationId: "cid-only",
      source: "original",
      mode: "original",
      codeVersion: null,
      engines: [
        { engine: "Linguistic", score: 65, verdict: "GREEN", confidence: "HIGH" },
      ],
    },
  ],
};

async function seedReport(): Promise<number> {
  const apiCtx = await request.newContext({ baseURL: API_BASE });
  const submitRes = await apiCtx.post("/api/reports", {
    form: {
      rawText: SAMPLE_REPORT_TEXT,
      skipLlm: "true",
      skipRedaction: "true",
      showInFeed: "true",
    },
  });
  expect(
    submitRes.ok(),
    `POST /api/reports failed: ${submitRes.status()}`,
  ).toBeTruthy();
  const submitted = (await submitRes.json()) as SubmitResponse;
  expect(typeof submitted.id).toBe("number");
  await apiCtx.dispose();
  return submitted.id;
}

test.describe("ScoreHistoryTimeline — multi-entry rescore history", () => {
  test("card is collapsed by default, expands on click, renders correct SVG points and hover panel", async ({
    page,
    baseURL,
  }) => {
    const reportId = await seedReport();

    const mockPayload = {
      ...MULTI_ENTRY_HISTORY,
      reportId,
    };

    await page.route(`**/api/reports/${reportId}/score-history`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockPayload),
      }),
    );

    await page.goto(`${baseURL}/results/${reportId}`, {
      waitUntil: "networkidle",
    });

    const card = page.locator('[data-testid="card-score-history"]');
    await expect(card).toBeVisible({ timeout: 15_000 });

    await expect(card.getByText("Score history")).toBeVisible();
    await expect(card.getByText("3 scores")).toBeVisible();

    const svg = card.locator('[data-testid="svg-score-history"]');
    await expect(svg).not.toBeVisible();

    const header = card.locator('[data-testid="header-score-history"]');
    await header.click();

    await expect(svg).toBeVisible({ timeout: 5_000 });

    const points = card.locator('[data-testid^="point-score-history-"]');
    await expect(points).toHaveCount(3);

    await expect(
      card.getByText("Hover a point to see engine sub-scores."),
    ).toBeVisible();

    const lastPoint = card.locator('[data-testid="point-score-history-2"]');
    await lastPoint.focus();

    const hoverPanel = card.locator(
      '[data-testid="panel-score-history-hover"]',
    );
    await expect(hoverPanel).toBeVisible({ timeout: 5_000 });

    await expect(hoverPanel.getByText("71")).toBeVisible();
    await expect(hoverPanel.getByText("backfill-rescore")).toBeVisible();

    const engineCards = hoverPanel.locator(
      '[data-testid^="engine-score-history-"]',
    );
    await expect(engineCards).toHaveCount(3);

    await expect(hoverPanel.getByText("Linguistic")).toBeVisible();
    await expect(hoverPanel.getByText("Structural")).toBeVisible();
    await expect(hoverPanel.getByText("Contextual")).toBeVisible();
    await expect(hoverPanel.getByText("65").first()).toBeVisible();
    await expect(hoverPanel.getByText("70").first()).toBeVisible();
    await expect(hoverPanel.getByText("78").first()).toBeVisible();

    const firstPoint = card.locator('[data-testid="point-score-history-0"]');
    await firstPoint.focus();
    await expect(hoverPanel).toBeVisible();
    await expect(hoverPanel.getByText("original")).toBeVisible();
    await expect(
      hoverPanel.getByText(
        "No per-engine data on file for this scoring event.",
      ),
    ).toBeVisible();
  });
});

test.describe("ScoreHistoryTimeline — single entry (no rescores)", () => {
  test("card is absent when the report has only one scoring entry", async ({
    page,
    baseURL,
  }) => {
    const reportId = await seedReport();

    const mockPayload = {
      ...SINGLE_ENTRY_HISTORY,
      reportId,
    };

    let scoreHistoryHit = false;
    await page.route(`**/api/reports/${reportId}/score-history`, (route) => {
      scoreHistoryHit = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockPayload),
      });
    });

    const scoreHistoryResponse = page.waitForResponse(
      (resp) => resp.url().includes(`/api/reports/${reportId}/score-history`),
    );

    await page.goto(`${baseURL}/results/${reportId}`, {
      waitUntil: "networkidle",
    });

    await scoreHistoryResponse;
    expect(scoreHistoryHit).toBe(true);

    const card = page.locator('[data-testid="card-score-history"]');
    await expect(card).toHaveCount(0);
  });
});
