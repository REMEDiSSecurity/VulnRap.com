---
title: "Nightly MCP live smoke test failed"
labels: bug, mcp-server
---

The nightly MCP live smoke test failed.

**Run:** {{ env.RUN_URL }}

This means the MCP server could not successfully communicate with the
live VulnRap API — either `tools/list` or `score_report` returned an
unexpected response shape. This may indicate wire-format drift between
the MCP wrapper and the `/api/reports/check` endpoint.

### Next steps

1. Check the [workflow logs]({{ env.RUN_URL }}) for the specific assertion failure.
2. Verify the live API is healthy (`curl https://vulnrap.com/api/healthz`).
3. If the API response shape changed, update `lib/mcp-server/src/tools.ts` and the smoke test assertions.
