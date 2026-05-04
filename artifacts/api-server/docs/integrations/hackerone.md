# HackerOne integration recipe

> Wire VulnRap into your HackerOne triage queue: score every incoming
> report, post the result back as an internal comment, and (optionally)
> auto-close the ones the matrix puts in the AUTO_CLOSE band.
>
> No code is shipped to HackerOne. This is a recipe — copy the scripts,
> point them at your program, and adapt to taste.

## Audience

Triagers and PSIRT engineers who already use HackerOne's REST API and
just want a turnkey way to plug VulnRap into the queue. This doc
assumes you have:

- A HackerOne API token with `read` + `write` scopes for your program
  (Settings → Program → API tokens). OAuth apps are out of scope here;
  a manual token is fine.
- The program handle (e.g. `acme-inc`).
- A box that can receive HackerOne webhooks (or run a poller) and reach
  `https://vulnrap.com/api/...`.

VulnRap itself needs no API key — every endpoint used below is open and
anonymous (rate-limited at 30 analyses / 15 min / IP). If you triage at
volume, run the integration from a small fleet so you do not share an
egress IP with the rest of your team.

## What this recipe wires up

1. **HackerOne webhook → your handler** for the `report-created` event.
2. **Your handler → `POST /api/reports/check`** to score the report
   without storing anything on the public VulnRap feed.
3. **Your handler → HackerOne `internal-comments`** to post the
   composite score, the recommended triage action, and a link to the
   pipeline-diagnostics blob.
4. **(Optional) Auto-close on the AUTO_CLOSE tier** by calling the
   HackerOne `state_changes` endpoint with `not-applicable` plus a
   templated message asking for original research.

The `/api/reports/check` endpoint runs the full pipeline (multi-engine
consensus, similarity matching, redaction, AVRI gold signals) but does
**not** persist the report. Use `POST /api/reports` instead if you want
the analysis to land on the public feed and contribute to platform
calibration.

## The triage matrix at a glance

The composite score returned by VulnRap maps to one of five triage
actions. The mapping is the same one used by the public report view:

| Composite | Recommended action   | Suggested H1 move              |
| --------: | -------------------- | ------------------------------ |
|      ≥ 65 | `PRIORITIZE`         | Assign to senior triager + tag |
|      ≥ 55 | `MANUAL_REVIEW`      | Standard human review          |
|      ≥ 40 | `STANDARD_TRIAGE`    | Normal queue                   |
|      ≥ 25 | `CHALLENGE_REPORTER` | Post the generated questions   |
|      < 25 | `AUTO_CLOSE`         | Close as `not-applicable`      |

Override: if AVRI gold-signal hits ≥ 2 and composite ≥ 40, the action
is upgraded to `PRIORITIZE` regardless of band. Use this as a hard stop
against ever auto-closing a report with strong family-specific
evidence.

The `recommendation.action` field on `/api/reports/check` already
contains the right enum value — you do not need to re-implement the
matrix client-side.

## Step 1 — Set up the HackerOne webhook

In the HackerOne program admin UI:

1. Go to **Settings → Program → Webhooks → Add webhook**.
2. URL: your handler endpoint (e.g.
   `https://triage.acme.example/h1-hooks`).
3. Subscribed event: **report-created** (add **report-updated** later
   if you want to re-score on edits).
4. Secret: generate a long random string and store it as
   `H1_WEBHOOK_SECRET` on your handler box.

HackerOne signs webhook payloads with HMAC-SHA256 in the
`X-HackerOne-Signature` header. Verify it before doing any work:

```python
import hmac, hashlib, os

def verify_h1_signature(raw_body: bytes, header_value: str) -> bool:
    secret = os.environ["H1_WEBHOOK_SECRET"].encode()
    expected = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header_value or "")
```

If you cannot expose a public endpoint, skip the webhook and run the
poller from Step 4 on a 1-minute cron instead. The scoring/posting
logic is identical.

## Step 2 — Score the report

Pull the report body via the HackerOne API, then send it to
`/api/reports/check`. The `rawText` form field accepts the full
Markdown body unchanged.

