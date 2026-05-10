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
//
// Task #1310 — SSRF / DNS-rebinding protection at delivery time:
//
//   * Before each delivery attempt we resolve the destination hostname
//     and run it through `checkPrivateHost`. A registration-time check
//     is not enough on its own because an attacker can set their DNS
//     records to a public IP at registration time and then flip them
//     to a private IP afterwards (DNS rebinding).
//   * The resolved IP is then **pinned** for the actual fetch via an
//     undici Agent whose `connect.lookup` callback always returns that
//     IP. This closes the TOCTOU window between the check and the
//     network connect, where the resolver could otherwise return a
//     different address than the one we just validated.

import crypto from "node:crypto";
import { db, webhooksTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import {
  checkPrivateHost,
  resolveAllAddresses,
  type ResolveFn,
} from "./private-host-guard";

const IS_PRODUCTION = process.env.NODE_ENV === "production";

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
  /**
   * DNS resolver injected for tests. Production uses
   * {@link resolveAllAddresses} (node:dns/promises). Returns every
   * A/AAAA record so the SSRF guard sees the full set.
   */
  resolve?: ResolveFn;
  /**
   * Skip the IP-pinned dispatcher path. When `true`, the delivery
   * fetch goes out without a custom undici Agent, which is only safe
   * when the caller has already validated the destination by some
   * other means (test stub, etc.). Defaults to `false`.
   */
  skipIpPinning?: boolean;
}

let deps: DeliveryDeps = {};

// Test seam — swap fetch / setTimeout / resolver for deterministic
// delivery tests, and disable IP pinning so the stubbed fetch sees the
// original URL (otherwise the undici dispatcher would intercept and
// the stub would never run).
export function __setWebhookDeliveryDepsForTests(d: DeliveryDeps | null): void {
  deps = d ?? {};
}

function getFetch(): typeof fetch {
  return deps.fetch ?? fetch;
}

function getSetTimeout(): typeof setTimeout {
  return deps.setTimeout ?? setTimeout;
}

function getResolve(): ResolveFn {
  return deps.resolve ?? resolveAllAddresses;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => getSetTimeout()(resolve, ms));
}

/**
 * Build an undici Agent that pins the connect-time DNS lookup to the
 * caller-supplied IP. Used so the actual TCP connect targets the
 * exact address we validated, not whatever the system resolver
 * happens to return at the moment of the connect (which would be
 * vulnerable to DNS rebinding).
 *
 * Imported dynamically because undici's typed exports differ slightly
 * across the Node versions the api-server runs on, and the codebase
 * generally avoids tight coupling to undici internals.
 */
async function buildPinnedDispatcher(
  ip: string,
): Promise<{ dispatcher: unknown; close: () => Promise<void> } | null> {
  try {
    // undici is now an explicit dependency of @workspace/api-server
    // (so production builds can be sure the dynamic import resolves).
    // Narrow the surface to the one constructor we use.
    const undiciMod = await import("undici");
    const undici = undiciMod as unknown as {
      Agent: new (opts: unknown) => { close: () => Promise<void> };
    };
    const family = ip.includes(":") ? 6 : 4;
    const agent = new undici.Agent({
      connect: {
        lookup: (
          _hostname: string,
          _opts: unknown,
          cb: (
            err: NodeJS.ErrnoException | null,
            address: string,
            family: number,
          ) => void,
        ) => {
          cb(null, ip, family);
        },
      },
    });
    return {
      dispatcher: agent,
      close: () => agent.close(),
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "[webhook-delivery] could not build pinned dispatcher; falling back to default fetch",
    );
    return null;
  }
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
    // Re-validate the destination on every attempt. A reviewer-stored
    // hostname's DNS records can flip between attempts (DNS rebinding,
    // hostile DNS server), so we must check freshly each time and pin
    // the IP we just resolved for the actual connect.
    const guard = await checkPrivateHost(url, { resolve: getResolve() });
    if (!guard.ok) {
      logger.warn(
        {
          webhookId,
          url,
          attempt,
          reason: guard.reason,
          blockedIps: guard.blockedIps,
        },
        "[webhook-delivery] destination resolved to a blocked address; aborting delivery",
      );
      return false;
    }

    // Pin one of the IPs that the guard JUST validated for this
    // attempt. We must NOT call the resolver again here — a hostile
    // DNS server can return a public IP on the first lookup (which the
    // guard accepts) and a private IP on the second (which we'd then
    // pin and connect to). Use guard.addresses, never re-resolve.
    let pinned: { dispatcher: unknown; close: () => Promise<void> } | null =
      null;
    if (!deps.skipIpPinning) {
      const validatedAddrs = guard.addresses ?? [];
      if (validatedAddrs.length > 0) {
        pinned = await buildPinnedDispatcher(validatedAddrs[0]);
      }
      // In production, IP pinning is part of the security model — if
      // we couldn't build the dispatcher (undici import failed,
      // validatedAddrs empty for a non-literal host, etc.) we abort
      // rather than fall back to an unpinned fetch that the resolver
      // could redirect at connect time.
      if (!pinned && IS_PRODUCTION) {
        logger.error(
          {
            webhookId,
            url,
            attempt,
            validatedAddrCount: validatedAddrs.length,
          },
          "[webhook-delivery] could not pin validated IP; aborting delivery (production fail-closed)",
        );
        return false;
      }
    }

    const controller = new AbortController();
    const timer = getSetTimeout()(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      // RequestInit.dispatcher is undici-specific and not in the
      // standard fetch types; cast through `unknown` so TS is happy
      // while still passing the dispatcher through to undici's fetch.
      const init = {
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
      };
      if (pinned) {
        // `dispatcher` is undici's RequestInit extension; cast through
        // `Record<string, unknown>` so we don't fight the DOM types.
        (init as unknown as Record<string, unknown>).dispatcher =
          pinned.dispatcher;
      }
      const res = await getFetch()(url, init);
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
        {
          webhookId,
          url,
          attempt,
          err: err instanceof Error ? err.message : String(err),
        },
        "[webhook-delivery] request failed",
      );
    } finally {
      if (pinned) {
        await pinned.close().catch(() => {
          /* ignore — agent already closing */
        });
      }
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

export async function dispatchReportScoredEvent(
  payload: ReportScoredPayload,
): Promise<void> {
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
          .filter(
            (r) =>
              Array.isArray(r.eventTypes) &&
              r.eventTypes.includes(REPORT_SCORED_EVENT),
          )
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
