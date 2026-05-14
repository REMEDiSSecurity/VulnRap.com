# Hosted "Add to Slack" relay — security & ops design

> Forward-looking design note for the one-click Slack install path
> mentioned in `slack.md`. **Not shipped.** Captured here so that
> when demand pulls it forward, we don't re-derive the threat model
> from scratch and we don't ship a v1 that bakes in security debt.

## Goal

A single "Add to Slack" button on `vulnrap.com/integrations/slack`
that gives a user a working triage-card stream into a Slack channel
*without* them creating a Slack app, copying scopes, hosting a
handler, or storing a webhook URL on their side.

End state from the user's perspective:

1. Click "Add to Slack" → Slack OAuth consent screen → pick channel.
2. Land back on `vulnrap.com/integrations/slack/installed` showing a
   per-tenant notify URL: `https://vulnrap.com/api/slack/notify/<tenant_token>`.
3. POST a report body to that URL. We score it, render a Block Kit
   card, post it to their channel.

That's it. They never touch the Slack app config UI, never see a
bot token, never run a server.

## Why this is risky

Holding bot tokens for every tenant turns VulnRap from a stateless
analysis API into a multi-tenant identity store. The blast radius
of a single mistake (DB exfiltration, code execution on the API
host, careless logging) is the ability to post-as-VulnRap in
*every* customer Slack workspace. That is a much higher-value
target than the public scoring API and changes the security
posture of the whole project.

A near-term implementation has to make that risk affordable.

## Threat model

| Threat                                       | Realistic likelihood | Impact                                            | Primary mitigation                                                              |
| -------------------------------------------- | -------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Bot-token DB exfiltration                    | Low–medium           | Post-as-VulnRap to every tenant channel; phishing | App-layer encryption (KMS-wrapped DEK), tokens never logged, blast-radius scope |
| Notify URL leak (logs, screenshots, GitHub)  | High                 | Spam tenant's channel                             | URLs are HMAC'd unguessable, tenant-revocable, rate-limited per token           |
| Slack app permissions creep                  | Low                  | Larger blast radius if compromised                | Lock scopes to `chat:write` only — no `users:read`, no `channels:history`       |
| Replay of legitimate notify POSTs            | Medium               | Channel spam, DoS                                 | Optional HMAC-signed body + nonce window per tenant                             |
| Compromise of the relay's egress IP          | Low                  | Slack-side rate-limiting / abuse signal           | Dedicated egress, per-tenant Slack rate-limit tracking                          |
| Tenant deletes channel; bot keeps trying     | High                 | Stale tokens, noisy errors                        | On Slack `channel_not_found` → auto-disable, email tenant                       |
| Slack revokes app at the directory level     | Low                  | Total outage of all tenants                       | App Directory review done up-front, conservative scope set                      |
| Disgruntled ex-employee with DB read         | Low–medium           | Same as exfil                                     | DEK in a separate trust boundary (KMS), audit log on every decrypt              |
| Tenant uses notify URL as a public webhook   | Medium               | Random crap posted to their own channel          | Their problem — not ours — but document it loudly                               |

The dominant risks are **token exfiltration** and **notify URL
leak**. Everything below is shaped around those two.

## Scope minimization

Ship v1 with **only `chat:write`** on the bot token. Drop:

- `chat:write.public` — force the user to invite the bot into the
  target channel during OAuth. One extra click, but every notify
  call is now scoped to a channel they explicitly chose.
- `commands`, `reactions:write`, `incoming-webhook` — none are
  needed for the relay's job. Slash command and thread replies
  stay in the engineering path, where the user runs the handler
  and holds the token themselves.
- All event subscriptions. The relay is outbound-only. No event
  endpoint = no signature verification surface, no event-replay
  abuse vector.

This single decision shrinks the relay's attack surface to "post a
single message into one specific channel." A leaked token can spam
that channel. It cannot read history, list users, install other
apps, or pivot.

## Token storage

Layered, not just "encrypted at rest":

1. **At the platform layer** — Postgres column-level encryption
   isn't enough on its own (DBA / `pg_dump` / replica access all
   bypass it). We rely on disk encryption only for defence in
   depth.
2. **At the application layer** — every bot token is encrypted with
   a per-tenant data encryption key (DEK). The DEK is wrapped by a
   KMS key (e.g. Cloudflare Workers Secret Bindings, AWS KMS,
   GCP KMS — whichever the deployment target uses). The wrapped DEK
   is what lives in the database. The unwrapping key never leaves
   KMS.
3. **At runtime** — tokens are decrypted lazily, used inside a
   single function scope, and zeroed before return. They never hit
   the global, never get serialized, never get logged. The audit
   logger has an explicit redactor for `xox[abopsr]-` prefixes
   (we already have one in `audit-log-middleware.ts`) — extend it
   to cover the encrypted-token column name as a backstop.
4. **Rotation** — Slack supports OAuth token rotation
   (`token_rotation_enabled: true`). Turn it on. Tokens auto-rotate
   every 12 hours; if a token leaks, the window of usability is
   bounded.

