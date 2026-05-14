# Slack integration recipe

> Wire VulnRap into Slack so triagers see incoming reports scored,
> ranked, and ready to action without leaving the channel.
>
> Three paths in this doc — pick the lightest one that covers your
> use case, skip the rest:
>
> - **Quick start A — Paste an app manifest** (~2 minutes, ~0 lines
>   of code, covers the outbound-card use case). The shortest path
>   from "I want triage cards in a channel" to a working webhook.
> - **Quick start B — Workflow Builder, no app at all** (no code,
>   no server, no scopes — for teams on the Slack Pro plan or above
>   that already use Workflow Builder).
> - **Engineering path — three full postures** (outbound webhook,
>   `/vulnrap` slash command, Events API thread replies). Pick this
>   when you outgrow the quick starts and want signature verification,
>   per-thread context, and a shared Block Kit renderer.

## Quick start A — Paste an app manifest

The fastest way to get a working **outbound webhook** without
clicking through five Slack config screens. Slack apps can be
created from a single manifest paste — scopes, command, events, and
incoming-webhook switch are all set up in one shot.

1. Open <https://api.slack.com/apps> → **Create New App** → **From
   an app manifest** → pick your workspace.
2. Paste the YAML below into the editor. Replace the two placeholder
   URLs (`request_url` lines) with whatever HTTPS endpoint your
   handler will listen on. If you only want the outbound webhook,
   delete the `slash_commands:` and `event_subscriptions:` sections
   before pasting — the manifest still works.
3. Click **Create**. Slack provisions the app with all scopes,
   commands, and event subscriptions in one go.
4. Click **Install to Workspace** → choose the channel you want
   triage cards posted into.
5. Copy the **Webhook URL** that appears under **Incoming Webhooks**.
   Set it as `SLACK_WEBHOOK_URL` on whatever box is going to call
   the recipe (your tracker handler, a cron, a Lambda — anywhere
   that runs `curl`).

```yaml
display_information:
  name: VulnRap Triage
  description: Score incoming vulnerability reports through VulnRap before triage.
  long_description: |
    Posts the VulnRap composite score, recommended triage action,
    per-engine breakdown, and similarity matches into a triage
    channel. Optional /vulnrap slash command lets triagers re-score
    a snippet on demand.
  background_color: "#0a0e1a"
features:
  bot_user:
    display_name: VulnRap
    always_online: true
  slash_commands:
    - command: /vulnrap
      url: https://triage.example.com/slack/commands
      description: Score a report through VulnRap
      usage_hint: "<paste report text>  |  <vulnrap report id>"
      should_escape: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - chat:write.public
      - commands
      - incoming-webhook
      - reactions:write
settings:
  event_subscriptions:
    request_url: https://triage.example.com/slack/events
    bot_events:
      - message.channels
      - message.groups
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

That's it for outbound. A one-liner now posts triage cards into the
channel:

```bash
curl -fsS -X POST "$SLACK_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -d "$(curl -fsS -X POST https://vulnrap.com/api/reports/check \
          -F "rawText=$(cat report.md)" \
        | jq -c '{
            text: ("VulnRap analysis — composite " + (.vulnrap.compositeScore|tostring) +
                   "/100, recommended " + .recommendation.action),
          }')"
```

For richer Block Kit cards, copy the `build_blocks()` renderer from
the **Engineering path** below and pipe its output into the same
webhook. Everything past this point is optional.

## Quick start B — Slack Workflow Builder (no code, no app)

If your workspace is on **Slack Pro** or higher and you don't want
to run any code at all, Workflow Builder can call the VulnRap API
natively and post the result with built-in steps. No bot, no
scopes, no token to rotate.

1. Slack desktop → **Tools → Workflow Builder → New Workflow**.
2. Pick a trigger:
   - **Webhook** trigger if you want your tracker to fire it
     (HackerOne / Bugcrowd / Jira can all POST to the URL Slack
     will give you).
   - **From a link in Slack** trigger if you want triagers to kick
     off a one-off scoring by posting a link into a channel.
3. Add step → **Send a web request** with these settings:
   - URL: `https://vulnrap.com/api/reports/check`
   - Method: `POST`
   - Body: form-encoded `rawText=` followed by the variable from
     your trigger (the report body).
   - Save the response — Workflow Builder lets you reference fields
     like `vulnrap.compositeScore` and `recommendation.action`
     directly in later steps.
