import {
  test,
  expect,
  request,
  type APIRequestContext,
} from "@playwright/test";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Notification entries normally arrive via the webhook dispatcher, so the
// spec seeds them by writing the dedup state JSON file directly. The
// api-server reads the file on every request, so a fresh write before
// page.goto() is picked up immediately; the file is restored in afterEach.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEDUP_STATE_PATH = path.resolve(
  REPO_ROOT,
  "artifacts/api-server/data/avri-drift-notifications.json",
);

const API_PORT = Number(process.env.E2E_API_PORT || 8080);
const API_BASE = process.env.E2E_API_BASE || `http://127.0.0.1:${API_PORT}`;
const CALIBRATION_TOKEN =
  process.env.E2E_CALIBRATION_TOKEN || "e2e-calibration-token";

interface SeedRecord {
  key: string;
  weekStart: string;
  kind: "GAP_BELOW_45" | "FAMILY_MEAN_SHIFT";
  detail: string;
  notifiedAt: string;
}

const SEEDED_RECORDS: SeedRecord[] = [
  {
    key: "bulk-rearm-spec-2026-04-20|GAP_BELOW_45",
    weekStart: "2026-04-20",
    kind: "GAP_BELOW_45",
    detail: "T1/T3 gap collapsed to 3.8 (threshold 4.5)",
    notifiedAt: "2026-04-22T10:00:00.000Z",
  },
  {
    key: "bulk-rearm-spec-2026-04-20|FAMILY_MEAN_SHIFT|T1|INJECTION",
    weekStart: "2026-04-20",
    kind: "FAMILY_MEAN_SHIFT",
    detail: "T1 family INJECTION mean shifted by +0.7 vs prior week",
    notifiedAt: "2026-04-22T10:01:00.000Z",
  },
  {
    key: "bulk-rearm-spec-2026-04-20|FAMILY_MEAN_SHIFT|T3|MEMORY_CORRUPTION",
    weekStart: "2026-04-20",
    kind: "FAMILY_MEAN_SHIFT",
    detail: "T3 family MEMORY_CORRUPTION mean shifted by -0.6 vs prior week",
    notifiedAt: "2026-04-22T10:02:00.000Z",
  },
  {
    key: "bulk-rearm-spec-2026-04-13|FAMILY_MEAN_SHIFT|T1|XSS",
    weekStart: "2026-04-13",
    kind: "FAMILY_MEAN_SHIFT",
    detail: "T1 family XSS mean shifted by +0.5 vs prior week",
    notifiedAt: "2026-04-15T09:00:00.000Z",
  },
];

function newApiContext(): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { "X-Calibration-Token": CALIBRATION_TOKEN },
  });
}

let backup: string | null = null;
let backupExisted = false;

function seedDedupState(records: SeedRecord[]): void {
  writeFileSync(
    DEDUP_STATE_PATH,
    JSON.stringify({ notified: records }, null, 2) + "\n",
    "utf8",
  );
}

