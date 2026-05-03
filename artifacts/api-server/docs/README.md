# `artifacts/api-server/docs/` — index

Reference documentation for the VulnRap backend. Most files here are
hand-written; one (the state-of-platform doc) is regenerated from
source.

## Top-level

- **[`2026-05-02-state-of-platform.md`](./2026-05-02-state-of-platform.md)**
  Living reference for the current platform state — overview, scoring
  pipeline, full per-family signal catalog, calibration / drift,
  public API surface, reviewer surface, fixture battery, known
  limitations, roadmap pointers.

  Regenerate (writes the file):

  ```bash
  node scripts/regenerate-state-of-platform.mjs
  ```

  CI-friendly check (exit non-zero if regenerating would change the
  file; the time-sensitive `Generated:` line is ignored):

  ```bash
  node scripts/regenerate-state-of-platform.mjs --check
  ```

  The script has no external dependencies and is safe to run before
  `pnpm install`. Hand-written narrative lives inline in the
  generator script — edit there, never edit the generated `.md`
  directly.

- **[`parallelization-runbook.md`](./parallelization-runbook.md)**
  Generated batch plan for the active task queue. Inventories every
  active project task, builds the file-conflict graph, and groups
  tasks into ordered "waves" where every task in a wave is
  file-disjoint from the others — so we don't release batches that
  collide on hot files (`feedback-analytics.tsx`, `reports.ts`,
  `openapi.yaml`, ...). Includes a "Recommended next batch" callout.

  Regenerate (writes the file):

  ```bash
  node scripts/regenerate-parallelization-runbook.mjs
  ```

  CI-friendly check (exit non-zero if regenerating would change the
  file; the time-sensitive `Generated:` line is ignored):

  ```bash
  node scripts/regenerate-parallelization-runbook.mjs --check
  ```

  The script reads its input from the committed snapshot at
  `scripts/data/active-tasks.snapshot.json`; the snapshot is refreshed
  from a code_execution environment that has the project-task surface
  available.

## `retrospectives/`

- **`<YYYY-MM-DD>-24h-recap.md`** — rolling 24-hour engineering
  recap, generated from `git log` + the route table in
  `artifacts/vulnrap/src/App.tsx` + the on-disk scoring-regression
  artifact (when present). Sections: headline stat chips, what
  landed (by surface bucket), how the analysis got better, what's
  now visible to users, what's still in flight, operational
  lessons, credit accounting, plus a paste-ready marketing draft.

  Regenerate / check (mirrors the state-of-platform script
  conventions):

  ```bash
  node scripts/regenerate-24h-recap.mjs            # write
  node scripts/regenerate-24h-recap.mjs --check    # CI-safe
  node scripts/regenerate-24h-recap.mjs --window=48h
  node scripts/regenerate-24h-recap.mjs --since=2026-05-02T00:00:00Z
  ```

  The window anchors to the HEAD commit's timestamp, not wall-clock,
  so the same repo state always regenerates the same doc. The
  `Generated:` line is the only date-sensitive field and is ignored
  by `--check`.

  For accurate "what's still in flight" counts, snapshot the live
  project-task ledger to `.local/tasks/_status-snapshot.json` before
  regenerating (call `listProjectTasks({ state: "IN_PROGRESS" })` and
  `listProjectTasks({ state: "PENDING" })` and serialize as
  `{ generatedAt, inProgress: [...], pending: [...] }`). When that
  file is absent, the regenerator falls back to a best-effort
  task-plan-on-disk proxy and labels it as such in the doc.

## `calibration/`

- `2026-04-30-avri-blend-calibration.md` — substance/legacy ratio
  decision and the production-trace prerequisite for re-tuning.
- `2026-04-30-llm-cost-gate-audit.md` — LLM cost-gate audit.
- `2026-05-02-real-reports-sourcing.md` — real-reports corpus the
  synthetic battery is calibrated against.
- `disagreement-floor-audit.md`, `substance-prompt-audit.md` —
  point-in-time audits.
- `avri-drift-runbook.md` — drift response runbook.
- `avri-scoring-rubric.md` — AVRI rubric reference.
- `calibration-reviewer-token.md` — reviewer auth token mechanics.
- `diagnostics-stripped-crash-trace.md` — stripped-trace handling
  notes.

## `marketing/`

- `2026-05-02-llm-rewrite-prompt.md` — published rewrite prompt with
  before/after example and "why VulnRap still catches faked detail."
