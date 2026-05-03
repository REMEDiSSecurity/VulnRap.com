# Bugcrowd integration recipe

> Wire VulnRap into your Bugcrowd triage queue: score every incoming
> submission, post the result back as an internal note, and (optionally)
> auto-close the ones the matrix puts in the AUTO_CLOSE band.
>
> No code is shipped to Bugcrowd. This is a recipe — copy the scripts,
> point them at your program, and adapt to taste.

## Audience

Triagers and PSIRT engineers who already use the Bugcrowd REST API and
just want a turnkey way to plug VulnRap into the queue. This doc
assumes you have:

- A Bugcrowd API token with `read` + `write` scopes on your program
  (Organization Settings → API Credentials → New Token). Use a service
  account, not a personal token, so the audit trail makes sense.
- The program code (e.g. `acme-inc`) and, for webhooks, the program
  UUID.
- A box that can receive Bugcrowd outbound webhooks (or run a poller)
  and reach `https://vulnrap.com/api/...`.

VulnRap itself needs no API key — every endpoint used below is open and
anonymous (rate-limited at 30 analyses / 15 min / IP). If you triage at
volume, run the integration from a small fleet so you do not share an
egress IP with the rest of your team.

## What this recipe wires up

1. **Bugcrowd outbound webhook → your handler** for the
   `submission.created` event.
2. **Your handler → `POST /api/reports/check`** to score the submission
   without storing anything on the public VulnRap feed.
3. **Your handler → Bugcrowd `comments`** (with `visibility=internal`)
   to post the composite score, the recommended triage action, and a
   link to the pipeline-diagnostics blob.
4. **(Optional) Auto-close on the AUTO_CLOSE tier** by PATCHing the
   submission to `not_applicable` plus a templated message asking for
   original research.

The `/api/reports/check` endpoint runs the full pipeline (multi-engine
consensus, similarity matching, redaction, AVRI gold signals) but does
**not** persist the report. Use `POST /api/reports` instead if you want
the analysis to land on the public feed and contribute to platform
calibration.

## The triage matrix at a glance

The composite score returned by VulnRap maps to one of five triage
actions. The mapping is the same one used by the public report view:

| Composite | Recommended action   | Suggested Bugcrowd move        |
| --------: | -------------------- | ------------------------------ |
|      ≥ 65 | `PRIORITIZE`         | Assign to senior triager + tag |
|      ≥ 55 | `MANUAL_REVIEW`      | Standard human review          |
|      ≥ 40 | `STANDARD_TRIAGE`    | Normal queue                   |
|      ≥ 25 | `CHALLENGE_REPORTER` | Post the generated questions   |
|      < 25 | `AUTO_CLOSE`         | Transition to `not_applicable` |

Override: if AVRI gold-signal hits ≥ 2 and composite ≥ 40, the action
is upgraded to `PRIORITIZE` regardless of band. Use this as a hard stop
against ever auto-closing a submission with strong family-specific
evidence.

The `recommendation.action` field on `/api/reports/check` already
contains the right enum value — you do not need to re-implement the
matrix client-side.

## Step 1 — Set up the Bugcrowd webhook

In the Bugcrowd program admin UI:

1. Go to **Program → Settings → Outbound Webhooks → New webhook**.
2. URL: your handler endpoint (e.g.
   `https://triage.acme.example/bc-hooks`).
3. Subscribed event: **submission.created** (add **submission.updated**
   later if you want to re-score on edits).
4. Secret: generate a long random string and store it as
   `BC_WEBHOOK_SECRET` on your handler box.

Bugcrowd signs webhook payloads with HMAC-SHA256 in the
`X-Bugcrowd-Signature` header (`sha256=<hex>` form). Verify it before
doing any work:

```python
import hmac, hashlib, os

def verify_bc_signature(raw_body: bytes, header_value: str) -> bool:
    secret = os.environ["BC_WEBHOOK_SECRET"].encode()
    expected = "sha256=" + hmac.new(secret, raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header_value or "")
```

If you cannot expose a public endpoint, skip the webhook and run the
poller from Step 4 on a 1-minute cron against
`GET /submissions?filter[state]=new` instead. The scoring/posting
logic is identical.

## Step 2 — Score the submission

Pull the submission body via the Bugcrowd API, then send it to
`/api/reports/check`. The `rawText` form field accepts the full
Markdown body unchanged.

```bash
#!/usr/bin/env bash
# fetch-and-score.sh <submission-uuid>
set -euo pipefail

SUBMISSION_ID="$1"
: "${BC_TOKEN:?Bugcrowd API token required (format: email:token)}"

# 1. Pull the submission from Bugcrowd
SUB_JSON=$(curl -fsS \
  -H "Authorization: Token $BC_TOKEN" \
  -H "Accept: application/vnd.bugcrowd+json" \
  -H "Bugcrowd-Version: 2021-10-28" \
  "https://api.bugcrowd.com/submissions/$SUBMISSION_ID")

TITLE=$(echo "$SUB_JSON" | jq -r '.data.attributes.title')
BODY=$(echo "$SUB_JSON"  | jq -r '.data.attributes.description // .data.attributes.vulnerability_references')

# 2. Score it through VulnRap (no storage)
SCORED=$(curl -fsS -X POST https://vulnrap.com/api/reports/check \
  -F "rawText=$(printf '%s\n\n%s' "$TITLE" "$BODY")")

COMPOSITE=$(echo "$SCORED" | jq -r '.vulnrap.compositeScore')
ACTION=$(echo "$SCORED"    | jq -r '.recommendation.action // "STANDARD_TRIAGE"')
LABEL=$(echo "$SCORED"     | jq -r '.vulnrap.compositeLabel // .slopTier')

echo "submission=$SUBMISSION_ID composite=$COMPOSITE action=$ACTION label=\"$LABEL\""
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

## Step 3 — Post the score back as an internal note

Bugcrowd's `comments` endpoint takes a single POST. Set
`visibility_scope` to `team_only` so the note is visible to your
triagers only — never to the researcher — which is the right home for
the triage telemetry.

```python
# post_score_comment.py
import os, json, requests

