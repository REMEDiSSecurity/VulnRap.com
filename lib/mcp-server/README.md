# `@workspace/mcp-server` — Public VulnRap MCP server

A standalone [Model Context Protocol](https://modelcontextprotocol.io)
server that exposes the public VulnRap REST API as a set of MCP tools so
LLM-tool ecosystems (Claude Desktop, Cursor, custom agents) can call
VulnRap with one line of config.

The server is deliberately a thin wrapper: every tool maps 1:1 to a
public HTTP endpoint, validates the input with [`@workspace/api-zod`](../api-zod)
where possible, and returns the upstream JSON verbatim.

## Tools

| MCP tool               | Wraps                                 |
| ---------------------- | ------------------------------------- |
| `score_report`         | `POST /api/reports/check`             |
| `lookup_report`        | `GET /api/reports/{id}`               |
| `query_stats`          | `GET /api/stats`                      |
| `query_transparency`   | `GET /api/public/corpus-stats`        |
| `query_gallery`        | `GET /api/reports/feed`               |
| `get_drift_summary`    | `GET /api/public/drift-summary`       |
| `query_signal_metrics` | `GET /api/feedback/holdout-eval`      |
| `get_cohort_baseline`  | `GET /api/cohort/baseline`            |
| `test_yourself`        | `GET /api/test/run` (BYO rows POSTed) |

Reviewer-only endpoints are intentionally **not** exposed.

## Run

```bash
pnpm --filter @workspace/mcp-server build
pnpm --filter @workspace/mcp-server start
```

The server speaks MCP over stdio. Override the API base URL with
`VULNRAP_API_BASE_URL=https://example.test` for self-hosted deployments.

## Claude Desktop config

```jsonc
{
  "mcpServers": {
    "vulnrap": {
      "command": "node",
      "args": ["/absolute/path/to/lib/mcp-server/dist/index.js"],
      "env": {
        "VULNRAP_API_BASE_URL": "https://vulnrap.com",
      },
    },
  },
}
```

## Tests

```bash
pnpm --filter @workspace/mcp-server test
```

The tests stub `globalThis.fetch` so the suite is offline-safe.

### Live smoke test

An opt-in end-to-end smoke test spawns the built MCP server over stdio and
exercises `tools/list` and `score_report` against the real API. It is gated
behind the `MCP_LIVE` environment variable so the default `pnpm test` stays
offline-deterministic.

```bash
pnpm --filter @workspace/mcp-server build
pnpm --filter @workspace/mcp-server test:live
```

You can point it at a different deployment by setting `VULNRAP_API_BASE_URL`:

```bash
VULNRAP_API_BASE_URL=https://staging.vulnrap.com \
  pnpm --filter @workspace/mcp-server test:live
```

The live smoke test runs automatically on a nightly schedule via the
`.github/workflows/nightly-mcp-smoke.yml` workflow. On failure it opens (or
updates) a tracking issue. It can also be triggered manually from the GitHub
Actions UI via `workflow_dispatch`.