4. Add step → **Send a message**, target the triage channel, paste
   a template like:

   ```
   :mag: *VulnRap analysis*
   Composite: {{Step 1 — vulnrap.compositeScore}}/100
   Recommended: `{{Step 1 — recommendation.action}}`
   Reason: {{Step 1 — recommendation.reason}}
   ```

5. **Publish**. The workflow now runs every time the trigger fires.

Tradeoffs vs. the manifest path: no signature verification (the
webhook URL is the secret — keep it private), no slash command, no
threaded replies. If your tracker can POST a report body to a URL
and you just want triage cards in a channel, this is the shortest
path on the planet. Move to the engineering path below when you
need the slash command or per-thread context.

## On the roadmap — one-click "Add to Slack" relay

The shortest possible install would be a single button on
vulnrap.com that handles Slack OAuth, stores a per-tenant bot
token, and gives you back a unique notify URL. We have a design
write-up but have **not** shipped it yet — the security and
operational tradeoffs (multi-tenant token storage, scope-creep
risk, token-leak blast radius) need to be settled first.

If that path matters to you, read
[`slack-hosted-relay-design.md`](./slack-hosted-relay-design.md)
in this directory and open an issue with your requirements — real
demand is what will pull it forward.

---

# Engineering path

The rest of this doc is the full three-posture recipe — pick this
when the quick starts are not enough.

## Audience

Anyone running a triage channel in Slack who wants the VulnRap
composite score, the recommended action, the per-engine breakdown,
and similarity matches surfaced where the team already lives. You
should be comfortable creating a Slack app and dropping ~150 lines
of Python (or Node) on a small handler box / Lambda / Cloud Run
service.

VulnRap itself needs no API key — every endpoint used below is open
and anonymous (rate-limited at 30 analyses / 15 min / IP). Run the
integration from a dedicated egress IP if your team triages at
volume so you do not share quota with humans hitting the site.

## Step 0 — Create the Slack app

Go to <https://api.slack.com/apps> → **Create New App** → **From
scratch**, name it `VulnRap Triage` (or whatever — only your
workspace sees it), pick the workspace.

You will collect three secrets from the app config screens. Store
them as environment variables on the box that runs the handler:

| Env var                  | Where it lives in the app config                                    | Why                                |
| ------------------------ | ------------------------------------------------------------------- | ---------------------------------- |
| `SLACK_BOT_TOKEN`        | OAuth & Permissions → Bot User OAuth Token (`xoxb-…`)               | Posts/threads/reactions            |
| `SLACK_SIGNING_SECRET`   | Basic Information → App Credentials → Signing Secret                | Verifies inbound requests          |
| `SLACK_WEBHOOK_URL`      | Incoming Webhooks → Add New Webhook to Workspace (per-channel URL)  | Posture 1 only — outbound posting  |

Bot scopes (OAuth & Permissions → Scopes → Bot Token Scopes) for the
combined recipe:

- `chat:write` — post messages and threaded replies
- `chat:write.public` — post into channels the bot has not been added to
- `commands` — receive slash command payloads
- `incoming-webhook` — hold the per-channel webhook URL (Posture 1)
- `reactions:write` — optional, for the green-check / warning emoji
  reaction we apply to source posts in Posture 3

Reinstall the app after editing scopes — Slack invalidates the bot
token whenever scopes change.

## Step 1 — The triage matrix at a glance

The composite score returned by VulnRap maps to one of five triage
actions. The mapping is the same one used by every platform recipe
and by the public report view:

