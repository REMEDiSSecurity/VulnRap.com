// Task #617 — Public-safe transparency endpoints. Wraps the internal
// AVRI drift compute with a redacted DTO so the public `/transparency`
// page can show that the platform actively monitors itself for
// calibration drift without exposing reviewer-only fields.
import { Router, type IRouter } from "express";
import { getPublicDriftSummary } from "../lib/avri-drift-public";

const router: IRouter = Router();

router.get("/public/drift-summary", async (req, res) => {
  try {
    const summary = await getPublicDriftSummary();
    res.json(summary);
  } catch (err) {
    req.log?.error(err, "Failed to generate public drift summary");
    res.status(500).json({ error: "Failed to generate public drift summary." });
  }
});

export default router;