```bash
#!/usr/bin/env bash
# fetch-and-score.sh <report-id>
set -euo pipefail

REPORT_ID="$1"
: "${H1_USER:?H1 API username required}"
: "${H1_TOKEN:?H1 API token required}"

# 1. Pull the report from HackerOne
REPORT_JSON=$(curl -fsS \
  -u "$H1_USER:$H1_TOKEN" \
  "https://api.hackerone.com/v1/reports/$REPORT_ID")

TITLE=$(echo "$REPORT_JSON" | jq -r '.data.attributes.title')
BODY=$(echo "$REPORT_JSON"  | jq -r '.data.attributes.vulnerability_information')

# 2. Score it through VulnRap (no storage)
SCORED=$(curl -fsS -X POST https://vulnrap.com/api/reports/check \
  -F "rawText=$(printf '%s\n\n%s' "$TITLE" "$BODY")")

COMPOSITE=$(echo "$SCORED" | jq -r '.vulnrap.compositeScore')
ACTION=$(echo "$SCORED"    | jq -r '.recommendation.action // "STANDARD_TRIAGE"')
LABEL=$(echo "$SCORED"     | jq -r '.vulnrap.compositeLabel // .slopTier')

echo "report=$REPORT_ID composite=$COMPOSITE action=$ACTION label=\"$LABEL\""
```

`POST /api/reports/check` returns the same shape as `POST /api/reports`
minus the persisted fields (`id`, `deleteToken`). The fields you'll
typically pluck out:

| Path                                | What it is                                |
| ----------------------------------- | ----------------------------------------- |
| `vulnrap.compositeScore`            | 0–100, higher = better quality            |
| `vulnrap.compositeLabel`            | Human label (e.g. "Likely Human")         |
| `vulnrap.engines[]`                 | Per-engine score + verdict + reasoning    |
| `recommendation.action`             | One of the five triage enum values        |
| `recommendation.reason`             | One-liner the matrix used                 |
| `recommendation.challengeQuestions` | Pre-generated challenge prompts           |
| `similarityMatches[]`               | Existing reports with overlapping content |
| `slopScore` / `slopTier`            | Legacy single-axis projection             |

## Step 3 — Post the score back as an internal comment

HackerOne's `activities` API takes an internal comment in one POST.
Internal comments are visible to your team only — never to the
reporter — so they're the right home for the triage telemetry.

```python
# post_score_comment.py
import os, json, requests

H1_USER  = os.environ["H1_USER"]
H1_TOKEN = os.environ["H1_TOKEN"]

def post_internal_comment(report_id: int, scored: dict) -> None:
    composite = scored["vulnrap"]["compositeScore"]
    label     = scored["vulnrap"].get("compositeLabel") or scored.get("slopTier", "?")
    action    = scored.get("recommendation", {}).get("action", "STANDARD_TRIAGE")
    reason    = scored.get("recommendation", {}).get("reason", "")
    dupes     = len(scored.get("similarityMatches") or [])
    engines   = scored.get("vulnrap", {}).get("engines", [])

    engine_lines = "\n".join(
        f"- **{e['engine']}**: {e['score']}/100 — {e.get('verdict', '?')}"
        for e in engines
    ) or "_no engine breakdown_"

    body = f"""**VulnRap analysis** — composite **{composite}/100** ({label})

Recommended triage action: `{action}`
{reason}

{engine_lines}

Similar prior reports: **{dupes}**
"""

    payload = {
        "data": {
            "type": "activity-comment",
            "attributes": {
                "message":  body,
                "internal": True,
            },
        }
    }

    r = requests.post(
        f"https://api.hackerone.com/v1/reports/{report_id}/activities",
        auth=(H1_USER, H1_TOKEN),
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload),
        timeout=15,
    )
    r.raise_for_status()
```

Tips:

- Leave `internal: True` on. The reporter must never see the raw
  composite — they see your triage decision, not the score behind it.
- Add a permalink to the diagnostics blob if you also called
  `POST /api/reports` (which persists). The blob lives at
  `https://vulnrap.com/api/reports/<id>/diagnostics` and powers the
  "Why this score?" panel — useful when a senior reviewer asks how
  the matrix landed where it did.

## Step 4 — Auto-close the AUTO_CLOSE tier

