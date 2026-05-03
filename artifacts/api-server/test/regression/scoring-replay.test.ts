// Task #641 — Pre-merge scoring gate: replay last 100 production reports
// through the *current* scoring code and assert that the tier-flip rate
// against the persisted `slopTier` stays at or below 0.5%.
//
// Activation: only runs when SCORING_GATE_REPLAY=1 is set in the env so a
// developer running `vitest` locally on a feature branch does not stall
// on a 100-report DB query. The post-merge.sh hook (and the
// `scripts/scoring-gate.sh` wrapper) sets the flag explicitly.
//
// DB-less behavior: when DATABASE_URL is unset (e.g. fresh clone, CI
// machine without a provisioned db) the suite logs the reason and
// passes vacuously. The whole point of the gate is to catch silent
// regressions in real prod data; if there is no real prod data to
// replay against, the only honest outcome is "skip", not "fail".
//
// Threshold: 0.5% means at most 0 flips out of 100 reports. We compute
// the rate with `(flips / total) > 0.005` so a future increase to e.g.
// 1000 reports automatically loosens the gate proportionally without
// us having to redo the math.

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { analyzeLinguistic } from "../../src/lib/linguistic-analysis.js";
import { analyzeFactual } from "../../src/lib/factual-verification.js";
import { analyzeSloppiness } from "../../src/lib/sloppiness.js";
import { fuseScores, getSlopTier } from "../../src/lib/score-fusion.js";

// NOTE: `@workspace/db` throws at module load when DATABASE_URL is
// unset (see lib/db/src/index.ts). To make the "DB-less vacuous skip"
// claim below actually hold, we lazy-import it from inside the test
// body, AFTER the env gates. A static `import { db } from
// "@workspace/db"` would crash this file before vitest could even
// collect the suite, turning the intended graceful skip into a hard
// fail every time someone runs the gate without a configured DB.

const REPLAY_ENABLED = process.env.SCORING_GATE_REPLAY === "1";
const HAS_DB = Boolean(process.env.DATABASE_URL);
const REPLAY_LIMIT = Number(process.env.SCORING_GATE_REPLAY_LIMIT ?? 100);
const FLIP_RATE_THRESHOLD = Number(
  process.env.SCORING_GATE_FLIP_THRESHOLD ?? 0.005,
);

interface StoredRow {
  id: number;
  contentText: string | null;
  redactedText: string | null;
  slopScore: number;
  slopTier: string;
}

interface ReplayDiff {
  id: number;
  storedTier: string;
  recomputedTier: string;
  storedScore: number;
  recomputedScore: number;
  scoreDelta: number;
}

function recomputeTier(text: string): { tier: string; score: number } {
  const linguistic = analyzeLinguistic(text);
  const factual = analyzeFactual(text);
  const heuristic = analyzeSloppiness(text);
  const fusion = fuseScores(
    linguistic,
    factual,
    null,
    heuristic.qualityScore,
    text,
  );
  return {
    tier: fusion.slopTier ?? getSlopTier(fusion.slopScore),
    score: fusion.slopScore,
  };
}

