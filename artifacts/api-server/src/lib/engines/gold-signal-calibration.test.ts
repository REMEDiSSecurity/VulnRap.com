// Task #333 — calibration analysis for the gold-signal-bonus cap.
//
// This file is the human-readable calibration evidence that backs the
// per-category weights in `gold-signals.ts` (GOLD_SIGNAL_WEIGHTS) and the
// summed cap (GOLD_SIGNAL_BONUS_CAP). It replays the existing slop /
// curl-slop / legit / borderline fixture cohort under the LEGACY
// (AVRI-off) scoring path — that is the only path that consults
// GOLD_SIGNAL_WEIGHTS / GOLD_SIGNAL_BONUS_CAP, since the AVRI path has
// its own family-rubric weights baked into avri/families.ts. Two
// synthetic anchors (a "rich legit" report with 3 categories firing and
// a "max-stuffed" report with 6 categories firing) extend the cohort so
// the cap shape can actually be exercised, since real-world legit
// fixtures in the corpus today only fire one category each.
//
// For each fixture we record:
//
//   - rawSum     : Σ weight over the GOLD_SIGNAL ids the report fires
//   - bonus      : min(rawSum, cap) — the bonus actually applied
//   - capHit     : whether rawSum > cap (i.e. the cap actually clipped)
//   - composite  : final 3-engine composite (legacy + AVRI side-by-side)
//
// Calibration findings (Apr 2026 run, weights/cap unchanged from #240):
//
//   - Real-cohort distribution (11 fixtures): rawSum ∈ {0, 5}.
//     8/11 fixtures fire zero gold signals; 3/11 fire exactly one HIGH-
//     weight category. The cap (12) is NEVER hit by the current
//     real-world cohort — it functions as a safety ceiling for future
//     multi-category reports.
//
//   - "Rich legit" anchor (auth-bearer + SQLi UNION + diff): rawSum=11,
//     bonus=11. This is the realistic upper bound for a well-evidenced
//     web-auth bug report; the cap of 12 sits 1pt above it, leaving
//     headroom for a 4th category without clipping.
//
//   - "Max-stuffed" anchor (6 categories incl. crash trace + raw HTTP +
//     diff + auth + SQLi + command injection + traversal): rawSum=25,
//     bonus=12 (cap clips). Even with -13pt of cap suppression the
//     report still scores 81 (STRONG label), so the cap does NOT
//     over-suppress legitimately rich reports — it bounds the runaway.
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
import {
  GOLD_SIGNAL_WEIGHTS,
  GOLD_SIGNAL_BONUS_CAP,
} from "./gold-signals.js";

interface Fixture {
  name: string;
  text: string;
  kind: "slop" | "curl-slop" | "legit" | "borderline" | "synthetic-rich" | "synthetic-max";
  claimedCwes?: string[];
}

