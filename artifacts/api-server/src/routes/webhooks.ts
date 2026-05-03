// Task #673 — Reviewer-managed webhook registration / listing / deletion.
//
// Reviewers register a destination URL plus the events they want to
// receive. v1 only supports the `report.scored` event (fired after a
// successful POST /api/reports). All endpoints are gated by
// CALIBRATION_TOKEN — POST/DELETE through requireCalibrationAuth (per-IP
// throttle on wrong token), GET through requireCalibrationAuthStrict
// because the listing exposes destination URLs and failure counts.

import { Router, type IRouter } from "express";
import { db, webhooksTable, type Webhook } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  requireCalibrationAuth,
  requireCalibrationAuthStrict,
} from "../middlewares/require-calibration-auth";
import { auditLogMutationMiddleware } from "../middlewares/audit-log-middleware";
import {
  REPORT_SCORED_EVENT,
  forgetWebhookSecret,
  generateWebhookSecret,
  hashSecret,
  rememberWebhookSecret,
} from "../lib/webhook-delivery";

const SUPPORTED_EVENTS = new Set<string>([REPORT_SCORED_EVENT]);
const MAX_URL_LEN = 1000;

const router: IRouter = Router();

router.use("/webhooks", auditLogMutationMiddleware);

function isValidUrl(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  if (raw.length === 0 || raw.length > MAX_URL_LEN) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function serializeWebhook(row: Webhook): {
  id: number;
  url: string;
  eventTypes: string[];
  createdAt: string;
  lastDeliveredAt: string | null;
  failureCount: number;
} {
  return {
    id: row.id,
    url: row.url,
    eventTypes: row.eventTypes ?? [],
    createdAt: row.createdAt.toISOString(),
    lastDeliveredAt: row.lastDeliveredAt
      ? row.lastDeliveredAt.toISOString()
      : null,
    failureCount: row.failureCount,
  };
}

router.post("/webhooks", requireCalibrationAuth, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const url = body.url;
  if (!isValidUrl(url)) {
    res
      .status(400)
      .json({ error: "url must be an http(s) URL up to 1000 characters." });
    return;
  }
  const eventTypesRaw = Array.isArray(body.eventTypes)
    ? body.eventTypes
    : [REPORT_SCORED_EVENT];
  const eventTypes: string[] = [];
  for (const evt of eventTypesRaw) {
    if (typeof evt !== "string" || !SUPPORTED_EVENTS.has(evt)) {
      res.status(400).json({
        error: `Unsupported event type. v1 only supports: ${[...SUPPORTED_EVENTS].join(", ")}`,
      });
      return;
    }
    if (!eventTypes.includes(evt)) eventTypes.push(evt);
  }
  if (eventTypes.length === 0) {
    res
      .status(400)
      .json({ error: "eventTypes must contain at least one event." });
    return;
  }

  const secret = generateWebhookSecret();
  const secretHash = hashSecret(secret);

  try {
    const [inserted] = await db
      .insert(webhooksTable)
      .values({
        url,
        secretHash,
        eventTypes,
      })
      .returning();
    rememberWebhookSecret(inserted.id, secret);
    res.status(201).json({
      ...serializeWebhook(inserted),
      // Returned exactly once — the server only stores the hash, so the
      // caller MUST persist this now or re-register to receive a new one.
      secret,
    });
  } catch (err) {
    req.log?.error(err, "webhooks: insert failed");
    res.status(500).json({ error: "Failed to register webhook." });
  }
});

router.get("/webhooks", requireCalibrationAuthStrict, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(webhooksTable)
      .orderBy(desc(webhooksTable.createdAt), desc(webhooksTable.id));
    res.status(200).json({ webhooks: rows.map(serializeWebhook) });
  } catch (err) {
    req.log?.error(err, "webhooks: list failed");
    res.status(500).json({ error: "Failed to list webhooks." });
  }
});

router.delete("/webhooks/:id", requireCalibrationAuth, async (req, res) => {
  const id = Number.parseInt(String(req.params.id ?? ""), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid webhook id." });
    return;
  }
  try {
    const deleted = await db
      .delete(webhooksTable)
      .where(eq(webhooksTable.id, id))
      .returning({ id: webhooksTable.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "Webhook not found." });
      return;
    }
    forgetWebhookSecret(id);
    res.status(200).json({ id });
  } catch (err) {
    req.log?.error(err, "webhooks: delete failed");
    res.status(500).json({ error: "Failed to delete webhook." });
  }
});

export default router;
