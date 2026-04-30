# Calibration reviewer token setup

The `/feedback/calibration/*` namespace lets a reviewer apply
calibration runs and edit the curated hand-wavy phrase list. Those
endpoints can mutate scoring behaviour for every report, so once the
API server is reachable from the public internet you must protect
them with a shared reviewer token.

This doc explains when the token is required, how to provision it on
both sides (API + vulnrap UI), how to verify the gate, and how to
recover from the common misconfigurations.

## When you need a token

| Deployment shape                              | Token required?                               |
| --------------------------------------------- | --------------------------------------------- |
| Local dev / single-reviewer laptop            | No — leave both env vars unset                |
| Internal staging behind VPN, single reviewer  | Optional, but recommended for parity with prod|
| Anything publicly reachable                   | **Yes — set on both API and vulnrap build**   |

The mutation gate (`requireCalibrationAuth`) is intentionally a no-op
when `CALIBRATION_TOKEN` is unset so existing single-reviewer flows
keep working. The reviewer-metadata read endpoints
(`requireCalibrationAuthStrict`, e.g. `GET /feedback/calibration/handwavy-phrases`)
fail closed regardless — if you do not configure a token you simply
will not see those panels in the UI.

## Generating a token

The token is an opaque shared secret; the server only does a constant-
time string comparison. Anything with ≥128 bits of entropy and no
shell-special characters is fine. Pick one:

```bash
# 32 random bytes, URL-safe base64 (recommended)
openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_'

# Or, if openssl isn't available
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Treat the value like an API key: store it in your secrets manager,
never commit it, and rotate it if it leaks (see "Rotation" below).

## Where to set it

There are two env vars and they must hold **exactly the same string**:

1. **API server** (`artifacts/api-server`): set `CALIBRATION_TOKEN`
   in the runtime environment. It is read at request time inside
   `artifacts/api-server/src/middlewares/require-calibration-auth.ts`,
   so a server restart is enough — no rebuild required.
2. **vulnrap web build** (`artifacts/vulnrap`): set
   `VITE_CALIBRATION_TOKEN` **at build time**. Vite inlines it into
   the bundle (`artifacts/vulnrap/src/main.tsx` calls
   `setCalibrationToken(import.meta.env.VITE_CALIBRATION_TOKEN)` once
   at startup), so changing it requires a fresh
   `pnpm --filter @workspace/vulnrap run build` and a redeploy of the
   static assets.

On Replit, set both via the Secrets pane on the corresponding
artifact and republish/restart it.

### Why two variables?

The API and the static frontend are deployed independently and the
frontend has no way to read a server-side env var at runtime. Keeping
them as separate-but-equal secrets is what lets the bundle ship with
the credential baked in.

> Anyone who can load the published vulnrap UI can read the token out
> of the JS bundle. That is acceptable here because the token only
> guards a reviewer surface that is otherwise unauthenticated, and
> because we expect the UI to only be served to the reviewer in the
> first place. If you ever expose the vulnrap UI to untrusted users,
> you must move calibration mutations behind a real auth provider
> instead of relying on this token.

## Verifying the gate

After deploying both sides, sanity-check from a shell that has the
token:

```bash
# 1) Without a token — should be 401 once CALIBRATION_TOKEN is set.
curl -i -X POST "$API_URL/api/feedback/calibration/apply" \
  -H 'content-type: application/json' -d '{}'

# 2) With the wrong token — should also be 401.
curl -i -X POST "$API_URL/api/feedback/calibration/apply" \
  -H 'content-type: application/json' \
  -H 'x-calibration-token: wrong' -d '{}'

# 3) With the right token — should reach the route (any non-401 status,
#    e.g. 200/400, means the gate let you through).
curl -i -X POST "$API_URL/api/feedback/calibration/apply" \
  -H 'content-type: application/json' \
  -H "x-calibration-token: $CALIBRATION_TOKEN" -d '{}'
