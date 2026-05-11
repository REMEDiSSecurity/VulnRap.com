# Security Disclosure Policy

VulnRap is a tool for the security community. If you find a vulnerability in
VulnRap itself, we want to hear about it and we will fix it. This document is
the canonical disclosure policy for the project.

The machine-readable version is published at
[`/.well-known/security.txt`](https://vulnrap.com/.well-known/security.txt) per
RFC 9116.

## Reporting a vulnerability

Please report security issues privately by email — **do not** open a public
GitHub issue or pull request that describes the vulnerability.

- **Contact:** [remedisllc@gmail.com](mailto:remedisllc@gmail.com)
- **Subject line:** `VulnRap Security Report`
- **Preferred languages:** English

### PGP / GPG encryption

If you would like to encrypt the report, request our public key in your first
email and we will respond with the current key over the same channel.

- **PGP key fingerprint:** `TBD — request via email` _(placeholder until a
  long-lived signing key is published; once published the fingerprint will
  appear here verbatim and the key will be served from
  `/.well-known/pgp-key.txt`)_

### What to include

Help us reproduce and fix the issue quickly by including:

1. A clear description of the vulnerability and its potential impact.
2. Step-by-step instructions to reproduce the issue.
3. The affected component (API, frontend, redaction engine, similarity
   pipeline, etc.).
4. Environment details (browser, OS, tools used).
5. A proof of concept — screenshots, request/response logs, or a minimal
   script.
6. Optionally, a suggested fix or mitigation.

## Scope

### In scope

- The VulnRap web application at `vulnrap.com`.
- The VulnRap REST API at `vulnrap.com/api/*`.
- The auto-redaction engine — bypasses that leak PII or secrets out of a
  submitted report.
- The similarity / hashing pipeline — collision attacks, cross-tenant data
  leakage, deanonymization of redacted content.
- Authentication, authorization, or access-control flaws on any privileged
  endpoint (calibration, audit log, internal routes, webhooks).
- Server-side vulnerabilities such as SSRF, injection, path traversal,
  deserialization, or template injection.
- Vulnerabilities in any artifact hosted from this repository (the API server,
  the `vulnrap` web app, and any deployable engines under `artifacts/`).

### Out of scope

- Denial-of-service attacks against the production deployment. Rate limiting
  is in place; please do not stress-test it on production.
- Social engineering of the team or of users.
- Issues in third-party dependencies that do not have a demonstrated exploit
  path in VulnRap.
- Self-XSS, clickjacking on pages without sensitive actions, missing
  best-practice headers without a concrete exploit, or issues that require
  physical access to a user's device.
- Bug-bounty-style monetary rewards. We do not currently run a paid bounty
  program; this document only governs the disclosure channel.

## Safe harbor

We will not pursue or support any legal action against researchers who, in
good faith, comply with this policy. Specifically, when you act in good faith
to comply with the rules below, we will:

- Consider your activity authorized under the Computer Fraud and Abuse Act
  (and analogous laws in other jurisdictions) and will not initiate or
  recommend legal action against you.
- Waive any DMCA claim against you for circumventing technical measures used
  to protect the in-scope assets.
- Work with you to understand and resolve the issue quickly.

To stay within safe harbor:

- Make a good-faith effort to avoid privacy violations, degradation of user
  experience, disruption to production systems, and destruction or
  manipulation of data.
- Only interact with accounts you own or with explicit permission of the
  account holder.
- Stop testing and report immediately if you encounter user data, credentials,
  or any other sensitive information.
- Do not exfiltrate any data — proof of access via a minimal, non-sensitive
  identifier (e.g. a row count, a redacted excerpt) is sufficient.

If in doubt about whether your testing is consistent with this policy, contact
us _before_ proceeding.

## Response SLA

We aim to respond on the following timeline. These are targets; complex
issues may take longer, and we will keep you informed if they do.

| Stage          | Target                                                              |
| -------------- | ------------------------------------------------------------------- |
| Acknowledgment | Within **48 hours** of report                                       |
| Triage         | Within **1 week** of report                                         |
| Fix            | Severity-dependent; critical issues are patched as fast as possible |
| Disclosure     | Coordinated with the reporter, after the fix is deployed            |

## Disclosure

We believe in coordinated disclosure. Once a fix is deployed, we will work
with you on a public write-up and — with your permission — credit you in the
release notes and in the acknowledgments section of the
[`/security`](https://vulnrap.com/security) page.

## Out of scope: bounties

VulnRap does not currently offer monetary rewards for security reports. This
policy covers the disclosure channel only.

---

## Operator: production deployment checklist

The API server refuses to boot in production (`NODE_ENV=production`) until
every value below is set. This is enforced by
[`validateProductionConfig`](artifacts/api-server/src/lib/prod-config.ts) at
startup so a misconfigured deploy can never accept traffic with permissive
defaults.

| Variable                        | Why it matters                                                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                    | Canonical https origin of the deployment. Used by `security.txt`, OG cards, sitemap, and Atom feeds. In production, **the request `Host` header is never trusted as a fallback** — that would let an attacker poison every link by spoofing it. |
| `ALLOWED_ORIGINS`               | Comma-separated list of permitted browser origins for CORS. If unset, the API would allow every cross-origin caller. Malformed entries are dropped; if every entry is malformed the API refuses to boot rather than silently re-opening to all origins. |
| `CALIBRATION_TOKEN`             | Bearer token gating every reviewer-only mutation endpoint (calibration, audit log, webhooks, test fixtures, …). Without it those endpoints 401 unconditionally.                                          |
| `VISITOR_HMAC_KEY`              | HMAC key used to hash visitor IPs for the per-IP daily caps on phrase suggestions and showcase nominations. Without a stable key the per-IP counts drift on every restart.                                |
| `METRICS_TOKEN`                 | Bearer token gating the `/api/metrics` Prometheus scrape endpoint. Without it the endpoint would be open to the public Internet and would leak per-route latency / volume telemetry useful for recon.    |
| `DOCS_TOKEN` _(optional)_       | When set, gates `/api/docs` (interactive Swagger UI) behind a bearer token. When unset in production, `/api/docs` is disabled entirely. The static `openapi.yaml` remains available for machine clients. |
| `SECURITY_TXT_EXPIRY_DAYS` _(optional)_ | Rollover window for the `Expires:` line in `/.well-known/security.txt`. Defaults to 90 days; clamped to (0, 365].                                                                                  |

### Pre-deploy verification

1. `pnpm --filter @workspace/api-server run build` — must succeed.
2. `pnpm --filter @workspace/api-server run test` — must pass (covers the
   prod-config validator, the CORS allow-list parser, the public-URL parser,
   the SSRF guard, and the audit-log redactor).
3. Run `node --enable-source-maps artifacts/api-server/dist/index.mjs` with
   only `NODE_ENV=production` set — the process should exit immediately with
   a multi-line error listing every missing required variable. If it boots
   silently, the fail-closed check has regressed.
4. After setting all required values, hit `https://<host>/.well-known/security.txt`,
   `https://<host>/api/metrics` (with and without the bearer), and
   `https://<host>/api/docs` (with and without `DOCS_TOKEN`) and confirm the
   expected status codes (200, 401-without-bearer, 401-without-bearer
   respectively).

### Webhook destinations

Reviewer-registered webhook URLs are validated by an SSRF guard
([`lib/private-host-guard.ts`](artifacts/api-server/src/lib/private-host-guard.ts))
that rejects loopback, RFC1918, link-local, CGNAT, multicast, broadcast, and
known cloud-metadata endpoints both at the URL parsing stage (literal IPs)
and after DNS resolution (so a public hostname that resolves to a private
address is also caught). New blocked ranges should be added to that file
along with a unit test in `private-host-guard.test.ts`.

The same guard runs a second time **at delivery time** in
[`lib/webhook-delivery.ts`](artifacts/api-server/src/lib/webhook-delivery.ts):
on every attempt the destination is re-resolved, every returned address is
re-validated, and `checkPrivateHost` returns the validated address set so
the delivery code can pin one of those exact addresses for the outbound
connect — **the resolver is never called a second time per attempt**, so a
hostile DNS server cannot return a public IP on the validation lookup and
a private IP on the pin lookup. The actual `fetch` is issued through an
undici `Agent` whose `connect.lookup` callback returns the pre-validated
IP, which closes the TOCTOU window between the resolver check and the TCP
connect (DNS rebinding). In production, if the pinned dispatcher cannot be
built (undici import failure, etc.) the delivery is **aborted** rather
than falling back to an unpinned `fetch` — IP pinning is part of the
production security model, not best-effort.

### Dependency hygiene

`pnpm audit --prod` from the workspace root must report zero advisories
before a deploy goes out. Transitive vulnerabilities are pinned to a
patched release via the `overrides` block in
[`pnpm-workspace.yaml`](pnpm-workspace.yaml). The current overrides include
`ip-address: ^10.1.1` (GHSA-v2v4-37r5-5v8g, pulled in transitively via
`express-rate-limit`). When a new advisory appears, prefer adding an
override over pinning a single workspace package so every consumer in the
monorepo picks up the fix together.

`pdf-parse-new` is pinned to the exact version `2.0.0` in
[`artifacts/api-server/package.json`](artifacts/api-server/package.json).
The upstream `2.1.0` release ships a broken package (its `index.js` requires
a `lib/markdown-render-page.js` file that is missing from the published
tarball, causing the API server to fail to boot). The pin is intentional —
do not bump it until upstream republishes a working `2.1.x` release. A
longer-term follow-up to migrate to `pdfjs-dist` for a broader maintainer
base is tracked outside this file.

### Audit-log redaction

The reviewer audit log redacts both secret-shaped **field names** (`token`,
`secret`, `password`, `apiKey`, `auth*`, `cred*`, `cookie`) and secret-shaped
**values** (OpenAI / Anthropic `sk-…`, GitHub `ghp_…`, AWS `AKIA…`, Google
`AIza…`, Slack `xox?-…`, JWTs, and inline PEM private-key blocks). When
adding a new secret format anywhere in the codebase, also add it to
`SECRET_VALUE_PATTERNS` in
[`middlewares/audit-log-middleware.ts`](artifacts/api-server/src/middlewares/audit-log-middleware.ts)
so it can never end up in plaintext on disk.

---

## Threat model summary

This is the short version of what the codebase defends against and what it
explicitly does not. It is not a substitute for the disclosure policy above.

### Trust boundaries

- **Public Internet ↔ API server.** Untrusted. All input is validated; the
  CORS allow-list is enforced from `ALLOWED_ORIGINS`; rate limits cap
  abusive callers; a global helmet CSP locks down script / style / connect
  sources.
- **Reviewer ↔ calibration / audit / webhook endpoints.** Bearer-token
  gated by `CALIBRATION_TOKEN`. Wrong-token attempts are throttled per-IP.
  Every mutation is appended to the audit log with the redacted request
  payload, the actor, the IP, and the response status.
- **API server ↔ Postgres.** Trusted. Connection string is provided by the
  hosting environment; pooled writes go through Drizzle's parameterised
  query builder. No raw SQL is constructed from user input.
- **API server ↔ reviewer-supplied webhook destinations.** Untrusted.
  Outbound POSTs are filtered by the SSRF guard above; payloads are signed
  with HMAC-SHA-256 derived from a secret returned to the reviewer exactly
  once at registration time (only the SHA-256 hash is persisted).

### Defenses

- **Auto-redaction engine.** Strips PII / credentials from inbound report
  bodies before they are scored, hashed, persisted, or surfaced anywhere in
  the API output.
- **Audit-log redaction.** Belt-and-braces — even if the upstream redactor
  misses something, the reviewer audit log applies a second pass for
  high-confidence secret prefixes.
- **CSP.** In production, `script-src` is `'self'` only (no
  `'unsafe-inline'`); `style-src` retains `'unsafe-inline'` for the print-
  only stylesheets injected by the report results / whitepaper pages;
  `frame-ancestors`, `base-uri`, and `object-src` are all locked down.
- **Host-header poisoning.** `buildPublicUrl` never falls back to the
  request `Host` header in production; combined with the
  fail-closed `PUBLIC_URL` check this means every canonical link emitted
  by the server resolves to the operator-configured origin.
- **SSRF.** Reviewer-supplied URLs (currently webhook subscriptions) are
  filtered at the URL parsing stage and again after DNS resolution before
  any outbound request is made.
- **Rate limits.** Layered: per-route caps on the expensive analysis
  endpoints, a wider per-IP ceiling on the `/api/reports/*` namespace, and
  per-route caps on the public submission forms (phrase suggestions,
  showcase nominations).

### Out of scope

- DoS resilience beyond the limits listed above. The deployment is sized
  for the public service tier, not for survival under sustained attack.
- Vulnerabilities in third-party services (Replit, Postgres host) without a
  demonstrated exploit path inside VulnRap. The brand fonts are self-hosted
  from `/fonts/` (see Task #1311), so fonts.googleapis.com / fonts.gstatic.com
  are no longer part of the production trust boundary.
- Secrets stored outside the API server's environment (CI secrets, contributor
  laptops, etc.). Those are out of band.