What we explicitly do *not* do:

- We do not store a refresh token without rotation enabled. If
  rotation is off, refresh tokens are forever-credentials and
  encrypting them buys you nothing against an exfil.
- We do not cache decrypted tokens in memory across requests. The
  re-decrypt cost (single KMS round-trip, ~5–20 ms) is the price
  of bounded blast radius.

## Notify URL design

The per-tenant URL needs to be:

- **Unguessable** — 32 bytes of CSPRNG, base64url-encoded → a
  ~43-char tail. Brute-forcing the space is infeasible at any
  reasonable rate.
- **Revocable** — the URL token maps to a row in the `slack_tenants`
  table; deleting/disabling the row instantly revokes the URL with
  no Slack-side action.
- **Rate-limited per token** — the same 30 req / 15 min bucket the
  scoring API uses, but keyed on `(tenant_token, source_ip)` so a
  leaked URL gets capped before it can be used to spam at scale.
- **HMAC-bound (optional)** — for tenants who care, accept
  `X-VulnRap-Sig` headers signed with a per-tenant shared secret
  (also surfaced on the install page). When present, we verify
  before forwarding to Slack. When absent, we fall back to the
  rate-limit-only path, which is fine for low-volume tenants.

The URL never appears in our access logs in raw form — the audit
middleware hashes it before write so log exfil ≠ token exfil.

## Operational shape

- **Egress** — one dedicated egress IP for all relay → Slack
  traffic, separate from the public scoring API's IP. If Slack
  rate-limits us across tenants, we want it isolated; if Slack
  blocks the egress entirely (DDoS source, etc.) the user-facing
  scoring API stays up.
- **Per-tenant Slack rate-limit tracking** — Slack returns
  `Retry-After` on 429s. Track them per `team_id`, back off, and
  surface the throttle state on the tenant's status page. A noisy
  tenant cannot starve the others.
- **Failure mode** — relay is best-effort. If Slack is down, the
  caller gets `502 SLACK_UPSTREAM_DOWN` and no retry queue. We
  *do not* persist undelivered messages — that turns a 5-second
  outage into a customer-data retention problem.
- **Cost ceiling** — every relay call is one KMS decrypt + one
  Slack POST + one VulnRap score. Each of those is sub-cent at
  the volumes we expect. The cost concern is operational toil
  (incidents, on-call, App Directory review cycles) more than
  hosting bill.

## Compliance & disclosure surface

Going multi-tenant turns several previously-trivial things into
actual obligations:

- **Privacy policy** — we now hold tenant-controlled data (channel
  ids, team ids, encrypted bot tokens). Document it, scope the
  retention to "until the tenant clicks Disconnect", and never
  store report bodies past the synchronous request.
- **Disclosure path** — `security.txt` and `accessibility-audit.md`
  already exist; add a Slack-specific entry to the threat model
  (`threat_model.md`) covering the relay before launch.
- **Slack App Directory review** — required to put the install
  button in front of customers who don't already trust us with
  out-of-band credentials. Scope set above is intentionally
  reviewer-friendly.

## Phased rollout

1. **Private beta** — invite-only, manually provisioned. We hand
   out manifest paste-and-install to ~5 friendly users. We do not
   take their tokens; they install in their own workspace and use
   the engineering path. This validates demand without taking on
   any of the new attack surface.
2. **Closed alpha** — relay endpoint deployed, but the install
   button is gated behind an invite code. We hold tokens for
   maybe 20 tenants. Token storage is exercised; rotation runs
   nightly; the alert wiring (Slack-side errors, decrypt
   failures, rate-limit hits) is shaken out.
3. **Public beta** — install button visible on
   `/integrations/slack`. App Directory submission goes in.
   Documented SLA: best-effort, no retention beyond the live
   request, instant disconnect honored within seconds.
4. **GA** — only after we've operated closed alpha clean for
   ~1 month and we have a documented incident-response runbook
   for "bot token leaked".

## Decision

Don't ship v1 until the **dominant risks are designed-against, not
just acknowledged**:

- [ ] KMS-backed DEK wrapping in place (no plaintext tokens at
      rest, even with DB read).
- [ ] Audit logger token-redaction extended to cover the new
      column names; integration tested.
- [ ] Token rotation turned on at the Slack app level.
- [ ] Per-tenant rate limit + 429-aware backoff implemented and
      load-tested.
- [ ] App Directory submission scoped to `chat:write` only.
- [ ] Disconnect → token revocation tested end-to-end (Slack
      `auth.revoke` + DB row delete + cache flush).
- [ ] Threat model entry merged into `threat_model.md`.
- [ ] Incident-response runbook exists for "bot token leaked"
      with concrete steps (rotate, force-disconnect all tenants,
      notify).

Until those are checked, the manifest paste in `slack.md` is the
right answer — it pushes the security boundary back to the user
where it belongs.
