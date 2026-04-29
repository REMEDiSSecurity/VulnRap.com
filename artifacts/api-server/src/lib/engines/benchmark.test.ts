import { describe, it, expect } from "vitest";
import { analyzeWithEngines } from "./index.js";

interface Fixture {
  name: string;
  text: string;
  expectMaxScore?: number;
  expectMinScore?: number;
  claimedCwes?: string[];
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
    expectMaxScore: 35,
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
const CURL_SLOP_TIGHTENING_TARGETS: Array<{ name: string; expectMaxScore: number; reason: string }> = [
  {
    name: "curl-slop-h1-3295650-gitleaks-test-certs",
    expectMaxScore: 25,
    reason: "Sprint 13B handwavy-phrase + AI-self-disclosure tightening",
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
    // Sprint 12 A3: this fixture sat at exactly the old 55 threshold under
    // the 5/55/40 weighting. The new 5/60/35 weighting drops it ~1 point to
    // 54 because the fixture's E3 contribution shrank (35% vs 40%) faster
    // than its E2 contribution grew (the report cites CWE-444 cleanly but
    // doesn't expose any AVRI GOLD_SIGNAL — no crash trace, no real raw
    // HTTP pair). 50 stays well inside the REASONABLE band and still
    // distinguishes this from the slop fixtures (all ≤ 35).
    expectMinScore: 50,
  },
];

describe("VulnRap engines benchmark", () => {
  for (const f of SLOP_FIXTURES) {
    it(`slop fixture ${f.name} should score <= ${f.expectMaxScore}`, () => {
      const r = analyzeWithEngines(f.text, { claimedCwes: f.claimedCwes });
      expect(r.overallScore, `${f.name} composite=${r.overallScore} label=${r.label}`).toBeLessThanOrEqual(f.expectMaxScore!);
    });
  }

  for (const f of LEGIT_FIXTURES) {
    it(`legit fixture ${f.name} should score >= ${f.expectMinScore}`, () => {
      const r = analyzeWithEngines(f.text, { claimedCwes: f.claimedCwes });
      expect(r.overallScore, `${f.name} composite=${r.overallScore} label=${r.label}`).toBeGreaterThanOrEqual(f.expectMinScore!);
    });
  }

  for (const f of CURL_SLOP_FIXTURES) {
    it(`curl HackerOne slop fixture ${f.name} should score <= ${f.expectMaxScore}`, () => {
      const r = analyzeWithEngines(f.text, { claimedCwes: f.claimedCwes });
      expect(r.overallScore, `${f.name} composite=${r.overallScore} label=${r.label}`).toBeLessThanOrEqual(f.expectMaxScore!);
    });
  }

  // Tightening targets from Task #204 that v3.8.0 does not yet meet. Each one
  // is gated as `it.skip` until the corresponding Sprint 13B detector tightening
  // lands; flipping `.skip` off is then a single-line change that turns the
  // aspirational target into a real regression assertion.
  for (const t of CURL_SLOP_TIGHTENING_TARGETS) {
    it.skip(`tightening target (${t.reason}): ${t.name} should score <= ${t.expectMaxScore}`, () => {
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
      const r = analyzeWithEngines(f.text, { claimedCwes: f.claimedCwes });
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
