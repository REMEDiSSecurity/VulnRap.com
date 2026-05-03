# Parallelization runbook — active task queue

**Generated:** 2026-05-03 (regenerate with `node scripts/regenerate-parallelization-runbook.mjs`)
**Snapshot:** `scripts/data/active-tasks.snapshot.json` — 165 active tasks (8 in flight)
**Wave cap:** 10 concurrent tasks per wave
**Hot-file threshold:** ≥ 3 active tasks claiming the same file

This document is the single source of truth for "which batch is safe
to release next?". It inventories every active task, extracts each
task's declared `## Relevant files` block, builds the
file → tasks conflict graph, and groups tasks into ordered "waves"
where every task in a wave is file-disjoint from every other task in
the same wave.

The runbook is read-only guidance. It does not start, stop, or modify
any task — it only tells the human (or the next planning session)
which combination of tasks can run concurrently without colliding on
hot files.

---

## 1. Headline counts

### By state

| State | Count |
| ----- | ----: |
| `PROPOSED` | 57 |
| `PENDING` | 100 |
| `IN_PROGRESS` | 8 |
| **Total active** | **165** |

### By surface bucket

| Bucket | Count |
| ------ | ----: |
| `frontend-pages` | 51 |
| `api-routes` | 47 |
| `engines` | 16 |
| `frontend-components` | 11 |
| `scoring` | 11 |
| `api-lib` | 9 |
| `backend-docs` | 6 |
| `other` | 5 |
| `frontend-other` | 2 |
| `backend-other` | 2 |
| `api-spec` | 2 |
| `docs` | 2 |
| `scripts` | 1 |


---

## 2. Hot files

A "hot file" is one that ≥ 3 active tasks declare in their
`## Relevant files` block. These force serialization: if two tasks
both edit the same hot file, they cannot run in the same wave without
producing merge conflicts at apply time.

