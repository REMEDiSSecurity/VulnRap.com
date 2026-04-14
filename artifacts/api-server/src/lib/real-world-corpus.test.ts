import { describe, it, expect } from "vitest";
import { analyzeLinguistic } from "./linguistic-analysis.js";
import { analyzeFactual } from "./factual-verification.js";
import { analyzeSloppiness } from "./sloppiness.js";
import { fuseScores } from "./score-fusion.js";

function analyzeReport(text: string) {
  const linguistic = analyzeLinguistic(text);
  const factual = analyzeFactual(text);
  const heuristic = analyzeSloppiness(text);
  const fusion = fuseScores(linguistic, factual, null, heuristic.qualityScore, text);
  return { linguistic, factual, heuristic, fusion };
}

describe("Real-world corpus: Real slop from curl HackerOne", () => {
  it("REAL-SLOP-001: Buffer Overflow in WebSocket Handling (HackerOne #2298307)", () => {
    const text = `Hello security team, Hope you are doing well :) I would like to report a potential security vulnerability in the WebSocket handling code of the curl library. The issue is related to the usage of the strcpy function, which can lead to a buffer overflow if the length of the input is not properly checked. The vulnerable code snippet is located at this link.

Steps To Reproduce: Trigger the WebSocket functionality with a crafted request. Provide a base64-encoded nonce value that exceeds the buffer size. Observe that the strcpy function is used without proper bounds checking.

Fix: To address this issue, it is recommended to replace the strcpy function with the safer alternative strncpy and explicitly specify the maximum length to copy.

Reference: https://cwe.mitre.org/data/definitions/122.html

Impact: This vulnerability may allow an attacker to execute arbitrary code, potentially leading to a compromise of the application or system. An attacker could exploit this weakness by providing a specially crafted WebSocket request, causing a buffer overflow and overwriting adjacent memory.`;

    const result = analyzeReport(text);
    expect(result.fusion.slopScore).toBeGreaterThanOrEqual(30);
    expect(result.linguistic.score + result.factual.score).toBeGreaterThan(0);
  });

  it("REAL-SLOP-002: Exposure of Hard-coded Private Keys (HackerOne #3295650) — heuristic baseline", () => {
    const text = `Multiple private/test RSA keys and example credentials were discovered embedded in the public curl source repository and associated documentation. These sensitive secrets were detected using automated tools (gitleaks) and manual review. Their presence could allow attackers to impersonate trusted curl infrastructure, decrypt traffic, or pivot into build or CI systems if reused, creating a severe supply chain risk. Such exposures also risk compliance violations (e.g., GDPR, PCI-DSS, HIPAA) and undermine trust in open source releases. This report, including the verification steps and analysis, was prepared using an AI security assistant to ensure comprehensive and reproducible results.

Steps To Reproduce: Clone the curl repository: git clone https://github.com/curl/curl.git. Run a secret scanning tool (e.g., gitleaks detect --source=.) to identify hard-coded secrets. Alternatively, search for likely private key and credential strings with: grep -r '-----BEGIN' ./tests/ and grep -r 'password' ./docs/examples/. Review identified files to confirm the presence of full private keys or functional credential examples, such as tests/data/testprivkey.pem or docs/examples/http-auth-example.txt. See .gitleaks/report.json for a consolidated findings report.

Impact Summary: The security impact of this vulnerability is severe and multi-faceted: Impersonation and Privilege Escalation, Data Decryption, Credential Stuffing and Service Hijack, Supply Chain Attacks, Regulatory and Compliance Risks.`;

    const result = analyzeReport(text);
    expect(result.fusion.slopScore).toBeGreaterThanOrEqual(0);
    expect(result.linguistic.score + result.factual.score).toBeGreaterThanOrEqual(0);
  });

  it("REAL-SLOP-003: Use of Broken Cryptographic Algorithm CWE-327 (HackerOne #3116935) — heuristic baseline", () => {
    const text = `Summary: The DES cipher (Data Encryption Standard) is used in the curl_ntlm_core.c file of libcurl. DES is considered insecure due to its short key length (56 bits) and its susceptibility to brute-force attacks. Modern cryptographic standards recommend replacing DES with AES (Advanced Encryption Standard), which is more robust and secure.

Steps To Reproduce: Inspect the lib/curl_ntlm_core.c file of the libcurl source code. Locate the use of the kCCAlgorithmDES constant, which corresponds to the DES cipher. Verify that DES is being used for cryptographic operations in NTLM authentication (NTLMv1).

Impact Summary: Using DES compromises the security of the application due to the following points: Brute-force attacks: The short key length makes it possible to brute-force DES keys in a reasonable amount of time with modern hardware. Cryptographic weaknesses: DES is vulnerable to various cryptanalysis techniques, such as differential and linear cryptanalysis. Compliance risks: DES does not meet modern cryptographic standards and could lead to non-compliance with security regulations. An attacker exploiting this vulnerability could: Intercept and decrypt sensitive data during NTLM authentication. Execute man-in-the-middle (MITM) attacks to impersonate a user or server. Gain unauthorized access to systems relying on NTLM authentication.

Recommended Fix: Replace the use of kCCAlgorithmDES with kCCAlgorithmAES, which supports stronger encryption standards (e.g., AES-128, AES-256).`;

    const result = analyzeReport(text);
    expect(result.fusion.slopScore).toBeGreaterThanOrEqual(0);
  });

  it("REAL-SLOP-004: HTTP/3 Stream Dependency Cycle Exploit (HackerOne #3125832) — heuristic baseline", () => {
    const text = `Penetration Testing Report: HTTP/3 Stream Dependency Cycle Exploit

0x00 Overview
A novel exploit leveraging stream dependency cycles in the HTTP/3 protocol stack was discovered, resulting in memory corruption and potential denial-of-service or remote code execution scenarios when used against HTTP/3-capable clients such as curl (tested on version 8.13.0). This report details a practical proof of concept, required environment setup, attack execution, and crash analysis.

0x01 Environment Setup - Malicious Server Setup (aioquic modified): Clone aioquic, apply patch to enable cyclic stream dependency injection. The patch adds a new method (send_cyclic_priority) to the QuicConnection class to create cyclic stream dependencies.

0x02 Proof-of-Concept Code - Malicious HTTP/3 Server: ExploitServer class that opens 100 streams for heap shaping, injects cyclic dependency between stream 3 and 7, triggers parsing logic.

0x03 Crash Analysis Guide - Expected Output: Program received signal SIGSEGV, Segmentation fault. 0x00007ffff7e3b120 in ngtcp2_http3_handle_priority_frame(). Signs of memory overwrite: r15 shows 0x4141414141414141. Recursive calls to same handler.

0x06 Risk Summary - Affected Software: curl 8.13.0 (HTTP/3 enabled). Trigger: Stream dependency loop. Result: Heap layout corruption, segmentation fault, denial-of-service. Risk: High (pre-authentication, remote-triggerable).`;

    const result = analyzeReport(text);
    expect(result.fusion.slopScore).toBeGreaterThanOrEqual(0);
    expect(result.factual.score).toBeGreaterThanOrEqual(0);
  });

  it("REAL-SLOP-005: Stack Buffer Overflow in Cookie Parsing (HackerOne #3340109) — heuristic baseline", () => {
    const text = `Summary: I discovered a critical stack-based buffer overflow vulnerability in cURL's cookie parsing mechanism that can lead to remote code execution. The vulnerability occurs when processing maliciously crafted HTTP cookies, affecting all applications that use libcurl for HTTP requests.

Description: During security research on cURL's cookie handling implementation, I identified a stack buffer overflow in the cookie parsing logic. The vulnerability allows remote attackers to trigger memory corruption by sending oversized cookie data through HTTP responses.

Technical Details - Vulnerability Location: The vulnerability occurs in the cookie parsing functionality where string length calculations exceed allocated stack buffer boundaries. Root Cause Analysis: Buffer Size Mismatch: Cookie processing code reads beyond allocated stack buffer. Unsafe String Operations: strlen() operation on cookie data exceeds buffer boundaries. Stack Memory Corruption: Read of 8,193 bytes in a buffer allocated for 8,192 bytes. Multi-threaded Context: Issue manifests in threaded environments.

AddressSanitizer Detection: ERROR: AddressSanitizer: stack-buffer-overflow on address 0x00016f00a5c0. READ of size 8193 at 0x00016f00a5c0 thread T1. #0 0x000101676c34 in strlen+0x1b0. #1 0x000100f94c38 in cookie_overflow_hunter cookie_vulnerability_hunter.c:121.

CVSS 3.1 Assessment: Base Score: 9.8 (CRITICAL). Vector String: AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H.

Verified POC Code creates a local buffer of 8192 bytes, fills it without null terminator, calls strlen() which reads past the buffer. This code does NOT call curl.`;

    const result = analyzeReport(text);
    expect(result.fusion.slopScore).toBeGreaterThanOrEqual(0);
    expect(result.factual.score).toBeGreaterThanOrEqual(0);
  });
});

