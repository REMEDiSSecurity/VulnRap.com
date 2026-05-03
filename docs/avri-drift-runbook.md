# AVRI calibration drift runbook

The AVRI scoring path is on in production
(`VULNRAP_USE_AVRI=true`) with a calibrated 51pt T1/T3 composite gap. As
real reports flow through, the rubric weights, family floors, and FLAT
haircut markers can drift relative to actual reporter behaviour. This
runbook covers how to read the drift dashboard and which knobs to turn
when a flag fires.

## Where to look

- **Endpoint:** `GET /api/feedback/calibration/avri-drift?weeks=8`
- **Source:** `artifacts/api-server/src/lib/avri-drift.ts`
- **Mirrors the pattern in:** the `avriComparison` block of
  `GET /api/test/run` (see `artifacts/api-server/src/routes/test-fixtures.ts`).

The endpoint returns a rolling weekly view of the AVRI composite for
production reports, bucketed by the persisted composite label as a
proxy for the matrix triage outcome:

| Composite label               | Bucket  | Triage equivalent   |
| ----------------------------- | ------- | ------------------- |
| `STRONG`, `PROMISING`         | T1      | PRIORITIZE          |
| `LIKELY INVALID`, `HIGH RISK` | T3      | AUTO_CLOSE          |
| `NEEDS REVIEW`, `REASONABLE`  | NEUTRAL | (excluded from gap) |

For each week the response reports `t1.mean`, `t3.mean`, the `gap`
between them, and per-family means within each bucket.

## When flags fire

- **`GAP_BELOW_45`** — the weekly T1−T3 composite gap dropped below
  45pt while both buckets had at least 3 reports. The rubric is
  collapsing: legit reports are scoring lower or slop reports are
  scoring higher than the calibrated 51pt gap.
- **`FAMILY_MEAN_SHIFT`** — a family's mean inside T1 or T3 moved by
  ≥5pt from the previous eligible week. Indicates a single family is
  drifting (e.g. a new INJECTION fingerprint is letting weak reports
  through).

## How to re-tune

Decide which side is drifting before changing anything; the bucket the
flag fires in (T1 vs T3) tells you whether legit reports are scoring
too low or slop reports are scoring too high.

1. **T1 mean dropped (legit reports under-scoring)**
   - Inspect the affected family in
     `artifacts/api-server/src/lib/engines/avri/families.ts` and
     `engine2-avri.ts`.
   - Lower the family's `absencePenalties[*].points` for the gold
     signals legit reports are missing, or add a softer floor in
     `engine2-avri.ts` for that family.
2. **T3 mean climbed (slop reports over-scoring)**
   - Add or tighten a `contradictionPhrases` entry on the family
     rubric so the new slop archetype is demoted.
   - If the offender is unclassifiable, raise the FLAT slop haircut
     (`flatSlopPenalty`) or its trigger threshold
     (`totalAbsencePenalty >= 18`) in
     `artifacts/api-server/src/lib/engines/avri/composite.ts`.
3. **Gap collapsing without a single family driving it**
   - The behavioural penalties are likely too small. Adjust the
     velocity / template-fingerprint penalties in
     `artifacts/api-server/src/lib/engines/avri/velocity.ts` and
     `template-fingerprint.ts`, then re-run the smoke test
     (`GET /api/test/run`) and confirm the AVRI-on gap is back ≥50pt.

After any change, re-run `GET /api/test/run` and confirm
`avriComparison.avriOnGapMeetsTarget` is still true and the per-family
T1−T3 gaps look reasonable. The drift endpoint will also recompute on
the next request — confirm the previously-flagged week clears once
fresh reports come in.

## Tuning constants in this runbook

The drift thresholds themselves live in
`artifacts/api-server/src/lib/avri-drift.ts`:

- `GAP_WARN = 45`
- `FAMILY_SHIFT_WARN = 5`
- `MIN_BUCKET = 3`

Change them only when the calibrated 51pt gap target itself moves.

## Notifications

To shorten time-to-action, freshly-firing drift flags can be pushed to a
webhook instead of waiting for someone to open the calibration page.

- **Source:** `artifacts/api-server/src/lib/avri-drift-notifications.ts`
- **Endpoint (manual / external cron):**
  `POST /api/feedback/calibration/avri-drift/notify` (auth-gated by
  `CALIBRATION_TOKEN` — same header as the other calibration mutations).
