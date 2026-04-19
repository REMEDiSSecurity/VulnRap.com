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
    expectMinScore: 55,
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

  it("benchmark summary report (always passes, prints scores)", () => {
    const all = [...SLOP_FIXTURES.map(f => ({ ...f, kind: "slop" as const })), ...LEGIT_FIXTURES.map(f => ({ ...f, kind: "legit" as const }))];
    const rows = all.map(f => {
      const r = analyzeWithEngines(f.text, { claimedCwes: f.claimedCwes });
      return { name: f.name, kind: f.kind, score: r.overallScore, label: r.label, engines: r.engineResults.map(e => `${e.engine}:${e.score}/${e.verdict}`).join(" "), overrides: r.overridesApplied.join(",") };
    });
    // eslint-disable-next-line no-console
    console.log("\n=== VulnRap Engines Benchmark ===");
    for (const row of rows) {
      // eslint-disable-next-line no-console
      console.log(`[${row.kind.padEnd(5)}] ${row.name.padEnd(36)} score=${String(row.score).padStart(3)} label=${row.label.padEnd(15)} ${row.engines}${row.overrides ? " | " + row.overrides : ""}`);
    }
    expect(rows.length).toBe(11);
  });
});
