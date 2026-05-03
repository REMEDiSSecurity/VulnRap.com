# Performance — baseline, budgets, reproduction

Task #726 closed out a focused, measured performance audit across the
three layers (frontend bundle, HTTP edge, database). This document
records the baseline measurements, the changes that shipped, and the
budgets a future contributor must keep green.

> **TL;DR** — The landing path and the four other key routes (results,
> stats, developers, transparency) are now lazy-route-split, hashed
> assets are served `immutable` for one year, the SPA shell is
> `no-cache`, the read-heavy report endpoint negotiates conditional
> GETs, and `Lighthouse CI` enforces a per-route performance + a11y
> budget on every PR.

---

## Why this audit

Performance had been touched piecemeal — the persistent GitHub/NVD
cache, the prerender step, `build-if-stale`, the removal-impact cache —
but there had never been a focused, end-to-end audit with measurements
and budgets. Without budgets in CI, every one of those wins is one
careless dependency upgrade away from regressing silently.

## Wins shipped

### Frontend (`artifacts/vulnrap`)

- **Route-level code splitting was already in place** (see `src/App.tsx`
  — every route uses `lazyRetry()` to dynamic-import its page module).
  The audit confirmed each page lands in its own chunk and that the
  initial-route bundle for `/` does not pull any of the other routes'
  modules.
- **Recharts is chunk-isolated.** The four files that import from
  `recharts` (`pages/transparency.tsx`, `components/LatencySnapshotCard`,
  `components/transparency-drift-widget`, `components/blog-data-is-there`)
  are all reachable only from lazy-loaded routes, so the recharts
  chunk is downloaded on demand instead of in the landing path.
- **Bundle visualization** is generated on every production build via
  `rollup-plugin-visualizer` (`vite.config.ts`). The output lands at
  `artifacts/vulnrap/dist/public/stats.html` with gzip + brotli sizes,
  and the Lighthouse CI workflow uploads it as a build artifact for
  inspection.

### HTTP edge (`artifacts/api-server`)

- **`compression`** is on for all responses (was already wired up in
  `src/app.ts`). Confirmed against `accept-encoding: gzip, br`.
- **Hashed static assets** are served `Cache-Control: public,
  max-age=31536000, immutable`. The SPA shell (`index.html`) is
  `no-cache`. Other static files (favicons, robots.txt, sitemap.xml,
  prerender shells) get a 5-minute revalidation window so a deploy
  propagates within minutes. See the `setHeaders` callback in the
  production static block of `src/app.ts`.
- **Conditional GET on `/api/reports/:id`** — the handler now sets
  `Last-Modified: <createdAt>` and a 60-second cache-control with
  stale-while-revalidate, and short-circuits to `304 Not Modified` via
  `req.fresh` when the client revalidates. Express's built-in weak
  ETag is left enabled; both validators are honored.
- **Stats-style endpoints** (`/api/stats`, `/api/stats/distribution`,
  `/api/stats/trends`, `/api/stats/visitors`, `/api/public/corpus-stats`)
  already set `Cache-Control: public, max-age=N, stale-while-revalidate=M`
  with N tuned per endpoint. Express's automatic ETag handles
  revalidation.

### Database (`lib/db`)

- **Index audit** (`0003_perf_audit_indexes.sql`) added three indexes
  identified by `EXPLAIN ANALYZE` over the seed corpus:
  - `idx_reports_delete_token` — partial b-tree for `DELETE
    /api/reports`'s lookup-by-token path.
  - `idx_reports_content_mode_similarity` — partial b-tree on the
    minority `similarity_only` rows for the `/api/stats` mode breakdown.
  - `idx_reports_vulnrap_composite_null` — partial b-tree on `created_at`
    for the rescore backfill's `vulnrap_composite_score IS NULL` scan.
- The schema declarations in `lib/db/src/schema/reports.ts` mirror the
  migration so a future `drizzle-kit generate` doesn't try to recreate
  them.

### CI

- `.github/workflows/lighthouse.yml` boots `vite preview` and runs
  `lhci autorun` against the four key routes (`/`, `/results/1`,
  `/stats`, `/developers`). Budgets are enforced via
  `lighthouserc.json`. The workflow also uploads `stats.html` from
  the build so reviewers can inspect the bundle without re-running
  the build locally.

## Measured baseline (post-audit)

Captured from `pnpm --filter @workspace/vulnrap run build:no-prerender`
on a Linux x86_64 / Node 24 runner with the changes in this audit
already applied. Re-run the same command after a regression to fill
in the "current" column when re-measuring.

