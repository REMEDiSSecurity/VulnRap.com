import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  db,
  corpusUnreviewedTable,
  corpusLabelledTable,
} from "@workspace/db";
import { sql, eq, desc, and, gte, lt } from "drizzle-orm";
import { logger } from "../lib/logger";
import { requireCalibrationAuthStrict } from "../middlewares/require-calibration-auth";

// Task #1328 — REMEDiS feedback.v2 ingest + review.
//
// HTTP surface:
//   * POST /api/feedback/v2                       — REMEDiS-only, bearer-token gated, schema-validated ingest
//   * GET  /api/feedback/v2/pending               — admin: paginated pending queue
//   * GET  /api/feedback/v2/:id                   — admin: full payload for one row
//   * POST /api/feedback/v2/:id/promote           — admin: copy into corpus_labelled, mark promoted (append-only)
//   * POST /api/feedback/v2/:id/reject            — admin: reject with required reason
//   * POST /api/feedback/v2/:id/defer             — admin: defer with reason; stays in queue
//   * GET  /api/feedback/v2/stats                 — admin tile: pending count + week-over-week promotion rate
//
// Admin gating reuses the existing reviewer token (CALIBRATION_TOKEN +
// requireCalibrationAuthStrict). The REMEDIS ingest is gated by a
// dedicated REMEDIS_FEEDBACK_TOKEN so credentials shared with REMEDiS
// cannot mutate scoring config; the two trust boundaries are kept
// distinct on purpose.

// ---------------------------------------------------------------------------
// remedis.feedback.v2 schema
//
// Mirrors the shape documented in attached_assets/HANDOFF_1778880202817.md
// (Section "What REMEDiS will be sending you") and emitted by
// integration/feedback_builder.py. We deliberately accept unknown nested
// keys via `passthrough()` on the leaf objects — the schema is owned by
// the REMEDiS side and may grow new explanation/agreement axes between
// our deploys. The raw JSON is preserved verbatim in
// `corpus_unreviewed.payload` regardless, so even fields we do not
// validate today are recoverable.
// ---------------------------------------------------------------------------

const VERDICTS = [
  "confirm",
  "correct_authenticity",
  "correct_score",
  "correct_severity",
  "correct_in_scope",
  "correct_duplicate",
  "correct_multiple",
  "reject",
] as const;

const explanationAxisSchema = z
  .object({
    expected: z.string().optional(),
    vulnrap_said: z.string().optional(),
    should_have_weighted: z.array(z.string()).optional(),
    guidance: z.string().optional(),
  })
  .passthrough();