```

`Authorization: Bearer <token>` works as an alternative to the
`X-Calibration-Token` header.

In the UI: open the curated hand-wavy phrase panel. If the token is
wired up correctly on both sides you can list phrases (this is the
strict-gated read) and add/remove/edit them without 401s in the
browser network tab.

## Failure modes

### Server token set, UI token unset (or stale)
Symptoms: every calibration mutation in the UI returns 401, and the
hand-wavy phrase list panel comes up empty / errored.
Fix: set `VITE_CALIBRATION_TOKEN` to the same value as
`CALIBRATION_TOKEN`, rebuild vulnrap, and redeploy the static assets.

### UI token set, server token unset
Symptoms: mutations succeed but reviewer-metadata reads still 401
because `requireCalibrationAuthStrict` fails closed when
`CALIBRATION_TOKEN` is not configured. The mutation gate is also
effectively off — anyone who can reach the API can write.
Fix: set `CALIBRATION_TOKEN` on the API server and restart it.

### Tokens differ between the two sides
Symptoms: identical to "server set, UI unset" — every gated request
returns 401.
Fix: re-copy the token into both env vars; do not edit it by hand in
two places.

### 401 with the right header
Check that nothing is stripping the `X-Calibration-Token` header in
front of the API (CDN, reverse proxy, WAF). The header name is
case-insensitive but must arrive intact at the Express app.

## Rotation

1. Generate a new token (see above).
2. Update `CALIBRATION_TOKEN` on the API server **and**
   `VITE_CALIBRATION_TOKEN` on the vulnrap build to the new value.
3. Rebuild and redeploy the vulnrap UI.
4. Restart the API server so it picks up the new env var.
5. Verify with the curl probe above; the old token must now return 401.

There is no overlap window — a request that arrives between step 4 and
the UI redeploy will be rejected. If that matters, sequence the rollout
as: deploy the new UI bundle (it now sends the new token, which the
server still rejects), then flip the API env var (both old and new UI
clients with the new token start succeeding immediately).

To turn protection **off** entirely (e.g. reverting to single-reviewer
local dev): unset `CALIBRATION_TOKEN` on the API and restart it. The
mutation gate becomes a no-op again; the strict read gate stays closed
until you set a token.

## Brute-force alerts (Task #284)

Task #213 added warn-level pino records for every wrong-token 401 and
every throttled 429. Task #284 turns those events into actionable
pages: each rejection is also fed into an in-process per-IP sliding-
window counter, and when an IP crosses a configured threshold a
webhook is dispatched naming the offending IP and linking back to the
[Rotation](#rotation) section above.

### Configuration

| Env var                                            | Default                                              | What it does                                                  |
| -------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| `CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL`         | *(unset — no webhook dispatched)*                    | Where to POST the alert payload (Slack/Discord/PagerDuty).    |
| `CALIBRATION_AUTH_BRUTE_FORCE_ALERT_WINDOW_MS`     | `CALIBRATION_AUTH_RATE_LIMIT_WINDOW_MS` (60 000 ms)  | Sliding window for counting wrong-token events per IP.        |
| `CALIBRATION_AUTH_BRUTE_FORCE_ALERT_THRESHOLD`     | `CALIBRATION_AUTH_RATE_LIMIT_MAX_FAILURES` (10)      | Wrong-token attempts per IP per window before an alert fires. |
| `CALIBRATION_AUTH_BRUTE_FORCE_RUNBOOK_URL`         | `${PUBLIC_URL}/docs/calibration-reviewer-token.md#rotation` | Link included in the dispatched payload.               |

The window/threshold defaults are *intentionally* the same env vars
the limiter already exposes — set `CALIBRATION_AUTH_RATE_LIMIT_*` once
and both the throttle and the alert move together. Override the
brute-force-specific vars when you want them to diverge (e.g. only
page on sustained probes that stay over the limiter for several
windows).

When `CALIBRATION_AUTH_BRUTE_FORCE_WEBHOOK_URL` is unset the alerter
still updates its in-memory counters and emits a structured warn-level
pino log for every alert decision, so a deployment that already does
log-based alerting via Datadog / Loki / Splunk can build a query off
the `calibration auth: brute-force probe threshold crossed` message
without setting the webhook at all.

> **Per-process limitation.** The in-process counter is computed
> *inside one api-server replica*. If you run more than one replica
> (rolling deploys, blue/green, autoscaling), a probe whose requests
> are spread across replicas by the load balancer can stay below the
> in-process threshold on each replica even though the cross-replica
> total has crossed it. **In any multi-replica deployment, treat the
> log-aggregator alert below as the source of truth and the in-process
> webhook as a fast secondary signal.** Restart the api-server
> processes after changing `CALIBRATION_AUTH_BRUTE_FORCE_*` env vars
> (other than the webhook URL, which is re-read on every alert
> decision) so the alerter is rebuilt with the new values.

### Production log-aggregator alert (multi-replica)

