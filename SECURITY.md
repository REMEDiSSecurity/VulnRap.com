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
