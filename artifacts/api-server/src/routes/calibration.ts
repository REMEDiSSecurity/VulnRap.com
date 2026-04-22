import { Router, type IRouter } from "express";
import { generateCalibrationReport, type BucketAnalysis } from "../lib/calibration";
import { getCurrentConfig, getConfigHistory, applyNewConfig } from "../lib/scoring-config";
import { generateAvriDriftReport } from "../lib/avri-drift";

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

router.post("/feedback/calibration/apply", async (req, res) => {
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

export default router;
