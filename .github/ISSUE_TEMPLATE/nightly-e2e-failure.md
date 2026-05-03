---
title: "Nightly e2e suite failed on main"
labels: ["ci", "nightly-e2e"]
---

The scheduled nightly run of the full Playwright e2e suite against `main`
failed.

- Workflow run: {{ env.RUN_URL }}
- Branch: `main`
- Triggered: {{ date }}

This issue is auto-managed by `.github/workflows/nightly-e2e.yml` and will
be reused (rather than creating duplicates) on subsequent failures while it
remains open. Close it once the underlying regression is fixed; the next
green run will not reopen it.

## Suggested triage

1. Download the `nightly-playwright-report` artifact from the failing run.
2. Inspect the failing spec under `artifacts/vulnrap/e2e/`.
3. If the failure looks transient, rerun the workflow. If it is real, file
   a follow-up task and link it back here.