const RemedisFeedbackV2Schema = z
  .object({
    schema_version: z.literal("remedis.feedback.v2"),
    verdict: z.enum(VERDICTS),
    report_id: z.string().min(1).max(256),
    report_features: z
      .object({
        positive: z.array(z.string()).default([]),
        negative: z.array(z.string()).default([]),
      })
      .passthrough(),
    agreement: z
      .object({
        authenticity_match: z.boolean(),
        realness_in_band: z.boolean(),
        severity_match: z.boolean(),
        in_scope_match: z.boolean(),
        duplicate_match: z.boolean(),
      })
      .passthrough(),
    explanations: z
      .object({
        authenticity: explanationAxisSchema.optional(),
        realness_band: explanationAxisSchema.optional(),
        severity: explanationAxisSchema.optional(),
        in_scope: explanationAxisSchema.optional(),
        duplicate: explanationAxisSchema.optional(),
      })
      .passthrough(),
    signals_vulnrap_should_have_weighted: z
      .record(z.string(), z.array(z.string()))
      .optional(),
    model_improvement_suggestions: z.array(z.string()).optional(),
    calibration_note: z.string().optional(),
    ground_truth: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type RemedisFeedbackV2 = z.infer<typeof RemedisFeedbackV2Schema>;

// ---------------------------------------------------------------------------
// Ingest auth
// ---------------------------------------------------------------------------

const REMEDIS_HEADER = "x-remedis-token";

function readRemedisToken(): string | null {
  const raw = process.env.REMEDIS_FEEDBACK_TOKEN;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractRemedisToken(req: Request): string | null {
  const headerVal = req.header(REMEDIS_HEADER);
  if (typeof headerVal === "string" && headerVal.trim().length > 0) {
    return headerVal.trim();
  }
  const auth = req.header("authorization");
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) {
      const t = m[1].trim();
      if (t.length > 0) return t;
    }
  }
  return null;
}

function constantTimeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

// Fail-closed: when REMEDIS_FEEDBACK_TOKEN is unset, every ingest
// request is rejected. We do NOT trust any field in the payload itself
// to identify the caller — the payload claims its own origin via
// schema_version, which an attacker can trivially forge.
function requireRemedisToken(req: Request, res: Response, next: NextFunction): void {
  const expected = readRemedisToken();
  if (expected === null) {
    logger.warn(
      { route: req.originalUrl, ip: req.ip ?? null },
      "remedis feedback ingest rejected: REMEDIS_FEEDBACK_TOKEN not configured",
    );
    res.status(401).json({
      error:
        "REMEDIS_FEEDBACK_TOKEN is not configured on the server. Set it and resend the request with Authorization: Bearer <token> or X-Remedis-Token: <token>.",
    });
    return;
  }
  const presented = extractRemedisToken(req);
  if (presented === null || !constantTimeEquals(expected, presented)) {
    logger.warn(
      { route: req.originalUrl, ip: req.ip ?? null },
      "remedis feedback ingest rejected: missing or wrong token",
    );
    res.status(401).json({
      error:
        "Invalid or missing REMEDiS feedback token. Send Authorization: Bearer <token> or X-Remedis-Token: <token>.",
    });
    return;
  }
  next();
}

function resolveReviewer(req: Request): string {
  // Reviewer identity is taken from a free-form header the admin UI sets
  // (X-Reviewer-Id). Falling back to "anonymous-reviewer" keeps the audit
  // trail populated even when the UI omits the header. requireCalibration
  // AuthStrict has already authenticated the caller as a holder of the
  // reviewer token, so the identity header is informational only — its
  // job is to attribute decisions, not to grant access.
  const raw = req.header("x-reviewer-id");
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim().slice(0, 128);
  }
  return "anonymous-reviewer";
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router: IRouter = Router();

router.post("/feedback/v2", requireRemedisToken, async (req, res) => {
  const parsed = RemedisFeedbackV2Schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Payload does not match remedis.feedback.v2 schema.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
    return;
  }

  const payload = parsed.data;

  try {
    const [row] = await db
      .insert(corpusUnreviewedTable)
      .values({
        submissionId: payload.report_id,
        schemaVersion: payload.schema_version,
        verdict: payload.verdict,
        payload: payload as unknown as Record<string, unknown>,
      })
      .returning({ id: corpusUnreviewedTable.id });

    res.status(201).json({
      feedback_id: row.id,
      submission_id: payload.report_id,
      status: "pending",
    });
  } catch (err) {
    req.log?.error(err, "Failed to persist remedis.feedback.v2 payload");
    res
      .status(500)
      .json({ error: "Failed to persist remedis.feedback.v2 payload." });
  }
});

// --- Admin endpoints (gated by reviewer token) ------------------------------

router.get(
  "/feedback/v2/pending",
  requireCalibrationAuthStrict,
  async (req, res) => {
    try {
      const rawLimit = Number(req.query.limit ?? 50);
      const limit =
        Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), 200)
          : 50;
      const status =
        typeof req.query.status === "string" && req.query.status.length > 0
          ? req.query.status
          : "pending";

      const rows = await db
        .select({
          id: corpusUnreviewedTable.id,
          submissionId: corpusUnreviewedTable.submissionId,
          schemaVersion: corpusUnreviewedTable.schemaVersion,
          verdict: corpusUnreviewedTable.verdict,
          receivedAt: corpusUnreviewedTable.receivedAt,
          status: corpusUnreviewedTable.status,
          decidedAt: corpusUnreviewedTable.decidedAt,
          decidedBy: corpusUnreviewedTable.decidedBy,
          decisionReason: corpusUnreviewedTable.decisionReason,
        })
        .from(corpusUnreviewedTable)
        .where(eq(corpusUnreviewedTable.status, status))
        .orderBy(desc(corpusUnreviewedTable.receivedAt))
        .limit(limit);

      res.json({ rows, status, limit });
    } catch (err) {
      req.log?.error(err, "Failed to list pending remedis feedback");
      res
        .status(500)
        .json({ error: "Failed to list pending remedis feedback." });
    }
  },
);