| File | LOC | Tasks claiming | Refs |
| ---- | --: | -------------: | ---- |
| `lib/api-spec/openapi.yaml` | 8,489 | 12 | `#619`, `#635`, `#636`, `#671`, `#678`, `#771`, `#934`, `#970`, `#1000`, `#1012`, `#1112`, `#1151` |
| `artifacts/api-server/src/routes/reports.ts` | 3,693 | 12 | `#938`, `#949`, `#950`, `#959`, `#971`, `#975`, `#980`, `#985`, `#1011`, `#1091`, `#1092`, `#1106` |
| `artifacts/vulnrap/src/pages/results.tsx` | 4,815 | 11 | `#932`, `#933`, `#939`, `#940`, `#949`, `#951`, `#954`, `#987`, `#1010`, `#1013`, `#1145` |
| `artifacts/api-server/src/routes/calibration.ts` | 3,403 | 11 | `#944`, `#946`, `#974`, `#979`, `#1125`, `#1126`, `#1128`, `#1130`, `#1141`, `#1142`, `#1151` |
| `artifacts/vulnrap/src/pages/check.tsx` | 2,308 | 11 | `#957`, `#958`, `#962`, `#963`, `#965`, `#971`, `#972`, `#987`, `#1009`, `#1013`, `#1099` |
| `artifacts/vulnrap/src/pages/api.tsx` | 1,540 | 10 | `#667`, `#671`, `#682`, `#683`, `#684`, `#930`, `#931`, `#1010`, `#1147`, `#1149` |
| `artifacts/vulnrap/src/App.tsx` | 183 | 9 | `#635`, `#636`, `#653`, `#658`, `#667`, `#929`, `#940`, `#999`, `#1093` |
| `artifacts/vulnrap/src/pages/feedback-analytics.tsx` | 21,133 | 8 | `#619`, `#944`, `#986`, `#1115`, `#1118`, `#1119`, `#1130`, `#1132` |
| `artifacts/vulnrap/src/components/layout.tsx` | 881 | 8 | `#635`, `#636`, `#653`, `#658`, `#929`, `#987`, `#1006`, `#1007` |
| `artifacts/vulnrap/src/pages/home/index.tsx` | 1,355 | 5 | `#698`, `#965`, `#988`, `#991`, `#1099` |
| `artifacts/api-server/src/lib/linguistic-analysis.ts` | 806 | 5 | `#658`, `#928`, `#975`, `#976`, `#977` |
| `artifacts/api-server/src/lib/score-stability-monitor.ts` | 790 | 5 | `#944`, `#945`, `#946`, `#984`, `#1117` |
| `artifacts/vulnrap/src/lib/settings.ts` | 197 | 5 | `#955`, `#958`, `#960`, `#971`, `#1008` |
| `artifacts/api-server/src/lib/avri-drift-notifications.ts` | 2,275 | 4 | `#982`, `#1115`, `#1116`, `#1117` |
| `artifacts/api-server/src/lib/engines/avri/raw-http.ts` | 1,956 | 4 | `#1114`, `#1133`, `#1134`, `#1152` |
| `artifacts/api-server/src/lib/engines/extractors.ts` | 1,136 | 4 | `#1123`, `#1124`, `#1136`, `#1137` |
| `artifacts/api-server/docs/integrations/hackerone.md` | 675 | 4 | `#930`, `#931`, `#1105`, `#1148` |
| `artifacts/api-server/src/routes/newsletter.ts` | 567 | 4 | `#1110`, `#1111`, `#1112`, `#1113` |
| `artifacts/vulnrap/src/pages/transparency.tsx` | 556 | 4 | `#943`, `#947`, `#995`, `#1146` |
| `artifacts/api-server/src/routes/stats.ts` | 432 | 4 | `#952`, `#953`, `#1091`, `#1092` |
| `artifacts/api-server/src/lib/engines/avri/raw-http.test.ts` | 2,936 | 3 | `#1133`, `#1134`, `#1152` |
| `artifacts/api-server/src/lib/engines/benchmark.test.ts` | 2,083 | 3 | `#1114`, `#1123`, `#1124` |
| `scripts/regenerate-state-of-platform.mjs` | 869 | 3 | `#927`, `#928`, `#929` |
| `artifacts/vulnrap/src/pages/playground.tsx` | 824 | 3 | `#996`, `#997`, `#998` |
| `artifacts/vulnrap/src/pages/community.tsx` | 605 | 3 | `#1108`, `#1109`, `#1112` |
| `artifacts/vulnrap/src/pages/quickstart.tsx` | 536 | 3 | `#1001`, `#1002`, `#1003` |
| `artifacts/api-server/src/lib/engines/soft-citation.test.ts` | 517 | 3 | `#1124`, `#1135`, `#1136` |
| `artifacts/api-server/src/lib/rescore-backfill-scheduler.ts` | 460 | 3 | `#937`, `#1142`, `#1151` |
| `artifacts/api-server/src/routes/feedback.ts` | 442 | 3 | `#982`, `#983`, `#1127` |
| `artifacts/vulnrap/src/components/onboarding-tour.tsx` | 406 | 3 | `#987`, `#988`, `#1002` |
| `artifacts/api-server/docs/integrations/bugcrowd.md` | 397 | 3 | `#930`, `#931`, `#1147` |
| `artifacts/vulnrap/src/components/custom-redaction-panel.tsx` | 328 | 3 | `#962`, `#963`, `#964` |
| `artifacts/vulnrap/src/pages/gallery.tsx` | 317 | 3 | `#999`, `#1000`, `#1145` |
| `artifacts/vulnrap/src/hooks/use-keyboard-shortcuts.ts` | 210 | 3 | `#1007`, `#1008`, `#1009` |
| `artifacts/api-server/src/lib/newsletter-email.ts` | 196 | 3 | `#1111`, `#1112`, `#1113` |
| `scripts/regenerate-state-of-platform.test.mjs` | 190 | 3 | `#927`, `#928`, `#929` |
| `CONTRIBUTING.md` | 144 | 3 | `#697`, `#719`, `#1103` |
| `artifacts/api-server/src/lib/challenge.ts` | 87 | 3 | `#928`, `#1108`, `#1110` |
| `lib/db/src/schema/analysis_traces.ts` | 84 | 3 | `#947`, `#949`, `#950` |
| `artifacts/api-server/docs/README.md` | 78 | 3 | `#927`, `#928`, `#929` |

**Recommendations per hot file:**

