# AVRI/legacy substance blend calibration — Task #436

**Date:** 2026-04-30
**Decision:** Leave `avriWeight = 0.5` in `src/lib/engines/avri/engine2-avri.ts:550`
unchanged. Re-attempt this task on/after **2026-05-13** with the queries below
re-run against then-fresh production traces.

## Why the ratio change is deferred

Task #436 (and its predecessor in v3.9.0's notes / task #298) asked for a
re-tune to roughly 60/40 or 65/35 once **≥2 weeks of post-flip production
traces with `avriBreakdown` populated** had accumulated in `analysis_traces`.

That prerequisite is not met as of 2026-04-30:

| Source                       | Rows | Date range         | Rows with `trace.avriBreakdown` |
| ---------------------------- | ---: | ------------------ | ------------------------------: |
| Production `analysis_traces` |   30 | 2026-04-20 → 04-25 |                               0 |
| Dev `analysis_traces`        |   32 | 2026-04-20 → 04-25 |                               0 |

The v3.9.0 default-on flip (`VULNRAP_USE_AVRI=true`) shipped 2026-04-29,
**one day ago**. Every persisted trace was written under the legacy path.
The v3.9.1 trace-shape extension that adds `avriBreakdown` is the
prerequisite that just shipped — production traces written from
2026-04-29 onwards will carry the new field, but the corpus is empty
today.

