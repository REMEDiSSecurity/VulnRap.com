import { Router, type IRouter } from "express";
import { generateCalibrationReport, type BucketAnalysis } from "../lib/calibration";
import { getCurrentConfig, getConfigHistory, applyNewConfig } from "../lib/scoring-config";
import { generateAvriDriftReport } from "../lib/avri-drift";
import {
  getHandwavyPhrases,
  addHandwavyPhrase,
  removeHandwavyPhrase,
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

function previewHandwavyPhrase(phrase: string): DryRunMatches {
  const needle = normalizeForMatch(phrase);
  const cohorts: Array<{ tier: CorpusTier; fixtures: typeof TEST_FIXTURE_COHORTS.T1 }> = [
    { tier: "T1_LEGIT", fixtures: TEST_FIXTURE_COHORTS.T1 },
    { tier: "T2_BORDERLINE", fixtures: TEST_FIXTURE_COHORTS.T2 },
    { tier: "T3_SLOP", fixtures: TEST_FIXTURE_COHORTS.T3 },
    { tier: "T4_HALLUCINATED", fixtures: TEST_FIXTURE_COHORTS.T4 },
  ];
  const byTier = { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 };
  const sampleMatches: Array<{ id: string; tier: CorpusTier }> = [];
  let total = 0;
  let corpusSize = 0;
  for (const { tier, fixtures } of cohorts) {
    corpusSize += fixtures.length;
    for (const f of fixtures) {
      const haystack = f.text.toLowerCase().replace(/\s+/g, " ");
      if (!needle || !haystack.includes(needle)) continue;
      total += 1;
      if (tier === "T1_LEGIT") byTier.t1Legit += 1;
      else if (tier === "T2_BORDERLINE") byTier.t2Borderline += 1;
      else if (tier === "T3_SLOP") byTier.t3Slop += 1;
      else byTier.t4Hallucinated += 1;
      if (sampleMatches.length < 12) sampleMatches.push({ id: f.id, tier });
    }
  }
  const falsePositives = byTier.t1Legit + byTier.t2Borderline;
  let warning: string | null = null;
  if (falsePositives > 0) {
    const noun = falsePositives === 1 ? "legitimate report" : "legitimate reports";
    warning = `This phrase would have flagged ${falsePositives} ${noun} (${byTier.t1Legit} GREEN, ${byTier.t2Borderline} YELLOW) in the curated benchmark corpus — consider rewording.`;
  }
  return { total, byTier, falsePositives, corpusSize, sampleMatches, warning };
}

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
    res.json({ phrases, total: phrases.length });
  } catch (err) {
    _req.log?.error(err, "Failed to read hand-wavy phrases");
    res.status(500).json({ error: "Failed to read hand-wavy phrases." });
  }
});

router.post("/feedback/calibration/handwavy-phrases", requireCalibrationAuth, (req, res) => {
  try {
    const { phrase, category, dryRun } = (req.body ?? {}) as {
      phrase?: unknown;
      category?: unknown;
      dryRun?: unknown;
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
      const phrases = getHandwavyPhrases();
      const effectiveCategory = (category ?? "absence") as "absence" | "hedging" | "buzzword";
      res.status(200).json({
        dryRun: true,
        added: false,
        phrase: normalized,
        category: effectiveCategory,
        total: phrases.length,
        phrases,
        dryRunMatches: matches,
      });
      return;
    }
    const result = addHandwavyPhrase(phrase, category);
    res.status(result.added ? 201 : 200).json({
      ...result,
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

router.delete("/feedback/calibration/handwavy-phrases", requireCalibrationAuth, (req, res) => {
  try {
    const { phrase } = (req.body ?? {}) as { phrase?: unknown };
    if (typeof phrase !== "string" || phrase.trim().length === 0) {
      res.status(400).json({ error: "Body must include a non-empty 'phrase' string." });
      return;
    }
    const result = removeHandwavyPhrase(phrase);
    if (!result.removed) {
      res.status(404).json({ ...result, error: "Phrase not found." });
      return;
    }
    res.json({ ...result, phrases: getHandwavyPhrases() });
  } catch (err) {
    req.log?.error(err, "Failed to remove hand-wavy phrase");
    res.status(500).json({ error: "Failed to remove hand-wavy phrase." });
  }
});

export default router;
