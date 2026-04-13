import { Router, type IRouter } from "express";
import { generateCalibrationReport } from "../lib/calibration";
import { getCurrentConfig, getConfigHistory, applyNewConfig } from "../lib/scoring-config";

const router: IRouter = Router();

router.get("/feedback/calibration", async (_req, res) => {
  try {
    const report = await generateCalibrationReport();
    res.json(report);
  } catch (err) {
    _req.log?.error(err, "Failed to generate calibration report");
    res.status(500).json({ error: "Failed to generate calibration report." });
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