test.describe("Notified flags panel — bulk re-arm", () => {
  test.beforeEach(() => {
    if (existsSync(DEDUP_STATE_PATH)) {
      backup = readFileSync(DEDUP_STATE_PATH, "utf8");
      backupExisted = true;
    } else {
      backup = null;
      backupExisted = false;
    }
    seedDedupState(SEEDED_RECORDS);
  });

  test.afterEach(() => {
    if (backupExisted && backup !== null) {
      writeFileSync(DEDUP_STATE_PATH, backup, "utf8");
    } else {
      writeFileSync(
        DEDUP_STATE_PATH,
        JSON.stringify({ notified: [] }, null, 2) + "\n",
        "utf8",
      );
    }
    backup = null;
    backupExisted = false;
  });

  test("bulk-selecting multiple notified flags re-arms them in a single API call", async ({
    page,
  }) => {
    const rearmRequests: Array<{ keys: string[] }> = [];
    page.on("request", (req) => {
      if (
        req.method() === "POST" &&
        req.url().includes(
          "/api/feedback/calibration/avri-drift/notifications/rearm",
        )
      ) {
        const body = req.postDataJSON?.();
        if (body && Array.isArray(body.keys)) {
          rearmRequests.push({ keys: body.keys as string[] });
        }
      }
    });

    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    const checkboxes = SEEDED_RECORDS.map((r) =>
      page.getByTestId(`notified-flag-checkbox-${r.key}`),
    );
    for (const cb of checkboxes) {
      await expect(cb).toBeVisible({ timeout: 15_000 });
      await expect(cb).not.toBeChecked();
    }

    const bulkBar = page.getByTestId("notified-flags-bulk-bar");
    const bulkRearm = page.getByTestId("notified-flags-bulk-rearm");
    const bulkClear = page.getByTestId("notified-flags-bulk-clear");

    await expect(bulkBar).toHaveCount(0);

    await checkboxes[0]!.check();
    await expect(bulkBar).toBeVisible();
    await expect(bulkBar).toContainText("1 selected");
    await expect(bulkRearm).toBeVisible();
    await expect(bulkRearm).toBeEnabled();
    await expect(bulkRearm).toHaveText(/Re-arm selected \(1\)/);

    await checkboxes[1]!.check();
    await expect(bulkBar).toContainText("2 selected");
    await expect(bulkRearm).toHaveText(/Re-arm selected \(2\)/);

    await bulkClear.click();
    await expect(bulkBar).toHaveCount(0);
    for (const cb of checkboxes) {
      await expect(cb).not.toBeChecked();
    }
    expect(rearmRequests).toHaveLength(0);

    const keysToRearm = [
      SEEDED_RECORDS[0]!.key,
      SEEDED_RECORDS[1]!.key,
      SEEDED_RECORDS[2]!.key,
    ];
    await checkboxes[0]!.check();
    await checkboxes[1]!.check();
    await checkboxes[2]!.check();
    await expect(bulkRearm).toHaveText(/Re-arm selected \(3\)/);

    await bulkRearm.click();

    // The whole point of the affordance: one batched POST, not N per-row POSTs.
    await expect.poll(() => rearmRequests.length).toBe(1);
    expect(rearmRequests[0]!.keys.sort()).toEqual([...keysToRearm].sort());

    await expect(
      page.getByText(/Re-armed 3 drift flags/, { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });

    for (const key of keysToRearm) {
      await expect(
        page.getByTestId(`notified-flag-checkbox-${key}`),
      ).toHaveCount(0);
    }
    const survivor = page.getByTestId(
      `notified-flag-checkbox-${SEEDED_RECORDS[3]!.key}`,
    );
    await expect(survivor).toBeVisible();

    await expect(bulkBar).toHaveCount(0);

    // Confirm the dedup file was actually mutated, not just the React state.
    const apiCtx = await newApiContext();
    try {
      const resp = await apiCtx.get(
        "/api/feedback/calibration/avri-drift/notifications",
      );
      expect(resp.ok()).toBeTruthy();
      const body = (await resp.json()) as {
        notified: Array<{ key: string }>;
      };
      expect(body.notified.map((n) => n.key)).toEqual([
        SEEDED_RECORDS[3]!.key,
      ]);
    } finally {
      await apiCtx.dispose();
    }

    // Per-row re-arm must still work.
    await survivor.scrollIntoViewIfNeeded();
    const survivorRow = page
      .locator("li", { has: survivor })
      .first();
    const perRowRearm = survivorRow.getByRole("button", { name: /Re-arm/ });
    await expect(perRowRearm).toBeVisible();
    await perRowRearm.click();

    await expect(survivor).toHaveCount(0, { timeout: 10_000 });
    await expect(
      page.getByText(
        /No previously-notified flags are currently being suppressed/,
      ),
    ).toBeVisible();
  });

  test("master checkbox ticks every visible row, shows indeterminate, and feeds the bulk bar", async ({
    page,
  }) => {
    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    const masterCheckbox = page.getByTestId("notified-flags-select-all");
    const selectAllRow = page.getByTestId("notified-flags-select-all-row");
    const bulkBar = page.getByTestId("notified-flags-bulk-bar");
    const bulkRearm = page.getByTestId("notified-flags-bulk-rearm");
    const checkboxes = SEEDED_RECORDS.map((r) =>
      page.getByTestId(`notified-flag-checkbox-${r.key}`),
    );

    await expect(masterCheckbox).toBeVisible({ timeout: 15_000 });
    for (const cb of checkboxes) {
      await expect(cb).toBeVisible();
      await expect(cb).not.toBeChecked();
    }
    await expect(masterCheckbox).not.toBeChecked();
    // Empty state — no rows selected, so indeterminate is false.
    expect(
      await masterCheckbox.evaluate(
        (el) => (el as HTMLInputElement).indeterminate,
      ),
    ).toBe(false);
    await expect(selectAllRow).toContainText(
      `Select all ${SEEDED_RECORDS.length} notified flags`,
    );
    await expect(bulkBar).toHaveCount(0);

    // Tick a single row → master checkbox should flip to indeterminate.
    await checkboxes[0]!.check();
    await expect(masterCheckbox).not.toBeChecked();
    expect(
      await masterCheckbox.evaluate(
        (el) => (el as HTMLInputElement).indeterminate,
      ),
    ).toBe(true);
    await expect(masterCheckbox).toHaveAttribute("aria-checked", "mixed");
    await expect(bulkBar).toContainText("1 selected");
    await expect(bulkRearm).toHaveText(/Re-arm selected \(1\)/);

    // Click the master checkbox → ticks every visible row, count + button update.
    await masterCheckbox.click();
    await expect(masterCheckbox).toBeChecked();
    expect(
      await masterCheckbox.evaluate(
        (el) => (el as HTMLInputElement).indeterminate,
      ),
    ).toBe(false);
    await expect(masterCheckbox).toHaveAttribute("aria-checked", "true");
    for (const cb of checkboxes) {
      await expect(cb).toBeChecked();
    }
    await expect(bulkBar).toContainText(`${SEEDED_RECORDS.length} selected`);
    await expect(bulkRearm).toHaveText(
      new RegExp(`Re-arm selected \\(${SEEDED_RECORDS.length}\\)`),
    );
    await expect(selectAllRow).toContainText(
      `${SEEDED_RECORDS.length} of ${SEEDED_RECORDS.length} selected`,
    );

    // Click again → clears the selection, bulk bar disappears.
    await masterCheckbox.click();
    await expect(masterCheckbox).not.toBeChecked();
    expect(
      await masterCheckbox.evaluate(
        (el) => (el as HTMLInputElement).indeterminate,
      ),
    ).toBe(false);
    for (const cb of checkboxes) {
      await expect(cb).not.toBeChecked();
    }
    await expect(bulkBar).toHaveCount(0);
  });

  test("toast surfaces partial-success counts when some selected keys are already gone", async ({
    page,
  }) => {
    seedDedupState([SEEDED_RECORDS[0]!, SEEDED_RECORDS[1]!]);

    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    const cb0 = page.getByTestId(
      `notified-flag-checkbox-${SEEDED_RECORDS[0]!.key}`,
    );
    const cb1 = page.getByTestId(
      `notified-flag-checkbox-${SEEDED_RECORDS[1]!.key}`,
    );
    await expect(cb0).toBeVisible({ timeout: 15_000 });
    await expect(cb1).toBeVisible();

    await cb0.check();
    await cb1.check();

    // Drop one entry server-side between tick and click, simulating a
    // teammate clearing it concurrently. The api-server reads the file
    // on every POST, so the next bulk re-arm sees only one live key.
    seedDedupState([SEEDED_RECORDS[1]!]);

    await page.getByTestId("notified-flags-bulk-rearm").click();

    // The toast viewport renders text twice (visual + aria-live status),
    // hence .first() rather than the default strict locator.
    await expect(
      page.getByText(/1 re-armed/, { exact: false }).first(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByText(/1 already gone/, { exact: false }).first(),
    ).toBeVisible();
  });
});
