import { test, expect, type Page } from "@playwright/test";

// Task #402 — persistent UI coverage for the Task #288
// "History file: <size> · <count> snapshot(s)" line on the calibration
// dashboard's Emerging Slop Archetypes section.
//
// The api-server's /api/test/* surface 404s when NODE_ENV=production
// (see the production gates in artifacts/api-server/src/routes/test-fixtures.ts),
// and the playwright-managed api-server runs with NODE_ENV=production to
// mirror the deployed env. EmergingArchetypesSection therefore hides
// itself in this harness against the real backend. To exercise the
// historyFile line without flipping the api-server out of production
// mode (which would change behaviour for every other spec the worker
// shares its api-server with), we use page.route() to fulfill just the
// three /api/test/* endpoints the section consumes with stable mocked
// payloads. Backend behaviour for the historyFile block is already
// covered by archetype-history.test.ts and test-fixtures.route.test.ts;
// this spec specifically guards the UI rendering path against renames
// (e.g. `historyFile` -> `archetypeHistoryFile`) or CSS regressions
// that hide the line.

const CONFIG_URL_FRAGMENT = "/api/test/archetype-history/config";

test.describe("EmergingArchetypesSection — History file size indicator (Task #288)", () => {
  // Re-used across both branches. /api/test/run needs to return at
  // least one fixture row so the section actually renders (the early
  // return triggers when archetypes is empty), and /api/test/archetype-history
  // needs to return a stable empty payload so the sparklines don't
  // throw — neither matters to the assertion, but both must succeed
  // for the section to mount.
  async function mockSupportingEndpoints(page: Page) {
    await page.route("**/api/test/run", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          archetypes: [
            {
              archetype: "task402-fixture-archetype",
              count: 1,
              avriOnMean: 60,
              avriOnMax: 60,
              minDistanceToCeiling: 25,
              ceiling: 35,
              fixtures: [
                {
                  id: "task402-fixture",
                  tier: "T2_BORDERLINE",
                  composite: 60,
                  avriOnScore: 60,
                  avriOffScore: 55,
                  distanceToCeiling: 25,
                  triage: "review",
                  passed: true,
                },
              ],
            },
          ],
        }),
      });
    });

    await page.route("**/api/test/archetype-history", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ totalSnapshots: 0, archetypes: [] }),
      });
    });
  }

  // Resolve a locator scoped to the EmergingArchetypesSection card so a
  // future "History file: ..." string surfacing elsewhere on the page
  // can't accidentally satisfy this spec. The card is the unique
  // .glass-card whose header carries the "Emerging Slop Archetypes"
  // CardTitle (see feedback-analytics.tsx, EmergingArchetypesSection).
  function emergingArchetypesSection(page: Page) {
    return page
      .locator(".glass-card")
      .filter({ hasText: "Emerging Slop Archetypes" });
  }

  test("renders History file line with formatted size and plural snapshot count", async ({
    page,
  }) => {
    await mockSupportingEndpoints(page);

    // 124 * 1024 = 126_976 bytes -> formatBytes returns "124.0 KB"
    // (bytes >= 1024 takes the KB branch with toFixed(1)). 487 > 1
    // picks the plural "snapshots" branch of the JSX ternary.
    const SIZE_BYTES = 124 * 1024;
    const SNAPSHOT_COUNT = 487;

    await page.route("**/api/test/archetype-history/config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          effectiveDays: 30,
          source: "default",
          envOverride: null,
          persistedDays: null,
          defaultDays: 30,
          min: 7,
          max: 365,
          // The Task #288 block under test.
          historyFile: {
            sizeBytes: SIZE_BYTES,
            snapshotCount: SNAPSHOT_COUNT,
          },
        }),
      });
    });

    // Bind the response wait BEFORE navigation so a fast roundtrip
    // can't fire-and-resolve before we start listening. The "Done
    // looks like" criterion explicitly calls out waiting for
    // /api/test/archetype-history/config; awaiting the response
    // (rather than the rendered text) gives a clearer failure mode
    // when the endpoint or the browser-side query never fires.
    const configResponse = page.waitForResponse(
      (r) =>
        r.url().includes(CONFIG_URL_FRAGMENT) && r.request().method() === "GET",
    );
    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
    await configResponse;

    // Anchor selector that proves the section itself mounted (rather
    // than failing because the section unmounted under us). The
    // compaction-window input is the same anchor the Task #211 spec
    // uses, so a regression that drops the entire section header
    // fails consistently across both specs.
    const section = emergingArchetypesSection(page);
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.getByLabel("Compaction window in days")).toBeVisible({
      timeout: 15_000,
    });

    // The JSX hangs the raw bytes count on the span's `title`
    // attribute (so reviewers can hover for the exact byte count when
    // the formatted size has been rounded); anchoring on the title
    // also disambiguates this span from any ancestor that happens to
    // contain the same visible text. Scoping under `section` further
    // narrows the match to the EmergingArchetypesSection card so a
    // History-file-style line surfacing elsewhere on the page can't
    // satisfy the assertion.
    const historyFileLine = section.locator(
      `span[title="${SIZE_BYTES} bytes on disk"]`,
    );
    await expect(historyFileLine).toBeVisible({ timeout: 15_000 });

    // Assert the whole "History file: <size> · <count> snapshot(s)"
    // shape so a regression that drops the middle-dot separator or
    // the trailing "snapshot(s)" word during a refactor fails the
    // spec. The size-unit family (B|KB|MB|GB|TB) is asserted as a
    // family rather than the specific "124.0 KB" so a tweak to the
    // formatter's toFixed precision doesn't flake.
    await expect(historyFileLine).toHaveText(
      /^History file: [\d.]+ (B|KB|MB|GB|TB) · \d+ snapshots?$/,
    );

    // Numeric snapshot count + plural "snapshots" word
    // (SNAPSHOT_COUNT > 1).
    await expect(historyFileLine).toContainText(String(SNAPSHOT_COUNT));
    await expect(historyFileLine).toContainText("snapshots");
  });

  test("renders History file line with singular snapshot when count is 1", async ({
    page,
  }) => {
    await mockSupportingEndpoints(page);

    // Sub-1 KiB so the formatter takes the "B" branch — also exercises
    // the "no decimal" path (Math.round) alongside the singular fork.
    const SIZE_BYTES = 612;
    const SNAPSHOT_COUNT = 1;

    await page.route("**/api/test/archetype-history/config", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          effectiveDays: 30,
          source: "default",
          envOverride: null,
          persistedDays: null,
          defaultDays: 30,
          min: 7,
          max: 365,
          historyFile: {
            sizeBytes: SIZE_BYTES,
            snapshotCount: SNAPSHOT_COUNT,
          },
        }),
      });
    });

    const configResponse = page.waitForResponse(
      (r) =>
        r.url().includes(CONFIG_URL_FRAGMENT) && r.request().method() === "GET",
    );
    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });
    await configResponse;

    const section = emergingArchetypesSection(page);
    await expect(section).toBeVisible({ timeout: 15_000 });
    await expect(section.getByLabel("Compaction window in days")).toBeVisible({
      timeout: 15_000,
    });

    const historyFileLine = section.locator(
      `span[title="${SIZE_BYTES} bytes on disk"]`,
    );
    await expect(historyFileLine).toBeVisible({ timeout: 15_000 });

    // The singular branch must NOT pluralize. We assert the exact
    // suffix "1 snapshot" (with no trailing "s") so a regression
    // that always-pluralizes the word fails this test even though
    // it would silently pass the count == 487 case above.
    await expect(historyFileLine).toHaveText(
      /^History file: [\d.]+ (B|KB|MB|GB|TB) · 1 snapshot$/,
    );
  });
});
