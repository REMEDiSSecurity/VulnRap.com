import { test, expect } from "@playwright/test";

// Task #511 — UI smoke test for the Task #358 slice-rotation indicators
// on the Curated Dataset Cohort Drift card.
//
// `summarizeDatasetHistory` already has unit coverage for the data
// shaping (counting adjacent points whose `sampleDateKey` differs and
// surfacing the latest slice key), but nothing exercises the rendered
// SVG end-to-end against a seeded dataset-history payload. A future
// refactor that drops the rotation tick path or stops threading
// `sampleDateKey` through the React component would slip through
// silently — the unit tests would still pass, and the panel would
// quietly stop drawing the dashed ticks + header chip that reviewers
// rely on to tell daily-slice flips apart from real model drift.
//
// This spec stubs `/api/test/dataset-history` with a payload that
// contains a different number of cross-day rotations for every cohort
// tier and asserts:
//   1. The card header renders the `dataset-cohort-drift-latest-slice`
//      chip with the latest UTC slice key.
//   2. Each per-tier sparkline renders exactly N dashed
//      `dataset-cohort-drift-rotation-marker` ticks for that tier.
//   3. The per-tier rotation chip text reads "N rot" with the right
//      count, anchored on the stable
//      `dataset-cohort-drift-rotations-<tier>` test-id.
//
// Same harness pattern as last-compacted-indicator.spec.ts and
// recent-rollups-list.spec.ts: the api-server's `/api/test/*` surface
// 404s under NODE_ENV=production (which the playwright webServer runs
// against, mirroring the deployed env), so we mock the endpoint with
// page.route() rather than flipping the shared api-server out of
// production mode.

interface SeededSnapshot {
  timestamp: string;
  tier: string;
  label: string;
  count: number;
  compositeMean: number;
  gap: number;
  sampleDateKey: string;
}

// Per-tier seed: the slice keys each cohort's chronological snapshots
// were drawn from. Picking a distinct rotation count per tier means a
// regression that hard-codes the chip to one value (e.g. always reads
// the gap series, or wires the wrong tier's data into the chip)
// surfaces as a per-tier mismatch rather than a single coincidental
// pass.
const TIER_SEEDS: Record<string, { dates: string[]; rotations: number }> = {
  // 5 snapshots spanning 4 distinct UTC days → 3 adjacent rotations
  // (20→21, 21→22, 22→23). Two consecutive snapshots on the same day
  // intentionally do NOT count as a rotation, exercising the "key
  // differs" branch of summarizeDatasetHistory.
  T1_LEGIT: {
    dates: [
      "2026-04-20",
      "2026-04-21",
      "2026-04-22",
      "2026-04-22",
      "2026-04-23",
    ],
    rotations: 3,
  },
  // 3 snapshots spanning 3 distinct UTC days → 2 adjacent rotations.
  T2_BORDERLINE: {
    dates: ["2026-04-21", "2026-04-22", "2026-04-23"],
    rotations: 2,
  },
  // 2 snapshots spanning 2 distinct UTC days → exactly 1 rotation.
  T3_SLOP: {
    dates: ["2026-04-22", "2026-04-23"],
    rotations: 1,
  },
};

// Latest slice key across every cohort — the badge in the card header
// must echo this exact string after the "slice " prefix.
const LATEST_SLICE = "2026-04-23";

function buildHistoryPayload() {
  const cohorts = Object.entries(TIER_SEEDS).map(([tier, { dates }]) => {
    const snapshots: SeededSnapshot[] = dates.map((dateKey, idx) => ({
      // Encode (tier, position) into the timestamp so each row is
      // unique across cohorts as well as within them. The gap series
      // is deduped by timestamp inside summarizeDatasetHistory; using
      // unique-per-row timestamps keeps that dedupe from collapsing
      // points and skewing the rendered counts under test.
      timestamp: `${dateKey}T${String(8 + idx).padStart(2, "0")}:00:00.000Z`,
      tier,
      // The label only needs to be plausible — the panel doesn't read
      // it for any of the assertions below.
      label: tier === "T3_SLOP" ? "ai_generic" : "human_authentic",
      count: 25,
      // Spread the means so the sparkline span is non-zero (avoids the
      // "no history" / "1 snapshot" early-returns in
      // DatasetHistoryMeanSparkline).
      compositeMean:
        60 + idx + (tier === "T1_LEGIT" ? 10 : tier === "T3_SLOP" ? -10 : 0),
      gap: 18 + idx,
      sampleDateKey: dateKey,
    }));
    return { tier, snapshots };
  });
  const totalSnapshots = cohorts.reduce((n, c) => n + c.snapshots.length, 0);
  return { totalSnapshots, cohorts };
}

test.describe("DatasetCohortDriftSection — slice-rotation marker (Task #358)", () => {
  test("per-tier sparklines render rotation ticks + header chip when sampleDateKey flips", async ({
    page,
  }) => {
    const payload = buildHistoryPayload();

    // Stub the dataset-history endpoint with the seeded cross-day
    // rotations. Both `DatasetCohortMeansSection` and
    // `DatasetCohortDriftSection` query the same key
    // (DATASET_HISTORY_QUERY_KEY), so react-query dedupes the fetch
    // and a single route handler covers both panels.
    await page.route("**/api/test/dataset-history", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(payload),
      });
    });

    await page.goto("/feedback-analytics", { waitUntil: "networkidle" });

    const section = page.getByTestId("dataset-cohort-drift-section");
    await expect(section).toBeVisible({ timeout: 15_000 });

    // The Task #358 "slice YYYY-MM-DD" badge in the card header. Its
    // text is derived from the most recent snapshot that carries a
    // sampleDateKey — asserting the exact string proves both that the
    // chip is wired up and that summarizeDatasetHistory selected the
    // right key (a stale latest-slice would render the wrong date).
    const sliceChip = section.getByTestId("dataset-cohort-drift-latest-slice");
    await expect(sliceChip).toBeVisible();
    await expect(sliceChip).toHaveText(`slice ${LATEST_SLICE}`);

    // Per-tier assertions — for each cohort, the sparkline should
    // render exactly `rotations` vertical dashed ticks AND the
    // rotation chip should read "N rot" for that count. Scoping each
    // assertion to the per-tier card test-id is what catches a
    // regression that, say, always renders the gap-series count: the
    // test-id `dataset-cohort-drift-rotations-<tier>` is unique per
    // tier so the count and the tier are checked in lock-step.
    for (const [tier, { rotations }] of Object.entries(TIER_SEEDS)) {
      const tierCard = section.getByTestId(`dataset-cohort-drift-tier-${tier}`);
      await expect(tierCard).toBeVisible();

      // Vertical dashed ticks rendered inside the per-tier sparkline
      // SVG. One per cross-day adjacent pair.
      const markers = tierCard.locator(
        '[data-testid="dataset-cohort-drift-rotation-marker"]',
      );
      await expect(markers).toHaveCount(rotations);

      // Header chip text — JSX renders "· {count} rot". Using
      // toContainText instead of toHaveText keeps the assertion
      // robust against future whitespace tweaks while still failing
      // hard if the count is wrong or the literal "rot" word
      // disappears.
      const rotChip = tierCard.getByTestId(
        `dataset-cohort-drift-rotations-${tier}`,
      );
      await expect(rotChip).toBeVisible();
      await expect(rotChip).toContainText(`${rotations} rot`);
    }
  });
});