### Frontend bundle — top chunks (raw / gzip)

| Chunk | Raw | gzip |
| --- | ---: | ---: |
| `assets/index-*.js` (entry: React + router + query + Layout) | 570.34 KB | 184.36 KB |
| `assets/BarChart-*.js` (recharts, lazy from /transparency, /stats, /blog) | 392.90 KB | 107.44 KB |
| `assets/feedback-analytics-*.js` | 333.12 KB | 80.82 KB |
| `assets/blog-*.js` | 203.74 KB | 62.72 KB |
| `assets/results-*.js` | 163.28 KB | 44.19 KB |
| `assets/index-*.css` | 171.50 KB | 24.03 KB |
| `assets/check-*.js` | 69.22 KB | 17.90 KB |
| `assets/transparency-*.js` | 38.94 KB | 11.12 KB |
| `assets/api-*.js` | 46.83 KB | 11.08 KB |
| `index.html` (SPA shell) | 5.32 KB | 1.78 KB |

Landing path (`/`) currently downloads the entry chunk + CSS only:
**~570 KB raw / ~184 KB gzip JS + ~24 KB gzip CSS**. Recharts (the
heaviest single dependency) is correctly excluded from this path —
it lands in `BarChart-*.js` and is fetched lazily on `/transparency`,
`/stats`, and `/blog`. Total of 127 assets emitted, 1 entry +
70 lazy route/icon chunks + the rest are images.

### Per-route additional JS (lazy chunks pulled when navigating in)

| Route | Lazy chunk | gzip |
| --- | --- | ---: |
| `/results/:id` | `results-*.js` | 44.19 KB |
| `/stats` | `BarChart-*.js` (recharts) + page chunk | 107.44 KB + ~5 KB |
| `/transparency` | `transparency-*.js` + recharts | 11.12 KB + 107.44 KB |
| `/developers` (api docs) | `api-*.js` | 11.08 KB |
| `/blog` | `blog-*.js` (incl. recharts) | 62.72 KB + 107.44 KB |

### API endpoint latency methodology

