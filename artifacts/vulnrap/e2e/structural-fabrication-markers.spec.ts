import { test, expect, request } from "@playwright/test";

// Task #613 — end-to-end coverage for the per-marker bullets rendered by
// the Evidence Signals card on the structural_fabrication evidence row.
// Posts the T4-12-fake-prologue-offsets fixture (which the api-server's
// hallucination detector trips with three structural markers) and asserts
// the [data-testid="hallucination-structural-fabrication-markers"] list
// renders one bullet per marker — both on /results/:id and on /check —
// with the human-readable label from STRUCTURAL_MARKER_LABELS.
//
// The fixture below is copied verbatim from the T4-12-fake-prologue-offsets
// entry in artifacts/api-server/src/routes/test-fixtures.ts. Keeping the
// text in-file (rather than importing from the api-server package) avoids
// a cross-artifact runtime dependency in the Playwright bundle.

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;

const T4_12_FIXTURE = [
  "# Heap-use-after-free in libserver request handler (CVE-2099-30311)",
  "",
  "Discovered via automated AI-assisted code analysis of the upstream tree;",
  'the model rated confidence "very high" so I am submitting as Critical.',
  "I have not produced a runnable C reproducer — exploit.py is private and",
  "will be released after embargo.",
  "",
  "```asan",
  "==12345==ERROR: AddressSanitizer: heap-use-after-free on address 0xa1c0",
  "READ of size 8 at 0xa1c0 thread T0",
  "    #0 0x4001 in handle_request+0x1",
  "    #1 0x4002 in worker_loop+0x2",
  "    #2 0x4003 in dispatch+0x100",
  "    #4 0x4004 in main+0x200",
  "    #5 0x4005 in entry+0x300",
  "```",
  "",
  "Working PoC in exploit.py (not attached). Severity: Critical. CVSS: 10.0.",
].join("\n");

// Marker → human-readable label, mirrored from STRUCTURAL_MARKER_LABELS in
// artifacts/vulnrap/src/components/diagnostics-panel.tsx. Order matches the
// emission order of detectStructuralFabrication() in
// artifacts/api-server/src/lib/engines/avri/crash-trace.ts so a regression
// in either side trips a clear assertion failure here.
const EXPECTED_MARKERS: Array<{ id: string; label: string }> = [
  { id: "round_function_offsets", label: "Round/zero function offsets" },
  {
    id: "frame_numbering_gaps",
    label: "Frame-numbering gap inside a block",
  },
  {
    id: "implausible_function_offset",
    label: "Function offsets outside realistic bounds",
  },
];

const MARKER_LIST_TESTID = "hallucination-structural-fabrication-markers";

interface SubmitResponse {
  id: number;
}

interface ReportEvidenceRow {
  type: string;
  context?: { markers?: Array<{ id: string; description: string }> };
}

interface ReportBody {
  evidence?: ReportEvidenceRow[];
}

test.describe("structural_fabrication marker bullets — end-to-end (Task #613)", () => {
  test("results page renders one bullet per structural-fabrication marker", async ({
    page,
    baseURL,
  }) => {
    // Seed via the api directly. showInFeed=true so GET /reports/:id
    // returns 200; skipLlm/skipRedaction keep the run deterministic and
    // leave the fenced ASan trace intact (PII redaction would mangle the
    // hex offsets and break the structural detectors).
    const apiCtx = await request.newContext({ baseURL: API_BASE });
    const submitRes = await apiCtx.post("/api/reports", {
      form: {
        rawText: T4_12_FIXTURE,
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

    // Contract sanity check — a failure here points at the api-server
    // (score-fusion dropping context.markers, or the structural detector
    // not firing on the canonical T4-12 fixture) rather than at the UI.
    const reportRes = await apiCtx.get(`/api/reports/${submitted.id}`);
    expect(reportRes.ok()).toBeTruthy();
    const reportBody = (await reportRes.json()) as ReportBody;
    const structuralRow = (reportBody.evidence ?? []).find(
      (e) => e.type === "hallucination_structural_fabrication",
    );
    expect(
      structuralRow,
      "structural_fabrication evidence row should be present",
    ).toBeDefined();
    const apiMarkerIds = (structuralRow!.context?.markers ?? []).map(
      (m) => m.id,
    );
    expect(apiMarkerIds).toEqual(EXPECTED_MARKERS.map((m) => m.id));
    await apiCtx.dispose();

    await page.goto(`${baseURL}/results/${submitted.id}`, {
      waitUntil: "networkidle",
    });

    // The Evidence Signals card mounts the markers list with the test-id
    // we are pinning here. Exactly one structural_fabrication evidence
    // row exists for this fixture, so the list should be unique on the
    // page.
    const markerList = page.getByTestId(MARKER_LIST_TESTID);
    await expect(markerList).toBeVisible({ timeout: 15_000 });
    await expect(markerList).toHaveCount(1);

    const bullets = markerList.locator("li");
    await expect(bullets).toHaveCount(EXPECTED_MARKERS.length);

    for (const marker of EXPECTED_MARKERS) {
      const bullet = markerList.locator("li", {
        has: page.locator(`text=(${marker.id})`),
      });
      await expect(
        bullet,
        `bullet for marker ${marker.id} should render`,
      ).toHaveCount(1);
      await expect(bullet).toContainText(marker.label);
    }
  });

  test("check page renders one bullet per structural-fabrication marker", async ({
    page,
    baseURL,
  }) => {
    // /check doesn't persist anything, so drive the UI: paste the
    // fixture, disable PII redaction (auto-disables the LLM via the
    // existing onChange handler), submit.
    await page.goto(`${baseURL}/check`, { waitUntil: "networkidle" });

    const textarea = page.locator("textarea").first();
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    await textarea.fill(T4_12_FIXTURE);

    const skipRedactionToggle = page.getByTestId("toggle-skip-redaction");
    await expect(skipRedactionToggle).toBeVisible({ timeout: 10_000 });
    await skipRedactionToggle.check();
    await expect(skipRedactionToggle).toBeChecked();
    await expect(page.getByTestId("toggle-skip-llm")).toBeChecked();

    await page.getByRole("button", { name: /Check Report/i }).click();

    await expect(
      page.getByRole("heading", { name: /Check Results/i }),
    ).toBeVisible({ timeout: 30_000 });

    const markerList = page.getByTestId(MARKER_LIST_TESTID);
    await expect(markerList).toBeVisible({ timeout: 15_000 });
    await expect(markerList).toHaveCount(1);

    const bullets = markerList.locator("li");
    await expect(bullets).toHaveCount(EXPECTED_MARKERS.length);

    for (const marker of EXPECTED_MARKERS) {
      const bullet = markerList.locator("li", {
        has: page.locator(`text=(${marker.id})`),
      });
      await expect(
        bullet,
        `bullet for marker ${marker.id} should render`,
      ).toHaveCount(1);
      await expect(bullet).toContainText(marker.label);
    }
  });
});
