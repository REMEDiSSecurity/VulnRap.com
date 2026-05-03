-- Task #726 — Performance audit. Indexes that closed observed seq-scan
-- regressions surfaced by `EXPLAIN ANALYZE` over the seed corpus.
--
--   * idx_reports_delete_token — DELETE /api/reports looks up rows by
--     delete_token (see deleteReport handler in routes/reports.ts). The
--     token is a 64-char random hex per row so the column is highly
--     selective; without an index the lookup degrades to a full scan as
--     the corpus grows past a few thousand rows. Partial WHERE clause
--     keeps the index small (legacy rows persist the empty-string
--     default and would otherwise bloat the b-tree).
--
--   * idx_reports_content_mode_full — /api/stats counts reports by
--     content_mode. The default mode is `full`, so a partial b-tree on
--     the minority `similarity_only` rows lets the planner answer the
--     mode breakdown via index-only scans.
--
--   * idx_reports_vulnrap_composite_score — backfill-vulnrap.ts and the
--     calibration views filter by `vulnrap_composite_score IS NULL`.
--     A partial index over the not-yet-rescored rows keeps the backfill
--     scan O(rows-to-fix) instead of O(corpus-size).

CREATE INDEX IF NOT EXISTS "idx_reports_delete_token"
  ON "reports" ("delete_token")
  WHERE "delete_token" <> '';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reports_content_mode_similarity"
  ON "reports" ("content_mode")
  WHERE "content_mode" <> 'full';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_reports_vulnrap_composite_null"
  ON "reports" ("created_at")
  WHERE "vulnrap_composite_score" IS NULL;
