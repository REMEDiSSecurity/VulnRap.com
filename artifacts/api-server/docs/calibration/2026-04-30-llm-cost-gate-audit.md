# LLM cost-gate audit — Task #311

**Date:** 2026-04-30
**Decision:** Leave `COST_GUARD_LOW=25`, `COST_GUARD_HIGH=60`,
`COST_GUARD_CONFIDENCE=0.5` in `src/lib/llm-slop.ts` unchanged. The audit
shows widening these thresholds is the wrong lever; the gate signal itself
needs to change. Tracked as a separate follow-up.

## How the data was captured

`/api/test/run?debug=1` (added by this task, observation-only, dev-only)
runs all 72 calibration fixtures and surfaces the per-fixture `_audit`
row that Task #209's instrumentation already builds. Each row reports the
heuristic score (`analyzeSloppiness.score`) the cost-gate sees and the
resulting `LlmGateReason`.

```bash
curl -s 'http://localhost:8080/api/test/run?debug=1' \
  | jq '[.results[]._audit.heuristicScore] | group_by(.) | map({h:.[0],n:length})'
```

## Heuristic-score distribution across the 72-fixture battery

| Tier            | n   | h=0 | h=8 | h ≥ 25 |
| --------------- | --- | --- | --- | ------ |
| T1_LEGIT        | 15  | 15  | 0   | 0      |
| T2_BORDERLINE   | 10  | 10  | 0   | 0      |
| T3_SLOP         | 33  | 32  | 1   | 0      |
| T4_HALLUCINATED | 14  | 14  | 0   | 0      |
| **Total**       | 72  | 71  | 1   | **0**  |

Gate-fire rate on the battery: **0 / 72 (0%)**. Every fixture is reported
as `skipped_below_borderline`.

## Borderline-composite reports the gate is silently skipping

Fixtures whose composite score lands in the supposed `[25, 60]` borderline
band but whose heuristic is 0 (so the LLM substance pass is never invoked):

- T1: `T1-05-xxe-libxml`, `T1-06-prototype-pollution`, `T1-07-jwt-none`,
  `T1-08-redis-cmdinj`, `T1-11-toctou-symlink`
- T2: `T2-01-xss-unconfirmed`, `T2-03-info-disclosure-headers`,
  `T2-06-mixed-content`, `T2-07-idor-suspicion`,
  `T2-09-stack-trace-on-error`
- T3: `T3-05-no-target`, `T3-16-fabricated-diff-injection`,
  `T3-17-fabricated-diff-web-client`, `T3-23-contradiction-injection`
- T4: `T4-05-fake-cwe-mismatch`, `T4-11-impossible-http-shape`

Total: 16 fixtures. This includes the original Sprint 12 Report 82 motivating
case (composite 48, sophisticated slop, heuristic 0) — exactly the pattern
the cost-gate was supposed to catch.

## Why widening the thresholds is the wrong fix

- **Lowering `COST_GUARD_LOW` (25 → 0)** would convert the gate into "always
  fire" since _every_ heuristic value is ≥ 0. Gate-fire rate jumps from 0%
  to 100%, including all obvious-slop T3/T4 and obvious-legit T1 reports.
  That defeats the cost gate's only job.
- **Raising `COST_GUARD_HIGH` above 60** catches nothing. No fixture in the
  battery scores above 8 on the heuristic axis.
- **Raising `COST_GUARD_CONFIDENCE`** only matters once the call sites pass
  a real confidence. Today both call sites hardcode `confidence=1.0`
  (`src/routes/reports.ts` line 275, `src/routes/test-fixtures.ts` line
  2707; the `confidenceUsed` audit field documents this), so the OR-leg of
  the gate is dead and tuning it changes nothing observable.

## Root cause: signal selection, not threshold width

`analyzeSloppiness.score` keys off AI-buzzword tells, very-long sentences,
very-long reports, and repetitive language. Well-templated, sophisticated
slop reports trivially evade all of those checks, so the heuristic almost
never produces a value inside `[25, 60]`. The gate cannot be tuned by
threshold widening — the gate's input axis needs to change. The right fix
is to gate on the composite or Engine 2 substance score (with the heuristic
kept as a tiebreaker) rather than on the AI-buzzword heuristic alone. That
work is tracked as a follow-up to this task and is intentionally out of
scope for a "widen-or-justify" decision.
