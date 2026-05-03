// Task #645 — Reviewer audit log middleware.
//
// Wraps every mutation handler under the reviewer-gated routers
// (calibration, test-fixtures) and writes one `audit_log` row per
// request once the response has finished. We intentionally insert
// AFTER the response instead of before so a slow/failed DB write
// never blocks the reviewer's request.
//
// Skipped for GETs and HEADs — the table is a mutation paper trail,
// not a request log. Also skipped for the unauthenticated auth-status
// probe endpoint (which is a GET anyway, so this is belt-and-braces).
//
// Secret-shaped keys (token, password, secret, api[_-]?key, auth,
// cred, cookie) are blanked out of the persisted body and query so
// rotating CALIBRATION_TOKEN does not leave plaintext copies on disk.

import { db, auditLogTable, type InsertAuditLogEntry } from "@workspace/db";
import { logger } from "../lib/logger";
import type { Request, Response, NextFunction } from "express";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SECRET_KEY_RE = /(token|secret|password|api[_-]?key|auth|cred|cookie)/i;
const MAX_STRING_LEN = 4096;
const MAX_DEPTH = 8;
const MAX_ARRAY_LEN = 200;

function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated:depth]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_LEN
      ? `${value.slice(0, MAX_STRING_LEN)}…[truncated]`
      : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const trimmed = value
      .slice(0, MAX_ARRAY_LEN)
      .map((v) => redactPayload(v, depth + 1));
    if (value.length > MAX_ARRAY_LEN)
      trimmed.push(`[truncated:${value.length - MAX_ARRAY_LEN} more]`);
    return trimmed;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactPayload(v, depth + 1);
      }
    }
    return out;
  }
  // Functions, symbols, bigints, etc — collapse to a stringified description
  // to keep the JSON column happy.
  return String(value);
}

export function extractActor(req: Request): string {
  // Body-supplied reviewer identity wins (reviewers already pass `reviewer`
  // on most calibration mutation bodies — see HandwavyPhraseUndoBody etc.).
  const body = (req.body ?? null) as Record<string, unknown> | null;
  if (body && typeof body === "object") {
    const r = body.reviewer;
    if (typeof r === "string" && r.trim().length > 0)
      return r.trim().slice(0, 200);
  }
  const headerVal = req.header("x-reviewer-name");
  if (typeof headerVal === "string" && headerVal.trim().length > 0) {
    return headerVal.trim().slice(0, 200);
  }
  return "anonymous";
}

// Insertion is exposed so tests can await the write deterministically
// instead of polling the table; the production path just fires the
// promise and logs failures.
export async function writeAuditLogEntry(
  entry: InsertAuditLogEntry,
): Promise<void> {
  await db.insert(auditLogTable).values(entry);
}

export function auditLogMutationMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!MUTATION_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }
  const startedAt = new Date();
  // Snapshot inputs at request time — body is parsed by express.json() before
  // reaching us. Keep the redacted payload pinned in closure so res.on("finish")
  // doesn't observe a downstream handler mutating req.body.
  const requestPayload =
    req.body && typeof req.body === "object" && Object.keys(req.body).length > 0
      ? redactPayload(req.body)
      : null;
  const query =
    req.query && Object.keys(req.query).length > 0
      ? redactPayload(req.query)
      : null;
  const actor = extractActor(req);
  const endpoint = req.originalUrl.split("?")[0];
  const method = req.method.toUpperCase();
  const ip =
    typeof req.ip === "string" && req.ip.length > 0
      ? req.ip.slice(0, 64)
      : null;

  res.on("finish", () => {
    const entry: InsertAuditLogEntry = {
      actor,
      method,
      endpoint,
      requestPayload,
      queryParams: query,
      responseStatus: res.statusCode,
      ip,
      createdAt: startedAt,
    };
    writeAuditLogEntry(entry).catch((err) => {
      logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          endpoint,
          method,
        },
        "audit-log: failed to persist mutation entry",
      );
    });
  });

  next();
}

// Static map of revert hints — endpoints whose effect can be undone by
// calling another reviewer endpoint. The audit-log read endpoint stitches
// these onto each entry so the UI can render a "Revert" link without
// hard-coding the mapping in the frontend. Patterns match the FULL
// originalUrl (including the `/api` prefix) for clarity.
export interface AuditRevertHint {
  method: string;
  endpoint: string;
  description: string;
}

const REVERT_HINTS: Array<{
  pattern: RegExp;
  method: string;
  hint: AuditRevertHint;
}> = [
  {
    pattern: /^\/api\/feedback\/calibration\/handwavy-phrases$/,
    method: "POST",
    hint: {
      method: "DELETE",
      endpoint: "/api/feedback/calibration/handwavy-phrases",
      description: "Remove the just-added phrase",
    },
  },
  {
    pattern: /^\/api\/feedback\/calibration\/handwavy-phrases$/,
    method: "DELETE",
    hint: {
      method: "POST",
      endpoint: "/api/feedback/calibration/handwavy-phrases/reinstate",
      description: "Reinstate the removed phrase",
    },
  },
  {
    pattern: /^\/api\/feedback\/calibration\/handwavy-phrases\/undo$/,
    method: "POST",
    hint: {
      method: "POST",
      endpoint: "/api/feedback/calibration/handwavy-phrases",
      description: "Re-add the undone phrase",
    },
  },
  {
    pattern: /^\/api\/feedback\/calibration\/handwavy-phrases\/reinstate$/,
    method: "POST",
    hint: {
      method: "DELETE",
      endpoint: "/api/feedback/calibration/handwavy-phrases",
      description: "Remove the reinstated phrase again",
    },
  },
];

export function lookupRevertHint(
  method: string,
  endpoint: string,
): AuditRevertHint | null {
  const upper = method.toUpperCase();
  for (const candidate of REVERT_HINTS) {
    if (candidate.method === upper && candidate.pattern.test(endpoint)) {
      return candidate.hint;
    }
  }
  return null;
}

// Test seam — exposes the redactor for unit tests that want to assert
// secret keys are blanked without standing up an Express app.
export const __TESTING__ = { redactPayload };
