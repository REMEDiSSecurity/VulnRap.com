# Scoring regression golden corpus (Task #638)

A locked golden corpus of ~200 labeled fixtures (T1/T2/T3/T4) with
snapshotted pipeline scores. Every PR runs the corpus and any tier-flip
on any fixture fails CI loudly. This is the regression baseline the user
asked for: *"we need to test each update to make sure we are NOT
worsening our results."*

## Files

| File | Role | Regen workflow |
| --- | --- | --- |
| `golden-corpus.json` | Curated corpus: `id`, `text`, `claimedCwes?`, `expectedTier`, `expectedScoreRange` (±3 band), `expectedSignals[]`. Hand-reviewed. | `REGENERATE_CORPUS=1` |
| `golden-corpus.snap.json` | Per-entry current pipeline composite score. Drift inside the band shows up as a PR diff but does not fail; drift outside the band fails the band assertion. | `UPDATE_SNAPSHOTS=1` |
| `golden-corpus.regression.test.ts` | Loads both files, replays the full scoring pipeline (`analyzeWithEnginesTraced`) on every entry, asserts (a) tier matches, (b) score in band, (c) expected signals all fired. | n/a |

## Tier mapping (composite → tier)

The composite score is 0..100, higher = better. The corpus uses the
project's existing 4-bucket vocabulary:

| composite | tier |
| --- | --- |
| `>= 60` | `T1` (legit) |
| `>= 40` | `T2` (borderline) |
| `>= 20` | `T3` (slop) |
| `<  20` | `T4` (hallucinated) |

Bands are deliberately wider than the per-fixture `expectedScoreRange`
(±3) so a single small calibration tweak cannot silently flip a tier on
its own — only meaningful drift can.

## Running the suite

```bash
# CI / local: assert every entry, fail on tier flip / band exit /
# missing expected signal. This is the default.
pnpm --filter @workspace/api-server test test/regression/golden-corpus.regression.test.ts
```

## Intentional snapshot updates

A calibration change that *intentionally* nudges scores by a few points
within the recorded band will surface as a per-entry diff in
`golden-corpus.snap.json`. Update the snapshot with:

```bash
UPDATE_SNAPSHOTS=1 pnpm --filter @workspace/api-server test \
  test/regression/golden-corpus.regression.test.ts
```

Commit the resulting `golden-corpus.snap.json` diff alongside the code
change. PR review is responsible for confirming the per-entry deltas are
expected — CI does NOT auto-apply snapshot updates (per the task brief).

## Intentional corpus regeneration

Use this when the fixture battery in
`src/routes/test-fixtures.ts` changes (a new T1..T4 fixture is added,
tier labels are reorganized, etc.) — i.e. when you need to regenerate
the **expected** tier / band / signal set, not just the observed score.

```bash
REGENERATE_CORPUS=1 pnpm --filter @workspace/api-server test \
  test/regression/golden-corpus.regression.test.ts
```

This rewrites both `golden-corpus.json` and `golden-corpus.snap.json`
from scratch, using the current scoring pipeline as the source of
truth. Treat the resulting diff as a calibration change and review
every entry before committing.

## Composition of the corpus

The corpus seeds from two sources, both fully synthetic / curated (no
production reports, per the task's out-of-scope clause):

1. **Existing fixture battery** — every entry of `TEST_FIXTURE_COHORTS`
   (T1, T2, T3, T4) in `src/routes/test-fixtures.ts`, spanning all AVRI
   families (MEMORY_CORRUPTION, INJECTION, WEB_CLIENT, AUTHN_AUTHZ,
   CRYPTO, FLAT).
2. **Deterministic text-shape variants** — for each existing fixture,
   two minor mutations: a benign trailing triage note and a benign
   leading markdown header. These exercise the pipeline's stability
   under common-but-irrelevant text shape changes — exactly the kind
   of drift the user wants the gate to catch.

This brings the entry count to ~200 without inventing synthetic
vulnerabilities the AVRI rubric hasn't already been calibrated against.
