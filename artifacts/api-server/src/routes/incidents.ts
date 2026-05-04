// Task #707 — Public incident postmortems.
// Task #1057 — Reviewer-only POST endpoint to publish new incidents.
//
// Loads the static `data/incidents.json` file once at module import
// time and serves it from `GET /api/incidents`. The POST endpoint
// appends a new entry, bumps the version, persists to disk, and
// records an audit-log entry. Mirrors the auth pattern from
// `internal.ts` (requireCalibrationAuth).
import { existsSync, readFileSync } from "fs";
import { atomicWriteJsonFileSync } from "../lib/atomic-write";
import path from "path";
import { Router, type IRouter } from "express";
import { ListIncidentsResponse } from "@workspace/api-zod";
import { requireCalibrationAuth } from "../middlewares/require-calibration-auth";
import { auditLogMutationMiddleware } from "../middlewares/audit-log-middleware";
import { logger } from "../lib/logger";
import { z } from "zod";

const router: IRouter = Router();

const INCIDENTS_CANDIDATES = [
  process.env.INCIDENTS_PATH,
  path.resolve(process.cwd(), "data/incidents.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/incidents.json"),
].filter((p): p is string => !!p);

function resolveIncidentsPath(): string {
  for (const candidate of INCIDENTS_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[incidents] Could not find incidents.json. Tried: ${INCIDENTS_CANDIDATES.join(", ")}`,
  );
}

const incidentsFilePath = resolveIncidentsPath();

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(s: string): boolean {
  if (!ISO_DATE_RE.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().startsWith(s);
}

const CreateIncidentBody = z.object({
  id: z.string().min(1, "id is required"),
  date: z.string().refine(isValidIsoDate, {
    message: "date must be a valid YYYY-MM-DD calendar date",
  }),
  duration: z.string().min(1, "duration is required"),
  severity: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string().min(1, "summary is required"),
  rootCause: z.string().min(1, "rootCause is required"),
  remediation: z.string().min(1, "remediation is required"),
  changelogAnchor: z.string().optional(),
  reviewer: z.string().optional(),
});

function loadIncidentsFromDisk() {
  const raw = JSON.parse(
    readFileSync(incidentsFilePath, "utf8"),
  ) as Record<string, unknown>;
  return ListIncidentsResponse.parse({
    version: raw.version,
    incidents: raw.incidents,
  });
}

let INCIDENT_LOG = loadIncidentsFromDisk();

function bumpPatchVersion(version: string): string {
  const parts = version.split(".");
  if (parts.length !== 3) return "1.0.1";
  const patch = parseInt(parts[2], 10);
  return `${parts[0]}.${parts[1]}.${Number.isFinite(patch) ? patch + 1 : 1}`;
}

function dateToIsoDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

router.get("/incidents", (_req, res) => {
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  res.json(INCIDENT_LOG);
});

router.post(
  "/incidents",
  requireCalibrationAuth,
  auditLogMutationMiddleware,
  async (req, res) => {
    try {
      const parsed = CreateIncidentBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid incident body.",
          details: parsed.error.flatten().fieldErrors,
        });
        return;
      }

      const body = parsed.data;

      const duplicate = INCIDENT_LOG.incidents.some(
        (i: { id: string }) => i.id === body.id,
      );
      if (duplicate) {
        res.status(409).json({
          error: `An incident with id "${body.id}" already exists.`,
        });
        return;
      }

      const newVersion = bumpPatchVersion(INCIDENT_LOG.version);

      const candidateIncidents = [
        ...INCIDENT_LOG.incidents,
        {
          id: body.id,
          date: body.date,
          duration: body.duration,
          severity: body.severity,
          summary: body.summary,
          rootCause: body.rootCause,
          remediation: body.remediation,
          ...(body.changelogAnchor ? { changelogAnchor: body.changelogAnchor } : {}),
        },
      ];

      const candidateLog = ListIncidentsResponse.safeParse({
        version: newVersion,
        incidents: candidateIncidents,
      });

      if (!candidateLog.success) {
        logger.error(
          { err: candidateLog.error.flatten() },
          "[incidents] New entry failed ListIncidentsResponse validation",
        );
        res.status(400).json({
          error: "The new incident entry does not conform to the IncidentEntry schema.",
          details: candidateLog.error.flatten().fieldErrors,
        });
        return;
      }

      const fileData = {
        $comment: "Task #707 — Public incident postmortems. Each entry documents one operational incident (engine outage, scoring regression, calibration mistake) with what happened, root cause, remediation, and a link to the relevant changelog anchor. Curator-edited only; bump `version` when shipping changes. Empty array means we have no public incidents on file.",
        version: newVersion,
        incidents: candidateLog.data.incidents.map((i) => ({
          ...i,
          date: i.date instanceof Date
            ? dateToIsoDateString(i.date)
            : String(i.date),
        })),
      };

      atomicWriteJsonFileSync(incidentsFilePath, fileData);

      INCIDENT_LOG = candidateLog.data;

      logger.info(
        { incidentId: body.id, version: newVersion },
        "[incidents] New incident postmortem published",
      );

      res.status(201).json({
        ok: true,
        version: newVersion,
        incident: {
          id: body.id,
          date: body.date,
          duration: body.duration,
          severity: body.severity,
          summary: body.summary,
          rootCause: body.rootCause,
          remediation: body.remediation,
          ...(body.changelogAnchor ? { changelogAnchor: body.changelogAnchor } : {}),
        },
      });
    } catch (err) {
      logger.error({ err }, "[incidents] POST /incidents failed");
      res.status(500).json({ error: "Failed to publish incident." });
    }
  },
);

export default router;

export const __testing = {
  writeIncidentsFile(filePath: string, data: Record<string, unknown>): void {
    atomicWriteJsonFileSync(filePath, data);
  },
};
