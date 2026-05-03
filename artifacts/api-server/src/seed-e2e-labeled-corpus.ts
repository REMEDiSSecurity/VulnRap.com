// Task #458 — Seed enough labeled production reports so the Task #325 e2e
// (`artifacts/vulnrap/e2e/handwavy-production-scan-limit-honored.spec.ts`)
// catches regressions on a fresh DB.
//
// The spec's load-bearing assertion is:
//   dryRunMatchesProduction.corpusSize <= productionScanLimit (=100)
// AND when the same scan widened to 10000 returns more than 100 rows, the
// small probe must hit exactly 100 (i.e. the cap is binding). On a fresh
// CI DB with only the 6 hand-written rows from `seed.ts` the corpus is
// always <= 100, so the cap is non-binding and the regression check is
// vacuous. We need >= 101 rows where `vulnrap_composite_label` IS NOT NULL
// AND `content_text` IS NOT NULL to make the strict-increase branch fire.
//
// Idempotency: rows are tagged via `file_name LIKE 'e2e-labeled-corpus-%'`
// so reruns short-circuit when the target count is already met. This makes
// the seed safe to call from the Playwright globalSetup on every run
// (including watchdog reruns against a long-lived dev DB).
//
// Cost: a single bulk INSERT of ~150 rows with minimal payloads — well
// under the per-statement parameter ceiling and effectively instant
// (sub-100ms locally) so it fits inside the e2e suite's wall-clock budget.
//
// Sentinel-safety: the synthetic `content_text` deliberately AVOIDS the
// strings `task325 sentinel` and `unmatchable` that the spec uses as its
// guaranteed-no-match probe (see `sentinelPhrase()` in the spec). If the
// seed ever started writing rows that contained those tokens, the spec's
// `total === 0` and `byTier` all-zero checks would flip and the spec
// would start failing for the wrong reason.

import { db, reportsTable } from "@workspace/db";
import { like, sql } from "drizzle-orm";

const DEFAULT_TARGET_COUNT = 150;
export const E2E_LABELED_CORPUS_FILENAME_PREFIX = "e2e-labeled-corpus-";

// Cycled across rows so the corpus has a representative spread of the
// labels `productionLabelToTier` understands (all 6 buckets, balanced).
// All values must be members of that switch — anything else gets dropped
// at scoring time and the row would not count toward `corpusSize`.
const LABELS = [
  "STRONG",
  "PROMISING",
  "REASONABLE",
  "NEEDS REVIEW",
  "LIKELY INVALID",
  "HIGH RISK",
] as const;

function buildContentText(idx: number, label: string): string {
  // Plain ASCII, no markdown structure, no production phrases that the
  // hand-wavy phrase list could match. Keeping each row's text distinct
  // (via the index) means no LSH/simhash collision warnings appear in
  // logs even though we don't compute real hashes for the seed rows.
  return (
    `Labeled corpus fixture ${idx} (${label}). ` +
    `Synthetic security report seeded for the production-scan window e2e test. ` +
    `Describes a routine input-validation issue in the example service handler. ` +
    `Row index ${idx} keeps each entry's text distinct from its siblings.`
  );
}

interface SeedResult {
  /** Rows already tagged with the e2e-labeled-corpus marker before this run. */
  existing: number;
  /** Rows this run inserted. Zero on the idempotent fast path. */
  inserted: number;
  /** Total marker-tagged rows after this run; equals max(existing, target). */
  total: number;
}

/**
 * Bulk-seed (or top up) the e2e-labeled-corpus marker rows. Idempotent: if
 * `target` rows already exist, returns immediately without touching the DB.
 */
export async function seedE2eLabeledCorpus(
  target: number = DEFAULT_TARGET_COUNT,
): Promise<SeedResult> {
  const [{ count: existing = 0 } = { count: 0 }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reportsTable)
    .where(
      like(reportsTable.fileName, `${E2E_LABELED_CORPUS_FILENAME_PREFIX}%`),
    );

  if (existing >= target) {
    return { existing, inserted: 0, total: existing };
  }

  const toInsert = target - existing;
  // Stagger created_at by 1ms per row so the production scan's
  // `ORDER BY created_at DESC LIMIT N` returns a deterministic slice
  // (newest seeded rows first). Anchoring on a fixed `now` rather than
  // re-reading the clock per row guarantees all newly inserted rows
  // sort strictly after the existing 6 hand-seeded rows from seed.ts
  // (whose timestamps are days/weeks older), which is what the spec
  // assumes when it expects the small (limit=100) probe to be bound
  // by the cap rather than by archive size.
  const nowMs = Date.now();

  const rows = Array.from({ length: toInsert }, (_, i) => {
    const idx = existing + i;
    const label = LABELS[idx % LABELS.length]!;
    const content = buildContentText(idx, label);
    return {
      // Required NOT NULL columns without defaults — values are placeholders
      // (uniqueness/format are not enforced; the production-scan path only
      // reads label, content_text, created_at).
      contentHash: `e2e-labeled-${idx}`,
      simhash: "0",
      minhashSignature: [] as number[],
      // Required NOT NULL columns with relevant payload for the test.
      contentText: content,
      vulnrapCompositeLabel: label,
      // Marker for idempotency — also doubles as a "do not surface in the
      // public feed" hint (showInFeed defaults to false anyway).
      fileName: `${E2E_LABELED_CORPUS_FILENAME_PREFIX}${idx
        .toString()
        .padStart(4, "0")}.md`,
      fileSize: Buffer.byteLength(content, "utf-8"),
      createdAt: new Date(nowMs + i),
    };
  });

  // Single bulk insert — drizzle batches into one INSERT ... VALUES (...),(...)
  // statement. ~150 rows × ~9 bound parameters each is well under PG's
  // ~32k parameter ceiling.
  await db.insert(reportsTable).values(rows);

  return { existing, inserted: toInsert, total: target };
}

// CLI entry: `node dist/seed-e2e-labeled-corpus.mjs` (built only when
// added to esbuild entryPoints) or `tsx src/seed-e2e-labeled-corpus.ts`.
// The test harness imports `seedE2eLabeledCorpus` directly; this branch is
// for ad-hoc operator runs.
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  typeof process.argv[1] === "string" &&
  /seed-e2e-labeled-corpus(\.[mc]?[jt]s)?$/.test(process.argv[1]);

if (invokedDirectly) {
  seedE2eLabeledCorpus()
    .then((r) => {
      console.log(
        `[seed-e2e-labeled-corpus] existing=${r.existing} inserted=${r.inserted} total=${r.total}`,
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error("[seed-e2e-labeled-corpus] failed:", err);
      process.exit(1);
    });
}
