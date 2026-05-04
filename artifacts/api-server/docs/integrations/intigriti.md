# Intigriti integration recipe

> Wire VulnRap into your Intigriti triage queue: score every incoming
> submission, post the result back as an internal message, and (optionally)
> auto-close the ones the matrix puts in the AUTO_CLOSE band.
>
> No code is shipped to Intigriti. This is a recipe — copy the scripts,
> point them at your program, and adapt to taste.

## Audience

Triagers and PSIRT engineers who already use Intigriti's REST API and
just want a turnkey way to plug VulnRap into the queue. This doc
assumes you have:

- An Intigriti API client credential (Company Settings → API Clients →
  New Client) with the **company** scope. The OAuth2 client-credentials
  flow returns a short-lived bearer token; cache it for its expiry.
  Use a service account, not a personal token, so the audit trail
  makes sense.
- The program's `programId` (UUID, visible in the program URL).
- A box that can receive Intigriti outbound webhooks (or run a poller)
  and reach `https://vulnrap.com/api/...`.

VulnRap itself needs no API key — every endpoint used below is open and
anonymous (rate-limited at 30 analyses / 15 min / IP). If you triage at
volume, run the integration from a small fleet so you do not share an
egress IP with the rest of your team.

## What this recipe wires up

1. **Intigriti outbound webhook → your handler** for the
   `submission.created` event.
2. **Your handler → `POST /api/reports/check`** to score the submission
   without storing anything on the public VulnRap feed.
3. **Your handler → Intigriti `messages`** (with `isInternal=true`) to
   post the composite score, the recommended triage action, and a link
   to the pipeline-diagnostics blob.
4. **(Optional) Auto-close on the AUTO_CLOSE tier** by transitioning
   the submission to `Closed` with `closeReason=NotApplicable` plus a
   templated message asking for original research.

The `/api/reports/check` endpoint runs the full pipeline (multi-engine
consensus, similarity matching, redaction, AVRI gold signals) but does
**not** persist the report. Use `POST /api/reports` instead if you want
the analysis to land on the public feed and contribute to platform
calibration.

## The triage matrix at a glance

The composite score returned by VulnRap maps to one of five triage
actions. The mapping is the same one used by the public report view:

| Composite | Recommended action   | Suggested Intigriti move           |
| --------: | -------------------- | ---------------------------------- |
|      ≥ 65 | `PRIORITIZE`         | Assign to senior triager + tag     |
|      ≥ 55 | `MANUAL_REVIEW`      | Standard human review              |
|      ≥ 40 | `STANDARD_TRIAGE`    | Normal queue                       |
|      ≥ 25 | `CHALLENGE_REPORTER` | Post the generated questions       |
|      < 25 | `AUTO_CLOSE`         | Close with `NotApplicable` reason  |

Override: if AVRI gold-signal hits ≥ 2 and composite ≥ 40, the action
is upgraded to `PRIORITIZE` regardless of band. Use this as a hard stop
against ever auto-closing a submission with strong family-specific
evidence.

The `recommendation.action` field on `/api/reports/check` already
contains the right enum value — you do not need to re-implement the
matrix client-side.

## Step 1 — Set up the Intigriti webhook

In the Intigriti program admin UI:

1. Go to **Program → Settings → Webhooks → Add webhook**.
2. URL: your handler endpoint (e.g.
   `https://triage.acme.example/intigriti-hooks`).
3. Subscribed event: **Submission Created** (add **Submission Updated**
   later if you want to re-score on edits).
4. Secret: generate a long random string and store it as
   `INTIGRITI_WEBHOOK_SECRET` on your handler box.

Intigriti signs webhook payloads with HMAC-SHA1 in the
`X-Intigriti-Signature` header (`sha1=<hex>` form — note the SHA-1, not
SHA-256 like H1/Bugcrowd). Verify it before doing any work:

```python
import hmac, hashlib, os

def verify_intigriti_signature(raw_body: bytes, header_value: str) -> bool:
    secret = os.environ["INTIGRITI_WEBHOOK_SECRET"].encode()
    expected = "sha1=" + hmac.new(secret, raw_body, hashlib.sha1).hexdigest()
    return hmac.compare_digest(expected, header_value or "")
```