| Composite | Recommended action   | Suggested Slack treatment                  |
| --------: | -------------------- | ------------------------------------------ |
|      ≥ 65 | `PRIORITIZE`         | `:rotating_light:` + ping `@triage-lead`   |
|      ≥ 55 | `MANUAL_REVIEW`      | `:eyes:` + post into `#triage-review`      |
|      ≥ 40 | `STANDARD_TRIAGE`    | `:inbox_tray:` + leave for normal queue    |
|      ≥ 25 | `CHALLENGE_REPORTER` | `:question:` + paste challenge questions   |
|      < 25 | `AUTO_CLOSE`         | `:wastebasket:` + drop into `#triage-junk` |

Override: if AVRI gold-signal hits ≥ 2 and composite ≥ 40, the
action is upgraded to `PRIORITIZE` regardless of band. The
`recommendation.action` field on `/api/reports/check` already
encodes that override — do not re-implement the matrix client-side.

## Posture 1 — Outbound webhook (simplest)

The fastest way to put VulnRap in front of triagers: every time a
report comes in (from your tracker, your inbox, your CI gate),
score it and POST a Block Kit card to a channel via Incoming
Webhook. No public endpoint, no signature verification needed.

```python
# slack_outbound.py — one-shot helper. Call from your tracker
#                      webhook handler, your inbox parser, or cron.
import os, json, requests

SLACK_WEBHOOK_URL = os.environ["SLACK_WEBHOOK_URL"]

ACTION_BADGE = {
    "PRIORITIZE":         (":rotating_light:", "#dc2626"),
    "MANUAL_REVIEW":      (":eyes:",           "#f59e0b"),
    "STANDARD_TRIAGE":    (":inbox_tray:",     "#3b82f6"),
    "CHALLENGE_REPORTER": (":question:",       "#a855f7"),
    "AUTO_CLOSE":         (":wastebasket:",    "#737373"),
}

def score(raw_text: str) -> dict:
    r = requests.post(
        "https://vulnrap.com/api/reports/check",
        data={"rawText": raw_text},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()

def build_blocks(scored: dict, source_url: str | None = None) -> list:
    composite = scored.get("vulnrap", {}).get("compositeScore", "?")
    label     = scored.get("vulnrap", {}).get("compositeLabel", scored.get("slopTier", "?"))
    rec       = scored.get("recommendation") or {}
    action    = rec.get("action", "STANDARD_TRIAGE")
    reason    = rec.get("reason", "")
    emoji, _  = ACTION_BADGE.get(action, (":mag:", "#737373"))

    engines = scored.get("vulnrap", {}).get("engines", []) or []
    engine_lines = "\n".join(
        f"• *{e['engine']}* — {e['score']}/100 ({e.get('verdict','?')})"
        for e in engines
    ) or "_no engine breakdown_"

    dupes = len(scored.get("similarityMatches") or [])
    fields = [
        {"type": "mrkdwn", "text": f"*Composite*\n{composite}/100 — {label}"},
        {"type": "mrkdwn", "text": f"*Recommended*\n`{action}`"},
        {"type": "mrkdwn", "text": f"*Similar reports*\n{dupes}"},
        {"type": "mrkdwn", "text": f"*Reason*\n{reason or '_n/a_'}"},
    ]

    blocks = [
        {"type": "header",
         "text": {"type": "plain_text", "text": f"{emoji}  VulnRap analysis"}},
        {"type": "section", "fields": fields},
        {"type": "section",
         "text": {"type": "mrkdwn", "text": engine_lines}},
    ]
    if source_url:
        blocks.append({
            "type": "actions",
            "elements": [{
                "type": "button",
                "text": {"type": "plain_text", "text": "Open report"},
                "url": source_url,
            }],
        })
    return blocks

def post(raw_text: str, source_url: str | None = None) -> None:
    scored = score(raw_text)
    body = {"blocks": build_blocks(scored, source_url)}
    r = requests.post(SLACK_WEBHOOK_URL, json=body, timeout=10)
    r.raise_for_status()

if __name__ == "__main__":
    import sys
    post(sys.stdin.read(), source_url=os.environ.get("SOURCE_URL"))
```

