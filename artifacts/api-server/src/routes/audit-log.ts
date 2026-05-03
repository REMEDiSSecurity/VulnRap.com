// Task #645 — Reviewer audit log read endpoint.
//
// GET /api/audit-log returns the most recent reviewer mutation entries
// captured by the audit-log middleware. Strict reviewer auth — the log
// contains reviewer identities (`actor`), originating IPs, and the
// (redacted) request payloads, so it must never be public.
//
// Filtering: actor (exact match), endpoint (substring), method (exact),
// from/to (ISO timestamps). Results paginated via limit (max 200) +
// offset. Newest first.

import { Router, type IRouter } from "express";
import { db, auditLogTable, type AuditLogEntry } from "@workspace/db";
import { and, desc, eq, gte, ilike, lte, sql, type SQL } from "drizzle-orm";
import { requireCalibrationAuthStrict } from "../middlewares/require-calibration-auth";
import { lookupRevertHint } from "../middlewares/audit-log-middleware";

const router: IRouter = Router();

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function parsePositiveInt(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== "string" && typeof raw !== "number") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function parseIsoDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t);
}

router.get("/audit-log", requireCalibrationAuthStrict, async (req, res) => {
  try {
    const limit =
      parsePositiveInt(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT) ||
      DEFAULT_LIMIT;
    const offset = parsePositiveInt(req.query.offset, 0, 1_000_000);

    const filters: SQL[] = [];
    const actor =
      typeof req.query.actor === "string" ? req.query.actor.trim() : "";
    if (actor.length > 0) filters.push(eq(auditLogTable.actor, actor));

    const method =
      typeof req.query.method === "string"
        ? req.query.method.trim().toUpperCase()
        : "";
    if (method.length > 0) filters.push(eq(auditLogTable.method, method));

    const endpoint =
      typeof req.query.endpoint === "string" ? req.query.endpoint.trim() : "";
    if (endpoint.length > 0)
      filters.push(ilike(auditLogTable.endpoint, `%${endpoint}%`));

    const from = parseIsoDate(req.query.from);
    if (from) filters.push(gte(auditLogTable.createdAt, from));
    const to = parseIsoDate(req.query.to);
    if (to) filters.push(lte(auditLogTable.createdAt, to));

    const whereClause = filters.length > 0 ? and(...filters) : undefined;

    const [rows, [{ count }]] = await Promise.all([
      db
        .select()
        .from(auditLogTable)
        .where(whereClause)
        .orderBy(desc(auditLogTable.createdAt), desc(auditLogTable.id))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(auditLogTable)
        .where(whereClause),
    ]);

    const entries = rows.map((row: AuditLogEntry) => ({
      id: row.id,
      actor: row.actor,
      method: row.method,
      endpoint: row.endpoint,
      requestPayload: row.requestPayload ?? null,
      queryParams: row.queryParams ?? null,
      responseStatus: row.responseStatus,
      ip: row.ip ?? null,
      createdAt: row.createdAt.toISOString(),
      revertHint: lookupRevertHint(row.method, row.endpoint),
    }));

    res.status(200).json({
      total: count,
      limit,
      offset,
      entries,
    });
  } catch (err) {
    req.log?.error(err, "audit-log: query failed");
    res.status(500).json({ error: "Failed to load audit log." });
  }
});

export default router;
