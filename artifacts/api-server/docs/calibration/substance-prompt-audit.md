# Substance-prompt audit (Task #446)

This note records the calibration evidence behind the substance-prompt
tightening + evidence-free post-check added in Task #446. Update this
file (and link the new run from the inline comment in
[`computeValidityScore`](../../src/lib/score-fusion.ts)) the next time
the rule is re-evaluated.

## Decision

Two changes, applied together:

1. **Tighten `SYSTEM_PROMPT_FULL` and `SYSTEM_PROMPT_COMPACT` in
   [`llm-slop.ts`](../../src/lib/llm-slop.ts)** with an explicit
   "evidence-free report rules" block: naming a well-known bug class is
   necessary but not sufficient for substance; `domainCoherence` above
   60 requires concrete project-specific evidence; symbolless /
   placeholder sanitizer traces score `pocValidity ≤ 25`; and an
   evidence-free report (no PoC, no captured request/response, no
   sanitizer trace, no specific file/function/CVE/line) caps
   `validityScore` at 30.

2. **Add a heuristic post-check in
   [`computeValidityScore`](../../src/lib/score-fusion.ts)** that caps
   `llmRaw` at the heuristic when the LLM's *own* claim extraction
   confirms the report is evidence-free (`hasPoC === false`,
   `pocValidity ≤ 20`, no `claimedFiles`, no `claimedFunctions`, no
   `claimedCVEs`, no `claimedLineNumbers`). Surfaced as
   `validityFusion.evidenceFreeCapApplied`.

The prompt rules are best-effort — `gpt-5-nano` does not always honor
explicit caps. The post-check is the load-bearing guarantee: it only
fires when the LLM itself reports the report has no concrete material
to evaluate, so the LLM signal can still pull validity DOWN normally
but cannot push it UP above what the heuristic already justified.

## What the prompt was missing

Live `gpt-5-nano` probe of the 6 fixtures listed in Task #446
(baseline prompt, single shot per fixture):

| Fixture                              | poc | spec | domain | substance | validity |
|--------------------------------------|-----|------|--------|-----------|----------|
| T3-14-pseudo-asan-symbolless         | 20  | 30   | **70** | 40        | 38       |
| T3-AVRI-ssrf-template                | 0   | 30   | **70** | 33        | 33       |
| T3-21-no-gold-memory-corruption      | 0   | 50   | **70** | 40        | 55       |
| T3-20-no-gold-web-client             | 0   | 45   | **70** | 32        | 53       |
| T3-16-fabricated-diff-injection      | 0   | 50   | **70** | 60        | 60       |
| T3-02-marketing-tone                 | 0   | 10   | 50     | 20        |  0       |

Three failure modes were visible:

1. **`domainCoherence` consistently ≈ 70** for any report that names a
   real bug class (SSRF in cloud services, XSS in marketing pages,
   SQL injection in admin endpoints, generic memory corruption). The
   LLM correctly observed "this kind of bug fits this kind of
   project", but treated class-name plausibility as if it were
   project-specific evidence.

2. **`internalConsistency` and `hallucinationSignals` scored high for
   evidence-free prose.** Vague prose is trivially internally
   consistent with itself; a report that fabricates nothing has
   nothing to be flagged as hallucinated. Absence of fabricated
   specifics was being scored *equivalently to presence of real
   specifics*.

