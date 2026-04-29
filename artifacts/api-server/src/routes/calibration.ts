import { Router, type IRouter } from "express";
import { db, reportsTable } from "@workspace/db";
import { and, isNotNull, sql } from "drizzle-orm";
import { generateCalibrationReport, type BucketAnalysis } from "../lib/calibration";
import { getCurrentConfig, getConfigHistory, applyNewConfig } from "../lib/scoring-config";
import { generateAvriDriftReport } from "../lib/avri-drift";
import {
  notifyDriftFlagsIfNew,
  listNotifiedFlags,
  removeNotifiedFlags,
} from "../lib/avri-drift-notifications";
import {
  getHandwavyPhrases,
  getHandwavyPhraseHistory,
  addHandwavyPhrase,
  removeHandwavyPhrase,
  removeHandwavyPhrasesBatch,
  previewRemoveHandwavyPhrasesBatch,
  reinstateHandwavyPhrase,
  reinstateHandwavyPhrasesBatch,
  editHandwavyPhrase,
  undoHandwavyPhrase,
  revertHandwavyPhraseEdit,
  type HandwavyCategory,
  type HandwavyMarker,
} from "../lib/engines/avri/handwavy-phrases";
import { TEST_FIXTURE_COHORTS } from "./test-fixtures";
import {
  requireCalibrationAuth,
  requireCalibrationAuthStrict,
  getCalibrationAuthStatus,
} from "../middlewares/require-calibration-auth";

// Task #114 — preview a candidate FLAT hand-wavy phrase against the curated
// benchmark corpus (the T1–T4 fixture cohorts also used by /api/test/run) so
// reviewers can see, BEFORE persisting, how many GREEN (T1 legit) / YELLOW
// (T2 borderline) reports the phrase would have flagged. Matching mirrors the
// engine path in lib/engines/avri/engine2-avri.ts: lowercase + collapse
// whitespace, then plain substring match.
type CorpusTier = "T1_LEGIT" | "T2_BORDERLINE" | "T3_SLOP" | "T4_HALLUCINATED";

function normalizeForMatch(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

interface DryRunMatches {
  total: number;
  byTier: { t1Legit: number; t2Borderline: number; t3Slop: number; t4Hallucinated: number };
  falsePositives: number;
  corpusSize: number;
  sampleMatches: Array<{ id: string; tier: CorpusTier }>;
  warning: string | null;
  // Task #124 — for production scans, the createdAt range of the scanned
  // sample so reviewers can tell whether the false-positive signal reflects
  // recent reporter behavior or a long-stale archive. ISO-8601 timestamps,
  // or `null` when the scan was empty / not applicable (e.g. the curated
  // benchmark fixtures don't have a wall-clock timestamp).
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
}

function tallyMatches(
  needle: string,
  rows: Iterable<{ id: string; tier: CorpusTier; text: string }>,
): { total: number; byTier: DryRunMatches["byTier"]; sampleMatches: DryRunMatches["sampleMatches"] } {
  const byTier = { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 };
  const sampleMatches: Array<{ id: string; tier: CorpusTier }> = [];
  let total = 0;
  for (const r of rows) {
    const haystack = r.text.toLowerCase().replace(/\s+/g, " ");
    if (!needle || !haystack.includes(needle)) continue;
    total += 1;
    if (r.tier === "T1_LEGIT") byTier.t1Legit += 1;
    else if (r.tier === "T2_BORDERLINE") byTier.t2Borderline += 1;
    else if (r.tier === "T3_SLOP") byTier.t3Slop += 1;
    else byTier.t4Hallucinated += 1;
    if (sampleMatches.length < 12) sampleMatches.push({ id: r.id, tier: r.tier });
  }
  return { total, byTier, sampleMatches };
}

function previewHandwavyPhrase(phrase: string): DryRunMatches {
  const needle = normalizeForMatch(phrase);
  const cohorts: Array<{ tier: CorpusTier; fixtures: typeof TEST_FIXTURE_COHORTS.T1 }> = [
    { tier: "T1_LEGIT", fixtures: TEST_FIXTURE_COHORTS.T1 },
    { tier: "T2_BORDERLINE", fixtures: TEST_FIXTURE_COHORTS.T2 },
    { tier: "T3_SLOP", fixtures: TEST_FIXTURE_COHORTS.T3 },
    { tier: "T4_HALLUCINATED", fixtures: TEST_FIXTURE_COHORTS.T4 },
  ];
  let corpusSize = 0;
  const flat: Array<{ id: string; tier: CorpusTier; text: string }> = [];
  for (const { tier, fixtures } of cohorts) {
    corpusSize += fixtures.length;
    for (const f of fixtures) flat.push({ id: f.id, tier, text: f.text });
  }
  const { total, byTier, sampleMatches } = tallyMatches(needle, flat);
  const falsePositives = byTier.t1Legit + byTier.t2Borderline;
  let warning: string | null = null;
  if (falsePositives > 0) {
    const noun = falsePositives === 1 ? "legitimate report" : "legitimate reports";
    warning = `This phrase would have flagged ${falsePositives} ${noun} (${byTier.t1Legit} GREEN, ${byTier.t2Borderline} YELLOW) in the curated benchmark corpus — consider rewording.`;
  }
  // Curated fixtures have no wall-clock timestamp — Task #124's date-range
  // fields are production-only.
  return {
    total,
    byTier,
    falsePositives,
    corpusSize,
    sampleMatches,
    warning,
    oldestCreatedAt: null,
    newestCreatedAt: null,
  };
}

// Task #119 — Map a persisted vulnrap composite label to the same T1–T4 tier
// shape the curated corpus uses, so production reports can be scored with the
// identical match-counting pipeline. The mapping mirrors `bucketForLabel` in
// lib/avri-drift.ts but extends NEUTRAL into T2 and splits T3/T4 by severity:
//   STRONG, PROMISING        -> T1_LEGIT       (PRIORITIZE-equivalent)
//   REASONABLE, NEEDS REVIEW -> T2_BORDERLINE  (manual-review-equivalent)
//   LIKELY INVALID           -> T3_SLOP        (AUTO_CLOSE-equivalent)
//   HIGH RISK                -> T4_HALLUCINATED (highest-risk auto-close)
// Rows whose label does not fall into any of these bands (null / unknown) are
// skipped so they don't contaminate either bucket.
function productionLabelToTier(label: string | null): CorpusTier | null {
  switch (label) {
    case "STRONG":
    case "PROMISING":
      return "T1_LEGIT";
    case "REASONABLE":
    case "NEEDS REVIEW":
      return "T2_BORDERLINE";
    case "LIKELY INVALID":
      return "T3_SLOP";
    case "HIGH RISK":
      return "T4_HALLUCINATED";
    default:
      return null;
  }
}

// Task #119 — bound on the production scan. The dry-run preview is reviewer
// interactive (sub-second budget) so we cap at the most recent 2000 reports
// with a persisted composite label. That gives a much sharper false-positive
// signal than the ~50-fixture curated corpus alone without turning a phrase
// preview into a full table scan.
//
// Task #125 — reviewers can override the cap per-request via the optional
// `productionScanLimit` body field on the dry-run POST. Heavy-user installs
// can widen the window (up to PRODUCTION_PREVIEW_LIMIT_MAX) for a stronger
// false-positive signal; small installs can tighten it (down to
// PRODUCTION_PREVIEW_LIMIT_MIN) to focus on recent reporter behavior. The
// default is unchanged so existing reviewers see no behavior change.
//
// Task #230 — the same `productionScanLimit` field is also accepted on the
// DELETE single-phrase and batch dry-run paths so the reviewer-chosen scan
// window persisted in the calibration UI flows through every production
// archive scan, not just the add-phrase preview.
const PRODUCTION_PREVIEW_LIMIT = 2000;
const PRODUCTION_PREVIEW_LIMIT_MIN = 100;
const PRODUCTION_PREVIEW_LIMIT_MAX = 10000;

// Task #230 — shared parser/validator for the optional `productionScanLimit`
// body field. Returns the resolved limit (defaulting to PRODUCTION_PREVIEW_LIMIT
// when the field is absent) on success, or an `error` string when the value is
// present but malformed/out-of-range. Centralized here so the POST add-phrase
// and DELETE single/batch routes reject identical bad inputs with identical
// error messages.
function parseProductionScanLimit(
  raw: unknown,
): { ok: true; limit: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, limit: PRODUCTION_PREVIEW_LIMIT };
  const v = Number(raw);
  if (
    !Number.isFinite(v) ||
    !Number.isInteger(v) ||
    v < PRODUCTION_PREVIEW_LIMIT_MIN ||
    v > PRODUCTION_PREVIEW_LIMIT_MAX
  ) {
    return {
      ok: false,
      error: `productionScanLimit must be an integer between ${PRODUCTION_PREVIEW_LIMIT_MIN} and ${PRODUCTION_PREVIEW_LIMIT_MAX}.`,
    };
  }
  return { ok: true, limit: v };
}

