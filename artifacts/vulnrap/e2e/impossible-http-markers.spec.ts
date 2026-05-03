import { test, expect, request } from "@playwright/test";

// Task #607 — end-to-end coverage for the per-marker badges rendered by
// <ImpossibleHttpMarkers>. Posts a fixture that fires the
// impossible_http_response signal and asserts the badges + their RFC
// tooltip text render on /results/:id and /check.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;

// Two predicates from hallucination-detector.test.ts in one fence:
//   - "200 Not Found"            -> status_200_with_wrong_reason_phrase
//   - POST + Set-Cookie request  -> request_carries_response_only_set-cookie
const IMPOSSIBLE_HTTP_FIXTURE = [
  "Title: Authentication bypass on /admin via crafted reason-phrase response",
  "Severity: critical",
  "Steps to reproduce:",
  "1. Send a crafted GET to /admin with a tampered Host header.",
  "2. The upstream returned the impossible response shown below.",
  "3. We then captured the smuggled login request — note the response-only",
  "   Set-Cookie header on the request line, which a real browser cannot emit.",
  "Server response transcript:",
  "```http",
  "HTTP/1.1 200 Not Found",
  "Content-Type: application/json",
  "Content-Length: 16",
  "",
  '{"admin":true}',
  "```",
  "Smuggled request transcript:",
  "```http",
  "POST /login HTTP/1.1",
  "Host: target.test",
  "Set-Cookie: stolen=yes",
  "",
  "user=admin",
  "```",
  "Impact: full administrative compromise of the target tenant.",
  "Affected component: auth.controller.ts:88 (admin-bypass codepath).",
  "Reproduced on: Chrome 124, Firefox 125 (Linux + macOS).",
  "Expected: the upstream should return 401 Unauthorized; the proxy must",
  "reject any request line that carries a response-only header per RFC 6265.",
].join("\n");

interface SubmitResponse {
  id: number;
}

interface ReportBody {
  evidence?: Array<{
    type: string;
    markers?: string[] | null;
  }>;
}

// Both pages mount <ImpossibleHttpMarkers> with a custom testIdPrefix
// (`evidence-${i}-marker` and `check-evidence-${i}-marker`), so we
// match on the marker-ID suffix instead of a fixed prefix.
const MARKER_LIST_SELECTOR = '[data-testid$="-marker-list"]';
const STATUS_REASON_MARKER_SUFFIX =
  "-marker-status_200_with_wrong_reason_phrase";
const SET_COOKIE_MARKER_SUFFIX =
  "-marker-request_carries_response_only_set-cookie";

test.describe("ImpossibleHttpMarkers — end-to-end badges (Task #607)", () => {
  test("results page renders per-marker badges with RFC tooltips", async ({
    page,
    baseURL,
  }) => {
    // Seed via the api directly. showInFeed=true so GET /reports/:id
    // returns 200; skipLlm/skipRedaction keep the run deterministic and
    // leave the fenced HTTP transcripts intact.
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const submitRes = await apiCtx.post("/api/reports", {
      form: {
        rawText: IMPOSSIBLE_HTTP_FIXTURE,
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

    // Contract sanity check — a failure here points at score-fusion
    // dropping the markers field, not at the UI.
    const reportRes = await apiCtx.get(`/api/reports/${submitted.id}`);
    expect(reportRes.ok()).toBeTruthy();
    const reportBody = (await reportRes.json()) as ReportBody;
    const impossibleRow = (reportBody.evidence ?? []).find(
      (e) => e.type === "hallucination_impossible_http_response",
    );
    expect(impossibleRow).toBeDefined();
    expect(impossibleRow!.markers ?? []).toEqual(
      expect.arrayContaining([
        "status_200_with_wrong_reason_phrase",
        "request_carries_response_only_set-cookie",
      ]),
    );
    await apiCtx.dispose();

    await page.goto(`${baseURL}/results/${submitted.id}`, {
      waitUntil: "networkidle",
    });

    const lists = page.locator(MARKER_LIST_SELECTOR);
    await expect(lists.first()).toBeVisible({ timeout: 15_000 });
    expect(await lists.count()).toBeGreaterThanOrEqual(1);

    // Tooltip content lives in a Radix Portal that won't open without a
    // real hover, so we read aria-label off the trigger button.
    const statusTrigger = page
      .locator(`[data-testid$="${STATUS_REASON_MARKER_SUFFIX}"]`)
      .first();
    await expect(statusTrigger).toBeVisible({ timeout: 10_000 });
    const statusAria = await statusTrigger.getAttribute("aria-label");
    expect(statusAria).not.toBeNull();
    expect(statusAria!).toMatch(/200 status line has the wrong reason phrase/i);
    expect(statusAria!).toMatch(/RFC 7231|IANA HTTP Status Code Registry/);

    const setCookieTrigger = page
      .locator(`[data-testid$="${SET_COOKIE_MARKER_SUFFIX}"]`)
      .first();
    await expect(setCookieTrigger).toBeVisible({ timeout: 10_000 });
    const setCookieAria = await setCookieTrigger.getAttribute("aria-label");
    expect(setCookieAria).not.toBeNull();
    expect(setCookieAria!).toMatch(
      /Request carries response-only header: Set-Cookie/i,
    );
    expect(setCookieAria!).toMatch(/RFC 6265/);
  });

  test("check page renders per-marker badges with RFC tooltips", async ({
    page,
    baseURL,
  }) => {
    // /check doesn't persist anything, so drive the UI: paste the
    // fixture, disable PII redaction (which auto-disables the LLM via
    // the existing onChange handler), submit.
    await page.goto(`${baseURL}/check`, { waitUntil: "networkidle" });

    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    await textarea.fill(IMPOSSIBLE_HTTP_FIXTURE);

    const skipRedactionToggle = page.getByTestId("toggle-skip-redaction");
    await expect(skipRedactionToggle).toBeVisible({ timeout: 10_000 });
    await skipRedactionToggle.check();
    await expect(skipRedactionToggle).toBeChecked();
    await expect(page.getByTestId("toggle-skip-llm")).toBeChecked();

    await page.getByRole("button", { name: /Check Report/i }).click();

    await expect(
      page.getByRole("heading", { name: /Check Results/i }),
    ).toBeVisible({ timeout: 30_000 });

    const lists = page.locator(MARKER_LIST_SELECTOR);
    await expect(lists.first()).toBeVisible({ timeout: 15_000 });
    expect(await lists.count()).toBeGreaterThanOrEqual(1);

    const statusTrigger = page
      .locator(`[data-testid$="${STATUS_REASON_MARKER_SUFFIX}"]`)
      .first();
    await expect(statusTrigger).toBeVisible({ timeout: 10_000 });
    const statusAria = await statusTrigger.getAttribute("aria-label");
    expect(statusAria).not.toBeNull();
    expect(statusAria!).toMatch(/200 status line has the wrong reason phrase/i);
    expect(statusAria!).toMatch(/RFC 7231|IANA HTTP Status Code Registry/);

    const setCookieTrigger = page
      .locator(`[data-testid$="${SET_COOKIE_MARKER_SUFFIX}"]`)
      .first();
    await expect(setCookieTrigger).toBeVisible({ timeout: 10_000 });
    const setCookieAria = await setCookieTrigger.getAttribute("aria-label");
    expect(setCookieAria).not.toBeNull();
    expect(setCookieAria!).toMatch(
      /Request carries response-only header: Set-Cookie/i,
    );
    expect(setCookieAria!).toMatch(/RFC 6265/);
  });
});