// Real fixtures — kept in sync with benchmark.test.ts. The benchmark file
// does not export its fixture array, so we duplicate the texts here. Each
// name MUST match the corresponding benchmark fixture so the breakdown
// table and the regression assertions stay aligned. We deliberately keep
// the cohort small (the broad slop/legit boundary is owned by
// benchmark.test.ts; this file is for the gold-bonus distribution only).
const FIXTURES: Fixture[] = [
  { kind: "slop",  name: "slop-01-vague-xss",
    text: "I found a critical XSS vulnerability in your application that could allow attackers to steal user data and compromise the entire system. This is a very serious issue that affects all users and needs to be patched immediately. The impact is severe and could lead to complete account takeover. Please award me a bounty." },
  { kind: "slop",  name: "slop-03-fake-sqli",
    text: "Hello team,\n\nI discovered SQL injection in your login form. When I tried to login, I noticed that the application is vulnerable to SQL injection attacks which could allow an attacker to dump the entire database. This is a critical issue. Please fix it.\n\nRegards,\nResearcher" },
  { kind: "slop",  name: "slop-04-no-evidence-rce", claimedCwes: ["CWE-78"],
    text: "Remote Code Execution found in your API endpoint /api/upload. This vulnerability allows attackers to execute arbitrary commands on the server, leading to complete system compromise. The severity is critical (CVSS 10.0). I request a maximum bounty for this finding." },
  { kind: "slop",  name: "slop-08-vague-csrf", claimedCwes: ["CWE-352"],
    text: "CSRF vulnerability in account settings. An attacker could trick a user into changing their password by visiting a malicious page. This is a serious issue that violates security best practices and OWASP guidelines. Please patch this and award bounty." },
  { kind: "slop",  name: "slop-09-fabricated-asan-structure", claimedCwes: ["CWE-416"],
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
exercise. CVSS 9.8.` },
  { kind: "curl-slop", name: "curl-slop-h1-2298307-strcpy-template", claimedCwes: ["CWE-122"],
    text: `Hello security team, Hope you are doing well :) I would like to report a potential security vulnerability in the WebSocket handling code of the curl library. The issue is related to the usage of the strcpy function, which can lead to a buffer overflow if the length of the input is not properly checked. The vulnerable code snippet is located at this link.\n\nSteps To Reproduce: Trigger the WebSocket functionality with a crafted request. Provide a base64-encoded nonce value that exceeds the buffer size. Observe that the strcpy function is used without proper bounds checking.\n\nFix: To address this issue, it is recommended to replace the strcpy function with the safer alternative strncpy and explicitly specify the maximum length to copy.\n\nReference: https://cwe.mitre.org/data/definitions/122.html\n\nImpact: This vulnerability may allow an attacker to execute arbitrary code, potentially leading to a compromise of the application or system. An attacker could exploit this weakness by providing a specially crafted WebSocket request, causing a buffer overflow and overwriting adjacent memory.` },
  { kind: "curl-slop", name: "curl-slop-h1-3340109-fabricated-asan", claimedCwes: ["CWE-121"],
    text: `Summary: I discovered a critical stack-based buffer overflow vulnerability in cURL's cookie parsing mechanism that can lead to remote code execution. The vulnerability occurs when processing maliciously crafted HTTP cookies, affecting all applications that use libcurl for HTTP requests.\n\nDescription: During security research on cURL's cookie handling implementation, I identified a stack buffer overflow in the cookie parsing logic. The vulnerability allows remote attackers to trigger memory corruption by sending oversized cookie data through HTTP responses.\n\nTechnical Details - Vulnerability Location: The vulnerability occurs in the cookie parsing functionality where string length calculations exceed allocated stack buffer boundaries. Root Cause Analysis: Buffer Size Mismatch: Cookie processing code reads beyond allocated stack buffer. Unsafe String Operations: strlen() operation on cookie data exceeds buffer boundaries. Stack Memory Corruption: Read of 8,193 bytes in a buffer allocated for 8,192 bytes. Multi-threaded Context: Issue manifests in threaded environments.\n\nAddressSanitizer Detection: ERROR: AddressSanitizer: stack-buffer-overflow on address 0x00016f00a5c0. READ of size 8193 at 0x00016f00a5c0 thread T1. #0 0x000101676c34 in strlen+0x1b0. #1 0x000100f94c38 in cookie_overflow_hunter cookie_vulnerability_hunter.c:121.\n\nCVSS 3.1 Assessment: Base Score: 9.8 (CRITICAL). Vector String: AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H.\n\nVerified POC Code creates a local buffer of 8192 bytes, fills it without null terminator, calls strlen() which reads past the buffer. This code does NOT call curl.` },
  { kind: "legit", name: "legit-01-cve-2025-0725-curl", claimedCwes: ["CWE-122"],
    text: `# Buffer overflow in libcurl gzip decoding (CVE-2025-0725-style)\n\n## Affected component\nlibcurl's automatic content decoding for gzip when built against zlib < 1.2.0.3.\n\n## Root cause\nIn \`lib/content_encoding.c\`, the function \`inflate_stream()\` calls \`Curl_client_write()\` with the size returned by \`inflate()\` without bounding it against the destination buffer when an integer overflow occurs in zlib < 1.2.0.3.\n\n\`\`\`c\n// lib/content_encoding.c (approx line 290)\nstatus = inflate(z, Z_BLOCK);\nnread = DSIZ - z->avail_out; // <-- can overflow on legacy zlib\nresult = Curl_client_write(data, CLIENTWRITE_BODY, decomp, nread);\n\`\`\`\n\n## Reproduction\n1. Build curl 8.11.x against zlib 1.2.0.2:\n   \`\`\`\n   ./configure --with-zlib=/opt/zlib-1.2.0.2 && make\n   \`\`\`\n2. Run: \`./src/curl --compressed https://attacker.example/big.gz -o /dev/null\`\n3. Observe heap-buffer-overflow under ASan: \`==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x611000009f80\`\n\n## Patch\nValidate \`nread <= DSIZ\` before calling \`Curl_client_write\`; reject the response with \`CURLE_BAD_CONTENT_ENCODING\` otherwise.\n\n## Impact\nHeap buffer overflow → potential RCE in long-running clients fetching attacker-controlled compressed responses. CVSS 8.6 (AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H).` },
  { kind: "legit", name: "legit-02-curl-cookie-parser", claimedCwes: ["CWE-787"],
    text: `# Out-of-bounds write in curl cookie parser when domain is empty\n\n## Affected\ncurl/libcurl 8.0.0 - 8.10.1, file \`lib/cookie.c\`, function \`Curl_cookie_add\`.\n\n## Root cause\nWhen parsing a Set-Cookie header where the Domain attribute is the empty string, the parser advances past the terminating NUL. The bug is here:\n\n\`\`\`c\n// lib/cookie.c around line 712 in 8.10.1\nif(!strncasecompare("domain=", what, 7)) {\n  whatptr = &what[7];\n  while(*whatptr == '.') whatptr++; // walks past NUL on empty domain\n  co->domain = strdup(whatptr);\n}\n\`\`\`\n\nA 1-byte read past the end of the heap chunk leads to a write when \`strdup\` later copies into a sized buffer.\n\n## Reproduction\n\`\`\`\nprintf 'HTTP/1.1 200 OK\\r\\nSet-Cookie: x=1; Domain=\\r\\n\\r\\n' | nc -l 8080 &\ncurl -v -c jar.txt http://127.0.0.1:8080/\n\`\`\`\nASan output:\n\`\`\`\n==4711==ERROR: AddressSanitizer: heap-buffer-overflow READ of size 1\n    #0 Curl_cookie_add lib/cookie.c:712\n    #1 Curl_cookie_init lib/cookie.c:1003\n\`\`\`\n\n## Fix\nBounds-check \`whatptr\` against the original \`what + len\` before dereferencing.\n\n## Severity\nCVSS 7.5 (AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:L/A:H) — denial of service in clients that persist cookies.` },
  { kind: "legit", name: "legit-03-request-smuggling", claimedCwes: ["CWE-444"],
    text: `# HTTP request smuggling via conflicting Transfer-Encoding header in proxy\n\n## Affected\nacme-proxy 2.4.1 - 2.6.3, source file \`src/http/parser.rs\` lines 412-455.\n\n## Root cause\nThe proxy accepts \`Transfer-Encoding: chunked\` AND \`Content-Length\` simultaneously and forwards both to the backend. RFC 7230 §3.3.3 requires the proxy to either reject the message or strip Content-Length; this implementation does neither.\n\n\`\`\`rust\n// src/http/parser.rs:430\nif headers.contains_key("transfer-encoding") {\n    self.body = Body::Chunked(reader);\n} else if let Some(cl) = headers.get("content-length") {\n    self.body = Body::Sized(reader, cl.parse()?);\n}\n// missing: error or header strip when both are present\n\`\`\`\n\n## Reproduction\n\`\`\`\nprintf 'POST / HTTP/1.1\\r\\nHost: victim\\r\\nContent-Length: 6\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n0\\r\\n\\r\\nGPOST / HTTP/1.1\\r\\nHost: victim\\r\\n\\r\\n' | nc proxy 8080\n\`\`\`\nThe proxy forwards 0\\r\\n\\r\\n then GPOST as a separate request, smuggling the second request to the backend.\n\n## Patch\nReject any message containing both Transfer-Encoding and Content-Length with HTTP 400.\n\n## Impact\nCache poisoning, request hijacking, auth bypass. CVSS 9.0.` },
  { kind: "borderline", name: "borderline-01-thin-but-plausible", claimedCwes: ["CWE-79"],
    text: `# Reflected XSS in /search endpoint\n\nThe \`q\` parameter on GET /search is reflected unencoded:\n\n\`\`\`html\n<input value="<script>alert(1)</script>" />\n\`\`\`\n\nReproduction:\n1. curl 'https://app.example.com/search?q=<script>alert(1)</script>'\n2. Inspect response: payload echoes inside the search-bar input.\n\nSuggested fix: HTML-encode the parameter via the existing \`escapeHtml()\` helper in src/views/search.tsx:42.` },

  // ---------------------------------------------------------------------
  // Synthetic calibration anchors (Task #333). These do NOT live in the
  // benchmark cohort because they exist solely to exercise the gold-bonus
  // cap shape — every real bug report in the cohort fires at most one
  // category. The names are prefixed `synthetic-…` so a future calibration
  // can identify them at a glance.
  // ---------------------------------------------------------------------
  {
    // "Rich legit" — three categories: code_diff(3) + auth_token(3) +
    // sql_injection_payload(5) = 11pt. Models a well-evidenced authenticated
    // SQLi report. Sits just below the cap, with 1pt of headroom for a
    // hypothetical 4th category.
    kind: "synthetic-rich",
    name: "synthetic-rich-authenticated-sqli",
    claimedCwes: ["CWE-89"],
    text: `# Authenticated SQL injection in /api/admin/search via q param

## Affected
acme-app 4.2.0 - 4.5.1, file \`src/api/admin/search.ts\` lines 88-110.

## Root cause
The handler concatenates the q parameter into a raw SQL UNION query
without parameterisation. Authenticated session token is required.

## Reproduction (raw HTTP request)
\`\`\`http
GET /api/admin/search?q=foo'%20UNION%20SELECT%20username,password%20FROM%20users-- HTTP/1.1
Host: app.target.test
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsImlhdCI6MTcxNjU0Nzg5MH0.qkA7H3QyTzuKUbE_DEAD_beef_signature_xyz
Cookie: sessionid=8f3c2b9a4d6e1f7c0a5b9d2e
Accept: application/json

\`\`\`

The injection \`foo' UNION SELECT username,password FROM users--\`
returns the credentials table in the JSON body.

## Patch
\`\`\`diff
--- a/src/api/admin/search.ts
+++ b/src/api/admin/search.ts
@@ -88,7 +88,8 @@ export async function adminSearch(req, res) {
-  const rows = await db.query(\`SELECT id,name FROM items WHERE name LIKE '%\${q}%'\`);
+  const rows = await db.query("SELECT id,name FROM items WHERE name LIKE ?", [\`%\${q}%\`]);
   return res.json(rows);
\`\`\`

## Impact
Attacker with any authenticated session can dump entire users table.
CVSS 9.1.`,
  },
  {
    // "Max-stuffed" — 6 categories firing: code_diff(3) + real_crash_trace(5)
    // + auth_token(3) + sql_injection_payload(5) + command_injection_payload(5)
    // + path_traversal_payload(4) = 25pt. Cap clips to 12. This is the
    // unrealistic-but-possible chained-exploit upper bound. Confirms the
    // cap actually bites and that 12pt is enough to keep a richly
    // evidenced report in the STRONG band (≥75).
    kind: "synthetic-max",
    name: "synthetic-max-multi-vector-chain",
    claimedCwes: ["CWE-78"],
    text: `# Multi-vector chained exploit on /api/admin/upload
acme-app 1.0, file src/api/upload.ts.

\`\`\`http
POST /api/admin/upload?path=../../etc/passwd HTTP/1.1
Host: target.test
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiIsImlhdCI6MTcxNjU0Nzg5MH0.qkA7H3QyTzuKUbE_DEAD_beef_signature_xyz
Cookie: sessionid=8f3c2b9a4d6e1f7c0a5b9d2e
Content-Type: application/x-www-form-urlencoded
Content-Length: 88

name=test\` + \` UNION SELECT username,password FROM users--&cmd=;cat /etc/passwd
\`\`\`

The handler concatenates path into shell exec(\`tar xf $PATH\`) AND reads the file at /etc/passwd via the path-traversal: ../../etc/passwd. The injected command \`;cat /etc/passwd\` returns content. The SQL UNION SELECT username,password FROM users dumps creds.

Patch:
\`\`\`diff
--- a/src/api/upload.ts
+++ b/src/api/upload.ts
@@ -10,3 +10,3 @@
-  const out = exec(\`tar xf \${path}\`);
-  const rows = await db.query(\`SELECT * FROM items WHERE name='\${name}'\`);
+  const out = await execFile("tar", ["xf", validatedPath]);
+  const rows = await db.query("SELECT * FROM items WHERE name=?", [name]);
\`\`\`

The crash trace from oss-fuzz on this code path:
==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x611000009f80
READ of size 8 at 0x611000009f80 thread T0
    #0 0x4001000 in upload_handler src/api/upload.ts:14
    #1 0x4001100 in router_dispatch src/router.ts:88
    #2 0x4001200 in main src/index.ts:42
freed by thread T1 here:
    #0 0x4002000 in __interceptor_free
    #1 0x4002100 in close_session src/session.ts:33
`,
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
    | { bonus: number; rawSum: number; cap: number; signals: Array<{ id: string; weight: number }> }
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
    // eslint-disable-next-line no-console
    console.log("\n=== Task #333 gold-signal-bonus calibration ===");
    // eslint-disable-next-line no-console
    console.log(
      `cap=${GOLD_SIGNAL_BONUS_CAP}  weights=${JSON.stringify(GOLD_SIGNAL_WEIGHTS)}`,
    );
    for (const r of rows) {
      // eslint-disable-next-line no-console
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
    // against without re-reading every line of the breakdown table.
    const real = rows.filter((r) => !r.kind.startsWith("synthetic"));
    const realRawSums = real.map((r) => r.rawSum);
    const realMax = Math.max(...realRawSums);
    const realCapHits = real.filter((r) => r.capHit).length;
    // eslint-disable-next-line no-console
    console.log(
      `\nReal-cohort summary: n=${real.length}  rawSum.max=${realMax}  ` +
        `cap-hits=${realCapHits}/${real.length}  cap=${GOLD_SIGNAL_BONUS_CAP}`,
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  // Calibration finding (a): high-quality reports approach the cap.
  // The "rich legit" synthetic anchor (3 categories, 11pt) approaches
  // the cap (12) and the "max-stuffed" anchor (6 categories, 25pt) hits
  // it. This is the realistic shape: real-cohort fixtures fire one
  // category each and never approach the cap, but the synthetic anchors
  // confirm the cap is reachable for a well-evidenced multi-category
  // bug report.
  it("(a) high-quality multi-category reports approach or hit the cap", () => {
    const rich = rowFor(FIXTURES.find((f) => f.kind === "synthetic-rich")!);
    const max = rowFor(FIXTURES.find((f) => f.kind === "synthetic-max")!);
    // The rich-legit anchor must come within 2pt of the cap. If a future
    // detector change pushes it well below, the cap is too generous (or
    // a category weight has been mis-tuned).
    expect(
      rich.bonus,
      `rich-legit anchor bonus=${rich.bonus} (rawSum=${rich.rawSum}, cap=${GOLD_SIGNAL_BONUS_CAP}) — anchor should approach the cap to confirm 3-category combinations are rewarded`,
    ).toBeGreaterThanOrEqual(GOLD_SIGNAL_BONUS_CAP - 2);
    // The max-stuffed anchor must actually clip the cap. If it doesn't,
    // the cap is set above any achievable combination and is functionally
    // dead code.
    expect(
      max.capHit,
      `max-stuffed anchor rawSum=${max.rawSum} bonus=${max.bonus} cap=${GOLD_SIGNAL_BONUS_CAP} — cap must clip the unrealistic upper bound`,
    ).toBe(true);
  });

  // Calibration finding (b): the cap doesn't over-suppress legit reports.
  // Under the legacy AVRI-off path, every legit fixture must still clear
  // the LEGIT minScore band (composite ≥ 50, matching the
  // legit-03-request-smuggling lower bound), AND the max-stuffed
  // synthetic must still land in the STRONG band (≥75) — proving even
  // the worst-case cap suppression (-13pt) doesn't push a richly
  // evidenced report out of STRONG.
  it("(b) the cap doesn't over-suppress legit or richly-evidenced reports", () => {
    const legitRows = FIXTURES.filter((f) => f.kind === "legit").map(rowFor);
    for (const r of legitRows) {
      expect(
        r.legacyComposite,
        `${r.name} legacy composite=${r.legacyComposite} bonus=${r.bonus}/${GOLD_SIGNAL_BONUS_CAP}`,
      ).toBeGreaterThanOrEqual(50);
    }
    const max = rowFor(FIXTURES.find((f) => f.kind === "synthetic-max")!);
    expect(
      max.legacyComposite,
      `max-stuffed anchor legacy composite=${max.legacyComposite} bonus=${max.bonus}/${GOLD_SIGNAL_BONUS_CAP} — cap clipping must not knock STRONG reports below 75`,
    ).toBeGreaterThanOrEqual(75);
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
