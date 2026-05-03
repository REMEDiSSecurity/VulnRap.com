// Task #673 — Webhook delivery worker.
//
// Fired (fire-and-forget) from POST /api/reports after the response has
// been written, so a slow / failing webhook destination can never
// degrade the user-facing submit path. For each webhook subscribed to
// `report.scored`, we POST the JSON payload with an HMAC SHA-256
// signature header derived from the webhook's signing secret, retrying
// with exponential backoff up to MAX_ATTEMPTS attempts.
//
// On the first successful 2xx response we stamp `last_delivered_at` and
// reset `failure_count`. On terminal failure (all attempts exhausted)
// we increment `failure_count` so reviewers can spot dead destinations
// from the management UI.
//
// Secrets are never persisted plaintext — we only have the SHA-256
// hash. To sign deliveries, we keep a per-process in-memory map of
// {webhookId -> rawSecret} populated at registration time. A process
// restart loses the cache; the destination's HMAC verification will
// then fail until the webhook is re-registered. This is an explicit
// v1 trade-off (call out in the docs block on /api).

import crypto from "node:crypto";
import { db, webhooksTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export const REPORT_SCORED_EVENT = "report.scored" as const;
export type WebhookEventType = typeof REPORT_SCORED_EVENT;

const MAX_ATTEMPTS = 5;
// 1s, 2s, 4s, 8s, 16s — 31s worst-case wall clock per delivery. Each
// dispatch is fire-and-forget so this never blocks the request path.
const BACKOFF_BASE_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

// In-memory registry of webhook signing secrets. Populated when a
// webhook is registered (we have the plaintext at that moment) and
// when a process boots fresh, the cache is empty until the next
// register. We intentionally do NOT persist the plaintext — see file
// header for the trade-off.
const SECRET_CACHE = new Map<number, string>();

export function rememberWebhookSecret(webhookId: number, secret: string): void {
  SECRET_CACHE.set(webhookId, secret);
}

export function forgetWebhookSecret(webhookId: number): void {
  SECRET_CACHE.delete(webhookId);
}

export function getCachedWebhookSecret(webhookId: number): string | null {
  return SECRET_CACHE.get(webhookId) ?? null;
}

export function hashSecret(secret: string): string {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function signPayload(secret: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export interface ReportScoredPayload {
  event: typeof REPORT_SCORED_EVENT;
  reportId: number;
  slopScore: number;
  slopTier: string;
  compositeScore: number | null;
  label: string | null;
  createdAt: string;
}

interface DeliveryDeps {
  fetch?: typeof fetch;
  setTimeout?: typeof setTimeout;
}

let deps: DeliveryDeps = {};

// Test seam — swap fetch / setTimeout for deterministic delivery tests.
export function __setWebhookDeliveryDepsForTests(d: DeliveryDeps | null): void {
  deps = d ?? {};
}

function getFetch(): typeof fetch {
  return deps.fetch ?? fetch;
}

function getSetTimeout(): typeof setTimeout {
  return deps.setTimeout ?? setTimeout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => getSetTimeout()(resolve, ms));
}

async function deliverOne(
  webhookId: number,
  url: string,
  secret: string,
  payload: ReportScoredPayload,
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const signature = signPayload(secret, body);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = getSetTimeout()(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await getFetch()(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vulnrap-event": payload.event,
          "x-vulnrap-signature": `sha256=${signature}`,
          "x-vulnrap-webhook-id": String(webhookId),
          "x-vulnrap-delivery-attempt": String(attempt),
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status >= 200 && res.status < 300) {
        return true;
      }
      logger.warn(
        { webhookId, url, attempt, status: res.status },
        "[webhook-delivery] non-2xx response",
      );
    } catch (err) {
      clearTimeout(timer);
      logger.warn(
        { webhookId, url, attempt, err: err instanceof Error ? err.message : String(err) },
        "[webhook-delivery] request failed",
      );
    }
    if (attempt < MAX_ATTEMPTS) {
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
    }
  }
  return false;
}

async function recordSuccess(webhookId: number): Promise<void> {
  try {
    await db
      .update(webhooksTable)
      .set({ lastDeliveredAt: new Date(), failureCount: 0 })
      .where(eq(webhooksTable.id, webhookId));
  } catch (err) {
    logger.error(
      { webhookId, err: err instanceof Error ? err.message : String(err) },
      "[webhook-delivery] failed to record success",
    );
  }
}

async function recordFailure(webhookId: number): Promise<void> {
  try {
    await db
      .update(webhooksTable)
      .set({ failureCount: sql`${webhooksTable.failureCount} + 1` })
      .where(eq(webhooksTable.id, webhookId));
  } catch (err) {
    logger.error(
      { webhookId, err: err instanceof Error ? err.message : String(err) },
      "[webhook-delivery] failed to record failure",
    );
  }
}

export async function dispatchReportScoredEvent(payload: ReportScoredPayload): Promise<void> {
  let subscribers: Array<{ id: number; url: string }>;
  try {
    subscribers = await db
      .select({
        id: webhooksTable.id,
        url: webhooksTable.url,
        eventTypes: webhooksTable.eventTypes,
      })
      .from(webhooksTable)
      .then((rows) =>
        rows
          .filter((r) => Array.isArray(r.eventTypes) && r.eventTypes.includes(REPORT_SCORED_EVENT))
          .map((r) => ({ id: r.id, url: r.url })),
      );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "[webhook-delivery] failed to load subscribers",
    );
    return;
  }
  if (subscribers.length === 0) return;
  await Promise.all(
    subscribers.map(async ({ id, url }) => {
      const secret = getCachedWebhookSecret(id);
      if (!secret) {
        logger.warn(
          { webhookId: id, url },
          "[webhook-delivery] no cached signing secret (process restart since registration); skipping. Re-register the webhook to resume deliveries.",
        );
        return;
      }
      const ok = await deliverOne(id, url, secret, payload);
      if (ok) await recordSuccess(id);
      else await recordFailure(id);
    }),
  );
}