Drop-in usage from your H1/Bugcrowd/Intigriti webhook handler:

```python
from slack_outbound import post
post(report_body, source_url=f"https://hackerone.com/reports/{report_id}")
```

## Posture 2 — Slash command `/vulnrap`

Lets triagers re-score a report (or a snippet) on demand from any
channel. Useful when a teammate pastes something suspicious and
asks "is this real?".

In the Slack app config:

1. **Slash Commands → Create New Command**
   - Command: `/vulnrap`
   - Request URL: `https://triage.acme.example/slack/commands`
   - Short description: `Score a report through VulnRap`
   - Usage hint: `<paste report text> | <vulnrap report id>`

2. Reinstall the app so the command is registered.

The handler must respond inside 3 seconds (Slack hard timeout) and
verify every request signature. The pattern: ack immediately, then
do the slow work in a background task and patch the message via the
`response_url` Slack provides.

```python
# slack_handler.py
# Single-file handler that serves both the slash command (Posture 2)
# and the Events API endpoint (Posture 3 below).
import hashlib, hmac, json, os, threading, time
from flask import Flask, request, abort, jsonify
import requests

SLACK_SIGNING_SECRET = os.environ["SLACK_SIGNING_SECRET"].encode()
SLACK_BOT_TOKEN      = os.environ["SLACK_BOT_TOKEN"]
VULNRAP_BASE         = os.environ.get("VULNRAP_BASE", "https://vulnrap.com")

app = Flask(__name__)

# ------- Signature verification ---------------------------------------------
# https://api.slack.com/authentication/verifying-requests-from-slack
def verify_slack(req) -> bool:
    ts   = req.headers.get("X-Slack-Request-Timestamp", "")
    sig  = req.headers.get("X-Slack-Signature", "")
    if not ts or not sig:
        return False
    if abs(time.time() - int(ts)) > 60 * 5:   # replay window
        return False
    body = req.get_data(as_text=True)
    base = f"v0:{ts}:{body}".encode()
    expected = "v0=" + hmac.new(SLACK_SIGNING_SECRET, base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig)

# ------- Score helpers ------------------------------------------------------
def score_text(raw_text: str) -> dict:
    r = requests.post(
        f"{VULNRAP_BASE}/api/reports/check",
        data={"rawText": raw_text},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()

def fetch_report(report_id: str) -> str | None:
    """Pull an existing public VulnRap report by id (Posture 2 lookup)."""
    r = requests.get(f"{VULNRAP_BASE}/api/reports/{report_id}", timeout=15)
    if r.status_code != 200:
        return None
    j = r.json()
    return j.get("redactedText") or ""

# ------- Slash command ------------------------------------------------------
@app.post("/slack/commands")
def slack_command():
    if not verify_slack(request):
        abort(401)

    text = (request.form.get("text") or "").strip()
    response_url = request.form.get("response_url")

    # Acknowledge synchronously so Slack does not time us out.
    threading.Thread(
        target=_handle_slash_async,
        args=(text, response_url),
        daemon=True,
    ).start()

    return jsonify({
        "response_type": "ephemeral",
        "text": ":hourglass_flowing_sand: Scoring through VulnRap…",
    })

def _handle_slash_async(text: str, response_url: str) -> None:
    try:
        # If the argument is a bare integer or `vr-1234`, treat it as a
        # VulnRap report id and look it up; otherwise score the text inline.
        is_id = text.isdigit() or (text.startswith("vr-") and text[3:].isdigit())
        if is_id:
            rid = text.removeprefix("vr-")
            body = fetch_report(rid)
            if not body:
                requests.post(response_url, json={
                    "response_type": "ephemeral",
                    "text": f":x: VulnRap report `{rid}` not found or private.",
                })
                return
            scored = score_text(body)
            scored["__sourceUrl"] = f"{VULNRAP_BASE}/results/{rid}"
        else:
            if not text:
                requests.post(response_url, json={
                    "response_type": "ephemeral",
                    "text": "Usage: `/vulnrap <paste report text>` or `/vulnrap 1234`",
                })
                return
            scored = score_text(text)

        from slack_outbound import build_blocks   # share the renderer
        blocks = build_blocks(scored, scored.get("__sourceUrl"))
        requests.post(response_url, json={
            "response_type": "in_channel",
            "blocks": blocks,
        })
    except Exception as exc:
        requests.post(response_url, json={
            "response_type": "ephemeral",
            "text": f":warning: VulnRap scoring failed: `{exc}`",
        })
```