3. **`green_flags` rewarded soft signals** ("remediation aligns with
   standards", "vulnerability class is sound", "clear description")
   that do not substantiate any specific bug.

The net effect on T3_SLOP fixtures was an `llmRaw` 10–25 points above
the heuristic — just *under* the 30-point disagreement floor — so the
50/50 blend silently inflated the validity axis.

## Re-probe with the tightened prompt

Same 6 fixtures, single shot each, after the prompt change. Note the
collapse on the four prose-only reports:

| Fixture                              | poc | spec | domain | substance | validity (before → after) |
|--------------------------------------|-----|------|--------|-----------|---------------------------|
| T3-14-pseudo-asan-symbolless         | 25  | 28   | 55     | 36        | 38 → **38**               |
| T3-AVRI-ssrf-template                | 0   | 50   | 50     | 40        | 33 → **25**               |
| T3-21-no-gold-memory-corruption      | 0   | 50   | 25     | 25        | 55 → **25**               |
| T3-20-no-gold-web-client             | 0   | 15   | 65     | 40        | 53 → **40**               |
| T3-16-fabricated-diff-injection      | 0   | 25   | 45     | 27        | 60 → **24**               |

T3-14 is unchanged (still has the symbolless-ASan-as-PoC head-fake) —
it is already protected by the existing 30-point disagreement floor.

## Calibration sweep — full battery

`GET /api/test/run?withLlm=1` (74 fixtures, single LLM call per
fixture, gpt-5-nano), via the
[`auditTelemetry.validityFusion`](../../src/routes/test-fixtures.ts)
counters added in Task #446:

| Bucket                       | Before (audit doc run 2) | After |
|------------------------------|--------------------------|-------|
| T3_SLOP — LLM-higher count   | 6 / 33                   | **1 / 33** |
| T3_SLOP — floor-fires        | (subset of above)        | 1 (T3-06) |
| T3_SLOP — evidence-free cap  | n/a                      | 3 (T3-AVRI-ssrf, T3-11, T3-20) |
| T1_LEGIT — evidence-free cap | n/a                      | **0**     |
| T1_LEGIT — LLM-higher count  | (not recorded)           | 13 / 15   |
| T3_SLOP `passRate`           | 1.00                     | **1.00**  |
| T1_LEGIT `passRate`          | 0.73 (pre-existing)      | 0.73      |

Per-fixture audit, T3_SLOP rows where the cap or floor or LLM-higher
fired:

```
T3-AVRI-ssrf-template   h=29 llmRaw=29 final=29  evidenceFreeCap=true
T3-11-fabricated-diff-no-proof  h=27 llmRaw=27 final=27  evidenceFreeCap=true
T3-20-no-gold-web-client  h=29 llmRaw=29 final=29  evidenceFreeCap=true
T3-06-vague-xss   h=52 llmRaw=18 delta=34  conservativeFloor=true
T3-13-narrated-curl-no-evidence  h=56 llmRaw=77 final=67  (LLM-higher; Δ=21 < 30)
```

T3-13 still slips through because the LLM reported `hasPoC=true` (the
report includes a narrated curl session) so the evidence-free
precondition does not hold. Tracked as a follow-up: a separate
"narrated PoC without captured response" detector would catch this
class without expanding the evidence-free cap to risk T1_LEGIT
regressions.

## Why the post-check is conservative

The cap requires the LLM's *own* claim extraction to report ALL of:

- `hasPoC === false`
- `pocValidity ≤ 20`
- `claimedFiles.length === 0`
- `claimedFunctions.length === 0`
- `claimedCVEs.length === 0`
- `claimedLineNumbers.length === 0`

Any single one of these being non-empty disables the cap. Real
legitimate reports always have at least one form of concrete material
(a PoC, a CVE reference, a file/function name, a line number, a
captured request) — so the cap is mathematically unable to fire on
T1_LEGIT. The April 2026 sweep confirms this: the cap fired 3 times,
all on T3_SLOP, zero times on T1_LEGIT.

The cap is also asymmetric: it only fires when `llmRaw > heuristic`.
When the LLM correctly rates an evidence-free report *below* the
heuristic, the cap is a no-op and the LLM signal is allowed to pull
validity DOWN normally. This preserves the existing intent of the
disagreement floor.

## How the data was captured

```bash
# Server: pnpm --filter @workspace/api-server run dev
curl -s "http://localhost:8080/api/test/run?withLlm=1" > calibration.json

# Per-fixture probe (skips the gating + composite pipeline):
node /tmp/probe-llm.mjs /tmp/system-prompt-compact.txt /tmp/fixtures6.json 1 /tmp/probe2.json
```

Aggregate counters added in Task #446:

- `auditTelemetry.validityFusion.llmHigherCount` /
  `llmHigherByTier` — primary metric this audit drives.
- `auditTelemetry.validityFusion.evidenceFreeCapAppliedCount` /
  `evidenceFreeCapAppliedByTier` — observability for the new cap.

## Alternatives considered

- **Lower the disagreement floor from 30 to 20.** Would catch the
  remaining T3_SLOP LLM-higher rows but risks clipping T2_BORDERLINE
  reports where the LLM correctly elevates substance the heuristic
  cannot see (e.g. T2-10-open-redirect, Δ=55 today). Rejected for
  the same reason Task #312 rejected raising the threshold.
- **Cap `llmRaw` at heuristic whenever `pocValidity === 0`.** Too
  broad: legit reports without a runnable PoC (real research notes,
  responsible-disclosure summaries, third-party advisory references)
  would also be capped. The 6-condition AND-gate is the minimum that
  catches "well-shaped slop" without catching legit minimalist
  reports.
- **Drop the substance modifier in `computeValidityScore` entirely.**
  Would stop substance from inflating `llmRaw` but also stop it from
  correctly *deflating* `llmRaw` on borderline reports — the LLM's
  own substance signal is still useful when present.
