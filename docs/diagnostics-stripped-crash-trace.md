# Stripped crash traces in the diagnostics panel

_Sprint 11 / Task 78 — surfaces the `STRIPPED_CRASH_TRACE` indicator and the AVRI
trace-gold revocation block written by Engine 2._

## Why this exists

Engine 2's MEMORY_CORRUPTION rubric awards the largest single chunk of "gold"
points for sanitizer/Valgrind/`#N 0x...` crash dumps. Those are also the easiest
gold signals for a slop author to fake — paste a header and a few `frame N:`
lines and the regex fires. To stop that, `crash-trace.ts` inspects the actual
frames; if most of them are placeholder symbols (`<symbol stripped>`,
`+0xZZZZ`, `??(??:0)`, …) or carry no source location, Engine 2:

1. Revokes every gold hit whose ID is in `CRASH_TRACE_GOLD_SIGNAL_IDS`
   (`asan_or_sanitizer`, `valgrind`, `stack_trace_with_offset`).
2. Applies an out-of-cap `STRIPPED_TRACE_PENALTY` (-18) to the AVRI base score.
3. Writes a `crashTrace` block into `signalBreakdown.avri` and emits a
   `STRIPPED_CRASH_TRACE` triggered-indicator.

Before this task, none of that was visible in the diagnostics panel — reviewers
saw a low score with no obvious cause. Now the panel explains it.

## What reviewers see

Inside the **AVRI Family Rubric** section, when a stripped trace was detected,
a red-bordered block appears beneath the contradictions list:

```
┌─ AVRI Family Rubric ───────────────────── Memory corruption / unsafe C ─┐
│  Gold Signals  0/8     Base Score 18     Absence Penalty 0    …        │
│                                                                         │
│  ┌─ [STRIPPED_CRASH_TRACE]  crash trace downgraded (-18) ───────────┐   │
│  │  Crash trace has 4/6 frames with placeholder symbols/offsets     │   │
│  │  frames: 6   good: 1   placeholder: 4                            │   │
│  │                                                                  │   │
│  │  TRACE GOLD SIGNALS REVOKED                                      │   │
│  │   −22  asan_or_sanitizer                                         │   │
│  │   −14  stack_trace_with_offset                                   │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

Each piece maps directly to a field in the diagnostics payload:

| UI element                                  | Data path                                               |
| ------------------------------------------- | ------------------------------------------------------- |
| `STRIPPED_CRASH_TRACE` badge                | indicator emitted by Engine 2 + `crashTrace.isStripped` |
| `crash trace downgraded (-18)`              | `signalBreakdown.avri.crashTrace.penalty`               |
| Reason line                                 | `signalBreakdown.avri.crashTrace.reason`                |
| `frames / good / placeholder` counts        | `crashTrace.{framesAnalyzed, goodFrames, placeholderFrames}` |
| `Trace Gold Signals Revoked` list           | `crashTrace.revokedGoldHits[]` (id + points)            |

The same information is mirrored in the "Copy Markdown" export so it lands in
review threads alongside the rest of the AVRI breakdown.

## Example fixture

The `diagnostics-panel.test.tsx` smoke test
("renders the STRIPPED_CRASH_TRACE block …") uses the following minimal payload
to drive the screenshot above. Reviewers and engine authors can drop this into a
local fetch mock or a Storybook story to reproduce the view without re-running a
full pipeline:

```jsonc
{
  "avri": {
    "family": "MEMORY_CORRUPTION",
    "familyName": "Memory corruption / unsafe C",
    "classification": { "confidence": "HIGH", "reason": "matched member CWE-787", "evidence": ["CWE-787"], "technology": null },
    "goldHitCount": 0,
    "velocityPenalty": 0,
    "templatePenalty": 0,
    "rawCompositeBeforeBehavioralPenalties": 18
  },
  "engines": {
    "engines": [{
      "engine": "Technical Substance Analyzer",
      "score": 22, "verdict": "RED", "confidence": "MEDIUM",
      "signalBreakdown": {
        "avri": {
          "family": "MEMORY_CORRUPTION",
          "familyName": "Memory corruption / unsafe C",
          "baseScore": 18,
          "goldHitCount": 0, "goldTotalCount": 8,
          "goldHits": [], "goldMisses": [],
          "absencePenalty": 0, "absencePenalties": [],
          "contradictions": [], "contradictionPenalty": 0,
          "crashTrace": {
            "framesAnalyzed": 6,
            "goodFrames": 1,
            "placeholderFrames": 4,
            "isStripped": true,
            "reason": "Crash trace has 4/6 frames with placeholder symbols/offsets",
            "revokedGoldHits": [
              { "id": "asan_or_sanitizer", "points": 22 },
              { "id": "stack_trace_with_offset", "points": 14 }
            ],
            "penalty": -18
          },
          "rawAvriScore": 0, "legacyScore": 30, "blendedScore": 22
        }
      }
    }]
  }
}
```

## Triage decision tree

When you see the STRIPPED_CRASH_TRACE block on a low-scoring report:

1. **Does the report quote the original sanitizer output?** Open the source
   report and check the "stack trace" / "ASAN output" section. If the frames
   really are mostly `<symbol stripped>` or `+0xZZZZ`, the downgrade is
   correct — flag the report as low-evidence and move on.
2. **Were real symbols stripped by a sanitizer running without symbols?**
   Possible but rare for a real submission; reach out to the reporter and ask
   for a re-run with `ASAN_SYMBOLIZER_PATH` set. The downgrade is technically
   right, the report just isn't actionable yet.
3. **Are there ≥3 frames with real symbols *and* the validator still fired?**
   That's a false positive in `evaluateCrashTrace`. Drop the offending frames
   into `crash-trace.test.ts` as a regression case and tune the
   `goodFrames / framesAnalyzed` threshold or `PLACEHOLDER_TOKENS`.

## Related

- Engine code: `artifacts/api-server/src/lib/engines/avri/crash-trace.ts`
- Integration: `artifacts/api-server/src/lib/engines/avri/engine2-avri.ts`
  (`crashTrace` block + `STRIPPED_CRASH_TRACE` indicator)
- UI: `artifacts/vulnrap/src/components/diagnostics-panel.tsx`
  (`AvriFamilySection` → crash-trace block, markdown export)
- Rubric levers: `docs/avri-scoring-rubric.md`
