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
