import { Router, type IRouter } from "express";
import { db, reportsTable } from "@workspace/db";
import { and, isNotNull, sql } from "drizzle-orm";
import { generateCalibrationReport, type BucketAnalysis } from "../lib/calibration";
import { getCurrentConfig, getConfigHistory, applyNewConfig } from "../lib/scoring-config";
import { generateAvriDriftReport } from "../lib/avri-drift";
import {
  getHandwavyPhrases,
  getHandwavyPhraseHistory,
  addHandwavyPhrase,
  removeHandwavyPhrase,
  reinstateHandwavyPhrase,
  editHandwavyPhrase,
  type HandwavyCategory,
  type HandwavyMarker,
} from "../lib/engines/avri/handwavy-phrases";
import { TEST_FIXTURE_COHORTS } from "./test-fixtures";
import { requireCalibrationAuth } from "../middlewares/require-calibration-auth";

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
  return { total, byTier, falsePositives, corpusSize, sampleMatches, warning };
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
const PRODUCTION_PREVIEW_LIMIT = 2000;

// Pure scoring step (no DB) so it can be unit-tested independently of the
// drizzle layer.
function scoreProductionRows(
  phrase: string,
  rows: Array<{ id: number | string; label: string | null; contentText: string | null }>,
): DryRunMatches {
  const needle = normalizeForMatch(phrase);
  const tiered: Array<{ id: string; tier: CorpusTier; text: string }> = [];
  for (const r of rows) {
    const tier = productionLabelToTier(r.label);
    if (!tier || r.contentText == null) continue;
    tiered.push({ id: String(r.id), tier, text: r.contentText });
  }
  const { total, byTier, sampleMatches } = tallyMatches(needle, tiered);
  const falsePositives = byTier.t1Legit + byTier.t2Borderline;
  let warning: string | null = null;
  if (falsePositives > 0) {
    const noun = falsePositives === 1 ? "legitimate report" : "legitimate reports";
    warning = `This phrase would have flagged ${falsePositives} ${noun} (${byTier.t1Legit} GREEN, ${byTier.t2Borderline} YELLOW) in the most recent ${tiered.length} production reports — consider rewording.`;
  }
  return { total, byTier, falsePositives, corpusSize: tiered.length, sampleMatches, warning };
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

// Exported for unit testing the pure scoring step without DB access.
export const __testing = {
  productionLabelToTier,
  scoreProductionRows,
  previewHandwavyPhrase,
  detectCuratedOverlaps,
  PRODUCTION_PREVIEW_LIMIT,
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
        engineWeights: { engine1: 0.05, engine2: 0.55, engine3: 0.40 },
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
router.get("/feedback/calibration/handwavy-phrases", (_req, res) => {
  try {
    const phrases = getHandwavyPhrases();
    const history = getHandwavyPhraseHistory();
    res.json({ phrases, total: phrases.length, history });
  } catch (err) {
    _req.log?.error(err, "Failed to read hand-wavy phrases");
    res.status(500).json({ error: "Failed to read hand-wavy phrases." });
  }
});

router.post("/feedback/calibration/handwavy-phrases", requireCalibrationAuth, async (req, res) => {
  try {
    const { phrase, category, dryRun, reviewer, rationale } = (req.body ?? {}) as {
      phrase?: unknown;
      category?: unknown;
      dryRun?: unknown;
      reviewer?: unknown;
      rationale?: unknown;
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
        productionMatches = await previewHandwavyPhraseAgainstProduction(normalized);
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
        dryRunMatchesProductionLimit: PRODUCTION_PREVIEW_LIMIT,
        dryRunOverlaps: overlaps,
      });
      return;
    }
    const result = addHandwavyPhrase(phrase, category, {
      reviewer: typeof reviewer === "string" ? reviewer : undefined,
      rationale: typeof rationale === "string" ? rationale : undefined,
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

router.delete("/feedback/calibration/handwavy-phrases", requireCalibrationAuth, (req, res) => {
  try {
    const { phrase, reviewer } = (req.body ?? {}) as { phrase?: unknown; reviewer?: unknown };
    if (typeof phrase !== "string" || phrase.trim().length === 0) {
      res.status(400).json({ error: "Body must include a non-empty 'phrase' string." });
      return;
    }
    if (reviewer !== undefined && typeof reviewer !== "string") {
      res.status(400).json({ error: "reviewer must be a string when provided." });
      return;
    }
    const result = removeHandwavyPhrase(phrase, {
      reviewer: typeof reviewer === "string" ? reviewer : undefined,
    });
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
