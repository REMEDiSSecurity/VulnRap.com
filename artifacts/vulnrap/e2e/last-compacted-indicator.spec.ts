import { test, expect } from "@playwright/test";

// Task #290 — persistent UI coverage for the Task #211 "Last compacted Xh
// ago — removed N snapshots" line on the calibration dashboard.
//
// The api-server's /api/test/* surface 404s when NODE_ENV=production
// (see the production gates in artifacts/api-server/src/routes/test-fixtures.ts),
// and the playwright-managed api-server runs with NODE_ENV=production to
// mirror the deployed env. EmergingArchetypesSection therefore hides
// itself in this harness against the real backend. To exercise the new
// "Last compacted" line without flipping the api-server out of
// production mode (which would change behaviour for every other spec
// the worker shares its api-server with), we use page.route() to fulfill
// just the three /api/test/* endpoints the section consumes with stable
// mocked payloads. Backend behaviour for the lastCompaction block is
// already covered by archetype-history.test.ts and
// test-fixtures.route.test.ts; this spec specifically guards the UI
// rendering path, which was otherwise verified only by a one-off manual
// e2e check in the Task #211 implementation conversation.

const NINETY_MINUTES_MS = 90 * 60 * 1000;
const REMOVED_COUNT = 14;

test.describe("EmergingArchetypesSection — Last compacted indicator (Task #211)", () => {
  test("renders Last compacted line with relative-time fragment and removed-snapshots count", async ({
    page,
  }) => {
    // 90 minutes ago bins to "2h ago" via formatRelativeAgo's
    // Math.round(minutes/60), with ~30 minutes of slack before the
    // bucket would tick over to "3h ago".
    const compactedAt = new Date(Date.now() - NINETY_MINUTES_MS).toISOString();

    // Minimal but valid TestRunResponse — one fixture row keeps the
    // section visible (the early return triggers when archetypes is
    // empty). All numeric fields the row renderer reads are populated
    // so ArchetypeRowView's toFixed() calls don't throw.
    await page.route("**/api/test/run", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          archetypes: [
            {
              archetype: "task290-fixture-archetype",
              count: 1,
              avriOnMean: 60,
              avriOnMax: 60,
              minDistanceToCeiling: 25,
              ceiling: 35,
              fixtures: [
                {
                  id: "task290-fixture",
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
          // The Task #211 block under test. lastRemovedCount > 1
          // picks the plural "snapshots" branch of the JSX ternary.
          lastCompaction: {
            lastCompactedAt: compactedAt,
            lastRemovedCount: REMOVED_COUNT,
            // Required by CompactionStats; the Task #289 render block
            // reads `recentRuns.length` without an optional chain, so
            // omitting it crashes the page. Empty keeps that block
            // hidden (gated on length >= 2) for this spec.
            recentRuns: [],
          },
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

    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    // Anchor selector the task explicitly calls out as the stable
    // refactor handle. Asserting it visible first surfaces a clearer
    // failure if the row itself was removed during a refactor.
    await expect(page.getByLabel("Compaction window in days")).toBeVisible({
      timeout: 15_000,
    });

    // The JSX hangs the full ISO timestamp on the span's `title`
    // attribute (so reviewers can hover for an exact value when the
    // relative bucket is too coarse); anchoring on the title also
    // disambiguates this span from any ancestor that happens to
    // contain the same visible text.
    const lastCompactedLine = page.locator(
      `span[title="Last compacted at ${compactedAt}"]`,
    );
    await expect(lastCompactedLine).toBeVisible({ timeout: 15_000 });

    // Assert the whole "Last compacted <relative> — removed <N> snapshot(s)"
    // shape so a regression that drops the em-dash separator or the
    // trailing "snapshot(s)" word during a refactor fails the spec.
    await expect(lastCompactedLine).toHaveText(
      /^Last compacted .+ — removed \d+ snapshots?$/,
    );

    // Relative-time fragment: must match one of formatRelativeAgo's
    // bucket strings. Asserted as a family rather than the specific
    // "2h ago" so a tweak to the rounding boundary doesn't flake.
    await expect(lastCompactedLine).toContainText(
      /\b(just now|\d+s ago|\d+m ago|\d+h ago|\d+d ago)\b/,
    );

    // Numeric removed-snapshots count + plural "snapshots" word
    // (REMOVED_COUNT > 1).
    await expect(lastCompactedLine).toContainText(String(REMOVED_COUNT));
    await expect(lastCompactedLine).toContainText("snapshots");
  });
});
