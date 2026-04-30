# Validity-fusion disagreement-floor audit

This note records the calibration evidence behind the
`disagreementThreshold = 30` and `Math.min(heuristic, llmRaw)` floor in
[`src/lib/score-fusion.ts`](../../src/lib/score-fusion.ts). Update this
file (and link the new run from the inline comment) the next time the
rule is re-evaluated.

## Decision (Task #312)

Keep the floor: `Math.min` clipping when `|heuristic − llmRaw| > 30`.
The threshold and the operator both stay.

## How the data was captured

Dev-only smoke endpoint, with the LLM forced to fire on every fixture:

```bash
# Server: pnpm --filter @workspace/api-server run dev (NODE_ENV=development)
curl -s "http://localhost:8080/api/test/run?withLlm=1" > calibration.json
```

The route exposes:

- Aggregate counters at `auditTelemetry.validityFusion`
  (sampledCount, floorAppliedCount, meanDeltaWhenApplied,
  higherSideWhenApplied).
- A per-row `validityAudit` blob on each entry of `results[]` (added
  by Task #312 specifically so future audits don't need a code change
  to see which fixture tripped the floor).

## Findings (April 2026 sweep, 72 fixtures, two runs)

| Run | Floor-fires | Heur-higher | LLM-higher | Mean Δ |
|-----|-------------|-------------|------------|--------|
| 1   | 2 / 72 (3%) | 0           | 2          | 45     |
| 2   | 7 / 72 (10%)| 1           | 6          | 41.1   |

Run-to-run variance is `gpt-5-nano` non-determinism on borderline rows
plus silent LLM-call timeouts on the cold cache. Tracked separately as
follow-up #445.

### Per-tier disagreement (run 2, the more complete sample)

- T1_LEGIT — n=15, **0 disagreements**.
- T2_BORDERLINE — n=10, 1 LLM-higher (T2-10), Δ=55.
- T3_SLOP — n=33, 6 LLM-higher / 1 heuristic-higher (mean Δ ≈ 18).
- T4_HALLUCINATED — n=14, **0 disagreements**.

Both cohort extremes (T1, T4) are unanimous. The floor never harms
unambiguous reports.

### Floor-fire fixtures stable across both runs

- **T2-10-open-redirect** (T2_BORDERLINE) — heur=29, LLM=84,
  blended=57, Δ=55 → final=29. A legit-shaped open-redirect report the
  heuristic can't see; the LLM correctly elevates substance, the floor
  clips it back. T2-10's expected triage set already includes
  `AUTO_CLOSE`, so no calibration regression.
- **T3-14-pseudo-asan-symbolless** (T3_SLOP) — heur=29, LLM=64,
  blended=47, Δ=35 → final=29. A symbolless ASan trace fools the LLM
  into rating substance; the floor restores the heuristic's correct
  skepticism. Without the floor, validity creeps into Likely-Slop's
  borderline.

## Alternatives ruled out

- **Raise threshold to 40+** — T2-10 (Δ=55) still fires, T3-14 (Δ=35)
  stops firing. Loses the slop protection without saving the
  borderline case.
- **Switch to `median(heuristic, llmRaw, blended)`** — algebraically
  collapses to `blended`, i.e. removes the floor entirely.
- **Switch to `median(heuristic, llmRaw, neutral=50)`** — over-rates
  T3 slop (T3-14 jumps from 29 to 50).
- **Asymmetric "fire only when LLM-lower"** — helps T2-10 but loses
  the T3-14-style protection that motivated the rule.

## Why `Math.min` at 30 is the right shape

`Math.min` is asymmetric on purpose: the LLM is a cheap second opinion
that can pull validity DOWN (it rarely invents low-substance signals
from nothing) but should not single-handedly pull validity UP on
well-formatted fakes. The audit confirms the rule still matches that
intent.

Production impact today is bounded further by the cost gate
(`evaluateLlmGate` in `src/lib/llm-slop.ts`), which keeps the LLM from
firing at all on most calibration fixtures. If the gate widens, the
floor's real-world fire rate will rise — a re-audit at that point
should refresh this note.

## Verification — no slop-tier regression

The `/api/test/run` calibration assertions use
`analyzeWithEnginesTraced` (the 3-engine composite pipeline), which
does **not** import `score-fusion`. The disagreement-floor decision
therefore cannot regress slop-tier composite/E2/triage assertions on
the fabricated-report side. Confirmed by re-running the baseline
calibration after the docs change: every T3_SLOP fixture remained
within its expected composite range.