// Pure scoring step (no DB) so it can be unit-tested independently of the
// drizzle layer.
function scoreProductionRows(
  phrase: string,
  rows: Array<{
    id: number | string;
    label: string | null;
    contentText: string | null;
    // Task #124 — Optional so existing callers/tests that don't care about
    // the date-range surface can keep passing rows without timestamps; in
    // that case the oldest/newest fields stay null.
    createdAt?: Date | string | null;
  }>,
): DryRunMatches {
  const needle = normalizeForMatch(phrase);
  const tiered: Array<{ id: string; tier: CorpusTier; text: string }> = [];
  // Task #124 — track the createdAt window of the rows that actually made it
  // into the scanned sample (i.e. survived the label/content filter). This is
  // the same population reflected in `corpusSize`, so the reported range
  // matches what the UI describes as "scanned N reports".
  let oldestMs: number | null = null;
  let newestMs: number | null = null;
  for (const r of rows) {
    const tier = productionLabelToTier(r.label);
    if (!tier || r.contentText == null) continue;
    tiered.push({ id: String(r.id), tier, text: r.contentText });
    if (r.createdAt != null) {
      const t = r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt).getTime();
      if (Number.isFinite(t)) {
        if (oldestMs === null || t < oldestMs) oldestMs = t;
        if (newestMs === null || t > newestMs) newestMs = t;
      }
    }
  }
  const { total, byTier, sampleMatches } = tallyMatches(needle, tiered);
  const falsePositives = byTier.t1Legit + byTier.t2Borderline;
  let warning: string | null = null;
  if (falsePositives > 0) {
    const noun = falsePositives === 1 ? "legitimate report" : "legitimate reports";
    warning = `This phrase would have flagged ${falsePositives} ${noun} (${byTier.t1Legit} GREEN, ${byTier.t2Borderline} YELLOW) in the most recent ${tiered.length} production reports — consider rewording.`;
  }
  return {
    total,
    byTier,
    falsePositives,
    corpusSize: tiered.length,
    sampleMatches,
    warning,
    oldestCreatedAt: oldestMs === null ? null : new Date(oldestMs).toISOString(),
    newestCreatedAt: newestMs === null ? null : new Date(newestMs).toISOString(),
  };
}

async function previewHandwavyPhraseAgainstProduction(
  phrase: string,
  limit: number = PRODUCTION_PREVIEW_LIMIT,
): Promise<DryRunMatches> {
  const rows = await db
    .select({
      id: reportsTable.id,
      label: reportsTable.vulnrapCompositeLabel,
      contentText: reportsTable.contentText,
      // Task #124 — pull createdAt so the dry-run can surface the date range
      // the production sample actually covers.
      createdAt: reportsTable.createdAt,
    })
    .from(reportsTable)
    .where(
      and(
        isNotNull(reportsTable.vulnrapCompositeLabel),
        isNotNull(reportsTable.contentText),
      ),
    )
    .orderBy(sql`${reportsTable.createdAt} DESC`)
    .limit(limit);

  return scoreProductionRows(phrase, rows);
}

// Task #123 — Detect overlap between a candidate phrase and the existing
// curated hand-wavy phrase list. Reviewers most commonly should NOT add a new
// phrase when it duplicates or is wholly contained within an existing entry
// (or vice-versa: the candidate is so broad that an existing entry is already
// covered by it). The dry-run preview surfaces this so reviewers don't need
// to eyeball the GET response separately. Matching mirrors the engine path:
// both sides are normalized to lowercase + collapsed whitespace, then
// compared via plain substring containment.
type OverlapRelation = "equal" | "candidate-contains-existing" | "existing-contains-candidate";

interface DryRunOverlap {
  phrase: string;
  category: HandwavyCategory;
  relation: OverlapRelation;
}

interface DryRunOverlaps {
  total: number;
  matches: DryRunOverlap[];
}

function detectCuratedOverlaps(
  normalizedCandidate: string,
  curated: Iterable<HandwavyMarker>,
): DryRunOverlaps {
  const matches: DryRunOverlap[] = [];
  for (const m of curated) {
    const existing = m.phrase; // already normalized by the loader.
    if (!existing) continue;
    let relation: OverlapRelation | null = null;
    if (existing === normalizedCandidate) {
      relation = "equal";
    } else if (existing.includes(normalizedCandidate)) {
      // The candidate is a substring of (i.e. narrower than) an existing entry.
      relation = "existing-contains-candidate";
    } else if (normalizedCandidate.includes(existing)) {
      // The candidate is broader than an existing entry — anything matching
      // the existing entry would also match the candidate.
      relation = "candidate-contains-existing";
    }
    if (relation) {
      matches.push({ phrase: existing, category: m.category, relation });
    }
  }
  return { total: matches.length, matches };
}

// Task #145 — corpus impact for a bulk REMOVAL preview. For each fixture in
// the curated cohorts, decide whether it is currently flagged by any active
// phrase, and whether it would still be flagged after the supplied phrases
// were removed. The "lost" tally counts fixtures that were flagged before
// but would no longer be flagged after — i.e. detections the bulk removal
// would silently drop. We split the tally by tier so reviewers can see the
// trade-off: T3/T4 lost = real slop detection lost (worrying); T1/T2 lost =
// false-positives that would also disappear (informational good news).
interface RemovalImpact {
  total: number;
  byTier: { t1Legit: number; t2Borderline: number; t3Slop: number; t4Hallucinated: number };
  /** T3 + T4 lost matches — the "real slop detection lost" metric that drives the warning. */
  validDetectionsLost: number;
  /** T1 + T2 lost matches — false-positive flags that would also disappear. */
  falsePositivesDropped: number;
  corpusSize: number;
  sampleMatches: Array<{ id: string; tier: CorpusTier }>;
  warning: string | null;
  // Task #218 — for production scans, the createdAt range of the scanned
  // sample so reviewers using the bulk-retire flow have the same "is this
  // signal current or stale?" answer that the add-time preview already
  // surfaces (Task #124). ISO-8601 timestamps, or `null` when the scan was
  // empty / not applicable (e.g. the curated benchmark fixtures don't have
  // a wall-clock timestamp).
  oldestCreatedAt: string | null;
  newestCreatedAt: string | null;
}

function fixtureMatchesAny(haystackNormalized: string, phrases: Iterable<string>): boolean {
  for (const p of phrases) {
    if (!p) continue;
    if (haystackNormalized.includes(p)) return true;
  }
  return false;
}

function computeRemovalImpactOnRows(
  removedPhrases: string[],
  remainingPhrases: string[],
  rows: Array<{
    id: string;
    tier: CorpusTier;
    text: string;
    // Task #218 — Optional so existing callers (curated fixtures) can keep
    // passing rows without timestamps; in that case the oldest/newest fields
    // stay null. Production callers thread the row's `createdAt` through so
    // the same scan-range line the add-time preview shows can also render
    // on the bulk-removal preview.
    createdAt?: Date | string | null;
  }>,
  contextLabel: string,
): RemovalImpact {
  const byTier = { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 };
  const sampleMatches: Array<{ id: string; tier: CorpusTier }> = [];
  let total = 0;
  // Task #218 — track the createdAt window of the rows that actually made it
  // into the scanned sample (i.e. survived the label/content filter at the
  // caller, so the same population reflected in `corpusSize`). Mirrors
  // `scoreProductionRows` from the add-time preview path: the reported range
  // matches what the UI describes as "scanned N reports".
  let oldestMs: number | null = null;
  let newestMs: number | null = null;
  // Skip work when nothing would actually be removed.
  const removedSet = removedPhrases.filter((p) => p.length > 0);
  for (const r of rows) {
    if (r.createdAt != null) {
      const t = r.createdAt instanceof Date ? r.createdAt.getTime() : new Date(r.createdAt).getTime();
      if (Number.isFinite(t)) {
        if (oldestMs === null || t < oldestMs) oldestMs = t;
        if (newestMs === null || t > newestMs) newestMs = t;
      }
    }
    if (removedSet.length === 0) continue;
    const haystack = r.text.toLowerCase().replace(/\s+/g, " ");
    const wasFlagged = fixtureMatchesAny(haystack, removedSet) ||
      fixtureMatchesAny(haystack, remainingPhrases);
    if (!wasFlagged) continue;
    const willBeFlagged = fixtureMatchesAny(haystack, remainingPhrases);
    if (willBeFlagged) continue;
    total += 1;
    if (r.tier === "T1_LEGIT") byTier.t1Legit += 1;
    else if (r.tier === "T2_BORDERLINE") byTier.t2Borderline += 1;
    else if (r.tier === "T3_SLOP") byTier.t3Slop += 1;
    else byTier.t4Hallucinated += 1;
    if (sampleMatches.length < 12) sampleMatches.push({ id: r.id, tier: r.tier });
  }
  const validDetectionsLost = byTier.t3Slop + byTier.t4Hallucinated;
  const falsePositivesDropped = byTier.t1Legit + byTier.t2Borderline;
  let warning: string | null = null;
  if (validDetectionsLost > 0) {
    const noun = validDetectionsLost === 1 ? "report" : "reports";
    warning = `Removing these phrases would un-flag ${validDetectionsLost} legitimately-flagged hand-wavy ${noun} (${byTier.t3Slop} T3 SLOP, ${byTier.t4Hallucinated} T4 HALLUCINATED) in ${contextLabel} — these detections will be lost.`;
  }
  return {
    total,
    byTier,
    validDetectionsLost,
    falsePositivesDropped,
    corpusSize: rows.length,
    sampleMatches,
    warning,
    oldestCreatedAt: oldestMs === null ? null : new Date(oldestMs).toISOString(),
    newestCreatedAt: newestMs === null ? null : new Date(newestMs).toISOString(),
  };
}

