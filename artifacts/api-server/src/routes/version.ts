import { Router, type IRouter } from "express";
import { GetVersionResponse } from "@workspace/api-zod";
import { getBuildInfo } from "../lib/build-info";

const router: IRouter = Router();

router.get("/version", (_req, res) => {
  // GetVersionResponse is orval's name for the VersionInfo schema (it
  // keys the runtime zod export off the operationId, mirroring how
  // healthCheck => HealthCheckResponse).
  const data = GetVersionResponse.parse(getBuildInfo());
  res.json(data);
});

export default router;