router.get("/feedback/v2/stats", requireCalibrationAuthStrict, async (req, res) => {
  try {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const [counts] = await db
      .select({
        pending: sql<number>`count(*) filter (where ${corpusUnreviewedTable.status} = 'pending')::int`,
        deferred: sql<number>`count(*) filter (where ${corpusUnreviewedTable.status} = 'deferred')::int`,
        promoted: sql<number>`count(*) filter (where ${corpusUnreviewedTable.status} = 'promoted')::int`,
        rejected: sql<number>`count(*) filter (where ${corpusUnreviewedTable.status} = 'rejected')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(corpusUnreviewedTable);

    const [thisWeek] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(corpusLabelledTable)
      .where(gte(corpusLabelledTable.promotedAt, oneWeekAgo));

    const [lastWeek] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(corpusLabelledTable)
      .where(
        and(
          gte(corpusLabelledTable.promotedAt, twoWeeksAgo),
          lt(corpusLabelledTable.promotedAt, oneWeekAgo),
        ),
      );

    const thisWk = thisWeek?.count ?? 0;
    const lastWk = lastWeek?.count ?? 0;
    const weekOverWeekDelta = thisWk - lastWk;
    // Percent change clamped against a zero denominator: when last week
    // saw zero promotions, any non-zero this-week count is reported as
    // null (the UI renders "n/a") instead of an Infinity which would be
    // both misleading and not JSON-serializable.
    const weekOverWeekPct =
      lastWk === 0 ? null : ((thisWk - lastWk) / lastWk) * 100;

    res.json({
      counts: {
        pending: counts.pending,
        deferred: counts.deferred,
        promoted: counts.promoted,
        rejected: counts.rejected,
        total: counts.total,
      },
      promotions: {
        thisWeek: thisWk,
        lastWeek: lastWk,
        weekOverWeekDelta,
        weekOverWeekPct,
      },
    });
  } catch (err) {
    req.log?.error(err, "Failed to compute remedis feedback stats");
    res.status(500).json({ error: "Failed to compute remedis feedback stats." });
  }
});

router.get(
  "/feedback/v2/:id",
  requireCalibrationAuthStrict,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id must be a positive integer." });
      return;
    }
    try {
      const [row] = await db
        .select()
        .from(corpusUnreviewedTable)
        .where(eq(corpusUnreviewedTable.id, id))
        .limit(1);
      if (!row) {
        res.status(404).json({ error: "Not found." });
        return;
      }
      res.json(row);
    } catch (err) {
      req.log?.error(err, "Failed to fetch remedis feedback row");
      res.status(500).json({ error: "Failed to fetch remedis feedback row." });
    }
  },
);

function readReason(req: Request): string | null {
  const raw = req.body?.reason;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 2000);
}

// Task #1328 — Promotion requires a reason / note for the same reason
// reject and defer do: every decision that lands a row in
// corpus_labelled (or removes it from the queue) must carry a human
// rationale, so the append-only audit trail can answer "why was this
// promoted?" months later without spelunking through reviewer memory.
function readPromotionNote(req: Request): string | null {
  const raw = req.body?.note ?? req.body?.reason;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, 2000);
}

router.post(
  "/feedback/v2/:id/promote",
  requireCalibrationAuthStrict,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id must be a positive integer." });
      return;
    }
    const reviewer = resolveReviewer(req);
    const note = readPromotionNote(req);
    if (note === null) {
      res.status(400).json({
        error:
          "A non-empty `reason` (or `note`) is required when promoting a feedback row.",
      });
      return;
    }

    try {
      // Atomic promote: insert into corpus_labelled and flip the source
      // row's status in the same transaction. Promotion is append-only
      // for corpus_labelled — we never UPDATE existing rows there.
      // Re-promoting a row that's already promoted is a no-op (returns
      // the existing labelled row id) so the UI's retry / double-click
      // behavior cannot create phantom duplicates.
      const result = await db.transaction(async (tx) => {
        // Task #1328 — Row-level lock on the source row serializes
        // concurrent promote requests for the same id. Without this,
        // two simultaneous double-click promotes can both pass the
        // status==="pending" check before either UPDATE commits and
        // each insert a labelled row, defeating the idempotency
        // intent. A unique index on unreviewed_id would conflict with
        // the schema's append-on-retraction design (multiple labelled
        // rows per source row), so we serialize at the row level
        // instead.
        const [src] = await tx
          .select()
          .from(corpusUnreviewedTable)
          .where(eq(corpusUnreviewedTable.id, id))
          .limit(1)
          .for("update");
        if (!src) return { kind: "not_found" as const };
        if (src.status === "promoted") {
          const [existing] = await tx
            .select({ id: corpusLabelledTable.id })
            .from(corpusLabelledTable)
            .where(eq(corpusLabelledTable.unreviewedId, src.id))
            .orderBy(desc(corpusLabelledTable.promotedAt))
            .limit(1);
          return {
            kind: "already_promoted" as const,
            labelledId: existing?.id ?? null,
          };
        }
        const groundTruth =
          (src.payload as Record<string, unknown> | null)?.ground_truth ?? null;
        const [labelled] = await tx
          .insert(corpusLabelledTable)
          .values({
            unreviewedId: src.id,
            submissionId: src.submissionId,
            schemaVersion: src.schemaVersion,
            verdict: src.verdict,
            groundTruth: groundTruth as never,
            promotedBy: reviewer,
            promotionNote: note,
          })
          .returning({ id: corpusLabelledTable.id });
        await tx
          .update(corpusUnreviewedTable)
          .set({
            status: "promoted",
            decidedAt: new Date(),
            decidedBy: reviewer,
            decisionReason: note,
          })
          .where(eq(corpusUnreviewedTable.id, src.id));
        return { kind: "promoted" as const, labelledId: labelled.id };
      });

      if (result.kind === "not_found") {
        res.status(404).json({ error: "Not found." });
        return;
      }
      logger.info(
        {
          unreviewedId: id,
          labelledId: result.labelledId,
          reviewer,
          alreadyPromoted: result.kind === "already_promoted",
        },
        "remedis feedback promoted to corpus_labelled",
      );
      res.status(result.kind === "already_promoted" ? 200 : 201).json({
        unreviewedId: id,
        labelledId: result.labelledId,
        status: "promoted",
        alreadyPromoted: result.kind === "already_promoted",
      });
    } catch (err) {
      req.log?.error(err, "Failed to promote remedis feedback row");
      res
        .status(500)
        .json({ error: "Failed to promote remedis feedback row." });
    }
  },
);

router.post(
  "/feedback/v2/:id/reject",
  requireCalibrationAuthStrict,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id must be a positive integer." });
      return;
    }
    const reason = readReason(req);
    if (reason === null) {
      res.status(400).json({
        error:
          "A non-empty `reason` is required when rejecting a feedback row.",
      });
      return;
    }
    const reviewer = resolveReviewer(req);
    try {
      const result = await db
        .update(corpusUnreviewedTable)
        .set({
          status: "rejected",
          decidedAt: new Date(),
          decidedBy: reviewer,
          decisionReason: reason,
        })
        .where(
          and(
            eq(corpusUnreviewedTable.id, id),
            // Once promoted, a row is append-only on corpus_labelled and
            // can't be retroactively rejected here. This keeps the audit
            // trail honest: rejecting a promoted row would imply
            // retracting from the labelled corpus, which is a separate,
            // intentional operation we don't expose yet.
            sql`${corpusUnreviewedTable.status} <> 'promoted'`,
          ),
        )
        .returning({ id: corpusUnreviewedTable.id });
      if (result.length === 0) {
        res
          .status(409)
          .json({ error: "Row not found, or already promoted." });
        return;
      }
      logger.info(
        { unreviewedId: id, reviewer, reason },
        "remedis feedback rejected",
      );
      res.json({ unreviewedId: id, status: "rejected" });
    } catch (err) {
      req.log?.error(err, "Failed to reject remedis feedback row");
      res
        .status(500)
        .json({ error: "Failed to reject remedis feedback row." });
    }
  },
);

router.post(
  "/feedback/v2/:id/defer",
  requireCalibrationAuthStrict,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "id must be a positive integer." });
      return;
    }
    const reason = readReason(req);
    if (reason === null) {
      res.status(400).json({
        error:
          "A non-empty `reason` is required when deferring a feedback row.",
      });
      return;
    }
    const reviewer = resolveReviewer(req);
    try {
      const result = await db
        .update(corpusUnreviewedTable)
        .set({
          status: "deferred",
          decidedAt: new Date(),
          decidedBy: reviewer,
          decisionReason: reason,
        })
        .where(
          and(
            eq(corpusUnreviewedTable.id, id),
            sql`${corpusUnreviewedTable.status} <> 'promoted'`,
          ),
        )
        .returning({ id: corpusUnreviewedTable.id });
      if (result.length === 0) {
        res
          .status(409)
          .json({ error: "Row not found, or already promoted." });
        return;
      }
      logger.info(
        { unreviewedId: id, reviewer, reason },
        "remedis feedback deferred",
      );
      res.json({ unreviewedId: id, status: "deferred" });
    } catch (err) {
      req.log?.error(err, "Failed to defer remedis feedback row");
      res.status(500).json({ error: "Failed to defer remedis feedback row." });
    }
  },
);

export default router;