function previewRemovalAgainstCorpus(
  removedPhrases: string[],
  remainingPhrases: string[],
): RemovalImpact {
  const cohorts: Array<{ tier: CorpusTier; fixtures: typeof TEST_FIXTURE_COHORTS.T1 }> = [
    { tier: "T1_LEGIT", fixtures: TEST_FIXTURE_COHORTS.T1 },
    { tier: "T2_BORDERLINE", fixtures: TEST_FIXTURE_COHORTS.T2 },
    { tier: "T3_SLOP", fixtures: TEST_FIXTURE_COHORTS.T3 },
    { tier: "T4_HALLUCINATED", fixtures: TEST_FIXTURE_COHORTS.T4 },
  ];
  const flat: Array<{ id: string; tier: CorpusTier; text: string }> = [];
  for (const { tier, fixtures } of cohorts) {
    for (const f of fixtures) flat.push({ id: f.id, tier, text: f.text });
  }
  return computeRemovalImpactOnRows(removedPhrases, remainingPhrases, flat, "the curated benchmark corpus");
}

async function previewRemovalAgainstProduction(
  removedPhrases: string[],
  remainingPhrases: string[],
  limit: number = PRODUCTION_PREVIEW_LIMIT,
): Promise<RemovalImpact> {
  const rows = await db
    .select({
      id: reportsTable.id,
      label: reportsTable.vulnrapCompositeLabel,
      contentText: reportsTable.contentText,
      // Task #218 — pull createdAt so the bulk-removal preview can surface
      // the same date range as the add-time preview (Task #124).
      createdAt: reportsTable.createdAt,
    })
    .from(reportsTable)
    .where(
      and(
        isNotNull(reportsTable.vulnrapCompositeLabel),
        isNotNull(reportsTable.contentText),
      ),
    )
    .orderBy(sql`${reportsTable.createdAt} DESC`)
    .limit(limit);
  const tiered: Array<{
    id: string;
    tier: CorpusTier;
    text: string;
    createdAt: Date | string | null;
  }> = [];
  for (const r of rows) {
    const tier = productionLabelToTier(r.label);
    if (!tier || r.contentText == null) continue;
    tiered.push({
      id: String(r.id),
      tier,
      text: r.contentText,
      createdAt: r.createdAt ?? null,
    });
  }
  return computeRemovalImpactOnRows(
    removedPhrases,
    remainingPhrases,
    tiered,
    `the most recent ${tiered.length} production reports`,
  );
}

// Exported for unit testing the pure scoring step without DB access.
export const __testing = {
  productionLabelToTier,
  scoreProductionRows,
  previewHandwavyPhrase,
  detectCuratedOverlaps,
  computeRemovalImpactOnRows,
  previewRemovalAgainstCorpus,
  PRODUCTION_PREVIEW_LIMIT,
  PRODUCTION_PREVIEW_LIMIT_MIN,
  PRODUCTION_PREVIEW_LIMIT_MAX,
};

const router: IRouter = Router();

// v3.6.0 §8: Surface a non-applied "suggestedAdjustments" block alongside the
// existing calibration report. These are diagnostic suggestions only — the
// allocator/calibration applier is unchanged and still requires an explicit
// POST to /feedback/calibration/apply (with the allow-listed keys).
function buildSuggestedAdjustments(buckets: BucketAnalysis[]): Array<{
  scope: string;
  metric: string;
  observed: number;
  target: number;
  delta: number;
  recommendation: string;
}> {
  const out: Array<{ scope: string; metric: string; observed: number; target: number; delta: number; recommendation: string }> = [];
  for (const b of buckets) {
    if (!b.meetsThreshold) continue;
    if (b.signal === "over-scoring" && Math.abs(b.ratingDeviation) >= 0.5) {
      out.push({
        scope: b.bucket,
        metric: "rating_deviation",
        observed: Number((b.avgRating).toFixed(2)),
        target: Number((b.avgRating + Math.abs(b.ratingDeviation)).toFixed(2)),
        delta: Number(b.ratingDeviation.toFixed(2)),
        recommendation: `Bucket "${b.bucket}" is over-scoring. Consider lowering Engine 1 weight or relaxing slop thresholds for this band.`,
      });
    } else if (b.signal === "under-scoring" && Math.abs(b.ratingDeviation) >= 0.5) {
      out.push({
        scope: b.bucket,
        metric: "rating_deviation",
        observed: Number((b.avgRating).toFixed(2)),
        target: Number((b.avgRating - Math.abs(b.ratingDeviation)).toFixed(2)),
        delta: Number(b.ratingDeviation.toFixed(2)),
        recommendation: `Bucket "${b.bucket}" is under-scoring. Consider tightening evidence requirements (Engine 2) for this band.`,
      });
    }
  }
  return out;
}

router.get("/feedback/calibration", async (_req, res) => {
  try {
    const report = await generateCalibrationReport();
    const suggestedAdjustments = buildSuggestedAdjustments(report.bucketAnalysis);
    res.json({
      ...report,
      // v3.6.0: read-only suggestion field; no auto-apply.
      suggestedAdjustments,
      v3_6_0: {
        engineWeights: { engine1: 0.05, engine2: 0.60, engine3: 0.35 },
        evidenceTypeMultipliers: {
          CRASH_OUTPUT: 2.5, CODE_DIFF: 2.2, STACK_TRACE: 2.0, SHELL_COMMAND: 1.8,
          HTTP_REQUEST: 1.6, MEMORY_ADDRESS: 1.5, LINE_NUMBER: 1.4, FUNCTION_NAME: 1.3,
          FILE_PATH: 1.2, CVSS_VECTOR: 1.2, CVE_REFERENCE: 1.1, VERSION_PIN: 1.1,
          ENDPOINT_URL: 1.0, ENVIRONMENT_DETAIL: 1.0,
        },
        cweCalibration: { default: 42, vulnTypeNoCwe: 38, strongFitFloor: 68, perfectFitFloor: 78, wrongCweCeiling: 25 },
      },
    });
  } catch (err) {
    _req.log?.error(err, "Failed to generate calibration report");
    res.status(500).json({ error: "Failed to generate calibration report." });
  }
});

// Sprint 12 — AVRI calibration drift dashboard. Rolling weekly view of the
// AVRI composite for production reports, bucketed by triage outcome.
// Default window is 8 weeks; capped at 26 weeks by generateAvriDriftReport.
router.get("/feedback/calibration/avri-drift", async (req, res) => {
  try {
    const weeksRaw = req.query.weeks;
    const weeksParsed = typeof weeksRaw === "string" ? Number.parseInt(weeksRaw, 10) : undefined;
    const weeks = Number.isFinite(weeksParsed) ? weeksParsed : undefined;
    const report = await generateAvriDriftReport({ weeks });
    res.json(report);
  } catch (err) {
    req.log?.error(err, "Failed to generate AVRI drift report");
    res.status(500).json({ error: "Failed to generate AVRI drift report." });
  }
});

// Task #83 — Push freshly-fired drift flags to reviewers via the configured
// webhook (AVRI_DRIFT_WEBHOOK_URL) instead of waiting for someone to open
// the calibration page. The endpoint is auth-gated because it triggers an
// outbound HTTP call. It can be invoked by:
//   - external cron / scheduled job for periodic dispatch alongside the
//     in-process scheduler started in src/index.ts (Task #197),
//   - a reviewer manually pressing a button in the calibration UI to force
//     a check between scheduled runs.
// Repeat invocations within the same week for the same flag are de-duped by
// `lib/avri-drift-notifications.ts` so this endpoint is safe to poll.
router.post(
  "/feedback/calibration/avri-drift/notify",
  requireCalibrationAuth,
  async (req, res) => {
    try {
      const weeksRaw = req.query.weeks ?? (req.body ?? {}).weeks;
      const weeksParsed =
        typeof weeksRaw === "string"
          ? Number.parseInt(weeksRaw, 10)
          : typeof weeksRaw === "number"
            ? weeksRaw
            : undefined;
      const weeks = Number.isFinite(weeksParsed) ? weeksParsed : undefined;
      const driftReport = await generateAvriDriftReport({ weeks });
      const outcome = await notifyDriftFlagsIfNew(driftReport);
      const status = outcome.dispatchResult && !outcome.dispatchResult.ok ? 502 : 200;
      res.status(status).json({
        weeksRequested: driftReport.weeksRequested,
        totalFlags: driftReport.flags.length,
        notifiedCount: outcome.notified.length,
        alreadyNotifiedCount: outcome.alreadyNotified.length,
        dispatched: outcome.dispatched,
        webhookSkipped: outcome.webhookSkipped,
        dispatchResult: outcome.dispatchResult ?? null,
        calibrationUrl: outcome.calibrationUrl,
        runbookUrl: outcome.runbookUrl,
        notified: outcome.notified.map((f) => ({
          key: f.key,
          weekStart: f.weekStart,
          kind: f.kind,
          detail: f.detail,
        })),
      });
    } catch (err) {
      req.log?.error(err, "Failed to dispatch AVRI drift notifications");
      res.status(500).json({ error: "Failed to dispatch AVRI drift notifications." });
    }
  },
);