This is opt-in. The recommendation is conservative, but you should
still gate it behind:

- `recommendation.action == "AUTO_CLOSE"` (composite < 25), **and**
- No AVRI gold hits (the matrix already overrides upward, but belt &
  braces — check `vulnrap.engines` for the Technical Substance
  Analyzer entry and confirm `signalBreakdown.avri.goldHitCount`
  is 0), **and**
- `similarityMatches.length == 0` is **not** required — duplicates of
  known fabricated reports are exactly the case you want to close.

```python
# auto_close.py
import os, json, requests

H1_USER  = os.environ["H1_USER"]
H1_TOKEN = os.environ["H1_TOKEN"]

CLOSE_MESSAGE = (
    "Thanks for the submission. After automated review we were unable "
    "to identify original research or a reproducible impact in this "
    "report. We're closing as Not Applicable. If you believe this is "
    "incorrect, please reply with the specific request/response, "
    "stack trace, or commit hash that demonstrates the issue and we "
    "will reopen."
)

def should_auto_close(scored: dict) -> bool:
    if scored.get("recommendation", {}).get("action") != "AUTO_CLOSE":
        return False
    for e in scored.get("vulnrap", {}).get("engines", []):
        if e.get("engine") == "Technical Substance Analyzer":
            gold = (e.get("signalBreakdown", {})
                     .get("avri", {})
                     .get("goldHitCount", 0))
            if gold > 0:
                return False
    return True

def auto_close(report_id: int, scored: dict) -> bool:
    if not should_auto_close(scored):
        return False
    payload = {
        "data": {
            "type": "state-change",
            "attributes": {
                "state":   "not-applicable",
                "message": CLOSE_MESSAGE,
            },
        }
    }
    r = requests.post(
        f"https://api.hackerone.com/v1/reports/{report_id}/state_changes",
        auth=(H1_USER, H1_TOKEN),
        headers={"Content-Type": "application/json"},
        data=json.dumps(payload),
        timeout=15,
    )
    r.raise_for_status()
    return True
```

We strongly recommend running the close script in **dry-run mode for at
least a week** before flipping it on — log what you _would_ have closed
and have a senior triager spot-check the list. The composite is
calibrated against a public corpus, but every program's inbound mix is
different.

## Step 5 — Validate before flipping it on (recommended)

Rather than rolling your own logging/spot-check workflow, point the
batch endpoint `POST /api/reports/check/dry-run-batch` at the last week
of your inbox. It runs the same scoring/matrix as `POST /api/reports/check`
across up to 25 reports per call and returns the per-item triage action,
the composite score, the AVRI gold-signal hit count, and a single
`wouldAutoClose` boolean that already encodes the safety gates from
Step 4 (`action == AUTO_CLOSE` AND `goldHitCount == 0`).

Nothing about the call lands in the public feed or the database — there
is no DB write, no public listing, no diagnostics blob. The endpoint
also runs in **read-only mode** for the AVRI behavioral signals: the
submission-velocity and template-fingerprint counters are *peeked*
instead of incremented, so replaying a week of historical reports does
not pollute live state and items inside the same batch can't
self-contaminate via velocity or template penalties.

The endpoint shares the analysis rate-limit bucket (30 req / 15 min /
IP) with `POST /api/reports/check`, so a one-week backlog of ~600
reports comfortably fits in a single 25-batch loop run from one egress
IP.

