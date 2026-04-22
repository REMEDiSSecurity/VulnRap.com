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
