import { Router, type IRouter } from "express";
import healthRouter from "./health";
import reportsRouter from "./reports";
import feedbackRouter from "./feedback";
import calibrationRouter from "./calibration";
import statsRouter from "./stats";
import publicRouter from "./public";
import latencyRouter from "./latency";
import testFixturesRouter from "./test-fixtures";
import newsletterRouter from "./newsletter";
import cohortRouter from "./cohort";
import presetsRouter from "./presets";
import phraseSuggestionsRouter from "./phrase-suggestions";
import internalRouter from "./internal";
import auditLogRouter from "./audit-log";
import webhooksRouter from "./webhooks";
import galleryRouter from "./gallery";
import ogCardRouter from "./og-card";
import embedRouter from "./embed";
import roadmapRouter from "./roadmap";

const router: IRouter = Router();

router.use(healthRouter);
router.use(reportsRouter);
router.use(feedbackRouter);
router.use(calibrationRouter);
router.use(statsRouter);
router.use(latencyRouter);
router.use(newsletterRouter);
router.use(cohortRouter);
router.use(presetsRouter);
router.use(phraseSuggestionsRouter);
router.use(internalRouter);
router.use(auditLogRouter);
router.use(webhooksRouter);
router.use(galleryRouter);
router.use(ogCardRouter);
router.use(embedRouter);
router.use(roadmapRouter);
router.use(publicRouter);
// v3.6.0 §7: Dev-only test endpoint at GET /api/test/run. The handler itself
// returns 404 in production, so it is safe to mount unconditionally here.
router.use(testFixturesRouter);

export default router;