```bash
#!/usr/bin/env bash
# dry-run-week.sh — preview what auto-close would have closed
# across the last week of an H1 program inbox.
set -euo pipefail

: "${H1_USER:?H1 API username required}"
: "${H1_TOKEN:?H1 API token required}"
PROGRAM="${1:?program handle required, e.g. acme-inc}"

SINCE=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%S.000Z)

# 1. Pull every page of submissions in the last week. HackerOne returns a
#    JSON-API `links.next` URL on each page until the cursor exhausts, so
#    we loop until that link disappears.
NEXT="https://api.hackerone.com/v1/reports?filter%5Bprogram%5D%5B%5D=$PROGRAM&filter%5Bcreated_at__gt%5D=$SINCE&page%5Bsize%5D=100"
ALL_DATA="[]"
while [ -n "$NEXT" ] && [ "$NEXT" != "null" ]; do
  PAGE=$(curl -fsS -u "$H1_USER:$H1_TOKEN" "$NEXT")
  ALL_DATA=$(jq -s '.[0] + .[1].data' <(echo "$ALL_DATA") <(echo "$PAGE"))
  NEXT=$(echo "$PAGE" | jq -r '.links.next // ""')
done

# 2. Build the dry-run batch body (id + rawText per item).
BATCH=$(echo "$ALL_DATA" | jq '{
  reports: [
    .[] | {
      id:      (.id | tostring),
      rawText: (.attributes.title + "\n\n" + .attributes.vulnerability_information)
    }
  ]
}')

# 3. POST in chunks of 25 and concat the per-item results.
echo "id,composite,action,goldHits,wouldAutoClose,reason"
echo "$BATCH" | jq -c '.reports | _nwise(25) | {reports: .}' \
  | while IFS= read -r CHUNK; do
      curl -fsS -X POST https://vulnrap.com/api/reports/check/dry-run-batch \
        -H "Content-Type: application/json" \
        -d "$CHUNK" \
      | jq -r '.items[] | [
          .id, .compositeScore, .action, .goldHitCount,
          .wouldAutoClose, (.reason | gsub(",";";"))
        ] | @csv'
    done
```

Pipe the output into your spreadsheet of choice and have a senior
triager spot-check every row where `wouldAutoClose=true`. When the
`wouldAutoClose=true` set looks right for a full week, you have evidence
to flip the script in Step 4 from "log only" to "close for real".

Notes:

- Capture the CSV yourself — the endpoint does **not** keep a server-side
  history of dry-run runs. Re-running tomorrow re-scores against any
  pipeline updates that shipped in the meantime, which is usually what
  you want, but it does mean you can't go back and ask "what did the
  v3.6.1 run say last Tuesday?" without your own log.
- The same endpoint is the validation tool referenced from every
  platform-specific recipe (Bugcrowd, Intigriti, GitHub Security
  Advisories). The body shape and gates are identical — only the
  ingestion side (how you pull the report bodies) differs per platform.

## Putting it together

Minimal end-to-end handler. Drop it in any WSGI/ASGI/Lambda runner —
the only HTTP surface is `POST /h1-hooks`.

```python
# h1_hooks.py
from flask import Flask, request, abort
import os, requests

from post_score_comment import post_internal_comment
from auto_close          import auto_close

app = Flask(__name__)

H1_USER  = os.environ["H1_USER"]
H1_TOKEN = os.environ["H1_TOKEN"]

@app.post("/h1-hooks")
def h1_hooks():
    raw = request.get_data()
    if not verify_h1_signature(raw, request.headers.get("X-HackerOne-Signature", "")):
        abort(401)

    payload = request.get_json(silent=True) or {}
    if payload.get("type") != "report-created":
        return ("", 204)

    report_id = payload["report"]["id"]

    # 1. Pull the report
    r = requests.get(
        f"https://api.hackerone.com/v1/reports/{report_id}",
        auth=(H1_USER, H1_TOKEN), timeout=15,
    )
    r.raise_for_status()
    attrs = r.json()["data"]["attributes"]
    text  = f"{attrs['title']}\n\n{attrs['vulnerability_information']}"

    # 2. Score
    scored = requests.post(
        "https://vulnrap.com/api/reports/check",
        data={"rawText": text}, timeout=30,
    ).json()

    # 3. Comment
    post_internal_comment(report_id, scored)

    # 4. Optional auto-close
    auto_close(report_id, scored)

    return ("", 204)
```

## Go: end-to-end with the official SDK