BC_TOKEN = os.environ["BC_TOKEN"]  # format: email:api_token

API_HEADERS = {
    "Authorization":     f"Token {BC_TOKEN}",
    "Accept":            "application/vnd.bugcrowd+json",
    "Content-Type":      "application/vnd.api+json",
    "Bugcrowd-Version":  "2021-10-28",
}

def post_internal_note(submission_id: str, scored: dict) -> None:
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
            "type": "comment",
            "attributes": {
                "body":             body,
                "visibility_scope": "team_only",
            },
            "relationships": {
                "submission": {
                    "data": {"type": "submission", "id": submission_id},
                },
            },
        }
    }

    r = requests.post(
        "https://api.bugcrowd.com/comments",
        headers=API_HEADERS,
        data=json.dumps(payload),
        timeout=15,
    )
    r.raise_for_status()
```

Tips:

- Leave `visibility_scope: team_only` on. The researcher must never see
  the raw composite — they see your triage decision, not the score
  behind it.
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

Bugcrowd state transitions go through `PATCH /submissions/{uuid}` with
the new `state` in attributes. Pair the transition with a
researcher-visible comment (the close note) in a separate `comments`
POST so the message lands in the timeline.

```python
# auto_close.py
import os, json, requests

from post_score_comment import API_HEADERS  # reuse auth headers

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

def auto_close(submission_id: str, scored: dict) -> bool:
    if not should_auto_close(scored):
        return False

    # 1. Drop a public-visible close note
    note = {
        "data": {
            "type": "comment",
            "attributes": {
                "body":             CLOSE_MESSAGE,
                "visibility_scope": "public",
            },
            "relationships": {
                "submission": {
                    "data": {"type": "submission", "id": submission_id},
                },
            },
        }
    }
    requests.post(
        "https://api.bugcrowd.com/comments",
        headers=API_HEADERS,
        data=json.dumps(note),
        timeout=15,
    ).raise_for_status()

    # 2. Transition the submission
    patch = {
        "data": {
            "type": "submission",
            "attributes": {"state": "not_applicable"},
        }
    }
    r = requests.patch(
        f"https://api.bugcrowd.com/submissions/{submission_id}",
        headers=API_HEADERS,
        data=json.dumps(patch),
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

## Putting it together

Minimal end-to-end handler. Drop it in any WSGI/ASGI/Lambda runner —
the only HTTP surface is `POST /bc-hooks`.

```python
# bc_hooks.py
from flask import Flask, request, abort
import os, requests

from post_score_comment import post_internal_note, API_HEADERS
from auto_close          import auto_close

app = Flask(__name__)

@app.post("/bc-hooks")
def bc_hooks():
    raw = request.get_data()
    if not verify_bc_signature(raw, request.headers.get("X-Bugcrowd-Signature", "")):
        abort(401)

    payload = request.get_json(silent=True) or {}
    if payload.get("event") != "submission.created":
        return ("", 204)

    submission_id = payload["data"]["id"]

    # 1. Pull the submission
    r = requests.get(
        f"https://api.bugcrowd.com/submissions/{submission_id}",
        headers=API_HEADERS, timeout=15,
    )
    r.raise_for_status()
    attrs = r.json()["data"]["attributes"]
    text  = f"{attrs.get('title','')}\n\n{attrs.get('description','')}"

    # 2. Score
    scored = requests.post(
        "https://vulnrap.com/api/reports/check",
        data={"rawText": text}, timeout=30,
    ).json()

    # 3. Comment
    post_internal_note(submission_id, scored)

    # 4. Optional auto-close
    auto_close(submission_id, scored)

    return ("", 204)
```

## Operational notes

- **Rate limits.** VulnRap caps at 30 analyses / 15 min / IP. Bugcrowd
  itself caps at roughly 60 req / min / token. If your inbox is hotter
  than that, batch through a small worker pool with exponential
  backoff on 429 — don't retry-storm.
- **Privacy.** Report text is auto-redacted server-side before any
  storage path. `/api/reports/check` doesn't store at all, so the
  researcher's PII never leaves your handler in a persisted form.
- **Idempotency.** `submission.created` can fire more than once. Key
  your internal note by submission UUID + a tag in the body (e.g. a
  leading `[vulnrap-auto]`) so you can short-circuit duplicates.
- **Failure mode.** If the score call fails, **post nothing and let
  the human triage normally.** Never block a submission on this
  pipeline.

## See also

- [`/developers`](https://vulnrap.com/developers) — full API reference,
  Swagger UI, more sample scripts.
- [`/api/reports/:id/diagnostics`](https://vulnrap.com/developers#diagnostics)
  — the per-engine pipeline trace that powers the "Why this score?"
  panel. Drop the URL into your internal note so reviewers can dig
  in without leaving Bugcrowd.
