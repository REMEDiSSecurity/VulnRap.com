// Task #707 — Public incident postmortems.
//
// Loads the static `data/incidents.json` file once at module import
// time and serves it from `GET /api/incidents`. Mirrors the
// load-and-validate pattern used by `gallery.ts` (Task #647) and
// `presets.ts` (Task #631): try cwd-relative first, then fall back
// to monorepo-relative so tests run from the repo root also resolve.
// Curated only for v1 — there is no admin/write endpoint.
import { Router, type IRouter } from "express";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { ListIncidentsResponse } from "@workspace/api-zod";

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

// Eager parse + validate so a malformed `incidents.json` fails the
// process at boot instead of silently returning a 500 to the first
// caller.
function loadIncidents() {
  const raw = JSON.parse(readFileSync(resolveIncidentsPath(), "utf8")) as Record<string, unknown>;
  return ListIncidentsResponse.parse({
    version: raw.version,
    incidents: raw.incidents,
  });
}

const INCIDENT_LOG = loadIncidents();

router.get("/incidents", (_req, res) => {
  // 1h cache + short stale-while-revalidate. Curator-edited and
  // rarely changes; the `version` field lets clients bust their own
  // caches when needed.
  res.set("Cache-Control", "public, max-age=3600, stale-while-revalidate=600");
  res.json(INCIDENT_LOG);
});

export default router;
