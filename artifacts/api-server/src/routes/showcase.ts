// Task #694 — Curated /showcase endpoint.
//
// Loads the static `data/showcase.json` file once at module import
// time and serves it from `GET /api/showcase`. Mirrors the
// load-and-validate pattern used by `gallery.ts` (Task #647) and
// `presets.ts` (Task #631): try cwd-relative first, then fall back
// to monorepo-relative so tests run from the repo root also resolve.
// Curated only for v1 — there is no admin/write endpoint.
// Live-DB filter: same pattern as gallery.ts — the JSON pins each
// card to a specific `reportId`, so any environment whose seed has
// drifted out of sync renders broken click-throughs. We filter the
// returned entries to only those whose reportId actually resolves
// in the reports table on every request.
import { existsSync, readFileSync } from "fs";
import path from "path";
import { Router, type IRouter } from "express";
import { inArray } from "drizzle-orm";
import { db, reportsTable } from "@workspace/db";
import { ListShowcaseResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const SHOWCASE_CANDIDATES = [
  process.env.SHOWCASE_PATH,
  path.resolve(process.cwd(), "data/showcase.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/showcase.json"),
].filter((p): p is string => !!p);

function resolveShowcasePath(): string {
  for (const candidate of SHOWCASE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[showcase] Could not find showcase.json. Tried: ${SHOWCASE_CANDIDATES.join(", ")}`,
  );
}

// Eager parse + validate so a malformed `showcase.json` fails the
// process at boot instead of silently returning a 500 to the first
// caller.
function loadShowcase() {
  const raw = JSON.parse(readFileSync(resolveShowcasePath(), "utf8")) as Record<
    string,
    unknown
  >;
  return ListShowcaseResponse.parse({
    version: raw.version,
    entries: raw.entries,
  });
}

const SHOWCASE_LIBRARY = loadShowcase();

router.get("/showcase", async (_req, res, next) => {
  try {
    const candidateIds = Array.from(
      new Set(SHOWCASE_LIBRARY.entries.map((e) => e.reportId)),
    );
    let resolvable = new Set<number>();
    if (candidateIds.length > 0) {
      const rows = await db
        .select({ id: reportsTable.id })
        .from(reportsTable)
        .where(inArray(reportsTable.id, candidateIds));
      resolvable = new Set(rows.map((r) => r.id));
    }
    const entries = SHOWCASE_LIBRARY.entries.filter((e) =>
      resolvable.has(e.reportId),
    );
    // 60s cache with SWR — see gallery.ts for the rationale.
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json({ version: SHOWCASE_LIBRARY.version, entries });
  } catch (err) {
    next(err);
  }
});

export default router;
