# vulnrap-go

Official Go client for the [VulnRap](https://vulnrap.com) API — multi-engine
sloppiness scoring, similarity matching, and PII auto-redaction for
vulnerability reports. Designed for use inside cloud-native security tooling
(CI gates, Hubot/Slack bots, custom triage runners).

- No API key required. All endpoints are free, anonymous, rate-limited per IP.
- Pure standard library — no third-party deps.
- Idiomatic Go: `context.Context` first, errors returned, no panics.

## Install

```bash
go get github.com/vulnrap/vulnrap/sdks/go/vulnrap
```

## Quick start

```go
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/vulnrap/vulnrap/sdks/go/vulnrap"
)

func main() {
    c := vulnrap.NewClient()
    ctx := context.Background()

    res, err := c.ScoreReport(ctx, &vulnrap.ScoreReportInput{
        RawText:     "Found a path traversal in /api/files?path=../../etc/passwd ...",
        ContentMode: vulnrap.ContentModeFull,
    })
    if err != nil {
        log.Fatal(err)
    }

    fmt.Printf("report #%d: slop=%d/%s confidence=%.2f\n",
        res.ID, res.SlopScore, res.SlopTier, res.Confidence)
    fmt.Println("delete token (save this!):", res.DeleteToken)
}
```

## Methods

| Method                                      | HTTP                    | Returns            |
| ------------------------------------------- | ----------------------- | ------------------ |
| `ScoreReport(ctx, *ScoreReportInput)`       | `POST /reports`         | `*ReportAnalysis`  |
| `LookupReport(ctx, id int)`                 | `GET /reports/{id}`     | `*ReportAnalysis`  |
| `QueryStats(ctx)`                           | `GET /stats`            | `*PlatformStats`   |
| `TestYourself(ctx, *TestYourselfInput)`     | `POST /reports/check`   | `*CheckResult`     |

`ScoreReport` stores the report; `TestYourself` runs the same pipeline but
persists nothing — use it for read-only PSIRT-side validation of incoming
reports.

### Submitting content

Each submission method accepts exactly one of `RawText`, `ReportURL`, or
`File` (with `FileName`):

```go
// 1. Inline text
c.ScoreReport(ctx, &vulnrap.ScoreReportInput{RawText: body})

// 2. Public URL (GitHub raw, Gist, GitLab snippet, Pastebin, ...)
c.ScoreReport(ctx, &vulnrap.ScoreReportInput{
    ReportURL: "https://github.com/user/repo/blob/main/report.md",
})

// 3. Local file
f, _ := os.Open("report.txt")
defer f.Close()
c.ScoreReport(ctx, &vulnrap.ScoreReportInput{
    File:     f,
    FileName: "report.txt",
})
```

### Privacy and analysis flags

```go
c.ScoreReport(ctx, &vulnrap.ScoreReportInput{
    RawText:       "...",
    ContentMode:   vulnrap.ContentModeSimilarityOnly, // store only hashes
    SkipLLM:       true,                              // heuristics only
    SkipRedaction: false,                             // keep PII auto-redaction on
    ShowInFeed:    false,
})
```

> Setting `SkipRedaction: true` forces the server to also `SkipLLM`, so
> unredacted text never reaches the upstream LLM provider.

## Errors

Non-2xx responses are returned as `*vulnrap.APIError`:

```go
res, err := c.QueryStats(ctx)
if err != nil {
    var apiErr *vulnrap.APIError
    if errors.As(err, &apiErr) {
        log.Printf("vulnrap %d: %s", apiErr.StatusCode, apiErr.Message)
    }
    return err
}
```

## Configuration

```go
c := vulnrap.NewClient(
    vulnrap.WithBaseURL("https://staging.vulnrap.com/api"),
    vulnrap.WithHTTPClient(&http.Client{Timeout: 30 * time.Second}),
    vulnrap.WithUserAgent("acme-triage-bot/1.4"),
)
```

## CI gate example

```go
res, err := c.TestYourself(ctx, &vulnrap.TestYourselfInput{File: f, FileName: name})
if err != nil { log.Fatal(err) }
if res.SlopScore > 70 {
    log.Fatalf("report rejected: slop %d > 70 (%s)", res.SlopScore, res.SlopTier)
}
```

## Tests

```bash
cd sdks/go/vulnrap
go test ./...
```

Tests use `net/http/httptest` — no network access required.

## License

Same as the parent VulnRap project.