- **Background scheduler (Task #197):** the API server starts an
  in-process timer at boot (`startDriftNotificationScheduler` in
  `src/index.ts`) that runs the same check on a deterministic
  cadence — by default the first tick fires ~60s after boot and
  subsequent ticks fire every `AVRI_DRIFT_NOTIFY_INTERVAL_MS` ms
  (default 6 hours), independent of report traffic. A failed run
  re-arms with the shorter `AVRI_DRIFT_NOTIFY_RETRY_INTERVAL_MS`
  (default 5 minutes) so transient webhook outages recover quickly.
  The scheduler short-circuits when `AVRI_DRIFT_WEBHOOK_URL` is unset,
  so unconfigured environments pay zero cost per tick.

  Earlier versions (pre Task #197) coupled this check to
  `POST /api/reports` as a throttled fire-and-forget side effect. That
  hot-path hook has been removed; the scheduler is now the only auto
  trigger, alongside the manual / external-cron endpoint above.

### Setup

1. Set `AVRI_DRIFT_WEBHOOK_URL` to a webhook that accepts JSON
   (Slack/Discord incoming webhook, PagerDuty Events v2, your own
   bridge to email, etc.). When unset, the notifier is a no-op — the
   drift dashboard still works exactly as before.
2. Set `PUBLIC_URL` so the webhook payload's `calibrationUrl`
   resolves to your deployed site. Defaults to `https://vulnrap.com`
   if unset.
3. (Recommended) Set `AVRI_DRIFT_RUNBOOK_URL` to wherever you
   actually host this runbook (GitHub blob URL, internal wiki, etc.).
   The default link is the in-repo path off `PUBLIC_URL`, which will
   404 in most production setups because the deployed Express app
   does NOT serve the `docs/` directory as static assets.
4. (Optional) Override `AVRI_DRIFT_NOTIFY_INTERVAL_MS` to change the
   scheduler's success-case interval. Set to a small value during a
   drift incident if you want more frequent re-checks; set to `0` to
   tick almost continuously (only sane in low-volume / dev
   environments — production should stay at 6h).
5. (Optional) Override `AVRI_DRIFT_NOTIFY_RETRY_INTERVAL_MS` to
   change how quickly the scheduler retries after a failed dispatch
   (defaults to 5 minutes). Lower it during a drift incident if
   you're paging on a flaky webhook target.

### Payload

```json
{
  "event": "avri_drift_flags",
  "generatedAt": "2026-04-29T00:00:00Z",
  "calibrationUrl": "https://vulnrap.example.com/feedback-analytics",
  "runbookUrl": "https://vulnrap.example.com/docs/avri-drift-runbook.md",
  "thresholds": { "gapWarn": 45, "familyShiftWarn": 5, "minBucketSize": 3 },
  "cohort": "avri_on_only",
  "flags": [
    {
      "key": "2026-04-20|GAP_BELOW_45",
      "weekStart": "2026-04-20",
      "kind": "GAP_BELOW_45",
      "detail": "T1−T3 composite gap 40 < 45pt threshold (T1 n=5 mean=70, T3 n=5 mean=30)."
    }
  ]
}
```

### De-duplication

Reviewers are notified at most once per flag, scoped by:

- `GAP_BELOW_45`: `weekStart`
- `FAMILY_MEAN_SHIFT`: `weekStart` + bucket (`T1`/`T3`) + family

State is persisted to
`artifacts/api-server/data/avri-drift-notifications.json` so a process
restart does not re-flood the channel. To force re-notification of
recent flags (e.g. after a webhook outage), truncate that file's
`notified` array. A failed dispatch does NOT mark its flags as
notified, so transient webhook outages auto-recover on the next run.

### Operational notes

- The background scheduler short-circuits when
  `AVRI_DRIFT_WEBHOOK_URL` is unset, so unconfigured environments
  pay zero cost per tick. The drift dashboard endpoint still works
  exactly as before.
- The scheduler runs in every replica: in a multi-instance deploy
  each replica ticks independently. The dedup state file
  (`avri-drift-notifications.json`) is the cross-tick guard against
  duplicate webhook fan-out, so the same flag is dispatched at most
  once per replica's view of the state file. If you run multiple
  replicas with separate state files you will see at most one extra
  dispatch per flag per replica — point all replicas at the same
  state path (or at the same external state store) if that matters.
- **Per-replica heartbeats (Task #397).** Each replica writes its
  own scheduler heartbeat back to the shared
  `avri-drift-notifications.json` under `schedulerHeartbeats`,
  keyed by a stable `replicaId` (`${hostname}-${bootHex}`,
  overridable with the `AVRI_REPLICA_ID` env var). The
  scheduler-status endpoint merges this replica's live in-memory
  snapshot with the persisted heartbeats from peers, so the
  calibration UI surfaces every replica — not just whichever one
  happened to handle the request. The heartbeat map is capped at
  50 entries (oldest by `heartbeatAt` evicted) so transient
  replicas can't grow it unboundedly. Persistence is best-effort:
  failures are logged but never block a tick.
- The manual `POST .../notify` endpoint always runs the check (it's
  not gated by the scheduler interval) so reviewers can press a
  "Re-check now" button between scheduled runs.
- **Scheduler heartbeat panel.** The calibration page renders a
  "Scheduler heartbeat" panel below the notified-flags table with
  one row per replica that has published a heartbeat. Each row
  shows the replica's id + hostname, last tick + outcome, next
  scheduled tick, configured cadence, and a health badge ("Healthy"
  / "Last tick failed" / "Armed · webhook not configured" / "Not
  started in this process" / "Overdue · scheduler may be wedged").
  A row is flagged Overdue when its scheduled `nextTickAt` has been
  past due by more than `retryIntervalMs + 60s` — that grace window
  covers a single in-flight retry so transient failures don't trip
  the alarm, only persistent stalls. Use the panel as the first stop
  when the question is "are all replica schedulers still alive?" —
  no need to scrape stdout for per-replica
  `[avri-drift-notifications] Drift notification scheduler started.`
  boot lines. Backed by
  `GET /api/feedback/calibration/avri-drift/scheduler-status`, which
  is un-gated (status + replica identity only, no webhook URL or
  token leakage) and returns an array — one entry per known replica.
- When the webhook is unset but flags exist, the notifier still
  records them as notified locally so wiring up a webhook later
  does not produce a retroactive flood. Truncate the state file if
  you actually want the backlog.

### Stalled-scheduler alerts (Task #396)

The scheduler runs in-process, so a hung event loop, a botched
deploy, or a forgotten `stop()` can silently stop new drift flags
from paging anyone. To catch that case, a separate **watchdog timer**
also boots from `src/index.ts` (`startStalledSchedulerWatchdog`) and
polls the in-memory scheduler status every
`AVRI_DRIFT_STALL_WATCHDOG_INTERVAL_MS` (default 5 minutes).

- **Trigger.** The watchdog dispatches when the main scheduler is
  started, has a non-null `nextTickAt`, and the wall clock has moved
  past `nextTickAt + 2 * intervalMs`. The 2× buffer absorbs the
  normal jitter from a single failed-then-retried tick (which uses
  the shorter `AVRI_DRIFT_NOTIFY_RETRY_INTERVAL_MS`) without paging
  reviewers.
- **Webhook.** The alert reuses `AVRI_DRIFT_WEBHOOK_URL`. Payload:
  ```json
  {
    "event": "avri_drift_scheduler_stalled",
    "detectedAt": "2026-04-29T00:02:10.000Z",
    "expectedNextTickAt": "2026-04-29T00:00:00.000Z",
    "overdueByMs": 130000,
    "intervalMs": 60000,
    "retryIntervalMs": 5000,
    "schedulerStartedAt": "2026-04-28T00:00:00.000Z",
    "lastTickAt": "2026-04-28T23:59:00.000Z",
    "lastTickOk": true,
    "ticksCompleted": 7,
    "calibrationUrl": "https://vulnrap.example.com/feedback-analytics",
    "runbookUrl": "https://vulnrap.example.com/docs/avri-drift-runbook.md"
  }
  ```
- **De-duplication.** Each stall detection is keyed by
  `STALL|${expectedNextTickAt}` and stored in the same
  `avri-drift-notifications.json` file (under `schedulerStalls`) as
  drift dedup state, so the watchdog fires at most once per stall
  window even across process restarts. A failed dispatch is NOT
  persisted, so a flaky webhook auto-recovers on the next poll. If
  the scheduler resumes and later wedges on a _different_ expected
  tick, the dedup key changes and the watchdog re-pages.
- **Calibration banner.** The calibration page header renders a
  red "Scheduler appears stalled" banner driven by the same
  `nextTickAt + 2 * intervalMs` predicate, so reviewers see the
  problem in the UI even when `AVRI_DRIFT_WEBHOOK_URL` is unset.
- **Silencing.** To clear historical stall records (e.g. after a
  long-resolved incident), edit
  `artifacts/api-server/data/avri-drift-notifications.json` and
  truncate the `schedulerStalls` array. Removing only the most
  recent entry will allow the watchdog to re-page for that same
  stall window — usually only useful if you intentionally want a
  re-test page during recovery drills.
- **Recovery checklist.** When a stall page fires:
  1. Open the calibration page and confirm the red banner is still
     visible (the banner clears as soon as the next tick lands).
  2. Check `Scheduler heartbeat` for `lastTickOk` and `lastTickAt`
     — a long-stale `lastTickAt` with `lastTickOk: true` typically
     means the timer was cleared (e.g. the process is shutting
     down) rather than the tick body throwing.
  3. If the API server is up but the scheduler is wedged, restart
     the `artifacts/api-server: API Server` workflow. The dedup
     state file survives the restart, so the watchdog will not
     re-page for the same stall window.
  4. After recovery, confirm `nextTickAt` advances on the next
     poll. The stall record stays in `schedulerStalls` as an audit
     trail; truncate it once the incident is closed if you'd
     rather not retain it.