// Task #196 — Surface the persisted dedup state so reviewers can see which
// flags would be silently suppressed on the next dispatch run, and re-arm
// any of them. Strict-auth because the response includes the original
// `detail` string (reviewer-facing context that we don't want exposed
// publicly when CALIBRATION_TOKEN is unset, matching the policy used by
// the hand-wavy phrase list).
router.get(
  "/feedback/calibration/avri-drift/notifications",
  requireCalibrationAuthStrict,
  (req, res) => {
    try {
      const notified = listNotifiedFlags();
      res.json({ notified, total: notified.length });
    } catch (err) {
      req.log?.error(err, "Failed to read AVRI drift notification dedup state");
      res
        .status(500)
        .json({ error: "Failed to read AVRI drift notification dedup state." });
    }
  },
);

// Task #196 — Re-arm one or more previously-notified drift flags by
// removing their entries from the persisted dedup state. The next
// dispatch run will treat them as never-seen and re-fire the webhook.
//
// Mutation gate (`requireCalibrationAuth`) so reviewers can't be re-paged
// by an unauthenticated caller; the same gate also lets the existing
// per-IP throttle catch wrong-token bursts. Body shape is
// `{ keys: string[] }`. Unknown keys are reported back via `notFound`
// (mirroring the per-phrase removal pattern) instead of failing the
// whole request — partial success is the common case when the file has
// already been pruned by a teammate.
router.post(
  "/feedback/calibration/avri-drift/notifications/rearm",
  requireCalibrationAuth,
  (req, res) => {
    try {
      const body = (req.body ?? {}) as { keys?: unknown };
      const rawKeys = body.keys;
      if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
        res
          .status(400)
          .json({ error: "Body must include a non-empty 'keys' string array." });
        return;
      }
      if (rawKeys.length > 200) {
        res
          .status(400)
          .json({ error: "'keys' batch is capped at 200 entries per request." });
        return;
      }
      const cleaned: string[] = [];
      for (const k of rawKeys) {
        if (typeof k !== "string" || k.trim().length === 0) {
          res
            .status(400)
            .json({ error: "Every entry in 'keys' must be a non-empty string." });
          return;
        }
        cleaned.push(k);
      }
      const result = removeNotifiedFlags(cleaned);
      // 200 when at least one entry was re-armed (even if some keys
      // were unknown); 404 only when nothing matched at all so the
      // reviewer's UI can distinguish "stale picker — refresh" from
      // "partial success".
      const status = result.removed.length > 0 ? 200 : 404;
      res.status(status).json({
        rearmed: result.removed.length,
        notFound: result.notFound,
        remaining: result.remaining,
        removed: result.removed,
        notified: listNotifiedFlags(),
      });
    } catch (err) {
      req.log?.error(err, "Failed to re-arm AVRI drift notifications");
      res.status(500).json({ error: "Failed to re-arm AVRI drift notifications." });
    }
  },
);

router.get("/feedback/calibration/config", (_req, res) => {
  try {
    res.json({
      current: getCurrentConfig(),
      history: getConfigHistory(),
    });
  } catch (err) {
    _req.log?.error(err, "Failed to fetch scoring config");
    res.status(500).json({ error: "Failed to fetch scoring config." });
  }
});

// Task #117 — un-gated probe so the dashboard can detect a token
// misconfiguration BEFORE the reviewer triggers a mutation that 401s. This
// endpoint deliberately does NOT enforce auth: it tells the caller whether
// the SERVER requires a token AND whether the token they sent (if any)
// would be accepted, so the UI can render a "Reviewer token: configured /
// missing / invalid" indicator instead of letting every add/remove explode
// into a generic 401 toast. We never echo the configured token back — only
// boolean signals — so this remains safe to expose without auth.
router.get("/feedback/calibration/auth-status", (req, res) => {
  const status = getCalibrationAuthStatus(req);
  res.json(status);
});

router.post("/feedback/calibration/apply", requireCalibrationAuth, async (req, res) => {
  try {
    const { changes, description } = req.body;

    if (!changes || typeof changes !== "object") {
      res.status(400).json({ error: "Changes object is required." });
      return;
    }

    if (!description || typeof description !== "string") {
      res.status(400).json({ error: "Description string is required." });
      return;
    }

    const allowedKeys = ["prior", "floor", "ceiling", "axisThresholds", "tierThresholds", "fabricationBoost"];
    const filteredChanges: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (key in changes) {
        filteredChanges[key] = changes[key];
      }
    }

    if (Object.keys(filteredChanges).length === 0) {
      res.status(400).json({ error: "No valid changes provided. Allowed: prior, floor, ceiling, axisThresholds, tierThresholds, fabricationBoost." });
      return;
    }

    if (filteredChanges.prior !== undefined) {
      const v = Number(filteredChanges.prior);
      if (isNaN(v) || v < 0 || v > 50) {
        res.status(400).json({ error: "prior must be between 0 and 50." });
        return;
      }
      filteredChanges.prior = v;
    }
    if (filteredChanges.floor !== undefined) {
      const v = Number(filteredChanges.floor);
      if (isNaN(v) || v < 0 || v > 30) {
        res.status(400).json({ error: "floor must be between 0 and 30." });
        return;
      }
      filteredChanges.floor = v;
    }
    if (filteredChanges.ceiling !== undefined) {
      const v = Number(filteredChanges.ceiling);
      if (isNaN(v) || v < 70 || v > 100) {
        res.status(400).json({ error: "ceiling must be between 70 and 100." });
        return;
      }
      filteredChanges.ceiling = v;
    }
    if (filteredChanges.fabricationBoost !== undefined) {
      const v = Number(filteredChanges.fabricationBoost);
      if (isNaN(v) || v < 1.0 || v > 3.0) {
        res.status(400).json({ error: "fabricationBoost must be between 1.0 and 3.0." });
        return;
      }
      filteredChanges.fabricationBoost = v;
    }
    if (filteredChanges.axisThresholds !== undefined) {
      const at = filteredChanges.axisThresholds;
      if (typeof at !== "object" || at === null || Array.isArray(at)) {
        res.status(400).json({ error: "axisThresholds must be an object mapping axis names to numbers." });
        return;
      }
      const validAxes = ["linguistic", "factual", "template", "llm", "verification"];
      const cleaned: Record<string, number> = {};
      for (const [key, val] of Object.entries(at as Record<string, unknown>)) {
        if (!validAxes.includes(key)) continue;
        const v = Number(val);
        if (isNaN(v) || v < 0 || v > 100) {
          res.status(400).json({ error: `axisThresholds.${key} must be between 0 and 100.` });
          return;
        }
        cleaned[key] = v;
      }
      filteredChanges.axisThresholds = cleaned;
    }
    if (filteredChanges.tierThresholds !== undefined) {
      const tt = filteredChanges.tierThresholds;
      if (typeof tt !== "object" || tt === null || Array.isArray(tt)) {
        res.status(400).json({ error: "tierThresholds must be an object with low and high numbers." });
        return;
      }
      const ttObj = tt as Record<string, unknown>;
      const cleaned: Record<string, number> = {};
      if (ttObj.low !== undefined) {
        const v = Number(ttObj.low);
        if (isNaN(v) || v < 0 || v > 100) {
          res.status(400).json({ error: "tierThresholds.low must be between 0 and 100." });
          return;
        }
        cleaned.low = v;
      }
      if (ttObj.high !== undefined) {
        const v = Number(ttObj.high);
        if (isNaN(v) || v < 0 || v > 100) {
          res.status(400).json({ error: "tierThresholds.high must be between 0 and 100." });
          return;
        }
        cleaned.high = v;
      }
      if (cleaned.low !== undefined && cleaned.high !== undefined && cleaned.low >= cleaned.high) {
        res.status(400).json({ error: "tierThresholds.low must be less than tierThresholds.high." });
        return;
      }
      filteredChanges.tierThresholds = cleaned;
    }

    const newConfig = applyNewConfig(
      filteredChanges as Parameters<typeof applyNewConfig>[0],
      description
    );

    res.status(201).json({
      message: "Scoring configuration updated successfully.",
      config: newConfig,
    });
  } catch (err) {
    req.log?.error(err, "Failed to apply calibration changes");
    res.status(500).json({ error: "Failed to apply calibration changes." });
  }
});

