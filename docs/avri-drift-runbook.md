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

| Composite label              | Bucket   | Triage equivalent     |
| ---------------------------- | -------- | --------------------- |
| `STRONG`, `PROMISING`        | T1       | PRIORITIZE            |
| `LIKELY INVALID`, `HIGH RISK`| T3       | AUTO_CLOSE            |
| `NEEDS REVIEW`, `REASONABLE` | NEUTRAL  | (excluded from gap)   |

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
- The scheduler is per-process: in a multi-instance deploy each
  replica ticks independently. The dedup state file
  (`avri-drift-notifications.json`) is the cross-tick guard against
  duplicate webhook fan-out, so the same flag is dispatched at most
  once per replica's view of the state file. If you run multiple
  replicas with separate state files you will see at most one extra
  dispatch per flag per replica — point all replicas at the same
  state path (or at the same external state store) if that matters.
- The manual `POST .../notify` endpoint always runs the check (it's
  not gated by the scheduler interval) so reviewers can press a
  "Re-check now" button between scheduled runs.
- **Scheduler heartbeat panel.** The calibration page
  renders a "Scheduler heartbeat" panel below the notified-flags
  table. It displays the in-process scheduler's last tick + last
  outcome, the next scheduled tick, the configured cadence, and a
  health badge ("Healthy" / "Last tick failed" / "Armed · webhook
  not configured" / "Not started in this process"). Use it as the
  first stop when the question is "is the scheduler still alive?" —
  no need to scrape stdout for the
  `[avri-drift-notifications] Drift notification scheduler started.`
  boot line. Backed by
  `GET /api/feedback/calibration/avri-drift/scheduler-status`, which
  is un-gated (status only, no webhook URL or token leakage). Like
  every other piece of scheduler state it is per-process, so in a
  multi-replica deploy the panel reflects whichever replica handled
  the request.
- When the webhook is unset but flags exist, the notifier still
  records them as notified locally so wiring up a webhook later
  does not produce a retroactive flood. Truncate the state file if
  you actually want the backlog.