If you cannot expose a public endpoint, skip the webhook and run a
poller on a 1-minute cron against
`GET /external/company/v1/programs/{programId}/submissions?statusId=1`
(status `1` is "New") instead. The scoring/posting logic is identical.

## Step 2 — Score the submission

You'll need a fresh bearer token before any API call. Cache it for the
returned `expires_in` minus a safety margin.

```bash
#!/usr/bin/env bash
# get-token.sh — exchange client-credentials for a bearer token.
set -euo pipefail
: "${INTIGRITI_CLIENT_ID:?required}"
: "${INTIGRITI_CLIENT_SECRET:?required}"

curl -fsS -X POST https://login.intigriti.com/connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=$INTIGRITI_CLIENT_ID" \
  -d "client_secret=$INTIGRITI_CLIENT_SECRET" \
  -d "scope=company_api" \
| jq -r .access_token
```

Pull the submission body via the Intigriti API, then send it to
`/api/reports/check`. The `rawText` form field accepts the full
Markdown body unchanged.

```bash
#!/usr/bin/env bash
# fetch-and-score.sh <program-id> <submission-code>
set -euo pipefail

PROGRAM_ID="$1"
SUBMISSION_CODE="$2"
TOKEN="$(./get-token.sh)"

# 1. Pull the submission from Intigriti
SUB_JSON=$(curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" \
  "https://api.intigriti.com/external/company/v1/programs/$PROGRAM_ID/submissions/$SUBMISSION_CODE")

TITLE=$(echo "$SUB_JSON" | jq -r '.title')
BODY=$(echo "$SUB_JSON"  | jq -r '.description')

# 2. Score it through VulnRap (no storage)
SCORED=$(curl -fsS -X POST https://vulnrap.com/api/reports/check \
  -F "rawText=$(printf '%s\n\n%s' "$TITLE" "$BODY")")

COMPOSITE=$(echo "$SCORED" | jq -r '.vulnrap.compositeScore')
ACTION=$(echo "$SCORED"    | jq -r '.recommendation.action // "STANDARD_TRIAGE"')
LABEL=$(echo "$SCORED"     | jq -r '.vulnrap.compositeLabel // .slopTier')

echo "submission=$SUBMISSION_CODE composite=$COMPOSITE action=$ACTION label=\"$LABEL\""
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

## Step 3 — Post the score back as an internal message

Intigriti's `messages` endpoint takes a single POST. Set
`isInternal: true` so the message is visible to your triagers only —
never to the researcher — which is the right home for the triage
telemetry.

```python
# post_score_message.py
import os, json, requests

from get_token import get_bearer_token  # your token-cache helper

def post_internal_message(program_id: str, submission_code: str, scored: dict) -> None:
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
        "content":    body,
        "isInternal": True,
    }

    r = requests.post(
        f"https://api.intigriti.com/external/company/v1/programs/{program_id}"
        f"/submissions/{submission_code}/messages",
        headers={
            "Authorization": f"Bearer {get_bearer_token()}",
            "Accept":        "application/json",
            "Content-Type":  "application/json",
        },
        data=json.dumps(payload),
        timeout=15,
    )
    r.raise_for_status()
```

Tips:

- Leave `isInternal: true` on. The researcher must never see the raw
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

Intigriti state transitions go through
`PUT /external/company/v1/programs/{programId}/submissions/{submissionCode}/status`
with the new status (`Closed`) and a `closeReason`. Pair the
transition with a researcher-visible message (the close note) in a
separate `messages` POST so the message lands in the timeline.

```python
# auto_close.py
import os, json, requests

from get_token             import get_bearer_token
from post_score_message    import post_internal_message  # not used, but pattern reference

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

def auto_close(program_id: str, submission_code: str, scored: dict) -> bool:
    if not should_auto_close(scored):
        return False

    headers = {
        "Authorization": f"Bearer {get_bearer_token()}",
        "Accept":        "application/json",
        "Content-Type":  "application/json",
    }

    # 1. Drop a researcher-visible close note
    note_url = (
        f"https://api.intigriti.com/external/company/v1/programs/{program_id}"
        f"/submissions/{submission_code}/messages"
    )
    requests.post(
        note_url,
        headers=headers,
        data=json.dumps({"content": CLOSE_MESSAGE, "isInternal": False}),
        timeout=15,
    ).raise_for_status()

    # 2. Transition the submission
    status_url = (
        f"https://api.intigriti.com/external/company/v1/programs/{program_id}"
        f"/submissions/{submission_code}/status"
    )
    r = requests.put(
        status_url,
        headers=headers,
        data=json.dumps({"status": "Closed", "closeReason": "NotApplicable"}),
        timeout=15,
    )
    r.raise_for_status()
    return True