// Task #108 — Reviewer-curated FLAT hand-wavy marker phrases. The list lives
// in data/handwavy-phrases.json and is loaded by the AVRI Engine 2 FLAT path
// at every triage. GET surfaces the active list; POST appends a new phrase;
// DELETE removes one. Phrases are normalized to lowercase + collapsed
// whitespace before storage so reviewers don't have to worry about case or
// stray spaces matching the engine's matcher.
router.get("/feedback/calibration/handwavy-phrases", requireCalibrationAuthStrict, (_req, res) => {
  try {
    const phrases = getHandwavyPhrases();
    const history = getHandwavyPhraseHistory();
    res.json({ phrases, total: phrases.length, history });
  } catch (err) {
    _req.log?.error(err, "Failed to read hand-wavy phrases");
    res.status(500).json({ error: "Failed to read hand-wavy phrases." });
  }
});

// Task #160 — Slim, picker-friendly summary of recent BATCH removal entries
// from the hand-wavy phrase history log. The reinstate-batch CLI fetches this
// to render a numbered menu so reviewers don't have to copy/paste an ISO
// `removedAt` from the calibration UI history pane. Single-phrase removal
// entries are excluded because they're not reinstatable through the
// /reinstate-batch endpoint.
const REMOVAL_BATCHES_DEFAULT_LIMIT = 10;
const REMOVAL_BATCHES_MAX_LIMIT = 50;
const REMOVAL_BATCHES_SAMPLE_SIZE = 5;

router.get(
  "/feedback/calibration/handwavy-phrases/removal-batches",
  requireCalibrationAuthStrict,
  (req, res) => {
    try {
      const rawLimit = req.query.limit;
      let limit = REMOVAL_BATCHES_DEFAULT_LIMIT;
      if (typeof rawLimit === "string" && rawLimit.length > 0) {
        const parsed = Number.parseInt(rawLimit, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          res.status(400).json({ error: "limit must be a positive integer." });
          return;
        }
        limit = Math.min(parsed, REMOVAL_BATCHES_MAX_LIMIT);
      }
      const history = getHandwavyPhraseHistory();
      // Newest first — the history log itself is append-only / oldest-first.
      const batches = history
        .filter((h) => Array.isArray(h.phrases) && h.phrases.length > 0)
        .reverse()
        .slice(0, limit)
        .map((h) => {
          const phrases = h.phrases ?? [];
          return {
            removedAt: h.removedAt,
            removedBy: h.removedBy,
            phraseCount: phrases.length,
            reinstated: h.reinstated === true,
            samplePhrases: phrases.slice(0, REMOVAL_BATCHES_SAMPLE_SIZE).map((p) => p.phrase),
          };
        });
      res.json({
        limit,
        totalBatches: history.filter((h) => Array.isArray(h.phrases) && h.phrases.length > 0).length,
        batches,
      });
    } catch (err) {
      req.log?.error(err, "Failed to list hand-wavy removal batches");
      res.status(500).json({ error: "Failed to list hand-wavy removal batches." });
    }
  },
);

// Task #176 — Sibling detail endpoint that returns the FULL inner phrase list
// for a single batch removal entry. The list endpoint above returns at most
// REMOVAL_BATCHES_SAMPLE_SIZE sample strings per batch so the picker stays
// compact; reviewers who want to eyeball every phrase before reinstating
// (especially for big batches) call this endpoint to fetch the complete
// inventory plus the per-phrase audit metadata (category, original adder,
// per-phrase reinstated flag, etc.). The reinstate-batch CLI uses this to
// render a "preview" step between the picker / --removed-at flag and the
// final confirmation prompt. A future inline picker UI can also call it to
// power a "Show all N phrases" expand toggle on each batch entry.
//
// `:removedAt` is the parent entry's ISO 8601 timestamp (matches the
// parent's `removedAt` field in the removal-history log). It must be
// URL-encoded (`%3A`, etc.) by the caller. Single-phrase removal entries
// are NOT addressable here — they return 404 reason:"not-a-batch" so the
// CLI surfaces a clear "use /reinstate" hint instead of mysteriously
// finding nothing.
router.get(
  "/feedback/calibration/handwavy-phrases/removal-batches/:removedAt",
  requireCalibrationAuthStrict,
  (req, res) => {
    try {
      const removedAtParam = req.params.removedAt;
      if (typeof removedAtParam !== "string" || removedAtParam.trim().length === 0) {
        res.status(400).json({ error: "removedAt path parameter is required." });
        return;
      }
      const history = getHandwavyPhraseHistory();
      const entry = history.find((h) => h.removedAt === removedAtParam);
      if (!entry) {
        res.status(404).json({
          error: "No matching removal-history entry found for that removedAt.",
          reason: "history-not-found",
        });
        return;
      }
      if (!Array.isArray(entry.phrases) || entry.phrases.length === 0) {
        // Single-phrase legacy entry — not addressable through this batch
        // detail endpoint. The CLI maps this to a "use /reinstate" hint.
        res.status(404).json({
          error: "That history entry is a single-phrase removal — use /reinstate for single-phrase entries.",
          reason: "not-a-batch",
        });
        return;
      }
      // Echo the full inner list with all per-phrase audit metadata. We
      // copy the entries so callers can't accidentally mutate the cached
      // history through the response shape.
      const phrases = entry.phrases.map((p) => ({ ...p }));
      const reinstatedCount = phrases.filter((p) => p.reinstated === true).length;
      res.json({
        removedAt: entry.removedAt,
        removedBy: entry.removedBy,
        reinstated: entry.reinstated === true,
        reinstatedAt: entry.reinstatedAt,
        reinstatedBy: entry.reinstatedBy,
        phraseCount: phrases.length,
        reinstatedCount,
        phrases,
      });
    } catch (err) {
      req.log?.error(err, "Failed to fetch hand-wavy removal batch detail");
      res.status(500).json({ error: "Failed to fetch hand-wavy removal batch detail." });
    }
  },
);

