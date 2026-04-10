import { Router, type IRouter } from "express";
import healthRouter from "./health";
import reportsRouter from "./reports";
import feedbackRouter from "./feedback";
import statsRouter from "./stats";

const router: IRouter = Router();

router.use(healthRouter);
router.use(reportsRouter);
router.use(feedbackRouter);
router.use(statsRouter);

export default router;