The task spec is explicit that the ratio decision must come from
production data, not the synthetic battery (`Done looks like → "A new
ratio is chosen from that data (not just from the synthetic fixture
battery)"`). Lifting `avriWeight` blindly today risks `legit-03` (sits at
77, floor was just bumped to 70 by Task #427) and the other
near-floor legit fixtures.

## How to re-run this calibration when production traces accumulate

Once `analysis_traces` carries enough post-2026-04-29 rows with
`avriBreakdown` populated (target: ≥200 rows split across multiple
families, with at least 30 rows per major family — `INJECTION`,
`MEMORY_CORRUPTION`, `WEB_CLIENT`, `AUTHN_AUTHZ`, `CRYPTO`,
`DESERIALIZATION`, `REQUEST_SMUGGLING`, `FLAT`):

### 1. Per-family AVRI vs legacy disagreement

```sql
SELECT
  trace->'avriBreakdown'->>'family' AS family,
  COUNT(*) AS n,
  ROUND(AVG((trace->'avriBreakdown'->>'rawAvriScore')::numeric), 1) AS avg_raw_avri,
  ROUND(AVG((trace->'avriBreakdown'->>'legacyScore')::numeric), 1) AS avg_legacy,
  ROUND(AVG((trace->'avriBreakdown'->>'rawAvriScore')::numeric
            - (trace->'avriBreakdown'->>'legacyScore')::numeric), 1) AS avg_delta,
  ROUND(STDDEV((trace->'avriBreakdown'->>'rawAvriScore')::numeric
               - (trace->'avriBreakdown'->>'legacyScore')::numeric), 1) AS stddev_delta
FROM analysis_traces
WHERE trace->'avriBreakdown' IS NOT NULL
  AND created_at >= '2026-04-29'
GROUP BY family
ORDER BY n DESC;
```

### 2. Candidate-weight projection

For each row, project the substance score at all candidate weights
(0.50, 0.55, 0.60, 0.65) and bucket which fixtures cross the two
behavior gates that matter:

- **`E3_SUBSTANCE_GATE`** at substance < 45 caps Engine 3 at 55
  (see `src/lib/engines/index.ts` BMR/E3 logic and
  `src/lib/engines/e3-substance-gate.test.ts`).
- **`BEHAVIORAL_MATCH_REWARD`** at substance ≥ 60 + Engine 3 coherent
  CWE match rewards the composite.

```sql
SELECT
  trace->'avriBreakdown'->>'family' AS family,
  COUNT(*) AS n,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.50
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.50) < 45) AS at_50_under_45,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.55
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.45) < 45) AS at_55_under_45,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.60
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.40) < 45) AS at_60_under_45,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.65
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.35) < 45) AS at_65_under_45,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.50
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.50) >= 60) AS at_50_over_60,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.55
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.45) >= 60) AS at_55_over_60,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.60
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.40) >= 60) AS at_60_over_60,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.65
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.35) >= 60) AS at_65_over_60
FROM analysis_traces
WHERE trace->'avriBreakdown' IS NOT NULL
  AND created_at >= '2026-04-29'
GROUP BY family
ORDER BY family;
```

The decision rule: pick the smallest weight bump that **does not** flip
the `over_60` count for slop-shaped families (`FLAT`, traces with no
gold evidence) and does **not** flip the `under_45` count for legit
families (`MEMORY_CORRUPTION`, `INJECTION`, `DESERIALIZATION`,
`REQUEST_SMUGGLING`).

#### Cohort segmentation (slop vs legit proxy)

`family` alone isn't a clean slop/legit split — `INJECTION` covers both
real RCEs and `slop-04-no-evidence-rce` shapes. Re-run the candidate-
weight projection bucketed by a defensible legit-vs-slop proxy. The
strongest proxy persisted on every trace is the **composite label**
(`trace->'composite'->>'label'`): `CRITICAL` / `HIGH` / `REASONABLE`
read as legit-shaped; `SLOP` reads as slop-shaped. Every weight change
should flip slop-shaped `at_w_over_60` further DOWN and must not
materially raise legit-shaped `at_w_under_45`:

```sql
SELECT
  CASE WHEN trace->'composite'->>'label' = 'SLOP'
       THEN 'slop_shape' ELSE 'legit_shape' END AS cohort,
  trace->'avriBreakdown'->>'family' AS family,
  COUNT(*) AS n,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.55
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.45) < 45) AS at_55_under_45,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.60
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.40) < 45) AS at_60_under_45,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.65
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.35) < 45) AS at_65_under_45,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.55
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.45) >= 60) AS at_55_over_60,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.60
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.40) >= 60) AS at_60_over_60,
  COUNT(*) FILTER (WHERE
    ROUND((trace->'avriBreakdown'->>'rawAvriScore')::numeric * 0.65
        + (trace->'avriBreakdown'->>'legacyScore')::numeric * 0.35) >= 60) AS at_65_over_60
FROM analysis_traces
WHERE trace->'avriBreakdown' IS NOT NULL
  AND trace->'composite' IS NOT NULL
  AND created_at >= '2026-04-29'
GROUP BY cohort, family
ORDER BY cohort, family;
```

The label is a soft proxy (it is itself a function of the substance
score the calibration is trying to tune, so there's some
self-reference), but combined with the family breakdown it's the
strongest cohort signal persisted on every trace and matches what the
acceptance criteria call for. For a stricter check, sample a handful
of rows from each `cohort × at_X_over_60` cell and human-verify the
composite label still reads correctly at the candidate weight before
shipping.

### 3. Rescue-override (0.25) review

The override at `engine2-avri.ts:572..583` flips `avriWeight` from 0.5
down to 0.25 when **all** of the following hold:

```
rawAvriScore < 25
&& legacyScore >= 55
&& !contradictionsAnywhere      // no family-contradiction phrase anywhere in text
&& goldHits.length >= 1         // at least one family gold-signal hit
&& !crashTrace?.isStripped
&& !crashTrace?.hasStructuralFabrication
&& !rawHttp?.isFake
&& !rawHttpResponse?.isFake
```

The two score thresholds (`rawAvri < 25 && legacy >= 55`) capture the
shape; the remaining six are slop disqualifiers — they ensure the
rescue path only fires for reports that look legit to the legacy
engine for the right reasons (real evidence, no family contradictions,
no fabricated crash trace or HTTP response). The pattern is real-world
legit reports like shell-script TOCTOU bugs and CORS-credentials
misconfigurations: AVRI distrusts them because their evidence shape
doesn't match a narrow gold-signal rubric, but the legacy substance
probes recognize them and they have no contradictions.

The persisted `trace.avriBreakdown` only carries the two score fields,
so the production audit query can identify the **score-shape candidate
set**, but confirming the override actually fired (vs. being shut down
by one of the six disqualifiers) requires checking `trace.signals` for
the family-contradiction / stripped-trace / fake-HTTP / structural-
fabrication / gold-signal indicators on each row.

```sql
-- Score-shape candidate set: how often does the rescue predicate
-- POSSIBLY fire (passes the score-threshold half), and what is the
-- composite distribution on those rows?
SELECT
  trace->'avriBreakdown'->>'family' AS family,
  COUNT(*) AS rescue_candidate_rows,
  ROUND(AVG((trace->'composite'->>'overallScore')::numeric), 1) AS avg_composite,
  ROUND(MIN((trace->'composite'->>'overallScore')::numeric), 1) AS min_composite,
  ROUND(MAX((trace->'composite'->>'overallScore')::numeric), 1) AS max_composite
FROM analysis_traces
WHERE trace->'avriBreakdown' IS NOT NULL
  AND (trace->'avriBreakdown'->>'rawAvriScore')::numeric < 25
  AND (trace->'avriBreakdown'->>'legacyScore')::numeric >= 55
  AND created_at >= '2026-04-29'
GROUP BY family
ORDER BY rescue_candidate_rows DESC;
```

If `rescue_candidate_rows` is non-trivial and the average composite
lands above 50 for those rows (i.e. the rescue path is plausibly
ratifying legit reports), the override is earning its keep — pull a
sample, manually verify a few rescued reports were genuinely
legitimate, and keep it. If `rescue_candidate_rows` is empty or
rescued composites land in slop-band, the override should be
revisited (tightened to a known family allow-list, or removed).

## Synthetic-fixture snapshot (for reference only)

Captured 2026-04-30 by replaying the 29-fixture battery in
`src/lib/engines/benchmark.test.ts` through `analyzeWithEnginesTraced`
with `forceAvri:true`. **These numbers are not the basis for any
decision** — the task spec explicitly bars synthetic-only tuning — but
they show what shape of data the production query above will surface.

### AVRI vs legacy substance scores per fixture

```
[cohort   ] name                                                family             rawAvri  legacy  blended  composite  rescue?
[slop     ] slop-01-vague-xss                                   WEB_CLIENT               0       9        5         16  no  (Δ= -9)
[slop     ] slop-02-ai-template                                 FLAT                     9       9        9         23  no  (Δ= +0)
[slop     ] slop-03-fake-sqli                                   INJECTION                0       5        3         15  no  (Δ= -5)
[slop     ] slop-04-no-evidence-rce                             INJECTION                0      15        8          9  no  (Δ=-15)
[slop     ] slop-05-clickjacking-template                       FLAT                     9       9        9         23  no  (Δ= +0)
[slop     ] slop-06-cwe-mismatch                                WEB_CLIENT               0       9        5          6  no  (Δ= -9)
[slop     ] slop-07-marketing-fluff                             FLAT                     9       9        9         19  no  (Δ= +0)
[slop     ] slop-08-vague-csrf                                  WEB_CLIENT               0       9        5         10  no  (Δ= -9)
[slop     ] slop-09-fabricated-asan-structure                   MEMORY_CORRUPTION        0      30       15          0  no  (Δ=-30)
[slop     ] slop-13-fabricated-register-dump-and-memory-map     MEMORY_CORRUPTION        0      52       26         24  no  (Δ=-52)
[slop     ] slop-10-fabricated-http-response                    INJECTION                0      32       16         23  no  (Δ=-32)
[slop     ] slop-13-fabricated-xss-response                     WEB_CLIENT               0      32       16         23  no  (Δ=-32)
[slop     ] slop-11-impossible-http-204-with-body               INJECTION               33      46       39         27  no  (Δ=-13)
[slop     ] slop-12-impossible-http-head-returns-body           AUTHN_AUTHZ             34      44       39         27  no  (Δ=-10)
[slop     ] slop-14-impossible-graphql-response                 INJECTION                0      24       12          0  no  (Δ=-24)
[curl-slop] curl-slop-h1-2298307-strcpy-template                MEMORY_CORRUPTION        0      12        6          8  no  (Δ=-12)
[curl-slop] curl-slop-h1-3295650-gitleaks-test-certs            FLAT                    10      25       10         19  no  (Δ=-15)
[curl-slop] curl-slop-h1-3116935-des-ntlm-broken-crypto         CRYPTO                  84      17       51         41  no  (Δ=+67)
[curl-slop] curl-slop-h1-3125832-fabricated-pentest             INJECTION                0      30       15         22  no  (Δ=-30)
[curl-slop] curl-slop-h1-3340109-fabricated-asan                MEMORY_CORRUPTION       68      28       48         62  no  (Δ=+40)
[legit    ] legit-01-cve-2025-0725-curl                         MEMORY_CORRUPTION       51      69       60         71  no  (Δ=-18)
[legit    ] legit-02-curl-cookie-parser                         MEMORY_CORRUPTION       72      65       69         79  no  (Δ= +7)
[legit    ] legit-03-request-smuggling                          REQUEST_SMUGGLING       84      50       67         77  no  (Δ=+34)
[legit    ] legit-04-xxe-cve-2017-5004-phpexcel                 DESERIALIZATION         64      93       79         56  no  (Δ=-29)
[legit    ] legit-05-lfi-cve-2019-11510-pulse-secure            WEB_CLIENT              28      58       43         54  no  (Δ=-30)
[legit    ] legit-06-open-redirect-cve-2017-7233-django         WEB_CLIENT               4      85       44         55  no  (Δ=-81)
[legit    ] legit-07-deserialization-cve-2017-9805-struts-xs... DESERIALIZATION         78      88       83         88  no  (Δ=-10)
[legit    ] legit-08-prototype-pollution-cve-2019-10744-lodash  INJECTION               84      93       89         90  no  (Δ= -9)
[legit    ] legit-09-command-injection-cve-2017-1000117-git-... INJECTION               84      68       76         83  no  (Δ=+16)
```

### Synthetic candidate-weight pivots (substance score only, not composite)

The substance-score projection at `w ∈ {0.50, 0.55, 0.60, 0.65}`. Only
fixtures that cross a behavior gate at any candidate are listed:

| fixture                                       | rawAvri | legacy | w=0.50 | w=0.55 | w=0.60 | w=0.65 | crosses                              |
| --------------------------------------------- | ------: | -----: | -----: | -----: | -----: | -----: | ------------------------------------ |
| `curl-slop-h1-3116935-des-ntlm-broken-crypto` |      84 |     17 |     51 |     54 |     57 |     61 | crosses BMR (≥60) gate at w=0.65     |
| `legit-01-cve-2025-0725-curl`                 |      51 |     69 |     60 |     59 |     58 |     57 | drops below BMR (≥60) at w=0.55+     |
| `legit-06-open-redirect-cve-2017-7233-django` |       4 |     85 |     45 |     40 |     36 |     32 | drops below E3 gate (<45) at w=0.55+ |

Reading: the synthetic battery suggests **w=0.55 is safe**, **w=0.60 is
right at the edge** (legit-06's substance drops to 36, well into the
E3-cap zone), and **w=0.65 introduces a slop-side risk** at
`des-ntlm-broken-crypto` (substance crosses 60 → eligible for BMR
reward). These are projections only — the real production-trace sweep
will be more representative.

Note on slop-cohort distribution: most synthetic slop fixtures have
`rawAvri ≤ legacy` (so a higher `avriWeight` pulls them further down,
which is the desired direction), **but two curl-slop fixtures invert
that pattern**: `curl-slop-h1-3116935-des-ntlm-broken-crypto` (rawAvri
84, legacy 17) and `curl-slop-h1-3340109-fabricated-asan` (rawAvri 68,
legacy 28). Both are families where AVRI's gold-signal rubric mistakes
weak slop for real evidence (CRYPTO and MEMORY_CORRUPTION); the legacy
substance probes catch them. These are exactly the fixtures that argue
for keeping `avriWeight` ≤ 0.60. The 0.65 BMR-gate crossing on
`des-ntlm-broken-crypto` quoted in the table above is the leading
synthetic indicator of this risk.

### 0.25 rescue-override fire-rate (synthetic)

**Zero synthetic fixtures trigger the override** as currently shaped.
Walking the full predicate (engine2-avri.ts:572..583) against the
battery: legit-01/02/03/04/07/08/09 fail the `rawAvri < 25` clause;
legit-03 fails `legacy >= 55` (sits at 50); legit-05 has rawAvri 28
(fails `rawAvri < 25`); legit-06 satisfies both score thresholds
(rawAvri 4, legacy 85) but appears not to satisfy at least one of the
six slop-disqualifier clauses (gold-signal hit / no contradictions /
no stripped trace / no structural fabrication / no fake raw HTTP) —
the `expect rescue=no` column in the table confirms the override
didn't fire end-to-end at runtime. The override is designed for
real-world legit-report shapes (shell-script TOCTOU, CORS-credentials
misconfig) that this synthetic battery doesn't represent. The
production-trace audit query above is the right way to confirm the
override still earns its keep.

## What to ship next sprint

1. Re-run the three queries above on a populated `analysis_traces`
   table.
2. Pick the smallest `avriWeight` bump (0.55 / 0.60 / 0.65) that does
   not flip behavior gates against the production family distribution.
3. Patch `engine2-avri.ts:550`, re-run `pnpm vitest run src/lib/engines/`
   and verify `benchmark.test.ts` and `e3-substance-gate.test.ts` stay
   green at the new ratio.
4. Decide on the 0.25 rescue override based on the production
   `rescue_candidate_rows` numbers (keep, tighten, or remove).
5. Document the decision in the changelog, replacing the v3.9.1
   "deferred to ~v3.10.0" entry with a v3.10.x ratio-change entry.