describe("Pre-merge scoring gate: replay last 100 production reports", () => {
  if (!REPLAY_ENABLED) {
    it.skip("skipped (set SCORING_GATE_REPLAY=1 to activate)", () => {});
    return;
  }
  if (!REPLAY_ENABLED || !HAS_DB) {
    it("skipped: DATABASE_URL not set", () => {
      console.warn(
        "[scoring-gate] DATABASE_URL is not set; skipping replay. The gate " +
          "passes vacuously. To exercise the gate, point DATABASE_URL at a " +
          "database that has at least a few reports stored.",
      );
      expect(true).toBe(true);
    });
    return;
  }

  it(`tier-flip rate against last ${REPLAY_LIMIT} reports stays <= ${
    FLIP_RATE_THRESHOLD * 100
  }%`, async () => {
    const { db } = await import("@workspace/db");
    const rows = (await db.execute(
      sql`SELECT id,
                   content_text  AS "contentText",
                   redacted_text AS "redactedText",
                   slop_score    AS "slopScore",
                   slop_tier     AS "slopTier"
            FROM reports
            WHERE COALESCE(content_text, redacted_text) IS NOT NULL
              AND length(COALESCE(content_text, redacted_text)) > 0
            ORDER BY id DESC
            LIMIT ${REPLAY_LIMIT}`,
    )) as unknown as { rows: StoredRow[] } | StoredRow[];

    const reports: StoredRow[] = Array.isArray(rows)
      ? (rows as StoredRow[])
      : (rows.rows ?? []);

    if (reports.length === 0) {
      console.warn(
        "[scoring-gate] No reports with stored text found in DB; " +
          "passing vacuously. Run the analyze pipeline against a few " +
          "fixtures so the gate has signal to compare against.",
      );
      expect(true).toBe(true);
      return;
    }

    const diffs: ReplayDiff[] = [];
    const flips: ReplayDiff[] = [];

    for (const row of reports) {
      const text = (row.contentText ?? row.redactedText ?? "").trim();
      if (!text) continue;
      let recomputed: { tier: string; score: number };
      try {
        recomputed = recomputeTier(text);
      } catch (err) {
        console.error(
          `[scoring-gate] report #${row.id}: scoring threw — ${
            (err as Error).message
          }`,
        );
        throw err;
      }
      const diff: ReplayDiff = {
        id: row.id,
        storedTier: row.slopTier,
        recomputedTier: recomputed.tier,
        storedScore: row.slopScore,
        recomputedScore: recomputed.score,
        scoreDelta: recomputed.score - row.slopScore,
      };
      diffs.push(diff);
      if (diff.storedTier !== diff.recomputedTier) {
        flips.push(diff);
      }
    }

    const total = diffs.length;
    const flipRate = total === 0 ? 0 : flips.length / total;

    console.log(
      `[scoring-gate] replayed ${total} reports — ${flips.length} tier-flip(s), ` +
        `flip rate ${(flipRate * 100).toFixed(2)}% (threshold ${(
          FLIP_RATE_THRESHOLD * 100
        ).toFixed(2)}%)`,
    );

    if (flips.length > 0) {
      console.log("[scoring-gate] Per-fixture tier-flip diff:");
      for (const f of flips) {
        console.log(
          `  #${f.id}: ${f.storedTier} (${f.storedScore}) -> ` +
            `${f.recomputedTier} (${f.recomputedScore}, delta ${
              f.scoreDelta >= 0 ? "+" : ""
            }${f.scoreDelta})`,
        );
      }
    }

    const largeScoreDeltas = diffs
      .filter((d) => Math.abs(d.scoreDelta) >= 5)
      .sort((a, b) => Math.abs(b.scoreDelta) - Math.abs(a.scoreDelta))
      .slice(0, 10);
    if (largeScoreDeltas.length > 0) {
      console.log(
        "[scoring-gate] Top score drift (no tier flip but |delta|>=5):",
      );
      for (const d of largeScoreDeltas) {
        console.log(
          `  #${d.id}: ${d.storedTier} ${d.storedScore} -> ` +
            `${d.recomputedScore} (delta ${
              d.scoreDelta >= 0 ? "+" : ""
            }${d.scoreDelta})`,
        );
      }
    }

    if (flipRate > FLIP_RATE_THRESHOLD) {
      throw new Error(
        `[scoring-gate] FAIL: tier-flip rate ${(flipRate * 100).toFixed(
          2,
        )}% exceeds threshold ${(FLIP_RATE_THRESHOLD * 100).toFixed(
          2,
        )}% (${flips.length}/${total} reports flipped). ` +
          "If this change is an intentional calibration update, re-run " +
          "with SCORING_GATE_BYPASS=1 (see README 'Pre-merge scoring gate').",
      );
    }
    expect(flipRate).toBeLessThanOrEqual(FLIP_RATE_THRESHOLD);
  }, 120_000);
});