```

We strongly recommend running the close script in **dry-run mode for at
least a week** before flipping it on — log what you _would_ have closed
and have a senior triager spot-check the list. The composite is
calibrated against a public corpus, but every program's inbound mix is
different. The shared dry-run batch endpoint
`POST /api/reports/check/dry-run-batch` (covered in detail in the
HackerOne recipe, Step 5) accepts the same body shape regardless of
source platform — pull a week of Intigriti submissions, project each
into `{ id, rawText }`, POST in chunks of 25, and spot-check the rows
where `wouldAutoClose=true`.

## Putting it together

Minimal end-to-end handler. Drop it in any WSGI/ASGI/Lambda runner —
the only HTTP surface is `POST /intigriti-hooks`.

```python
# intigriti_hooks.py
from flask import Flask, request, abort
import os, requests

from get_token             import get_bearer_token
from post_score_message    import post_internal_message
from auto_close            import auto_close, verify_intigriti_signature

app = Flask(__name__)

@app.post("/intigriti-hooks")
def intigriti_hooks():
    raw = request.get_data()
    if not verify_intigriti_signature(
        raw, request.headers.get("X-Intigriti-Signature", "")
    ):
        abort(401)

    payload = request.get_json(silent=True) or {}
    if payload.get("eventType") != "submission.created":
        return ("", 204)

    program_id      = payload["data"]["programId"]
    submission_code = payload["data"]["submissionCode"]

    headers = {
        "Authorization": f"Bearer {get_bearer_token()}",
        "Accept":        "application/json",
    }

    # 1. Pull the submission
    r = requests.get(
        f"https://api.intigriti.com/external/company/v1/programs/{program_id}"
        f"/submissions/{submission_code}",
        headers=headers, timeout=15,
    )
    r.raise_for_status()
    sub  = r.json()
    text = f"{sub.get('title','')}\n\n{sub.get('description','')}"

    # 2. Score
    scored = requests.post(
        "https://vulnrap.com/api/reports/check",
        data={"rawText": text}, timeout=30,
    ).json()

    # 3. Comment
    post_internal_message(program_id, submission_code, scored)

    # 4. Optional auto-close
    auto_close(program_id, submission_code, scored)

    return ("", 204)
```

## Operational notes

- **Rate limits.** VulnRap caps at 30 analyses / 15 min / IP. Intigriti
  itself caps roughly per-token; respect `Retry-After` on 429s and
  back off exponentially. If your inbox is hotter than that, batch
  through a small worker pool — don't retry-storm.
- **Token expiry.** Bearer tokens are short-lived (typically ~1 hour).
  Cache the token + its expiry, and refresh on 401 with one retry —
  don't re-exchange credentials per request.
- **Privacy.** Report text is auto-redacted server-side before any
  storage path. `/api/reports/check` doesn't store at all, so the
  researcher's PII never leaves your handler in a persisted form.
- **Idempotency.** `submission.created` can fire more than once. Key
  your internal message by `submissionCode` + a tag in the body
  (e.g. a leading `[vulnrap-auto]`) so you can short-circuit
  duplicates.
- **Failure mode.** If the score call fails, **post nothing and let
  the human triage normally.** Never block a submission on this
  pipeline.

## See also

- [`/developers`](https://vulnrap.com/developers) — full API reference,
  Swagger UI, more sample scripts.
- [`/api/reports/:id/diagnostics`](https://vulnrap.com/developers#diagnostics)
  — the per-engine pipeline trace that powers the "Why this score?"
  panel. Drop the URL into your internal message so reviewers can dig
  in without leaving Intigriti.
- [HackerOne recipe](./hackerone.md) — same flow, H1 conventions,
  includes the shared dry-run batch validation walkthrough.
- [Bugcrowd recipe](./bugcrowd.md) — same flow, Bugcrowd conventions.