The two warn-level pino lines emitted by the gate are designed to be
grouped by `ip` in your log aggregator. The recommended alert is
**"calibration-auth wrong-token rejections from a single IP exceeded
`CALIBRATION_AUTH_BRUTE_FORCE_ALERT_THRESHOLD` over
`CALIBRATION_AUTH_BRUTE_FORCE_ALERT_WINDOW_MS`"** — group across
*all* api-server replicas and page the on-call with a link to the
[Rotation](#rotation) section.

The two messages to match are:

- `calibration auth: wrong-token attempt rejected (401)`
- `calibration auth: wrong-token throttle triggered (429)`

Drop-in queries (replace `{threshold}` and `{window}` with whatever
you've set in env — defaults are `10` and `1m`):

**Grafana Loki / LogQL** (alert rule):

```logql
sum by (ip) (
  count_over_time(
    {service="vulnrap-api-server"}
      |= "calibration auth: wrong-token"
      | json
      | __error__ = ""
      [1m]
  )
) > 10
```

**Datadog Logs** (monitor: log alert, group by `@ip`):

```
service:vulnrap-api-server
  ("calibration auth: wrong-token attempt rejected (401)"
   OR "calibration auth: wrong-token throttle triggered (429)")
```

Set the monitor to "Threshold above 10 per 1 minute, group by `@ip`".

**AWS CloudWatch Logs Insights** (scheduled query, every 1 min):

```
fields @timestamp, ip, msg
| filter msg like /calibration auth: wrong-token/
| stats count(*) as wrong_token_count by ip
| sort wrong_token_count desc
| filter wrong_token_count >= 10
```

**Splunk** (saved search → alert action):

```spl
index=vulnrap "calibration auth: wrong-token"
| stats count by ip
| where count >= 10
```

The alert payload / runbook link to include with the page:

> Calibration-auth brute-force probe from `{ip}`: {count} wrong-token
> rejections in the last {window}. Runbook:
> `docs/calibration-reviewer-token.md#rotation`. Block at the proxy
> and rotate `CALIBRATION_TOKEN`.

If you also want to alert on the in-process detector's own decisions
(e.g. as a fast first-line signal before the aggregator's batch query
fires), match this message instead — it's emitted with structured
fields `ip`, `threshold`, `windowMs`, `wrongTokenCount`,
`rejectionsByStatus`, and `runbookUrl`:

- `calibration auth: brute-force probe threshold crossed` (with
  `webhookConfigured: true|false` indicating whether a webhook was
  also POSTed)

### Payload shape

```json
{
  "event": "calibration_auth_brute_force",
  "detectedAt": "2026-04-30T03:00:12.345Z",
  "ip": "203.0.113.42",
  "windowMs": 60000,
  "threshold": 10,
  "wrongTokenCount": 11,
  "rejectionsByStatus": { "401": 9, "429": 2 },
  "rejectionsByGate": { "mutation": 11, "strict-read": 0 },
  "firstSeenAt": "2026-04-30T02:59:38.000Z",
  "lastSeenAt":  "2026-04-30T03:00:12.000Z",
  "lastRoute": "/api/feedback/calibration/handwavy-phrases",
  "lastMethod": "POST",
  "runbookUrl": "https://example.com/docs/calibration-reviewer-token.md#rotation",
  "recommendedActions": [
    "Confirm the source IP is not a legitimate reviewer (NAT / office Wi-Fi).",
    "Block the offending IP at the upstream proxy / WAF.",
    "Rotate CALIBRATION_TOKEN per docs/calibration-reviewer-token.md (Rotation)."
  ]
}
```

The presented (wrong) token value is **never** included in the payload
— same security guarantee as the underlying 401/429 logs.

### Dedup behaviour

Once an IP has triggered an alert, the alerter suppresses further
alerts for that IP for one full window. After the cooldown lapses the
IP can re-trigger another alert if a fresh batch of wrong-token
attempts crosses the threshold. This keeps a sustained attack from
re-paging the on-call on every request while still surfacing
genuinely-new attacker IPs.

### Acting on an alert

1. Confirm the source IP isn't a legitimate reviewer behind NAT
   (office Wi-Fi, VPN egress).
2. Block the IP at the upstream proxy / WAF.
3. Follow [Rotation](#rotation) to issue a new token and roll both
   sides — the old token is now considered burned.
4. If the alert is too noisy for legitimate fat-finger traffic, raise
   `CALIBRATION_AUTH_BRUTE_FORCE_ALERT_THRESHOLD` (alerting only)
   without weakening the limiter.

## Local dev default (Task #232)

The `dev` scripts in `artifacts/api-server/package.json` and
`artifacts/vulnrap/package.json` default both `CALIBRATION_TOKEN` (api
server, runtime) and `VITE_CALIBRATION_TOKEN` (vulnrap, baked by Vite
at dev time) to the literal string **`e2e-calibration-token`** — the
same value `artifacts/vulnrap/playwright.config.ts` already pins for
the e2e suite. This is what makes the FLAT hand-wavy phrase panel on
`/feedback-analytics` work out of the box on a fresh `pnpm dev`
without any manual env setup.

The defaults use the shell `${VAR:-default}` form, so any value you
export in your shell (or pass on the command line) takes precedence —
including the empty string if you want to exercise the
"unconfigured token" code path locally:

```bash
# Use a different token for local dev:
CALIBRATION_TOKEN=my-dev-token VITE_CALIBRATION_TOKEN=my-dev-token pnpm dev

# Force the strict read gate to fail closed for testing:
CALIBRATION_TOKEN= pnpm --filter @workspace/api-server run dev
```

Production / CI continue to receive their own value through the
deployment env (api server) and the production build env (vulnrap);
the dev-script default never reaches a deployed environment.
