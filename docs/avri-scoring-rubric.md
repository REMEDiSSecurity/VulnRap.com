# AVRI Scoring Rubric Reference

This document is the single source of truth for how AVRI (the family-aware vulnerability-report scoring pipeline introduced in Sprint 11) turns a report's text into a composite triage score. It walks through every lever in the order it is applied, links each lever back to its source file, and explains the fixture failure modes that motivated its current calibration.

If you are tuning AVRI, **read this top-to-bottom first**. If you are debugging a single surprising score, jump to the [decision tree](#how-to-debug-a-surprising-score) at the bottom.

---

## Pipeline at a glance

For every submitted report the composite runner does the following, in order:

1. **Engine 1 — AI authorship** (legacy + perplexity blend; out of scope for AVRI tuning).
2. **Engine 0 — Family classification** (`classify.ts`) picks one of nine families: `MEMORY_CORRUPTION`, `INJECTION`, `WEB_CLIENT`, `AUTHN_AUTHZ`, `CRYPTO`, `DESERIALIZATION`, `RACE_CONCURRENCY`, `REQUEST_SMUGGLING`, or `FLAT`.
3. **Engine 2 (AVRI substance)** scores gold-signal evidence and applies absence + contradiction penalties for the chosen family, then blends with the legacy substance engine.
4. **Engine 3 (AVRI coherence)** assigns an explicit base score from the cited-vs-evidence family relationship, then nudges it with behavioural bonuses and coherence penalties.
5. **Composite** runs the existing 5/55/40 weighting with the v3.6.0 override rules, then layers the Sprint 11 behavioural overrides (velocity, template campaign, no-gold, family contradiction) and the FLAT slop haircut.

The ten levers documented below are the knobs that determine the final number after step 1 has run.

---

## Engine 2 — substance (`engine2-avri.ts`)

### Lever 1 — `calibratedMax` (gold-signal normalisation denominator)

- **Source:** `artifacts/api-server/src/lib/engines/avri/engine2-avri.ts`, line ~139.
- **What it does:** Normalises the sum of matched gold-signal points by `Math.max(1, round(totalPossible * 0.55))` rather than `totalPossible`. A complete report only needs to hit ~55% of the family's possible signal weight to saturate the rubric.
- **Why this value:** Earlier sprints normalised against `totalPossible`, which meant only "the perfect synthetic report" reached 100. Real well-evidenced fixtures (e.g. the canonical SQL-injection PoC, the use-after-free with stack trace + ASAN output) consistently topped out around 70 because no real report contains *every* optional gold signal. Lowering to 55% lets these reach the upper band without rescuing slop, which still hits 0–2 signals.
- **Fixtures that motivated the value:** Real-world memory-corruption with ASAN + crash dump + minimised reproducer; INJECTION reports with payload + sink + DB error message but no proxy capture.

### Lever 2 — `baseScore` ceiling of 84

- **Source:** `engine2-avri.ts` line ~145 (`Math.min(84, ...)`).
- **What it does:** Caps the post-normalisation gold-signal base at 84/100 even if every signal fired.
- **Why this value:** AVRI is a triage signal, not a verdict. Reserving the top 16 points for downstream evidence (live verification, reviewer judgement) prevents the substance engine from saturating before the composite gets to weigh authorship and coherence. A maximally-evidenced report should still leave room for human-confirmed reproduction to raise it.
- **Fixtures that motivated the value:** Synthetic "every gold signal" stress test in `corpus-calibration.test.ts` was scoring 100 and pushing the composite to STRONG before any verification step ran.

### Lever 3 — `ABSENCE_PENALTY_CAP = 12`

- **Source:** `engine2-avri.ts` line 15 (`const ABSENCE_PENALTY_CAP = 12;`), applied at line ~152.
- **What it does:** Sums absence penalties only up to a total of 12 points. Once the cap is reached, remaining missing-signal penalties stop accruing.
- **Why this value:** The original Sprint-11 spec used a -25 cap (still referenced in the file header comment as "Sprint 11 Part 4 math fix"). Field calibration showed -25 over-punished partial reports that legitimately omitted one or two evidence types (e.g. a CRYPTO finding with key material but no test vectors). -12 keeps the penalty meaningful for missing-everything slop while letting partial-but-real reports stay above the YELLOW band.
- **Fixtures that motivated the value:** The Sprint 11 calibration corpus' partial-evidence CRYPTO and AUTHN_AUTHZ fixtures.

### Lever 4 — Adaptive blend weight (`avriWeight`)

- **Source:** `engine2-avri.ts` lines ~184–193.
- **What it does:** Default blend is 50% AVRI / 50% legacy substance. When all of the following hold the AVRI weight drops to 25%:
  - `rawAvriScore < 25`
  - `legacy.score >= 55`
  - no contradictions detected anywhere in the text
  - at least one gold signal hit
- **Why this rule:** Some legitimate vulnerability classes don't fit any family rubric cleanly — shell-script TOCTOU, CORS-credentials misconfig, header-injection variants. Their gold-signal coverage is sparse but the legacy substance engine recognises them as well-evidenced. Without the rescue path, AVRI was forcing these into RED. The strict gate (gold≥1, no contradictions, legacy strong) ensures slop reports — which have weak legacy substance scores too — are not rescued.
- **Fixtures that motivated the value:** Shell TOCTOU report (CWE-367 inside MEMORY_CORRUPTION's narrow rubric), CORS-credentials misconfig classified as WEB_CLIENT but light on the canonical XSS gold signals.

### Lever 5 — `contradictionsAnywhere` guard

- **Source:** `engine2-avri.ts` lines ~181–183 (used inside the adaptive-blend gate).
- **What it does:** When deciding whether to enable the legacy-anchor rescue (Lever 4), checks for contradiction phrases anywhere in the raw text — including inside fenced code blocks and unified-diff hunks. Engine 2's main contradiction count uses prose-only (via `stripCodeAndDiffs`), but the rescue gate uses raw text.
- **Why this matters:** Type-swap slop sometimes carries *real* INJECTION evidence (working SQLi payload, DB error from the sink) while citing CWE-79 and including `alert(1)` somewhere in the text. Without the slip-through guard, the high legacy substance score would rescue them via Lever 4 even though the cited family is wrong. Counting contradictions anywhere — including code — disqualifies these from the rescue path.
- **Fixtures that motivated the value:** "Working SQLi disguised as XSS" cross-class slop discovered after Sprint 11 Part 4. Note the asymmetry with the main contradiction count, which strips code; this is intentional and is the only place we look at code blocks for contradictions.

### Lever 6 — FLAT hand-wavy haircut (`flat_handwavy_haircut`)

- **Source:** `engine2-avri.ts` lines ~67–123.
- **What it does:** When the classifier returns `FLAT` (no family fits), Engine 2 normally just passes through the legacy substance score. The haircut scans for ~20 hand-wavy markers ("private fuzzing harness", "structural rather than", "comprehensive zero-trust assessment", "modern threat landscape", etc.). Each match deducts 6 points; the total is capped at 24.
- **Why this exists:** FLAT was the slop attacker's cheat code — write generic prose with no concrete evidence, no fingerprints fire, the family rubric can't crater you, and the legacy substance score (which doesn't know about hand-waving) leaves you in the YELLOW band. The haircut markers are a curated list of self-admitted-no-evidence phrases ("I do not have a runnable reproducer") and buzzword-soup framings ("defense-in-depth posture").
- **Fixtures that motivated the value:** Sprint 11 buzzword-soup corpus; the "leadership-level discussion" / "weak security culture" archetype.

---

## Engine 3 — coherence (`engine3-avri.ts`)

Engine 3 selects exactly one **base rule** from the matrix below, then applies a small behavioural bonus, contradiction penalty, and coherence penalty on top.

### Lever 7 — `SAME_FAMILY_FLOOR = 75`

- **Source:** `engine3-avri.ts` lines ~110–134.
- **What it does:** When the rubric family selected for scoring matches the family inferred from the report's *evidence* (vuln-type signals + keyword fallback), and the report has at least one **concrete** gold signal (anything other than `cwe_correct_class`), the Engine 3 base score is locked to 75.
- **Why this value:** 75 sits just above the 65 GREEN threshold so a coherent, cited-correctly report doesn't fall below "REASONABLE" for stylistic reasons. The floor protects against over-aggressive coherence penalties accumulating into a low score for a fundamentally correct report.
- **Fixtures that motivated the value:** Memory-corruption reports with crash dump + CWE-787 cited that were scoring in the 50s due to a single coherence nit before the floor was added.

### Lever 8 — `SAME_FAMILY_NO_CONCRETE_EVIDENCE = 32`

- **Source:** `engine3-avri.ts` lines ~123–130 (the `concreteGoldHitCount === 0` branch of `sameFamily`).
- **What it does:** Same-family detection requires a *concrete* gold-signal hit before granting the 75 floor. If the only gold signal that matched is `cwe_correct_class` (the report mentions a CWE id mapped to the family but nothing else), the base drops to 32 — well inside RED territory.
- **Why this value:** T3 slop reports learned to copy the right CWE label without producing any real artefact (no payload, sink, code reference, or stack trace). With the original `sameFamily` floor they inherited 75 just by saying "CWE-89". The concrete-hit requirement closes that loophole. 32 is low enough to keep them in RED but not so low it's indistinguishable from `OFF_FAMILY_CEILING`.
- **Fixtures that motivated the value:** "Cite the right CWE, prove nothing" T3 slop campaign discovered after Sprint 11 Part 4.

### Lever 9 — `OFF_FAMILY_CEILING = 25` and `CITED_NO_EVIDENCE = 60`

- **Source:** `engine3-avri.ts` lines ~119–146.
- **What they do:** These are the other branches of the base-rule matrix:
  - **`OFF_FAMILY_CEILING` (25)** — Cited CWE family disagrees with the evidence family, *and* the evidence family was identified with at least MEDIUM confidence. This is the "type-swap" signal: high-confidence evidence points one way, the cited CWE points another.
  - **`CITED_NO_EVIDENCE` (60)** — A CWE is cited and maps to a family, but no corroborating evidence-family fingerprint matched. We trust the report cautiously: well above the 42 fallback, well below the 75 floor.
  - **`FAMILY_DETECTED_NO_CWE` (38)** — Evidence points at a family but the report doesn't cite any CWE.
  - **`FALLBACK` (42)** — None of the above.
- **Why these values:** The bands match the triage labels they imply (≤25 LIKELY INVALID/HIGH RISK, ~38–42 NEEDS REVIEW, 60 REASONABLE, 75 PROMISING). `evidenceConfidentEnough` requires HIGH or MEDIUM evidence confidence — gating off-family on weak/LOW evidence would punish vague-but-honest reports.
- **Fixtures that motivated the value:** Type-swap slop (cited CWE-79, evidence is SQLi); the "CWE-190 → MEMORY_CORRUPTION via keyword fallback" integer-overflow report that motivated using `selectedFamily` for `sameFamily` while keeping cited-vs-evidence for the off-family ceiling.

---

## Composite (`composite.ts`)

### Lever 10 — `AVRI_FLAT_SLOP_HAIRCUT = -8`

- **Source:** `artifacts/api-server/src/lib/engines/avri/composite.ts` lines ~109–113.
- **What it does:** When the family is `FLAT` and Engine 2's hand-wavy haircut accumulated ≥18 points (i.e. ≥3 hand-wavy markers fired), apply an additional -8 to the final composite.
- **Why this exists:** Engine 2's haircut alone only zeroes the substance contribution. Engines 1 and 3 still report their legacy values, leaving a buzzword-soup composite hovering in the high teens to low twenties — just inside HIGH RISK rather than LIKELY INVALID where it belongs. -8 tips these over the 20-point boundary into LIKELY INVALID without touching legitimate FLAT reports (which never accumulate the haircut threshold).
- **Fixtures that motivated the value:** The "comprehensive zero-trust assessment" / "modern threat landscape" archetype reports that scored ~22 composite before the haircut.

### Other composite-layer overrides (context only)

These predate AVRI Part 4 and aren't re-tuned, but reviewers should know they exist and where they fire:

- **`AVRI_VELOCITY`** — additive penalty from same-day submission velocity (computed in the route layer, passed in via `opts.velocityPenalty`).
- **`AVRI_TEMPLATE_CAMPAIGN`** — additive penalty when the report's structural fingerprint has been seen before (template-fingerprint detector).
- **`AVRI_NO_GOLD_SIGNALS`** — informational override flagged when family ≠ FLAT and both engines report zero gold hits.
- **`AVRI_FAMILY_CONTRADICTION`** — informational override flagged when Engine 2 found at least one contradiction phrase in prose.

---

## How to debug a surprising score

Use this when a single report's composite doesn't match expectations.

```
START: pull the report's signalBreakdown (engine.signalBreakdown.avri exists for E2 and E3).

1. What family was selected?  (avri.family)
   ├── FLAT
   │     • Was a hand-wavy haircut applied? (E2 detail.totalAbsencePenalty)
   │     │     ├── Yes, ≥18 → composite should also show AVRI_FLAT_SLOP_HAIRCUT (-8). If not, check classification: a real family may have been missed.
   │     │     └── No / <18 → score is essentially the legacy substance + coherence + authorship blend. Treat it like a pre-AVRI score.
   │     • Expected a real family? Look at classification.evidence and classification.reason in the avri payload.
   │
   └── A real family (MEMORY_CORRUPTION, INJECTION, …)
         │
         2. What Engine 3 base rule fired?  (E3 avri.baseRule)
         ├── SAME_FAMILY_FLOOR (75)
         │     → score is high-coherence; if final is still RED, look at E2 and E1.
         ├── SAME_FAMILY_NO_CONCRETE_EVIDENCE (32)
         │     → only the cwe_correct_class gold signal hit. Report is reciting the CWE without evidence. Usually correct that this is RED.
         ├── OFF_FAMILY_CEILING (25)
         │     → cited CWE disagrees with evidence at MEDIUM/HIGH confidence. Verify by reading classification.citedFamily vs classification.evidenceFamily.
         ├── CITED_NO_EVIDENCE (60)
         │     → CWE cited but no evidence fingerprint matched. Often a real but light report; check whether evidence-family detection missed something.
         ├── FAMILY_DETECTED_NO_CWE (38) or FALLBACK (42)
         │     → expected to be NEEDS REVIEW band.
         │
         3. What does Engine 2 say?  (E2 avri.baseScore, goldHits, absencePenalty, contradictionPenalty, blendedScore)
         ├── baseScore at the 84 cap?  → Lever 2 is in effect; this is by design.
         ├── Many gold hits but blendedScore unexpectedly low?
         │     • Check totalAbsencePenalty hitting the cap (12) — if so, Lever 3 is intentionally limiting damage.
         │     • Check contradictionPenalty — every contradiction phrase docks 8 (capped at 24).
         ├── Few gold hits, but blendedScore high?
         │     • Adaptive blend (Lever 4) may have pulled in a high legacy score. Confirm: rawAvriScore < 25, legacyScore ≥ 55, ≥1 gold hit, no contradictions anywhere.
         │     • If you see a contradiction in code blocks but blend was 25/75 anyway, Lever 5's slip-through guard is failing — check stripCodeAndDiffs and the contradictionsAnywhere construction.
         │
         4. Composite still off?
         ├── Check overridesApplied for AVRI_VELOCITY / AVRI_TEMPLATE_CAMPAIGN — these come from the route layer and aren't visible in the engine signals.
         ├── Check for AVRI_NO_GOLD_SIGNALS / AVRI_FAMILY_CONTRADICTION — informational only, but they confirm the family-vs-content mismatch.
         └── If none of the AVRI levers explain it, Engine 1 (authorship + perplexity) is doing the work. AVRI tuning won't help; check perplexity.combinedScore.
```

---

## Lever index (quick reference)

| # | Lever | File | Default |
|---|-------|------|---------|
| 1 | `calibratedMax` | `engine2-avri.ts` | `round(totalPossible * 0.55)` |
| 2 | `baseScore` cap | `engine2-avri.ts` | 84 |
| 3 | `ABSENCE_PENALTY_CAP` | `engine2-avri.ts` | 12 |
| 4 | Adaptive blend weight | `engine2-avri.ts` | 0.5 (drops to 0.25 under guard) |
| 5 | `contradictionsAnywhere` guard | `engine2-avri.ts` | always-on |
| 6 | `flat_handwavy_haircut` | `engine2-avri.ts` | -6 per marker, cap -24 |
| 7 | `SAME_FAMILY_FLOOR` | `engine3-avri.ts` | 75 |
| 8 | `SAME_FAMILY_NO_CONCRETE_EVIDENCE` | `engine3-avri.ts` | 32 |
| 9 | `OFF_FAMILY_CEILING` / `CITED_NO_EVIDENCE` | `engine3-avri.ts` | 25 / 60 |
| 10 | `AVRI_FLAT_SLOP_HAIRCUT` | `composite.ts` | -8 |

Whenever you change one of these, update both the inline comment in the source file *and* the corresponding section here so the rationale and the value never drift apart.
