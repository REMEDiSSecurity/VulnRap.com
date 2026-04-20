import { Router, type IRouter } from "express";
import healthRouter from "./health";
import reportsRouter from "./reports";
import feedbackRouter from "./feedback";
import calibrationRouter from "./calibration";
import statsRouter from "./stats";
import testFixturesRouter from "./test-fixtures";

const router: IRouter = Router();

router.use(healthRouter);
router.use(reportsRouter);
router.use(feedbackRouter);
router.use(calibrationRouter);
router.use(statsRouter);
// v3.6.0 §7: Dev-only test endpoint at GET /api/test/run. The handler itself
// returns 404 in production, so it is safe to mount unconditionally here.
router.use(testFixturesRouter);

export default router;
