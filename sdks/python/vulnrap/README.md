# vulnrap

Official Python client for the [VulnRap](https://vulnrap.com) API — multi-engine
sloppiness scoring, similarity matching, and PII auto-redaction for
vulnerability reports. Designed for security teams scripting PSIRT
workflows, CI gates, and triage bots in Python.

- No API key required. All endpoints are free, anonymous, rate-limited per IP.
- One runtime dependency: [`httpx`](https://www.python-httpx.org/).
- Fully type-hinted (`py.typed` ships with the package).

## Install

```bash
pip install vulnrap
```

## Quick start

```python
from vulnrap import Client

with Client() as c:
    res = c.score_report(
        raw_text="Found a path traversal in /api/files?path=../../etc/passwd ...",
    )
    print(f"report #{res.id}: slop={res.slop_score}/{res.slop_tier} "
          f"confidence={res.confidence:.2f}")
    print("delete token (save this!):", res.delete_token)
```

## Methods

| Method                     | HTTP                  | Returns          |
| -------------------------- | --------------------- | ---------------- |
| `score_report(...)`        | `POST /reports`       | `ReportAnalysis` |
| `lookup_report(report_id)` | `GET /reports/{id}`   | `ReportAnalysis` |
| `query_stats()`            | `GET /stats`          | `PlatformStats`  |
| `test_yourself(...)`       | `POST /reports/check` | `CheckResult`    |

`score_report` stores the report; `test_yourself` runs the same pipeline
but persists nothing — use it for read-only PSIRT-side validation of
incoming reports.

### Submitting content

Each submission method accepts exactly one of `raw_text`, `report_url`, or
`file` (with `file_name`):

```python
# 1. Inline text
c.score_report(raw_text=body)

# 2. Public URL (GitHub raw, Gist, GitLab snippet, Pastebin, ...)
c.score_report(report_url="https://github.com/user/repo/blob/main/report.md")

# 3. Local file
with open("report.txt", "rb") as f:
    c.score_report(file=f, file_name="report.txt")
```

### Async client

For asyncio code (FastAPI handlers, aiohttp bots, Jupyter notebooks),
use `AsyncClient`. It mirrors `Client` one-for-one and shares the same
result models — only the methods are awaitables.

```python
import asyncio
from vulnrap import AsyncClient

async def main() -> None:
    async with AsyncClient() as c:
        res = await c.test_yourself(raw_text="Found a path traversal...")
        print(res.slop_score, res.slop_tier)

asyncio.run(main())
```

### Privacy and analysis flags

```python
from vulnrap import ContentMode

c.score_report(
    raw_text="...",
    content_mode=ContentMode.SIMILARITY_ONLY,  # store only hashes
    skip_llm=True,                             # heuristics only
    skip_redaction=False,                      # keep PII auto-redaction on
    show_in_feed=False,
)
```

> Setting `skip_redaction=True` forces the server to also skip the LLM,
> so unredacted text never reaches the upstream LLM provider.

## Errors

Non-2xx responses are raised as `vulnrap.APIError`:

```python
from vulnrap import APIError, Client

try:
    Client().query_stats()
except APIError as e:
    print(f"vulnrap {e.status_code}: {e.message}")
```

## Configuration

```python
import httpx
from vulnrap import Client

c = Client(
    base_url="https://staging.vulnrap.com/api",
    timeout=30.0,
    user_agent="acme-triage-bot/1.4",
)

# Or inject your own httpx client (retries, custom transport, etc.)
custom = httpx.Client(timeout=10.0)
c = Client(http_client=custom)
```

## CI gate example

```python
from vulnrap import Client
import sys

with Client() as c, open(sys.argv[1], "rb") as f:
    res = c.test_yourself(file=f, file_name=sys.argv[1])

if res.slop_score > 70:
    sys.exit(f"report rejected: slop {res.slop_score} > 70 ({res.slop_tier})")
```

## Tests

```bash
cd sdks/python/vulnrap
pip install -e ".[dev]"
pytest
```

Tests use `pytest-httpx` to mock HTTP — no network access required.

## License

Same as the parent VulnRap project.