- `lib/api-spec/openapi.yaml` (12 tasks, 8,489 LOC) — **split the file (LOC is large enough that even sequential edits compound review burden)**
- `artifacts/api-server/src/routes/reports.ts` (12 tasks, 3,693 LOC) — **route through a single owning task (the queue is too long to drain serially before the next wave)**
- `artifacts/vulnrap/src/pages/results.tsx` (11 tasks, 4,815 LOC) — **route through a single owning task (the queue is too long to drain serially before the next wave)**
- `artifacts/api-server/src/routes/calibration.ts` (11 tasks, 3,403 LOC) — **route through a single owning task (the queue is too long to drain serially before the next wave)**
- `artifacts/vulnrap/src/pages/check.tsx` (11 tasks, 2,308 LOC) — **route through a single owning task (the queue is too long to drain serially before the next wave)**
- `artifacts/vulnrap/src/pages/api.tsx` (10 tasks, 1,540 LOC) — **route through a single owning task (the queue is too long to drain serially before the next wave)**
- `artifacts/vulnrap/src/App.tsx` (9 tasks, 183 LOC) — **route through a single owning task (the queue is too long to drain serially before the next wave)**
- `artifacts/vulnrap/src/pages/feedback-analytics.tsx` (8 tasks, 21,133 LOC) — **split the file (LOC is large enough that even sequential edits compound review burden)**
- `artifacts/vulnrap/src/components/layout.tsx` (8 tasks, 881 LOC) — **route through a single owning task (the queue is too long to drain serially before the next wave)**
- `artifacts/vulnrap/src/pages/home/index.tsx` (5 tasks, 1,355 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/linguistic-analysis.ts` (5 tasks, 806 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/score-stability-monitor.ts` (5 tasks, 790 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/vulnrap/src/lib/settings.ts` (5 tasks, 197 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/avri-drift-notifications.ts` (4 tasks, 2,275 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/engines/avri/raw-http.ts` (4 tasks, 1,956 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/engines/extractors.ts` (4 tasks, 1,136 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/docs/integrations/hackerone.md` (4 tasks, 675 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/routes/newsletter.ts` (4 tasks, 567 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/vulnrap/src/pages/transparency.tsx` (4 tasks, 556 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/routes/stats.ts` (4 tasks, 432 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/engines/avri/raw-http.test.ts` (3 tasks, 2,936 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/engines/benchmark.test.ts` (3 tasks, 2,083 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `scripts/regenerate-state-of-platform.mjs` (3 tasks, 869 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/vulnrap/src/pages/playground.tsx` (3 tasks, 824 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/vulnrap/src/pages/community.tsx` (3 tasks, 605 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/vulnrap/src/pages/quickstart.tsx` (3 tasks, 536 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/engines/soft-citation.test.ts` (3 tasks, 517 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/rescore-backfill-scheduler.ts` (3 tasks, 460 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/routes/feedback.ts` (3 tasks, 442 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/vulnrap/src/components/onboarding-tour.tsx` (3 tasks, 406 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/docs/integrations/bugcrowd.md` (3 tasks, 397 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/vulnrap/src/components/custom-redaction-panel.tsx` (3 tasks, 328 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/vulnrap/src/pages/gallery.tsx` (3 tasks, 317 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/vulnrap/src/hooks/use-keyboard-shortcuts.ts` (3 tasks, 210 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/newsletter-email.ts` (3 tasks, 196 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `scripts/regenerate-state-of-platform.test.mjs` (3 tasks, 190 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `CONTRIBUTING.md` (3 tasks, 144 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/src/lib/challenge.ts` (3 tasks, 87 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `lib/db/src/schema/analysis_traces.ts` (3 tasks, 84 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**
- `artifacts/api-server/docs/README.md` (3 tasks, 78 LOC) — **keep the queue serial (LOC small enough that one-task-at-a-time is acceptable)**


---

## 3. Wave plan

Tasks are assigned to numbered waves by greedy graph coloring on the
file-conflict graph. Every task in a wave is file-disjoint from every
other task in the same wave. Waves are ordered so the most
collision-prone surfaces (scoring / engines / API routes) drain first
and hot-file queues are flushed last. Each wave is capped at
10 tasks (the platform's stated in-flight concurrency limit).

Read this top-to-bottom: Wave 1 is what's currently running or what
should be released next; later waves are safe to release once their
predecessors clear the hot files they share.

### Wave 1 — 10 tasks (combined blast radius: 37,343 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#687` | Blog post: engine deep-dives | 1 | 444 | `IN_PROGRESS` | `frontend-pages` |
| `#697` | Contributor guide + code of conduct | 2 | 144 | `IN_PROGRESS` | `frontend-pages` |
| `#771` | Make the Go SDK fail loudly when the OpenAPI spec drifts | 3 | 9,075 | `IN_PROGRESS` | `api-spec` |
| `#928` | Codebase provenance, wiring, and lifecycle headers (lib/*) | 28 | 9,328 | `IN_PROGRESS` | `scoring` |
| `#932` | Show the substance engine breakdown visually on each report | 3 | 8,866 | `PENDING` | `engines` |
| `#941` | Show plain-English drift trend hint with the public sparkline | 3 | 485 | `PENDING` | `scoring` |
| `#959` | Use the real fusion weights instead of hard-coded defaults | 3 | 4,802 | `PENDING` | `scoring` |
| `#978` | Show the multilingual agreement rate on the calibration dashboard | 1 | 272 | `PENDING` | `scoring` |
| `#982` | Alert when holdout accuracy drops below in-sample accuracy | 3 | 2,831 | `PENDING` | `scoring` |
| `#984` | Alert reviewers when shadow scoring drifts too far from live | 3 | 1,096 | `PENDING` | `scoring` |

### Wave 2 — 10 tasks (combined blast radius: 50,056 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#719` | OSS community scaffolding (CoC, SECURITY, CHANGELOG, templates, CODEOWNERS) | 4 | 892 | `IN_PROGRESS` | `docs` |
| `#929` | 24-hour retrospective: what we shipped on the free credits | 7 | 3,040 | `IN_PROGRESS` | `frontend-components` |
| `#942` | Cache the public drift summary so the transparency page loads instantly | 3 | 253 | `PENDING` | `scoring` |
| `#985` | Mirror /reports/check submissions through shadow scoring too | 2 | 3,866 | `PENDING` | `scoring` |
| `#1114` | Make the benchmark catch shell-escape regressions for more vulnerability families | 3 | 4,909 | `PROPOSED` | `engines` |
| `#1115` | Show recent silent-replica alerts on the calibration page | 2 | 23,408 | `PROPOSED` | `scoring` |
| `#1121` | Add a fixture exemplar for the new no-overlap fake-trace tell | 3 | 5,982 | `PROPOSED` | `engines` |
| `#1122` | Pin the remaining AVRI composite overrides with regression tests | 3 | 489 | `PROPOSED` | `engines` |
| `#1125` | Show edit and removal history for AI self-disclosure phrases | 3 | 5,564 | `PROPOSED` | `engines` |
| `#1136` | Recognise vulnerability shorthand in Arabic, Turkish, Polish, and Vietnamese reports | 2 | 1,653 | `PROPOSED` | `engines` |

### Wave 3 — 10 tasks (combined blast radius: 58,216 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#619` | Signal correlation matrix | 2 | 29,622 | `PENDING` | `api-routes` |
| `#927` | Parallelization runbook for the active task queue | 3 | 1,137 | `IN_PROGRESS` | `backend-docs` |
| `#940` | Build per-engine deep-dive pages the radar can link to | 3 | 6,145 | `PENDING` | `engines` |
| `#946` | Verify the score-stability endpoint end-to-end against a real database | 2 | 4,193 | `PENDING` | `api-routes` |
| `#948` | Verify the latency snapshot stays correct as data grows | 2 | 853 | `PENDING` | `api-routes` |
| `#950` | Persist per-engine sub-scores in analysis traces | 3 | 4,079 | `PENDING` | `engines` |
| `#1116` | Auto-clear stale heartbeats so retired replicas stop pinging on-call | 1 | 2,275 | `PROPOSED` | `scoring` |
| `#1123` | Cover foreign-language terse reports in the borderline benchmark fixtures | 2 | 3,219 | `PROPOSED` | `engines` |
| `#1133` | Recognize heredoc-style HTTP smuggling reproductions | 2 | 4,892 | `PROPOSED` | `engines` |
| `#1135` | Add a regression test that XXE reports route to the deserialization rubric | 3 | 1,801 | `PROPOSED` | `engines` |

### Wave 4 — 10 tasks (combined blast radius: 40,847 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#635` | Duplicate report finder | 3 | 9,553 | `PENDING` | `api-routes` |
| `#949` | Capture the actual scoring engine version on every analysis | 5 | 9,507 | `PENDING` | `engines` |
| `#952` | Let visitors download the corpus stats as CSV | 2 | 816 | `PENDING` | `api-routes` |
| `#967` | Notify reviewers when new phrase suggestions arrive | 1 | 260 | `PENDING` | `api-routes` |
| `#972` | Add automated tests for the preset library and deep-link flow | 3 | 2,496 | `PENDING` | `api-routes` |
| `#974` | Track scoring-gate flip rate over time so drift is visible | 3 | 3,687 | `PENDING` | `api-routes` |
| `#983` | Backfill holdout flag for any future schema migrations that recreate IDs | 3 | 674 | `PENDING` | `api-routes` |
| `#1117` | Make all on-disk state files crash-safe so a restart can't wipe them | 4 | 5,226 | `PROPOSED` | `scoring` |
| `#1124` | Add German and Chinese coverage to the soft-citation lookup | 3 | 3,736 | `PROPOSED` | `engines` |
| `#1134` | Recognize Python-style requests.raw / b'...' HTTP reproductions | 2 | 4,892 | `PROPOSED` | `engines` |

### Wave 5 — 10 tasks (combined blast radius: 69,498 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#636` | Reproducibility checklist tool | 3 | 9,553 | `PENDING` | `api-routes` |
| `#933` | Show how this report compares to the AI-likelihood baseline too | 3 | 5,283 | `PENDING` | `api-routes` |
| `#938` | Filter the public reports feed by engine version | 1 | 3,693 | `PENDING` | `api-routes` |
| `#944` | Add a one-click "investigate" link from each flip back to the report | 3 | 25,326 | `PENDING` | `api-routes` |
| `#947` | Show latency over time on the transparency page | 4 | 1,083 | `PENDING` | `api-routes` |
| `#953` | Cover the corpus stats endpoint with a route test | 3 | 14,464 | `PENDING` | `api-routes` |
| `#968` | Let reviewers see and re-open already-rejected suggestions | 2 | 557 | `PENDING` | `api-routes` |
| `#1004` | Let reviewers click 'Revert' to actually undo a change | 3 | 729 | `PENDING` | `api-routes` |
| `#1137` | Track which vulnerability-shorthand patterns actually fire on real reports | 2 | 3,918 | `PROPOSED` | `engines` |
| `#1152` | Extend punctuation-separator support to the POSTSLOT regex | 2 | 4,892 | `PROPOSED` | `engines` |

### Wave 6 — 10 tasks (combined blast radius: 50,811 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#934` | Make the cohort baseline percentile exact instead of bucket-approximated | 3 | 8,957 | `PENDING` | `api-routes` |
| `#971` | Make per-engine weights actually change the score | 3 | 6,198 | `PENDING` | `api-routes` |
| `#979` | Let reviewers add their own AI-agent fingerprint phrases | 2 | 3,984 | `PENDING` | `api-routes` |
| `#986` | End-to-end test the shadow drift API and reviewer panel together | 3 | 21,678 | `PENDING` | `api-routes` |
| `#1005` | Mount the audit middleware on every reviewer-only mutation route | 2 | 267 | `PENDING` | `api-routes` |
| `#1010` | Show the embed badge directly on each report's results page | 3 | 6,493 | `PENDING` | `api-routes` |
| `#1104` | Auto-generate the public changelog page on the website from CHANGELOG.md | 2 | 427 | `PROPOSED` | `api-routes` |
| `#1107` | Add automated tests for the dry-run preview endpoint | 1 | 470 | `PROPOSED` | `api-routes` |
| `#1110` | Add automated tests for the newsletter signup challenge so it can't silently break | 3 | 946 | `PROPOSED` | `api-routes` |
| `#1127` | Show 'restored from previous session' badge on calibration alerts panel | 2 | 1,391 | `PROPOSED` | `api-routes` |

### Wave 7 — 10 tasks (combined blast radius: 22,714 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#937` | Backfill engine version pins on legacy reports | 3 | 716 | `PENDING` | `api-lib` |
| `#945` | Stop the rescore log from growing forever | 3 | 1,126 | `PENDING` | `api-lib` |
| `#970` | Let visitors share their own preset configurations | 4 | 8,917 | `PENDING` | `api-routes` |
| `#975` | Strip injection text before sending reports to the LLM scorer | 3 | 4,727 | `PENDING` | `api-routes` |
| `#981` | Validate AI-agent fingerprint accuracy against a real-world labelled corpus | 3 | 944 | `PENDING` | `api-lib` |
| `#1108` | Show a clearer error when bots or stale tabs hit the newsletter form | 2 | 692 | `PROPOSED` | `api-lib` |
| `#1111` | Show subscribers a friendly confirmation page after they click the email link | 2 | 763 | `PROPOSED` | `api-routes` |
| `#1126` | Surface a phrase editor in the reviewer calibration UI | 1 | 3,403 | `PROPOSED` | `api-routes` |
| `#1138` | Add a startup smoke test that fails CI if the api-server bundle exits before listening | 3 | 879 | `PROPOSED` | `api-routes` |
| `#1144` | Refuse to start in production when CORS is wide open | 2 | 547 | `PROPOSED` | `api-lib` |

### Wave 8 — 10 tasks (combined blast radius: 31,081 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#658` | Engine deep-dive: linguistic | 3 | 1,870 | `PENDING` | `api-lib` |
| `#682` | Intigriti integration recipe | 1 | 1,540 | `PENDING` | `frontend-pages` |
| `#688` | Blog post: regression safety | 1 | 444 | `PENDING` | `frontend-pages` |
| `#698` | Testimonials section on home | 1 | 1,355 | `PENDING` | `frontend-pages` |
| `#939` | Add automated test for the new per-engine radar section | 2 | 5,142 | `PENDING` | `frontend-pages` |
| `#980` | Show the AI-agent fingerprint on the report card without expanding diagnostics | 2 | 6,597 | `PENDING` | `api-routes` |
| `#1000` | Show the real score breakdown on each gallery card | 4 | 9,024 | `PENDING` | `api-routes` |
| `#1113` | Track welcome email delivery so silent failures don't go unnoticed | 4 | 991 | `PROPOSED` | `api-routes` |
| `#1128` | Show the AI self-disclosure preview in the calibration UI | 1 | 3,403 | `PROPOSED` | `api-routes` |
| `#1143` | Use the same fleet-wide leader election for the nightly score-stability scheduler | 3 | 715 | `PROPOSED` | `api-lib` |

### Wave 9 — 10 tasks (combined blast radius: 52,935 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#653` | FAQ page | 2 | 1,064 | `PENDING` | `frontend-pages` |
| `#683` | Jira integration recipe | 1 | 1,540 | `PENDING` | `frontend-pages` |
| `#943` | Confirm the transparency page never leaks reviewer-only drift fields | 2 | 820 | `PENDING` | `frontend-pages` |
| `#951` | Add an end-to-end test for the score history timeline UI | 2 | 4,954 | `PENDING` | `frontend-pages` |
| `#957` | Make it easy to copy and share a tweaked check session | 2 | 2,540 | `PENDING` | `frontend-pages` |
| `#976` | Show reviewers when a report tried to manipulate the scorer | 1 | 806 | `PENDING` | `api-lib` |
| `#988` | Automated tests for the first-run onboarding tour | 2 | 1,761 | `PENDING` | `frontend-pages` |
| `#1011` | Show a live badge preview using a real public report | 2 | 4,108 | `PENDING` | `api-routes` |
| `#1112` | Let subscribers ask for the welcome / confirm email to be re-sent | 4 | 9,857 | `PROPOSED` | `api-routes` |
| `#1130` | Persist alert acknowledgements so they survive a server restart | 3 | 25,485 | `PROPOSED` | `api-routes` |

### Wave 10 — 10 tasks (combined blast radius: 31,607 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#667` | Embeddable iframe results widget | 2 | 1,723 | `PENDING` | `frontend-pages` |
| `#954` | Show the custom sensitivity slider on saved report results | 2 | 5,204 | `PENDING` | `frontend-pages` |
| `#958` | Save engine toggle settings between checks | 3 | 2,767 | `PENDING` | `frontend-pages` |
| `#977` | Detect AI-style filler phrases in non-English reports | 3 | 1,183 | `PENDING` | `api-lib` |
| `#989` | Add a methodology citation block users can copy/paste | 1 | 356 | `PENDING` | `frontend-pages` |
| `#991` | Let visitors paste their own report into the explainer and watch it light up | 2 | 2,039 | `PENDING` | `frontend-pages` |
| `#993` | Add mobile-friendly card layout for the detector comparison | 1 | 304 | `PENDING` | `frontend-pages` |
| `#1012` | Let badge embedders pick light or dark themes | 5 | 9,221 | `PENDING` | `api-routes` |
| `#1091` | Stress-test API endpoints under load and capture p50/p95 numbers | 3 | 4,389 | `PROPOSED` | `api-routes` |
| `#1141` | Fix the auth-status probe so it works when no reviewer token is configured | 3 | 4,421 | `PROPOSED` | `api-routes` |

### Wave 11 — 10 tasks (combined blast radius: 27,943 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#671` | Rust SDK | 2 | 10,029 | `PENDING` | `frontend-pages` |
| `#962` | Highlight custom redaction matches inline in the report textarea | 2 | 2,636 | `PENDING` | `frontend-pages` |
| `#990` | Generate a real downloadable PDF of the whitepaper on the server | 1 | 356 | `PENDING` | `frontend-pages` |
| `#992` | Add a printable one-page PDF version of the methodology walkthrough | 2 | 1,249 | `PENDING` | `frontend-pages` |
| `#994` | Cross-link the comparison page from the homepage hero | 1 | 304 | `PENDING` | `frontend-pages` |
| `#995` | Fix the accessibility gaps documented on the Accessibility page | 7 | 3,225 | `PENDING` | `frontend-pages` |
| `#996` | Let users save and share their custom playground configurations | 1 | 824 | `PENDING` | `frontend-pages` |
| `#999` | Let visitors share a gallery example with a permalink | 2 | 500 | `PENDING` | `frontend-pages` |
| `#1092` | Catch performance regressions in tests before they reach production | 3 | 4,674 | `PROPOSED` | `api-routes` |
| `#1142` | Show on the calibration page when the weekly rescore was last run fleet-wide | 4 | 4,146 | `PROPOSED` | `api-routes` |

### Wave 12 — 10 tasks (combined blast radius: 108,593 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#684` | Self-hosted deployment doc | 1 | 1,540 | `PENDING` | `frontend-pages` |
| `#963` | Apply custom redaction patterns to the submitted report text | 2 | 2,636 | `PENDING` | `frontend-pages` |
| `#997` | Add a 'compare to default' overlay to the playground score | 1 | 824 | `PENDING` | `frontend-pages` |
| `#1001` | Quickstart in Python and JavaScript, not just curl | 1 | 536 | `PENDING` | `frontend-pages` |
| `#1006` | Show the audit log link in the reviewer navigation | 3 | 1,929 | `PENDING` | `frontend-pages` |
| `#1100` | Add a real captions track to the home-page rap-sheet video | 3 | 63,247 | `PROPOSED` | `frontend-pages` |
| `#1106` | Show the dry-run preview in the developers UI | 1 | 3,693 | `PROPOSED` | `api-routes` |
| `#1109` | Move the newsletter signup challenge into a Web Worker so the page never stutters | 2 | 703 | `PROPOSED` | `frontend-pages` |
| `#1119` | Show bulk re-arm attribution in the confirmation dialog before submitting | 1 | 21,133 | `PROPOSED` | `frontend-pages` |
| `#1151` | Add the rescore-backfill scheduler-status endpoint to the API contract | 3 | 12,352 | `PROPOSED` | `api-routes` |

### Wave 13 — 10 tasks (combined blast radius: 39,503 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#930` | Intigriti integration recipe | 3 | 2,612 | `PENDING` | `frontend-pages` |
| `#955` | Let teammates name and reuse their favorite sensitivity configs | 2 | 586 | `PENDING` | `frontend-components` |
| `#956` | Show what each signal would do before you toggle it | 2 | 473 | `PENDING` | `frontend-components` |
| `#961` | Add automated tests for the preset comparison panel | 2 | 421 | `PENDING` | `frontend-components` |
| `#965` | Side-by-side draft comparison in the quality preview | 3 | 3,944 | `PENDING` | `frontend-pages` |
| `#998` | Add automated tests for the scoring playground math | 2 | 1,123 | `PENDING` | `frontend-pages` |
| `#1002` | Add Quickstart to the in-app onboarding tour | 2 | 942 | `PENDING` | `frontend-pages` |
| `#1118` | Restore the reviewer dashboard's broken test suite | 5 | 22,630 | `PROPOSED` | `frontend-pages` |
| `#1145` | Add a 'Featured in gallery' badge on report results pages | 2 | 5,132 | `PROPOSED` | `frontend-pages` |
| `#1146` | Show live precision and recall numbers on the engines overview | 3 | 1,640 | `PROPOSED` | `frontend-pages` |

### Wave 14 — 10 tasks (combined blast radius: 39,842 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#931` | Render integration recipes inside the app instead of linking to GitHub | 3 | 2,612 | `PENDING` | `frontend-pages` |
| `#960` | Save your favorite preset comparisons for later | 2 | 453 | `PENDING` | `frontend-components` |
| `#964` | Import and export custom redaction rule sets as files | 1 | 328 | `PENDING` | `frontend-components` |
| `#966` | Calibrate the local quality estimate against the real engine | 1 | 281 | `PENDING` | `frontend-components` |
| `#969` | Auto-add approved AI-self-disclosure suggestions to the live list | 1 | 297 | `PENDING` | `frontend-components` |
| `#987` | Guided tours for the Check, Results, and Compare pages | 5 | 9,254 | `PENDING` | `frontend-pages` |
| `#1003` | End-to-end test for the Quickstart Try-it widget | 1 | 536 | `PENDING` | `frontend-pages` |
| `#1093` | Make the largest entry chunk smaller so the landing path loads faster | 4 | 582 | `PROPOSED` | `frontend-other` |
| `#1102` | Show the running build version on the website footer | 1 | 0 | `PROPOSED` | `frontend-components` |
| `#1132` | Add a UI test that exercises the alert acknowledge button end-to-end | 2 | 25,499 | `PROPOSED` | `frontend-pages` |

### Wave 15 — 9 tasks (combined blast radius: 18,647 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#678` | Browser extension for bounty platforms | 1 | 8,489 | `PENDING` | `api-spec` |
| `#973` | Block deploys when the scoring gate fails (not just warn) | 4 | 796 | `PENDING` | `docs` |
| `#1009` | Automated tests for keyboard shortcuts | 3 | 2,608 | `PENDING` | `frontend-pages` |
| `#1101` | Run automated colour-contrast checks against the live OKLCH palette | 4 | 1,472 | `PROPOSED` | `frontend-other` |
| `#1103` | Block PRs that change the API contract without a changelog entry | 4 | 718 | `PROPOSED` | `scripts` |
| `#1105` | Cross-link the dry-run preview from every platform recipe | 1 | 675 | `PROPOSED` | `backend-docs` |
| `#1139` | Add an automated check that the API server starts cleanly without firing maintenance scripts | 5 | 1,403 | `PROPOSED` | `backend-other` |
| `#1147` | Show Go SDK usage in the Bugcrowd integration recipe | 3 | 2,084 | `PROPOSED` | `frontend-pages` |
| `#1150` | Add a ready-to-run Python triage script example next to the SDK | 3 | 402 | `PROPOSED` | `other` |

### Wave 16 — 5 tasks (combined blast radius: 12,882 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#1007` | Show a hint that keyboard shortcuts are available | 2 | 1,091 | `PENDING` | `frontend-components` |
| `#1013` | Link fired signals on the report results page to their explainer | 3 | 8,025 | `PENDING` | `frontend-pages` |
| `#1140` | Move the seed and other backfill scripts to the same library + CLI split as backfill-vulnrap | 5 | 1,129 | `PROPOSED` | `backend-other` |
| `#1148` | Surface the triage recommendation as a typed field on the Go SDK | 2 | 890 | `PROPOSED` | `backend-docs` |
| `#1149` | Publish the Python SDK to PyPI so `pip install vulnrap` works | 3 | 1,747 | `PROPOSED` | `frontend-pages` |

### Wave 17 — 2 tasks (combined blast radius: 6,184 LOC)

| Ref | Title | Files | LOC (sum) | State | Bucket |
| --- | ----- | ----: | --------: | ----- | ------ |
| `#1008` | Let users customize their own keyboard shortcuts | 3 | 497 | `PENDING` | `frontend-components` |
| `#1099` | Make every clickable card keyboard-accessible (Enter/Space + focus) | 7 | 5,687 | `PROPOSED` | `frontend-pages` |


---

## 4. Cannot parallelize

These tasks are excluded from wave assignment because their
`## Relevant files` section is missing, empty, or so vague (e.g.
claims a whole top-level directory) that the conflict graph can't
reason about them. They need replanning before they can be batched.

| Ref | Title | Reason | State |
| --- | ----- | ------ | ----- |
| `#700` | Conference talk abstract + outline | all `Relevant files` entries are vague (top-level dir or 'new file') | `PENDING` |
| `#702` | Social post templates | all `Relevant files` entries are vague (top-level dir or 'new file') | `PENDING` |
| `#703` | Email signature + outreach templates | all `Relevant files` entries are vague (top-level dir or 'new file') | `PENDING` |
| `#742` | Catch quoted and bracketed placeholder slots split by punctuation | no `Relevant files` section | `IN_PROGRESS` |
| `#935` | Show why a referenced resource failed verification | empty `Relevant files` section | `PENDING` |
| `#936` | Cover the verification trust panel with UI tests | empty `Relevant files` section | `PENDING` |
| `#1120` | Add a test that bulk re-arm audit entries include reviewer and rationale end-to-end | no `Relevant files` section | `PROPOSED` |
| `#1129` | Cover AI self-disclosure preview helpers with focused unit tests | all `Relevant files` entries are vague (top-level dir or 'new file') | `PROPOSED` |
| `#1131` | Show acknowledged alerts in their own filter on the dashboard | all `Relevant files` entries are vague (top-level dir or 'new file') | `PROPOSED` |


---

## 5. Recommended next batch

**Next batch: Wave 4** — 8 tasks in this wave are file-disjoint from each other AND from every currently in-flight task.

In-flight set: **8** tasks occupying 8 of 10 slots; **2** slots are open right now. Recommended releases (in ref order):

- `#949` — Capture the actual scoring engine version on every analysis (`engines`)
- `#952` — Let visitors download the corpus stats as CSV (`api-routes`)

_(6 additional tasks in this wave can be released as in-flight slots open up; they're already known to be file-disjoint from the rest of the wave and from the in-flight set.)_

_(2 tasks in this wave share files with the in-flight set and are held back from this batch.)_


---

## 6. Line-range references

_(No active task currently pins a line range in its `## Relevant files` block.)_


---

## Regenerating this document

Run from the repo root:

```bash
node scripts/regenerate-parallelization-runbook.mjs
```

The script reads `scripts/data/active-tasks.snapshot.json` and emits this doc
deterministically.

To pull fresh plan bodies from the on-disk project-task surface
(`.local/tasks/*.md`) into the snapshot before regenerating:

```bash
node scripts/regenerate-parallelization-runbook.mjs --refresh
```

`--refresh` walks every `.local/tasks/*.md` plan file, matches each by
its H1 title against the snapshot, and overwrites the matched
snapshot entry's description with the live plan body. Ref + state
are preserved from the snapshot because they live on the project-task
surface that only the planning agent can mutate. Plan files with no
matching snapshot title are reported and skipped (a snapshot rebuild
from the project-task surface is needed to pick them up).

This keeps the script free of external dependencies and safe to run
in CI before `pnpm install`.

CI-friendly check (exits non-zero if regenerating would change the
file; the time-sensitive `Generated:` line is ignored):

```bash
node scripts/regenerate-parallelization-runbook.mjs --check
```