router.post("/feedback/calibration/handwavy-phrases", requireCalibrationAuth, async (req, res) => {
  try {
    const { phrase, category, dryRun, reviewer, rationale, productionScanLimit, addedAt } = (req.body ?? {}) as {
      phrase?: unknown;
      category?: unknown;
      dryRun?: unknown;
      reviewer?: unknown;
      rationale?: unknown;
      productionScanLimit?: unknown;
      // Task #223 — test-only override for the marker's `addedAt` ISO
      // timestamp. Lets the e2e suite seed a phrase whose 5-minute undo
      // window is about to elapse so the urgent-state styling
      // (text-red-400 + animate-pulse + data-undo-urgent="true") can be
      // exercised without the spec having to wait 4m 30s of real wall-
      // clock time. Only honored when HANDWAVY_ALLOW_TEST_BACKDATE=1 is
      // set on the api-server process so a production deployment cannot
      // be tricked into rewriting the audit timestamp.
      addedAt?: unknown;
    };
    if (typeof phrase !== "string" || phrase.trim().length === 0) {
      res.status(400).json({ error: "Body must include a non-empty 'phrase' string." });
      return;
    }
    if (
      category !== undefined &&
      category !== "absence" &&
      category !== "hedging" &&
      category !== "buzzword"
    ) {
      res.status(400).json({ error: "category must be one of 'absence', 'hedging', 'buzzword'." });
      return;
    }
    if (reviewer !== undefined && typeof reviewer !== "string") {
      res.status(400).json({ error: "reviewer must be a string when provided." });
      return;
    }
    if (rationale !== undefined && typeof rationale !== "string") {
      res.status(400).json({ error: "rationale must be a string when provided." });
      return;
    }
    // Task #125 — optional reviewer override for the production-scan window.
    // Only meaningful on the dry-run path (the only place the production
    // scan runs), but we validate it on every POST so a malformed value
    // never makes it past the input layer.
    // Task #230 — validation lives in the shared `parseProductionScanLimit`
    // helper so the DELETE single/batch dry-run paths reject identical bad
    // inputs with identical error messages.
    const productionLimitParse = parseProductionScanLimit(productionScanLimit);
    if (!productionLimitParse.ok) {
      res.status(400).json({ error: productionLimitParse.error });
      return;
    }
    const effectiveProductionLimit = productionLimitParse.limit;
    // Task #114 — dry-run mode: validate length the same way as a real add so
    // reviewers see the same "too short / too long" errors before committing,
    // then return a corpus-match preview without persisting anything.
    if (dryRun === true) {
      const normalized = phrase.toLowerCase().replace(/\s+/g, " ").trim();
      if (normalized.length < 3) {
        res.status(400).json({ error: "Phrase must be at least 3 characters after normalization." });
        return;
      }
      if (normalized.length > 200) {
        res.status(400).json({ error: "Phrase must be at most 200 characters." });
        return;
      }
      const matches = previewHandwavyPhrase(normalized);
      // Task #119 — Also score the candidate against the most recent production
      // reports (capped at PRODUCTION_PREVIEW_LIMIT). The curated cohorts are
      // tiny (~50 fixtures) so a domain-specific phrase can easily score 0/0
      // there yet flag dozens of legitimate production reports. We surface the
      // production block as a SECOND signal so reviewers see both. If the DB
      // probe fails we don't fail the whole preview — the curated block is
      // still useful — but we DO record the failure so the UI can render a
      // clear "production scan unavailable" notice rather than silently
      // hiding the second signal.
      let productionMatches: DryRunMatches | null = null;
      let productionError: string | null = null;
      try {
        // Task #125 — honor the reviewer-supplied scan window if any (already
        // validated above), otherwise the legacy 2000-row default.
        productionMatches = await previewHandwavyPhraseAgainstProduction(
          normalized,
          effectiveProductionLimit,
        );
      } catch (err) {
        req.log?.error(err, "Production dry-run scan failed");
        productionError = "Production archive scan failed; only curated-corpus signal is shown.";
      }
      const phrases = getHandwavyPhrases();
      const effectiveCategory = (category ?? "absence") as "absence" | "hedging" | "buzzword";
      // Task #123 — flag overlap with existing curated entries so the reviewer
      // can spot near-duplicates before they crowd the active list.
      const overlaps = detectCuratedOverlaps(normalized, phrases);
      res.status(200).json({
        dryRun: true,
        added: false,
        phrase: normalized,
        category: effectiveCategory,
        total: phrases.length,
        phrases,
        dryRunMatches: matches,
        dryRunMatchesProduction: productionMatches,
        dryRunMatchesProductionError: productionError,
        // Task #125 — echo the effective limit (default or reviewer override)
        // so the UI can render "scanned the last N reports" accurately.
        dryRunMatchesProductionLimit: effectiveProductionLimit,
        dryRunOverlaps: overlaps,
      });
      return;
    }
    // Task #223 — only honor a caller-supplied addedAt when the api-server
    // process has explicitly opted in via HANDWAVY_ALLOW_TEST_BACKDATE=1.
    // The e2e suite sets this in playwright.config.ts so the urgent-state
    // styling on the per-row Undo button can be tested without 4m 30s of
    // real wait. Production deployments leave the env var unset, so this
    // path is a no-op there: the addedAt body field is silently dropped
    // and addHandwavyPhrase falls back to its default `new Date()` clock.
    let now: string | undefined;
    if (process.env.HANDWAVY_ALLOW_TEST_BACKDATE === "1" && typeof addedAt === "string") {
      const trimmed = addedAt.trim();
      if (trimmed.length > 0 && Number.isFinite(Date.parse(trimmed))) {
        now = trimmed;
      }
    }
    const result = addHandwavyPhrase(phrase, category, {
      reviewer: typeof reviewer === "string" ? reviewer : undefined,
      rationale: typeof rationale === "string" ? rationale : undefined,
      now,
    });
    res.status(result.added ? 201 : 200).json({
      added: result.added,
      phrase: result.phrase,
      category: result.category,
      total: result.total,
      marker: result.marker,
      phrases: getHandwavyPhrases(),
    });
  } catch (err) {
    if (err instanceof Error && /must be at (?:least|most)/.test(err.message)) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log?.error(err, "Failed to add hand-wavy phrase");
    res.status(500).json({ error: "Failed to add hand-wavy phrase." });
  }
});

// Task #121 — reinstate a previously removed phrase straight from the
// removal-history log. The reviewer doesn't have to retype the phrase or
// rationale; the server pulls them from the matching history entry (matched
// by `phrase` + `removedAt`) and re-adds the marker with the original
// category and rationale. The CURRENT reviewer is recorded as `addedBy` (so
// the active list shows who reinstated it), and the history entry itself is
// flagged `reinstated: true` so the same row can't be reinstated twice.
router.post(
  "/feedback/calibration/handwavy-phrases/reinstate",
  requireCalibrationAuth,
  (req, res) => {
    try {
      const { phrase, removedAt, reviewer } = (req.body ?? {}) as {
        phrase?: unknown;
        removedAt?: unknown;
        reviewer?: unknown;
      };
      if (typeof phrase !== "string" || phrase.trim().length === 0) {
        res.status(400).json({ error: "Body must include a non-empty 'phrase' string." });
        return;
      }
      if (typeof removedAt !== "string" || removedAt.trim().length === 0) {
        res.status(400).json({
          error: "Body must include the 'removedAt' ISO timestamp of the history entry to reinstate.",
        });
        return;
      }
      if (reviewer !== undefined && typeof reviewer !== "string") {
        res.status(400).json({ error: "reviewer must be a string when provided." });
        return;
      }
      const result = reinstateHandwavyPhrase(phrase, removedAt, {
        reviewer: typeof reviewer === "string" ? reviewer : undefined,
      });
      if (!result.ok) {
        if (result.reason === "history-not-found") {
          res.status(404).json({
            error: "No matching removal-history entry found for that phrase + removedAt.",
            reason: result.reason,
          });
          return;
        }
        if (result.reason === "already-reinstated") {
          res.status(409).json({
            error: "That history entry has already been reinstated.",
            reason: result.reason,
          });
          return;
        }
        // already-active
        res.status(409).json({
          error: "That phrase is already in the active list.",
          reason: result.reason,
        });
        return;
      }
      res.status(201).json({
        reinstated: true,
        phrase: result.phrase,
        category: result.category,
        total: result.total,
        marker: result.marker,
        historyEntry: result.historyEntry,
        phrases: getHandwavyPhrases(),
        history: getHandwavyPhraseHistory(),
      });
    } catch (err) {
      req.log?.error(err, "Failed to reinstate hand-wavy phrase");
      res.status(500).json({ error: "Failed to reinstate hand-wavy phrase." });
    }
  },
);

// Task #144 — reinstate every not-yet-reinstated inner phrase from a single
// batch removal entry in one round-trip. The reviewer supplies the parent
// entry's `removedAt`; the server reinstates each remaining inner phrase,
// records the current reviewer on each one, and flips the aggregate
// `reinstated` flag once everything is back. Per-phrase reinstate via the
// existing /reinstate endpoint still works for partial undos.
router.post(
  "/feedback/calibration/handwavy-phrases/reinstate-batch",
  requireCalibrationAuth,
  (req, res) => {
    try {
      const { removedAt, reviewer, dryRun } = (req.body ?? {}) as {
        removedAt?: unknown;
        reviewer?: unknown;
        dryRun?: unknown;
      };
      if (typeof removedAt !== "string" || removedAt.trim().length === 0) {
        res.status(400).json({
          error: "Body must include the 'removedAt' ISO timestamp of the batch entry to reinstate.",
        });
        return;
      }
      if (reviewer !== undefined && typeof reviewer !== "string") {
        res.status(400).json({ error: "reviewer must be a string when provided." });
        return;
      }
      if (dryRun !== undefined && typeof dryRun !== "boolean") {
        res.status(400).json({ error: "dryRun must be a boolean when provided." });
        return;
      }
      const isDryRun = dryRun === true;
      const result = reinstateHandwavyPhrasesBatch(removedAt, {
        reviewer: typeof reviewer === "string" ? reviewer : undefined,
        dryRun: isDryRun,
      });
      if (!result.ok) {
        if (result.reason === "history-not-found") {
          res.status(404).json({
            error: "No matching removal-history entry found for that removedAt.",
            reason: result.reason,
          });
          return;
        }
        // not-a-batch
        res.status(409).json({
          error: "That history entry is not a batch removal — use /reinstate for single-phrase entries.",
          reason: result.reason,
        });
        return;
      }
      // Task #159 — preview mode: return the same `results` /
      // `reinstatedCount` / `skipped` shape so the CLI can reuse the same
      // renderer, but with `dryRun: true` and no state mutation. Mirrors
      // the bulk-remove dry-run pattern (Task #145): both the mutating
      // and dry-run paths return HTTP 200 and callers discriminate on the
      // `dryRun` flag in the body. We report the projected `total` (active
      // list size after the batch would be applied) so reviewers can
      // sanity-check before pressing yes.
      if (isDryRun) {
        res.status(200).json({
          dryRun: true,
          batch: true,
          removedAt: result.removedAt,
          reinstatedCount: result.reinstated,
          skipped: result.skipped,
          // Projected size AFTER the batch would be applied. The pre-batch
          // count is `result.total - result.reinstated` if a reviewer wants
          // to derive it, but the CLI / UI typically just shows "would
          // reinstate N inner phrase(s)".
          total: result.total,
          results: result.results,
          historyEntry: result.historyEntry,
          // Echo back the CURRENT (unchanged) active list so the response
          // shape stays parallel to the mutating path.
          phrases: getHandwavyPhrases(),
          history: getHandwavyPhraseHistory(),
        });
        return;
      }
      res.status(200).json({
        reinstated: true,
        batch: true,
        removedAt: result.removedAt,
        reinstatedCount: result.reinstated,
        skipped: result.skipped,
        total: result.total,
        results: result.results,
        historyEntry: result.historyEntry,
        phrases: getHandwavyPhrases(),
        history: getHandwavyPhraseHistory(),
      });
    } catch (err) {
      req.log?.error(err, "Failed to reinstate hand-wavy phrase batch");
      res.status(500).json({ error: "Failed to reinstate hand-wavy phrase batch." });
    }
  },
);