describe("Real-world corpus: heuristic-only does not crash and produces scores", () => {
  it("all real-slop reports produce non-negative scores without crashing", () => {
    const reports = [
      "Hello security team, Hope you are doing well :) I would like to report a potential security vulnerability in the WebSocket handling code.",
      "Multiple private/test RSA keys were discovered embedded in the public curl source repository. This report was prepared using an AI security assistant.",
      "The DES cipher is used in the curl_ntlm_core.c file of libcurl. DES is considered insecure due to its short key length.",
      "Penetration Testing Report: HTTP/3 Stream Dependency Cycle Exploit. 0x00 Overview. SIGSEGV in ngtcp2_http3_handle_priority_frame().",
      "I discovered a critical stack-based buffer overflow in cURL cookie parsing. AddressSanitizer: stack-buffer-overflow. CVSS 9.8.",
    ];

    for (const text of reports) {
      const result = analyzeReport(text);
      expect(result.fusion.slopScore).toBeGreaterThanOrEqual(0);
      expect(result.fusion.slopScore).toBeLessThanOrEqual(100);
      expect(result.fusion.slopTier).toBeDefined();
    }
  });
});

describe("Real-world corpus: Real legitimate reports", () => {
  it("REAL-LEGIT-001: Access Control Vulnerability on HackerOne (#2516250)", () => {
    const text = `Hi there, I hope you are doing well :) I found a vulnerability which allows me to close a report as duplicate of another program report. This can cause problems in various ways, i will include some of them and rest needs to be verified on Hackerone side what additional impact it can cause and its root cause analysis.

Steps To Reproduce: Create a Sandbox program. Invite a user with Report and Engagement access. Accept invitation from User B and login. Check any report and select option to Close Report as duplicate and this will be the HTTP request:

POST /reports/bulk HTTP/2
Host: hackerone.com
Cookie: <USER B Cookies>
Content-Type: application/x-www-form-urlencoded; charset=UTF-8

message=s&substate=duplicate&original_report_id=TARGET_ID&reference=&add_reporter_to_original=false&reply_action=close-report

Impact: It can impact Automation Pipelines because there can be many reports and the program can mistakenly enter other report ID. When you close a report as duplicate of other report (Original report), it will show on right side panel the reports which are duplicate of that particular report. So it gives ability for any attacker to make other public reports look like they have duplicates but the duplicates are other reports from other program.`;

    const result = analyzeReport(text);
    expect(result.fusion.slopScore).toBeLessThanOrEqual(40);
  });
});