If your triage tooling lives in Go, the [official SDK](https://github.com/vulnrap/vulnrap/blob/main/sdks/go/vulnrap/README.md)
(`github.com/vulnrap/vulnrap/sdks/go/vulnrap`) collapses Steps 2 and 3 into
a couple of typed calls — no hand-rolled `net/http` POST against
`/api/reports/check`, no manual JSON shape tracking. The snippet below is
a drop-in handler for the same `report-created` webhook covered in Steps
1–3: it verifies the H1 signature, pulls the report body, runs the
read-only pipeline via `Client.TestYourself`, and posts the composite
score back as an internal H1 comment.

```bash
go get github.com/vulnrap/vulnrap/sdks/go/vulnrap
```

```go
// h1_hooks.go — minimal end-to-end H1 → VulnRap → internal comment handler.
package main

import (
        "bytes"
        "context"
        "crypto/hmac"
        "crypto/sha256"
        "encoding/hex"
        "encoding/json"
        "fmt"
        "io"
        "log"
        "net/http"
        "os"
        "strconv"
        "time"

        "github.com/vulnrap/vulnrap/sdks/go/vulnrap"
)

var (
        h1User    = os.Getenv("H1_USER")
        h1Token   = os.Getenv("H1_TOKEN")
        h1Secret  = []byte(os.Getenv("H1_WEBHOOK_SECRET"))
        vulnrapCl = vulnrap.NewClient(
                vulnrap.WithUserAgent("acme-h1-triage/1.0"),
                vulnrap.WithHTTPClient(&http.Client{Timeout: 30 * time.Second}),
        )
)

// H1's report-created webhook payload (only the fields we need).
type h1Webhook struct {
        Type   string `json:"type"`
        Report struct {
                ID json.Number `json:"id"`
        } `json:"report"`
}

func verifyH1Signature(body []byte, header string) bool {
        mac := hmac.New(sha256.New, h1Secret)
        mac.Write(body)
        expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
        return hmac.Equal([]byte(expected), []byte(header))
}

func fetchReportText(ctx context.Context, reportID string) (string, error) {
        url := "https://api.hackerone.com/v1/reports/" + reportID
        req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
        req.SetBasicAuth(h1User, h1Token)
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return "", err
        }
        defer resp.Body.Close()
        if resp.StatusCode/100 != 2 {
                return "", fmt.Errorf("h1 report fetch: HTTP %d", resp.StatusCode)
        }
        var payload struct {
                Data struct {
                        Attributes struct {
                                Title                    string `json:"title"`
                                VulnerabilityInformation string `json:"vulnerability_information"`
                        } `json:"attributes"`
                } `json:"data"`
        }
        if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
                return "", err
        }
        a := payload.Data.Attributes
        return a.Title + "\n\n" + a.VulnerabilityInformation, nil
}

func postInternalComment(ctx context.Context, reportID string, res *vulnrap.CheckResult) error {
        composite, label := 0, res.SlopTier
        action, reason := "STANDARD_TRIAGE", ""

        if res.Vulnrap != nil {
                composite = res.Vulnrap.CompositeScore
                if res.Vulnrap.Label != "" {
                        label = res.Vulnrap.Label
                }
        }
        if res.Recommendation != nil {
                if res.Recommendation.Action != "" {
                        action = res.Recommendation.Action
                }
                reason = res.Recommendation.Reason
        }

        var lines bytes.Buffer
        if res.Vulnrap != nil {
                for _, e := range res.Vulnrap.Engines {
                        fmt.Fprintf(&lines, "- **%s**: %d/100 — %s\n", e.Engine, e.Score, e.Verdict)
                }
        }
        body := fmt.Sprintf(
                "**VulnRap analysis** — composite **%d/100** (%s)\n\n"+
                        "Recommended triage action: `%s`\n%s\n\n%s\n"+
                        "Similar prior reports: **%d**\n",
                composite, label, action, reason, lines.String(), len(res.SimilarityMatches),
        )

        payload := map[string]any{
                "data": map[string]any{
                        "type": "activity-comment",
                        "attributes": map[string]any{
                                "message":  body,
                                "internal": true,
                        },
                },
        }
        buf, _ := json.Marshal(payload)

        url := "https://api.hackerone.com/v1/reports/" + reportID + "/activities"
        req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(buf))
        req.SetBasicAuth(h1User, h1Token)
        req.Header.Set("Content-Type", "application/json")
        resp, err := http.DefaultClient.Do(req)
        if err != nil {
                return err
        }
        defer resp.Body.Close()
        if resp.StatusCode/100 != 2 {
                b, _ := io.ReadAll(resp.Body)
                return fmt.Errorf("h1 internal comment: HTTP %d: %s", resp.StatusCode, b)
        }
        return nil
}

func h1Hooks(w http.ResponseWriter, r *http.Request) {
        raw, err := io.ReadAll(r.Body)
        if err != nil {
                http.Error(w, "read body", http.StatusBadRequest)
                return
        }
        if !verifyH1Signature(raw, r.Header.Get("X-HackerOne-Signature")) {
                http.Error(w, "bad signature", http.StatusUnauthorized)
                return
        }

        var hook h1Webhook
        if err := json.Unmarshal(raw, &hook); err != nil || hook.Type != "report-created" {
                w.WriteHeader(http.StatusNoContent)
                return
        }
        reportID := hook.Report.ID.String()
        if _, err := strconv.Atoi(reportID); err != nil {
                http.Error(w, "bad report id", http.StatusBadRequest)
                return
        }

        ctx := r.Context()

        text, err := fetchReportText(ctx, reportID)
        if err != nil {
                log.Printf("h1 fetch %s: %v", reportID, err)
                w.WriteHeader(http.StatusNoContent) // never block triage on us
                return
        }

        // Read-only scoring — nothing lands on the public VulnRap feed.
        res, err := vulnrapCl.TestYourself(ctx, &vulnrap.TestYourselfInput{RawText: text})
        if err != nil {
                log.Printf("vulnrap test_yourself %s: %v", reportID, err)
                w.WriteHeader(http.StatusNoContent)
                return
        }

        if err := postInternalComment(ctx, reportID, res); err != nil {
                log.Printf("h1 comment %s: %v", reportID, err)
        }
        w.WriteHeader(http.StatusNoContent)
}

func main() {
        http.HandleFunc("/h1-hooks", h1Hooks)
        log.Fatal(http.ListenAndServe(":8080", nil))
}
```

A few notes specific to the Go path:

- **`TestYourself` is the SDK twin of `POST /api/reports/check`** —
  same pipeline, no DB write, no public feed entry, no `id` /
  `deleteToken` returned. `Client.ScoreReport` is the persisting
  variant if you also want a diagnostics blob to link from the
  internal comment.
- **`CheckResult.Vulnrap`** carries the typed composite (score, label,
  per-engine breakdown). **`CheckResult.Recommendation`** is the typed
  triage recommendation (`Action`, `Reason`, `ChallengeQuestions`) —
  read it directly off the struct instead of reaching into `Raw`. It is
  `nil` when the server omits the field (treat that as `STANDARD_TRIAGE`).
- **Errors are typed.** Wrap `vulnrapCl.TestYourself` returns with
  `errors.As(err, &apiErr)` (where `apiErr` is `*vulnrap.APIError`) if
  you want to branch on `apiErr.StatusCode` — for example, treat 429
  as "back off and let a human triage" rather than "post nothing".
- **The auto-close logic from Step 4 maps 1:1.** Check
  `res.Recommendation.Action == "AUTO_CLOSE"` and the AVRI gold-hit
  count off the Technical Substance Analyzer entry of
  `res.Vulnrap.Engines` to gate a `POST /v1/reports/{id}/state_changes`
  call with `state: "not-applicable"`.

## Operational notes

- **Rate limits.** VulnRap caps at 30 analyses / 15 min / IP. If your
  inbox is hotter than that, batch through a small worker pool with
  exponential backoff on 429 — don't retry-storm.
- **Privacy.** Report text is auto-redacted server-side before any
  storage path. `/api/reports/check` doesn't store at all, so the
  reporter's PII never leaves your handler in a persisted form.
- **Idempotency.** `report-created` can fire more than once. Key your
  internal comment by report id + a tag in the body (e.g. a leading
  `[vulnrap-auto]`) so you can short-circuit duplicates.
- **Failure mode.** If the score call fails, **post nothing and let
  the human triage normally.** Never block a report on this pipeline.

## See also

- [`/developers`](https://vulnrap.com/developers) — full API reference,
  Swagger UI, more sample scripts.
- [`/api/reports/:id/diagnostics`](https://vulnrap.com/developers#diagnostics)
  — the per-engine pipeline trace that powers the "Why this score?"
  panel. Drop the URL into your internal comment so reviewers can dig
  in without leaving HackerOne.