// Task #120 — In-place edit of a curated phrase. Supports updating `category`
// and/or `rationale` while preserving the original add audit context. The
// phrase string itself is the row identity and is NOT mutable here — to
// rename, reviewers must remove + re-add (which already records both events).
router.patch("/feedback/calibration/handwavy-phrases", requireCalibrationAuth, (req, res) => {
  try {
    const { phrase, category, rationale, reviewer } = (req.body ?? {}) as {
      phrase?: unknown;
      category?: unknown;
      rationale?: unknown;
      reviewer?: unknown;
    };
    if (typeof phrase !== "string" || phrase.trim().length === 0) {
      res.status(400).json({ error: "Body must include a non-empty 'phrase' string." });
      return;
    }
    if (
      category !== undefined &&
      category !== "absence" &&
      category !== "hedging" &&
      category !== "buzzword"
    ) {
      res.status(400).json({ error: "category must be one of 'absence', 'hedging', 'buzzword'." });
      return;
    }
    if (rationale !== undefined && typeof rationale !== "string") {
      res.status(400).json({ error: "rationale must be a string when provided." });
      return;
    }
    if (reviewer !== undefined && typeof reviewer !== "string") {
      res.status(400).json({ error: "reviewer must be a string when provided." });
      return;
    }
    if (category === undefined && rationale === undefined) {
      res.status(400).json({ error: "Provide at least one of 'category' or 'rationale' to edit." });
      return;
    }
    const result = editHandwavyPhrase(
      phrase,
      {
        category: category as "absence" | "hedging" | "buzzword" | undefined,
        rationale: typeof rationale === "string" ? rationale : undefined,
      },
      { reviewer: typeof reviewer === "string" ? reviewer : undefined },
    );
    res.status(200).json({
      edited: result.edited,
      phrase: result.phrase,
      total: result.total,
      marker: result.marker,
      editEntry: result.editEntry,
      phrases: getHandwavyPhrases(),
    });
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof Error && /(must be|category)/i.test(err.message)) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log?.error(err, "Failed to edit hand-wavy phrase");
    res.status(500).json({ error: "Failed to edit hand-wavy phrase." });
  }
});

// Task #130 — undo a brand-new add inside a short window. Mirror of the
// /reinstate flow: takes the phrase + addedAt of the live marker, removes
// the marker, and tags the resulting history row `undone: true` so the
// audit trail clearly records "added then undone" rather than producing an
// unrelated manual-removal entry.
router.post(
  "/feedback/calibration/handwavy-phrases/undo",
  requireCalibrationAuth,
  (req, res) => {
    try {
      const { phrase, addedAt, reviewer } = (req.body ?? {}) as {
        phrase?: unknown;
        addedAt?: unknown;
        reviewer?: unknown;
      };
      if (typeof phrase !== "string" || phrase.trim().length === 0) {
        res.status(400).json({ error: "Body must include a non-empty 'phrase' string." });
        return;
      }
      if (typeof addedAt !== "string" || addedAt.trim().length === 0) {
        res.status(400).json({
          error: "Body must include the 'addedAt' ISO timestamp of the marker to undo.",
        });
        return;
      }
      if (reviewer !== undefined && typeof reviewer !== "string") {
        res.status(400).json({ error: "reviewer must be a string when provided." });
        return;
      }
      const result = undoHandwavyPhrase(phrase, addedAt, {
        reviewer: typeof reviewer === "string" ? reviewer : undefined,
      });
      if (!result.ok) {
        if (result.reason === "not-found" || result.reason === "no-addedAt") {
          res.status(404).json({
            error:
              result.reason === "no-addedAt"
                ? "That phrase has no addedAt timestamp (curated default) and cannot be undone."
                : "No active phrase matches the given phrase + addedAt.",
            reason: result.reason,
          });
          return;
        }
        if (result.reason === "addedAt-mismatch") {
          res.status(409).json({
            error: "The active phrase's addedAt no longer matches — refresh and try again.",
            reason: result.reason,
          });
          return;
        }
        // window-expired
        res.status(409).json({
          error: "The undo window has elapsed. Use the regular Trash flow instead.",
          reason: result.reason,
        });
        return;
      }
      res.status(200).json({
        undone: true,
        phrase: result.phrase,
        total: result.total,
        historyEntry: result.historyEntry,
        phrases: getHandwavyPhrases(),
        history: getHandwavyPhraseHistory(),
      });
    } catch (err) {
      req.log?.error(err, "Failed to undo hand-wavy phrase");
      res.status(500).json({ error: "Failed to undo hand-wavy phrase." });
    }
  },
);

// Task #132 — One-click revert of a single edit-history entry. The reviewer
// supplies the phrase + the `editedAt` of the edit they want to undo. The
// helper computes the inverse update from that entry's before/after and runs
// it through the normal edit path so the audit log stays append-only — the
// revert shows up as a fresh edit entry with the inverse before/after pair.
router.post(
  "/feedback/calibration/handwavy-phrases/revert-edit",
  requireCalibrationAuth,
  (req, res) => {
    try {
      const { phrase, editedAt, reviewer } = (req.body ?? {}) as {
        phrase?: unknown;
        editedAt?: unknown;
        reviewer?: unknown;
      };
      if (typeof phrase !== "string" || phrase.trim().length === 0) {
        res.status(400).json({ error: "Body must include a non-empty 'phrase' string." });
        return;
      }
      if (typeof editedAt !== "string" || editedAt.trim().length === 0) {
        res.status(400).json({
          error: "Body must include the 'editedAt' ISO timestamp of the edit entry to revert.",
        });
        return;
      }
      if (reviewer !== undefined && typeof reviewer !== "string") {
        res.status(400).json({ error: "reviewer must be a string when provided." });
        return;
      }
      const result = revertHandwavyPhraseEdit(phrase, editedAt, {
        reviewer: typeof reviewer === "string" ? reviewer : undefined,
      });
      if (!result.ok) {
        if (result.reason === "phrase-not-found") {
          res.status(404).json({ error: "Phrase not found in active list.", reason: result.reason });
          return;
        }
        // edit-not-found
        res.status(404).json({
          error: "No matching edit entry on that phrase for the supplied editedAt.",
          reason: result.reason,
        });
        return;
      }
      res.status(200).json({
        reverted: true,
        edited: result.edited,
        phrase: result.phrase,
        total: result.total,
        marker: result.marker,
        editEntry: result.editEntry,
        revertedEntry: result.revertedEntry,
        phrases: getHandwavyPhrases(),
      });
    } catch (err) {
      req.log?.error(err, "Failed to revert hand-wavy phrase edit");
      res.status(500).json({ error: "Failed to revert hand-wavy phrase edit." });
    }
  },
);

