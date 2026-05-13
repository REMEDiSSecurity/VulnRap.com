// Task #647 — Curated sample-report gallery.
//
// Loads the static `data/gallery.json` file once at module import time
// and serves it from `GET /api/gallery`. Mirrors the load-and-validate
// pattern used by `presets.ts` (Task #631): try cwd-relative first,
// then fall back to monorepo-relative so tests run from the repo root
// also resolve. Curated only for v1 — there is no admin/write endpoint.
//
// Live-DB filter (this commit): the JSON pins each card to a specific
// `reportId`, but those IDs only resolve in environments that have
// been seeded with the matching rows. When the seed drifts out of
// sync (e.g. seed re-run, IDs autoincrement past the curated range,
// production DB imported from a different source), click-through to
// `/results/<id>` 404s. To prevent that broken-link footgun we now
// look up which of the curated `reportId`s actually exist in the
// reports table on every request and filter the response down to
// only the resolvable ones. Cheap: it's a single indexed
// `WHERE id IN (...)` over ~6-12 small integers.
import { existsSync, readFileSync } from "fs";
import path from "path";
import { Router, type IRouter } from "express";
import { inArray } from "drizzle-orm";
import { db, reportsTable } from "@workspace/db";
import { ListGalleryResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const GALLERY_CANDIDATES = [
  process.env.GALLERY_PATH,
  path.resolve(process.cwd(), "data/gallery.json"),
  path.resolve(process.cwd(), "artifacts/api-server/data/gallery.json"),
].filter((p): p is string => !!p);

function resolveGalleryPath(): string {
  for (const candidate of GALLERY_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `[gallery] Could not find gallery.json. Tried: ${GALLERY_CANDIDATES.join(", ")}`,
  );
}

// Eager parse + validate so a malformed `gallery.json` fails the
// process at boot instead of silently returning a 500 to the first
// caller.
function loadGallery() {
  const raw = JSON.parse(readFileSync(resolveGalleryPath(), "utf8")) as Record<
    string,
    unknown
  >;
  return ListGalleryResponse.parse({
    version: raw.version,
    samples: raw.samples,
  });
}

const GALLERY_LIBRARY = loadGallery();

router.get("/gallery", async (_req, res, next) => {
  try {
    // Filter the curated samples down to those whose pinned reportId
    // actually exists in the reports table right now. This protects
    // every environment (dev, prod, fresh import) from broken
    // /results/<id> click-throughs when the seed drifts.
    const candidateIds = Array.from(
      new Set(GALLERY_LIBRARY.samples.map((s) => s.reportId)),
    );
    let resolvable = new Set<number>();
    if (candidateIds.length > 0) {
      const rows = await db
        .select({ id: reportsTable.id })
        .from(reportsTable)
        .where(inArray(reportsTable.id, candidateIds));
      resolvable = new Set(rows.map((r) => r.id));
    }
    const samples = GALLERY_LIBRARY.samples.filter((s) =>
      resolvable.has(s.reportId),
    );
    // Cache shortened from 1h → 60s with SWR because the live-DB
    // filter can change as reports are added/deleted; 60s is short
    // enough that newly-seeded reports appear quickly, long enough
    // that the indexed lookup runs at most once per minute per edge.
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    res.json({ version: GALLERY_LIBRARY.version, samples });
  } catch (err) {
    next(err);
  }
});

export default router;