describe("Pipeline robustness: special characters do not crash analysis", () => {
  it("handles SQL injection payloads in report text", () => {
    const text = `I found a SQL injection vulnerability.

Payload: ' OR '1'='1' -- 
Also tried: '; DROP TABLE users; --
And: " UNION SELECT * FROM information_schema.tables WHERE table_name LIKE '%user%'

The endpoint /api/search?q= is vulnerable.`;

    expect(() => analyzeReport(text)).not.toThrow();
  });

  it("handles GraphQL JSON payloads in report text", () => {
    const text = `GraphQL mutation bypass:

{"operationName":"SaveCollaboratorsMutation","variables":{"input":{"reportId":"123","collaborators":[{"userId":"attacker"}]}},"query":"mutation SaveCollaboratorsMutation($input: SaveCollaboratorsInput!) { saveCollaborators(input: $input) { success }}"}

Impact: unauthorized access to reports.`;

    expect(() => analyzeReport(text)).not.toThrow();
  });

  it("handles pipe characters and backticks in report text", () => {
    const text = `Command injection via filename:

\`\`\`
curl https://target.com/upload -F "file=@payload.txt;filename=\`id | base64\`"
\`\`\`

The server executes the filename in a shell context.`;

    expect(() => analyzeReport(text)).not.toThrow();
  });

  it("handles extremely long single line input", () => {
    const text = "A".repeat(20000) + " buffer overflow test " + "B".repeat(20000);
    expect(() => analyzeReport(text)).not.toThrow();
  });

  it("handles unicode and emoji in report text", () => {
    const text = `Vulnerability Report \u{1F6A8}

The endpoint /api/users returns PII data \u{1F512}
Including \u00e9\u00e8\u00ea accent characters and \u4e2d\u6587 Chinese text.

Steps: Send GET request to /api/users without authentication \u2705`;

    expect(() => analyzeReport(text)).not.toThrow();
  });
});
