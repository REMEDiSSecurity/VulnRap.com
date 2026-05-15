# `eval/` — offline scoring evaluation harnesses

## REMEDiS 170-report harness (Task #1326)

REMEDiS handed us a 170-report labelled corpus spanning 50+ CWE classes, 6
languages, and 5 adversarial classes
(`attached_assets/AllReports_1778880171809.zip`). This directory is the
measuring stick for vulnrap's scoring pipeline against that corpus.

### Layout

- `remedis-corpus/AllReports/reports/rr-*.json` — extracted corpus (170
  files). **Not committed**; the wrapper script auto-extracts from
  `attached_assets/` on first run.
- `remedis-baseline.json` — committed baseline snapshot. Future runs diff
  against this; regressions show up as threshold-row deltas.
- `remedis-results/<timestamp>.json` — per-run output (gitignored).

### Run

```bash
bash scripts/remedis-harness.sh                 # CI-style, exits non-zero on threshold miss
bash scripts/remedis-harness.sh --baseline      # rewrites remedis-baseline.json
bash scripts/remedis-harness.sh --no-exit-on-fail
```

The metric set and thresholds come from
`attached_assets/HANDOFF_1778880202817.md` §"What CI should look like" and
are tunable from a single `THRESHOLDS` block at the top of
`artifacts/api-server/src/remedis-harness.ts`.

### CI wiring

`scripts/scoring-gate.sh` calls this harness when `REMEDIS_HARNESS=1` is
exported. It is off by default to keep merge times stable while the harness
shakes out; turn it on per-job (nightly) or per-merge by setting the env
var.

### What today's baseline measures

vulnrap currently has no LLM in path and no L1 deterministic pre-filters,
so the pipeline is fully deterministic (L1 and final-verdict stability =
100%) but conservative on the `real` class. The baseline captures that
starting point; Task #1327 (REMEDiS L1 deterministic pre-filters) is
expected to lift FN rate and macro F1 in particular.

Predicted-real is derived from the composite label
(`STRONG | PROMISING | REASONABLE` → real, otherwise not-real). Vulnrap
doesn't predict authenticity classes natively (it scores substance +
AI-authorship), so the harness reports macro F1 over the binary
real-vs-not-real split, plus a per-authenticity-class recall column for
visibility into where errors concentrate.