// Task #135 — DELETE accepts either a single phrase (legacy `{phrase}`) or a
// batch (`{phrases: [...]}`). The batch path runs in one in-memory pass, one
// file rewrite, and one history-log append (containing the list of removed
// phrases) so a release-checklist cleanup of a dozen phrases stops doing a
// dozen round-trips and a dozen history rows.
router.delete("/feedback/calibration/handwavy-phrases", requireCalibrationAuth, async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      phrase?: unknown;
      phrases?: unknown;
      reviewer?: unknown;
      dryRun?: unknown;
      productionScanLimit?: unknown;
    };
    const { phrase, phrases, reviewer, dryRun, productionScanLimit } = body;
    if (reviewer !== undefined && typeof reviewer !== "string") {
      res.status(400).json({ error: "reviewer must be a string when provided." });
      return;
    }
    const reviewerStr = typeof reviewer === "string" ? reviewer : undefined;
    // Task #230 — optional reviewer override for the production-scan window,
    // honored on both the single and batch dry-run paths so the
    // reviewer-chosen window persisted in the calibration UI applies to every
    // production-archive scan, not just the add-phrase preview. We validate
    // on every DELETE (not just dryRun) so a malformed value never makes it
    // past the input layer; non-dry-run paths simply ignore the resolved
    // limit since they don't probe production.
    const productionLimitParse = parseProductionScanLimit(productionScanLimit);
    if (!productionLimitParse.ok) {
      res.status(400).json({ error: productionLimitParse.error });
      return;
    }
    const effectiveProductionLimit = productionLimitParse.limit;

    // Task #229 — optional reviewer override for the production-scan window
    // on the bulk DELETE dry-run, mirroring the add path (Task #125). The
    // field is only consumed on the bulk dry-run path (the only place the
    // production scan currently runs for removals), but we run the
    // validator at the TOP of the handler — before the single-vs-batch
    // branch — so:
    //   1. A malformed value is rejected on EVERY DELETE (single or bulk,
    //      dry-run or real), guaranteeing bad input cannot slip past the
    //      validator into a state-mutating call.
    //   2. The single-phrase path accepts a well-formed value but does
    //      not consume it; its dry-run still uses the legacy 2000-row
    //      default. Wiring the single-phrase preview through this knob
    //      is tracked as a follow-up task.
    let effectiveBulkProductionLimit = PRODUCTION_PREVIEW_LIMIT;
    if (productionScanLimit !== undefined) {
      const v = Number(productionScanLimit);
      if (
        !Number.isFinite(v) ||
        !Number.isInteger(v) ||
        v < PRODUCTION_PREVIEW_LIMIT_MIN ||
        v > PRODUCTION_PREVIEW_LIMIT_MAX
      ) {
        res.status(400).json({
          error: `productionScanLimit must be an integer between ${PRODUCTION_PREVIEW_LIMIT_MIN} and ${PRODUCTION_PREVIEW_LIMIT_MAX}.`,
        });
        return;
      }
      effectiveBulkProductionLimit = v;
    }

    // Batch path — `{phrases: string[]}`. Mutually exclusive with `phrase`.
    if (phrases !== undefined) {
      if (phrase !== undefined) {
        res.status(400).json({
          error: "Provide either 'phrase' (single removal) or 'phrases' (batch removal), not both.",
        });
        return;
      }
      if (!Array.isArray(phrases)) {
        res.status(400).json({ error: "'phrases' must be an array of strings." });
        return;
      }
      if (phrases.length === 0) {
        res.status(400).json({ error: "'phrases' must contain at least one phrase." });
        return;
      }
      if (phrases.length > 200) {
        res.status(400).json({ error: "'phrases' batch is capped at 200 entries per request." });
        return;
      }
      const cleaned: string[] = [];
      for (const p of phrases) {
        if (typeof p !== "string" || p.trim().length === 0) {
          res.status(400).json({ error: "Every entry in 'phrases' must be a non-empty string." });
          return;
        }
        cleaned.push(p);
      }
      // Task #145 — preview mode: compute the same per-phrase results plus a
      // corpus impact summary, but DO NOT mutate the active list, history, or
      // cache. Reviewers (and the CLI `--dry-run` flag) get a "of these N,
      // X are not on the active list, Y are duplicates, the remaining Z
      // currently flag W legitimate hand-wavy reports between them" preview
      // before they pull the trigger.
      if (dryRun === true) {
        const preview = previewRemoveHandwavyPhrasesBatch(cleaned);
        const removedNormalized = preview.results
          .filter((r) => r.removed)
          .map((r) => r.phrase);
        const remainingNormalized = preview.nextMarkers.map((m) => m.phrase);
        const corpusImpact = previewRemovalAgainstCorpus(removedNormalized, remainingNormalized);
        let productionImpact: RemovalImpact | null = null;
        let productionError: string | null = null;
        if (removedNormalized.length === 0) {
          // Skip the DB probe entirely when nothing would be removed — there
          // is by definition no impact and no point spending the query.
          productionImpact = {
            total: 0,
            byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
            validDetectionsLost: 0,
            falsePositivesDropped: 0,
            corpusSize: 0,
            sampleMatches: [],
            warning: null,
            // Task #218 — empty/skipped scan has no createdAt window to
            // report; mirrors `scoreProductionRows` for a zero-row scan.
            oldestCreatedAt: null,
            newestCreatedAt: null,
          };
        } else {
          try {
            // Task #229 / #230 — honor the reviewer-supplied scan window
            // from the shared calibration preference (already validated
            // above), falling back to the legacy 2000-row default when
            // omitted. Mirrors the add-time preview (Task #125).
            productionImpact = await previewRemovalAgainstProduction(
              removedNormalized,
              remainingNormalized,
              effectiveProductionLimit,
            );
          } catch (err) {
            req.log?.error(err, "Production removal dry-run scan failed");
            productionError = "Production archive scan failed; only curated-corpus signal is shown.";
          }
        }
        res.status(200).json({
          dryRun: true,
          batch: true,
          // Mirror the post-mutation field names so the client can reuse the
          // same renderer; the `wouldRemove` count is what would have been
          // removed had this not been a dry run.
          wouldRemove: preview.wouldRemove,
          notFound: preview.notFound,
          duplicateInBatch: preview.duplicateInBatch,
          // Active list size BEFORE the batch (no mutation occurred).
          total: preview.total,
          // Projected size AFTER the batch would be applied.
          projectedTotal: preview.nextMarkers.length,
          results: preview.results,
          dryRunImpact: {
            corpus: corpusImpact,
            production: productionImpact,
            productionError,
            // Task #229 / #230 — echo the reviewer-chosen window (or default)
            // so the UI can label the production block ("last N of up to M
            // reports") with the window it actually scanned, matching the
            // add-phrase preview's behavior.
            productionLimit: effectiveProductionLimit,
          },
          phrases: getHandwavyPhrases(),
        });
        return;
      }
      const result = removeHandwavyPhrasesBatch(cleaned, { reviewer: reviewerStr });
      // Status code policy: 200 when at least one phrase was removed (even if
      // some were not-found), 404 only when nothing matched at all.
      const status = result.removed > 0 ? 200 : 404;
      res.status(status).json({
        batch: true,
        removed: result.removed,
        notFound: result.notFound,
        total: result.total,
        results: result.results,
        historyEntry: result.historyEntry ?? null,
        phrases: getHandwavyPhrases(),
        history: getHandwavyPhraseHistory(),
      });
      return;
    }

    // Single-phrase legacy path.
    if (typeof phrase !== "string" || phrase.trim().length === 0) {
      res.status(400).json({ error: "Body must include a non-empty 'phrase' string." });
      return;
    }

    // Task #155 — single-phrase dry-run preview. Mirrors the batch dry-run
    // shape (with `batch: false`) so the in-UI Trash flow can show the same
    // corpus + production removal-impact warning before a one-click removal,
    // without mutating the active list, history, or cache. Reuses
    // previewRemoveHandwavyPhrasesBatch with a one-element list so the
    // per-phrase result and the impact computation are identical to the
    // batch path.
    if (dryRun === true) {
      const preview = previewRemoveHandwavyPhrasesBatch([phrase]);
      const removedNormalized = preview.results
        .filter((r) => r.removed)
        .map((r) => r.phrase);
      const remainingNormalized = preview.nextMarkers.map((m) => m.phrase);
      const corpusImpact = previewRemovalAgainstCorpus(removedNormalized, remainingNormalized);
      let productionImpact: RemovalImpact | null = null;
      let productionError: string | null = null;
      if (removedNormalized.length === 0) {
        // Skip the DB probe entirely when the phrase is not on the active
        // list — there is by definition no impact and no point spending
        // the query.
        productionImpact = {
          total: 0,
          byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
          validDetectionsLost: 0,
          falsePositivesDropped: 0,
          corpusSize: 0,
          sampleMatches: [],
          warning: null,
          // Task #218 — empty/skipped scan has no createdAt window to
          // report; mirrors `scoreProductionRows` for a zero-row scan.
          oldestCreatedAt: null,
          newestCreatedAt: null,
        };
      } else {
        try {
          // Task #230 — honor the reviewer-supplied scan window from the
          // shared calibration preference, falling back to the legacy
          // 2000-row default when omitted.
          productionImpact = await previewRemovalAgainstProduction(
            removedNormalized,
            remainingNormalized,
            effectiveProductionLimit,
          );
        } catch (err) {
          req.log?.error(err, "Production removal dry-run scan failed");
          productionError = "Production archive scan failed; only curated-corpus signal is shown.";
        }
      }
      const single = preview.results[0];
      res.status(200).json({
        dryRun: true,
        batch: false,
        // Mirror the batch dry-run field names so the client can reuse the
        // same renderer; here `wouldRemove` is 0 or 1.
        wouldRemove: preview.wouldRemove,
        notFound: preview.notFound,
        duplicateInBatch: preview.duplicateInBatch,
        phrase: single.phrase,
        raw: single.raw,
        removed: single.removed,
        reason: single.reason ?? null,
        // Active list size BEFORE the removal (no mutation occurred).
        total: preview.total,
        // Projected size AFTER the removal would be applied.
        projectedTotal: preview.nextMarkers.length,
        results: preview.results,
        dryRunImpact: {
          corpus: corpusImpact,
          production: productionImpact,
          productionError,
          // Task #230 — echo the reviewer-chosen window (or default) so the
          // UI can label the production block with the window it actually
          // scanned, matching the add-phrase preview's behavior.
          productionLimit: effectiveProductionLimit,
        },
        phrases: getHandwavyPhrases(),
      });
      return;
    }

    const result = removeHandwavyPhrase(phrase, { reviewer: reviewerStr });
    if (!result.removed) {
      res.status(404).json({ ...result, error: "Phrase not found." });
      return;
    }
    res.json({
      removed: result.removed,
      phrase: result.phrase,
      total: result.total,
      historyEntry: result.historyEntry,
      phrases: getHandwavyPhrases(),
      history: getHandwavyPhraseHistory(),
    });
  } catch (err) {
    req.log?.error(err, "Failed to remove hand-wavy phrase");
    res.status(500).json({ error: "Failed to remove hand-wavy phrase." });
  }
});

export default router;