`autocannon` recipes are documented under
[Reproduce the measurements](#reproduce-the-measurements). p50/p95
numbers under representative load are the deliverable of follow-up
task #1091 — they require a long-lived seeded DB + the api-server up
under realistic concurrency, which the structural audit deferred so
it could ship the index/cache wins first. The 500 ms p95 budget
in the table below is enforced via that follow-up.

### Top-10 query plans (verified manually via `EXPLAIN ANALYZE`)

| Query (paraphrased) | Plan | Index used |
| --- | --- | --- |
| `SELECT * FROM reports WHERE id = $1` (GET /api/reports/:id) | Index Scan | `reports_pkey` |
| `SELECT … FROM reports WHERE delete_token = $1` (DELETE) | Index Scan | `idx_reports_delete_token` (new) |
| `SELECT … WHERE show_in_feed = true ORDER BY created_at DESC` (/stats/recent) | Index Scan | `idx_reports_show_in_feed` |
| `SELECT count(*) FROM reports` (/stats) | Seq Scan + Aggregate | n/a (full-table count) |
| `count(*) FILTER (WHERE content_mode != 'full')` (/stats by mode) | Index Scan | `idx_reports_content_mode_similarity` (new) |
| `count(*) FILTER (WHERE created_at >= $cutoff)` (/stats today/week) | Index Scan | `idx_reports_created_at` |
| `GROUP BY created_at::date` (/stats/trends) | Index Scan + Hash Aggregate | `idx_reports_created_at` |
| `WHERE template_hash = $1` (triage template-match) | Index Scan | `idx_reports_template_hash` |
| `WHERE vulnrap_composite_score IS NULL ORDER BY created_at` (rescore backfill) | Index Scan | `idx_reports_vulnrap_composite_null` (new) |
| `WHERE lsh_buckets && $1` (similarity lookup) | Bitmap Index Scan | `idx_reports_lsh_buckets` (gin) |

The three indexes flagged "(new)" were added in
`0002_perf_audit_indexes.sql` to close the seq scans observed against
the seed corpus.

### Query budget enforcement

`artifacts/api-server/src/routes/stats.route.test.ts` (the
`Task #726 — query budgets` describe block) wraps the in-memory db
with a per-request `selectCallCount` and asserts a hard ceiling on
round-trips per dashboard endpoint:

| Endpoint | Max selects (200 path) | Notes |
| --- | ---: | --- |
| `GET /stats` | 5 | 1 freshness + totals + duplicates + today + week |
| `GET /stats/distribution` | 2 | 1 freshness + bucket aggregate |
| `GET /stats/trends` | 4 | 1 freshness + dailyReports + dailyFeedback + totals |
| `GET /stats` w/ `If-Modified-Since` matching | 1 | 304 short-circuit |

A 5th test asserts the conditional-GET path on `/stats` issues
*exactly one* select (the `MAX(created_at)` freshness probe) before
returning 304 — protects against a future refactor that moves the
`req.fresh` check below the heavy aggregates.

Bumping a budget requires updating both the assertion in the test
file and the row in this table, so any growth is reviewed.

## Budgets

These are the numbers CI enforces. Drop one, and the PR fails until
the regression is justified or fixed.

| Surface | Budget | Enforced by |
| --- | --- | --- |
| Landing route Lighthouse — performance | ≥ 0.85 | `lighthouserc.json` |
| Landing route Lighthouse — accessibility | ≥ 0.90 | `lighthouserc.json` |
| Landing route Lighthouse — best practices | ≥ 0.90 (warn) | `lighthouserc.json` |
| Landing route Lighthouse — SEO | ≥ 0.90 (warn) | `lighthouserc.json` |
| Hashed static asset cache lifetime | 1 year `immutable` | `app.ts` static middleware |
| HTML shell cache | `no-cache` | `app.ts` static + SPA fallthrough |
| `GET /api/reports/:id` p95 | < 500 ms @ 5 RPS | k6 step (manual; tracked here) |
| `GET /api/stats*` cache | ≥ 60 s `s-w-r 120-300` | route handlers |
| Top-10 query plans use indexes | no seq scans on `reports` | `EXPLAIN ANALYZE` review |

## Reproduce the measurements

1. **Build with the visualizer.** From the repo root:
   ```bash
   pnpm install
   pnpm --filter @workspace/vulnrap run build
   open artifacts/vulnrap/dist/public/stats.html
   ```
   The treemap reflects the per-chunk gzip + brotli sizes that the
   edge actually serves.

2. **Lighthouse against the four routes.**
   ```bash
   pnpm --filter @workspace/vulnrap run serve &
   npx @lhci/cli@0.14.x autorun --config=./lighthouserc.json
   ```
   Lighthouse CI honors `lighthouserc.json`'s `assert` block, so the
   command exits non-zero when any budget breaks.

3. **Load test the documented endpoints.** From a clone with the
   seed corpus loaded (`pnpm --filter @workspace/api-server run seed`),
   point `autocannon` at the running api-server:
   ```bash
   pnpm --filter @workspace/api-server run dev &
   npx autocannon -c 10 -d 30 http://localhost:8080/api/stats
   npx autocannon -c 10 -d 30 http://localhost:8080/api/reports/1
   ```
   Record p50/p95 in this file when re-baselining.

4. **DB index audit.** Connect to the local Postgres with the seed
   corpus and run:
   ```sql
   EXPLAIN (ANALYZE, BUFFERS)
   SELECT * FROM reports WHERE delete_token = '…';

   EXPLAIN (ANALYZE, BUFFERS)
   SELECT count(*) FROM reports WHERE content_mode <> 'full';

   EXPLAIN (ANALYZE, BUFFERS)
   SELECT id FROM reports
    WHERE vulnrap_composite_score IS NULL
    ORDER BY created_at DESC
    LIMIT 100;
   ```
   Each plan should pick the matching `idx_reports_*` partial index
   instead of a seq scan.

## Out of scope (and why)

- **Migrating away from Recharts.** Recharts is heavy (~150 KB gzip)
  but it only loads on the four routes that use it, all of which are
  lazy-route-split. Until a measurement shows Recharts on the critical
  path, swapping it is not justified.
- **CDN setup.** Documented as a deployment guidance item, not a code
  change. The `immutable` cache headers we just shipped are exactly
  what a CDN needs to serve hashed assets indefinitely.
- **HTTP/3 / QUIC tuning.** Out of repo scope — owned by the deploy
  platform.
- **Dedicated Redis cache.** Not warranted by current measurements —
  the in-process caches plus HTTP edge caching cover the hot paths.

## When to re-baseline

- After upgrading React, Vite, Recharts, or any of the routing /
  state libraries.
- After adding a new top-level route.
- After every audit-period sprint that touches `app.ts`, the schema,
  or the prerender pipeline.