Sharing `build_blocks()` between Posture 1 and Posture 2 means the
card looks identical whether it was pushed automatically or pulled
on demand — same scaffolding for the triager to scan.

## Posture 3 — Events API: post into the matching thread

If your team already mirrors tracker activity into Slack (a "report
created" message in `#h1-feed` per submission, for example), you can
have the bot reply *in the thread* with the VulnRap analysis the
moment the source post lands.

In the Slack app config:

1. **Event Subscriptions → Enable Events**
2. Request URL: `https://triage.acme.example/slack/events`
   (Slack will hit this once with `type=url_verification` — handle it.)
3. Subscribe to `message.channels` (and/or `message.groups` for
   private channels). Limit the subscription to the feed channel(s)
   in the channel's app settings, otherwise the bot wakes up on every
   message in the workspace.

```python
# Append to slack_handler.py
import re

# Tune to your tracker's "report created" feed format. Examples:
#   "New report #4242 — SSRF in /api/files"
#   "[acme-h1] Report 4242 created: https://hackerone.com/reports/4242"
TRACKER_RE = re.compile(r"(?:report\s*#?(\d+)|reports/(\d+))", re.IGNORECASE)

@app.post("/slack/events")
def slack_events():
    if not verify_slack(request):
        abort(401)
    payload = request.get_json(force=True, silent=True) or {}

    # URL verification handshake (one-time, when you set the Events URL).
    if payload.get("type") == "url_verification":
        return jsonify({"challenge": payload.get("challenge")})

    if payload.get("type") != "event_callback":
        return ("", 204)

    event = payload.get("event") or {}
    if event.get("type") != "message" or event.get("subtype"):
        return ("", 204)
    # Skip our own messages and other bots.
    if event.get("bot_id") or event.get("user") is None:
        return ("", 204)

    text = event.get("text") or ""
    m = TRACKER_RE.search(text)
    if not m:
        return ("", 204)
    tracker_id = m.group(1) or m.group(2)

    threading.Thread(
        target=_thread_reply_async,
        args=(event["channel"], event["ts"], tracker_id, text),
        daemon=True,
    ).start()
    return ("", 204)

def _thread_reply_async(channel: str, parent_ts: str, tracker_id: str, fallback_text: str) -> None:
    # If you already have a way to fetch the report body from the tracker,
    # call it here. As a generic fallback we just score the message text
    # itself, which still surfaces obvious slop / template duplicates.
    body = fetch_tracker_body(tracker_id) or fallback_text
    scored = score_text(body)

    from slack_outbound import build_blocks
    blocks = build_blocks(scored)

    requests.post(
        "https://slack.com/api/chat.postMessage",
        headers={
            "Authorization": f"Bearer {SLACK_BOT_TOKEN}",
            "Content-Type":  "application/json; charset=utf-8",
        },
        json={
            "channel": channel,
            "thread_ts": parent_ts,
            "blocks": blocks,
        },
        timeout=10,
    )

def fetch_tracker_body(tracker_id: str) -> str | None:
    """Replace with a call to your H1 / Bugcrowd / Intigriti SDK.
    Returning None falls back to scoring the parent Slack message."""
    return None
```

The handler also rate-limits itself against Slack: never DM the
reporter, never edit the parent post, never react with emoji
unprompted — operate strictly inside the thread you were invited
into.

## Step 2 — Block Kit message reference

The renderer above produces a card that looks like this:

```
:rotating_light:  VulnRap analysis
─────────────────────────────────
Composite          Recommended
72/100 — Likely Human   `PRIORITIZE`
Similar reports    Reason
0                  AVRI gold ≥ 2 + composite ≥ 40

• AI Authorship — 18/100 (human)
• Technical Substance Analyzer — 78/100 (substantive)
• CWE Coherence — 81/100 (coherent)

[ Open report ]
```

Tweak the `ACTION_BADGE` table at the top of `slack_outbound.py` if
your team prefers different emoji or color stripes. The colour
field is reserved for the legacy `attachments` API — Block Kit
ignores it, but it stays handy if you want to fall back to
`attachments` for older Slack clients.

## Step 3 — Validate before flipping it on (recommended)

Same validation tool as every other platform recipe: replay your
last week of inbound traffic through `POST /api/reports/check/dry-run-batch`
and have a senior triager spot-check what the matrix would have
done before you turn auto-actions on (auto-close, auto-priority
ping, auto-`@channel`, etc.).

```bash
#!/usr/bin/env bash
# slack-dry-run.sh — preview what the bot would have posted across
# the last week of inbound reports. Pull `reports.json` however you
# normally pull it (tracker SDK, archive export, etc.).
set -euo pipefail

INPUT="${1:?path to reports.json — array of {id, rawText}}"

echo "id,composite,action,goldHits,wouldAutoClose"
jq -c '.[] | _nwise(25) | {reports: .}' "$INPUT" \
  | while IFS= read -r CHUNK; do
      curl -fsS -X POST https://vulnrap.com/api/reports/check/dry-run-batch \
        -H "Content-Type: application/json" \
        -d "$CHUNK" \
      | jq -r '.items[] | [.id, .compositeScore, .action, .goldHitCount, .wouldAutoClose] | @csv'
    done
```

Capture the CSV — the dry-run endpoint does not keep a server-side
history, so re-running tomorrow re-scores against any pipeline
updates that shipped overnight.

## Step 4 — Ship the handler

Any Python WSGI runner works. The smallest viable production setup:

```bash
pip install flask gunicorn requests
gunicorn -w 2 -b 0.0.0.0:8080 slack_handler:app
```

Put it behind your existing TLS edge (Caddy / Cloudflare Tunnel /
ngrok for dev). Slack requires HTTPS for every Request URL.

Health check: `curl -fsS https://triage.acme.example/healthz` —
add a trivial `@app.get("/healthz")` route returning `("ok", 200)`
so your edge can keep the container warm.

## Operational notes

- **Rate limits.** Both `/api/reports/check` and the dry-run batch
  endpoint share the 30 req / 15 min / IP bucket. A normal triage
  channel sees nowhere near that. If you also run the H1/Bugcrowd
  recipes from the same egress IP, budget accordingly.
- **Sensitive content.** Reports often contain credentials, PII, or
  unreleased CVE detail. The Slack channel is your trust boundary
  — pick a private channel and audit who is in it. The bot itself
  never logs the request body server-side, but Slack does keep
  message history forever by default.
- **Failure mode.** If VulnRap is down, the slash command returns
  an ephemeral `:warning:` to the invoking user and the outbound
  webhook silently drops (the Step 1 handler raises, your tracker
  retry loop covers it). The thread-reply Posture is
  fire-and-forget; we deliberately do not retry to avoid flooding
  threads on a partial outage.
- **Compose with the tracker recipes.** This file is the *Slack*
  side. The HackerOne / Bugcrowd / Intigriti recipes own the
  *tracker* side. Posture 1 here slots straight into the
  `/api/reports/check` step of any of them — pass the scored
  result both to your tracker comment poster and to the Slack
  webhook helper.

## Putting it together

If you want every posture wired up end-to-end:

1. Stand up `slack_handler.py` behind HTTPS.
2. Set the slash command Request URL to `…/slack/commands`.
3. Set the Events API Request URL to `…/slack/events` and subscribe
   to your tracker-feed channel.
4. From your tracker webhook (or the per-platform recipes in this
   directory), call `slack_outbound.post(report_body, source_url=…)`
   for Posture 1 push.

Three call sites, one shared renderer — no part of the recipe is
exclusive of the others.
