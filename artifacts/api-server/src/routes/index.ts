import { Router, type IRouter } from "express";
import healthRouter from "./health";
import versionRouter from "./version";
import reportsRouter from "./reports";
import feedbackRouter from "./feedback";
import feedbackV2Router from "./feedback-v2";
import calibrationRouter from "./calibration";
import statsRouter from "./stats";
import publicRouter from "./public";
import latencyRouter from "./latency";
import testFixturesRouter from "./test-fixtures";
import cohortRouter from "./cohort";
import presetsRouter from "./presets";
import phraseSuggestionsRouter from "./phrase-suggestions";
import internalRouter from "./internal";
import auditLogRouter from "./audit-log";
import webhooksRouter from "./webhooks";
import galleryRouter from "./gallery";
import incidentsRouter from "./incidents";
import showcaseRouter from "./showcase";
import showcaseNominationsRouter from "./showcase-nominations";
import ogCardRouter from "./og-card";
import embedRouter from "./embed";
import roadmapRouter from "./roadmap";
import statusRouter from "./status";
import testYourselfRouter from "./test-yourself";
import preferencesRouter from "./preferences";
import slackRelayRouter from "./slack-relay";

const router: IRouter = Router();

router.use(healthRouter);
router.use(versionRouter);
router.use(reportsRouter);
router.use(feedbackRouter);
router.use(feedbackV2Router);
router.use(calibrationRouter);
router.use(statsRouter);
router.use(latencyRouter);
router.use(cohortRouter);
router.use(presetsRouter);
router.use(phraseSuggestionsRouter);
router.use(internalRouter);
router.use(auditLogRouter);
router.use(webhooksRouter);
router.use(galleryRouter);
router.use(incidentsRouter);
router.use(showcaseRouter);
router.use(showcaseNominationsRouter);
router.use(ogCardRouter);
router.use(embedRouter);
router.use(roadmapRouter);
router.use(statusRouter);
router.use(testYourselfRouter);
router.use(preferencesRouter);
// Hosted Slack relay — UNDOCUMENTED, alpha-gated. Returns 503 with
// `{ error: "slack_relay_disabled" }` when SLACK_CLIENT_ID /
// SLACK_CLIENT_SECRET / SLACK_RELAY_MASTER_KEY are not all set, so
// it is safe to mount unconditionally. See routes/slack-relay.ts.
router.use(slackRelayRouter);
router.use(publicRouter);
// v3.6.0 §7: Dev-only test endpoint at GET /api/test/run. The handler itself
// returns 404 in production, so it is safe to mount unconditionally here.
router.use(testFixturesRouter);

export default router;
