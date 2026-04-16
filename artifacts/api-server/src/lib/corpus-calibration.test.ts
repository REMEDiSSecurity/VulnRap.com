import { describe, it, expect } from "vitest";
import { analyzeLinguistic } from "./linguistic-analysis.js";
import { analyzeFactual } from "./factual-verification.js";
import { analyzeSloppiness } from "./sloppiness.js";
import { fuseScores } from "./score-fusion.js";
import type { LLMSlopResult } from "./llm-slop.js";

function analyzeReport(text: string, llm?: LLMSlopResult | null) {
  const linguistic = analyzeLinguistic(text);
  const factual = analyzeFactual(text);
  const heuristic = analyzeSloppiness(text);
  const fusion = fuseScores(linguistic, factual, llm ?? null, heuristic.qualityScore, text);
  return fusion;
}

function makeFabricatedLlm(): LLMSlopResult {
  return {
    llmSlopScore: 70,
    llmFeedback: [],
    llmBreakdown: {
      claimSpecificity: 5,
      evidenceQuality: 5,
      internalConsistency: 10,
      hallucinationSignals: 5,
      validityScore: 25,
      redFlags: ["PoC does not exercise claimed library"],
      greenFlags: [],
      verdict: "LIKELY_FABRICATED",
    },
    llmRedFlags: [],
    llmTriageGuidance: null,
    llmReproRecipe: null,
    llmClaims: {
      claimedProject: "curl",
      claimedVersion: "8.13.0",
      claimedFiles: ["lib/ws.c"],
      claimedFunctions: ["ws_frame_handshake"],
      claimedLineNumbers: [],
      claimedCVEs: [],
      claimedImpact: "RCE",
      cvssScore: 9.8,
      hasPoC: true,
      pocTargetsClaimedLibrary: false,
      hasAsanOutput: false,
      asanFromClaimedProject: false,
      selfDisclosesAI: false,
      complianceBuzzwords: [],
      complianceRelevance: "none",
    },
    llmSubstance: {
      pocValidity: 10,
      claimSpecificity: 15,
      domainCoherence: 15,
      substanceScore: 13,
      coherenceScore: 20,
    },
  };
}

function makeLegitLlm(): LLMSlopResult {
  return {
    llmSlopScore: 15,
    llmFeedback: [],
    llmBreakdown: {
      claimSpecificity: 22,
      evidenceQuality: 20,
      internalConsistency: 22,
      hallucinationSignals: 20,
      validityScore: 82,
      redFlags: [],
      greenFlags: ["Real PoC", "Valid domain knowledge"],
      verdict: "LIKELY_VALID",
    },
    llmRedFlags: [],
    llmTriageGuidance: null,
    llmReproRecipe: null,
    llmClaims: {
      claimedProject: "curl",
      claimedVersion: "8.11.0",
      claimedFiles: ["lib/urldata.h"],
      claimedFunctions: ["Curl_setopt"],
      claimedLineNumbers: [245],
      claimedCVEs: ["CVE-2024-12345"],
      claimedImpact: "info_disclosure",
      cvssScore: 5.3,
      hasPoC: true,
      pocTargetsClaimedLibrary: true,
      hasAsanOutput: false,
      asanFromClaimedProject: false,
      selfDisclosesAI: false,
      complianceBuzzwords: [],
      complianceRelevance: "none",
    },
    llmSubstance: {
      pocValidity: 85,
      claimSpecificity: 80,
      domainCoherence: 78,
      substanceScore: 81,
      coherenceScore: 85,
    },
  };
}

describe("Corpus calibration: substance axis restructure", () => {
  describe("LLM-enhanced fabricated reports — substance crosses detection threshold (>=60)", () => {
    it("Adversarial curl blog report: hallucinated ws functions + PoC mismatch + domain incoherence", () => {
      const text = `Security Advisory: Critical Buffer Overflow in curl WebSocket Frame Processing
Executive Summary: A critical heap-based buffer overflow vulnerability was identified in curl's WebSocket frame processing logic. The vulnerability exists in the ws_frame_handshake() function, specifically in how WebSocket upgrade responses are parsed.
Technical Analysis: The ws_frame_handshake() function in lib/ws.c does not properly validate the length of the Sec-WebSocket-Accept header value before copying it into a fixed-size stack buffer. The ws_process_frame() function then processes the frame data without adequate bounds checking, leading to heap corruption.
Proof of Concept:
\`\`\`python
import asyncio
import websockets
async def exploit(websocket, path):
    await websocket.send("A" * 65536)
asyncio.get_event_loop().run_until_complete(websockets.serve(exploit, "0.0.0.0", 8765))
\`\`\`
Note: This PoC sets up a malicious WebSocket server. Connect curl with: curl --ws wss://attacker:8765/
CVSS v3.1: 9.8 (AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H)
Affected versions: curl 7.86.0 through 8.13.0`;

      const result = analyzeReport(text, makeFabricatedLlm());
      expect(result.slopScore).toBeGreaterThanOrEqual(60);
      expect(result.breakdown.substanceAxis).toBeGreaterThanOrEqual(60);
      expect(result.slopTier).toMatch(/Likely Slop|Slop/);
    });

    it("HTTP/3 fabricated report: hallucinated h3 functions + future CVEs + PoC mismatch", () => {
      const text = `Vulnerability: Heap Buffer Overflow in curl HTTP/3 Priority Handling
A critical vulnerability exists in the h3_process_priority() function of curl's HTTP/3 implementation.
CVE-2028-1000 has been assigned. CVE-2028-1001 covers the related issue in h3_resolve_deps().
Proof of Concept: curl --http3 https://malicious-server.example.com/exploit
AddressSanitizer output:
==12345== ERROR: AddressSanitizer: heap-buffer-overflow
#0 0x7f0000000000 in h3_process_priority
#1 0x7f0000000000 in h3_resolve_deps
#2 0x7f0000000000 in h3_validate_frame
Impact: Remote code execution. CVSS Score: 9.8 Critical.`;

      const result = analyzeReport(text, makeFabricatedLlm());
      expect(result.slopScore).toBeGreaterThanOrEqual(60);
      expect(result.breakdown.substanceAxis).toBeGreaterThanOrEqual(60);
    });
  });

  describe("Heuristic-only fabrication — substance axis elevates score significantly", () => {
    it("Hallucinated websocket function raises substanceAxis to 35+", () => {
      const text = `Security Advisory: Critical Buffer Overflow in curl WebSocket Frame Processing.
The vulnerability exists in the ws_frame_handshake() function.
The ws_process_frame() function then processes the frame data without adequate bounds checking.
Proof of Concept: import websockets; async def exploit(): await websocket.send("A" * 65536)
CVSS v3.1: 9.8 Affected versions: curl 7.86.0 through 8.13.0`;

      const result = analyzeReport(text);
      expect(result.breakdown.substanceAxis).toBeGreaterThanOrEqual(35);
      expect(result.slopScore).toBeGreaterThan(25);
    });

    it("Multiple heuristic fabrication signals (hallucinated h3 funcs + future CVEs) elevate score", () => {
      const text = `Vulnerability in the h3_process_priority() function.
CVE-2028-1000 and CVE-2028-1001 have been assigned for this issue.
The h3_resolve_deps() function is also affected.
AddressSanitizer: ==12345== ERROR: AddressSanitizer: heap-buffer-overflow
#0 0x7f0000000000 in h3_process_priority
#1 0x7f0000000000 in h3_resolve_deps
#2 0x7f0000000000 in h3_validate_frame
CVSS Score: 9.8`;

      const result = analyzeReport(text);
      expect(result.breakdown.substanceAxis).toBeGreaterThanOrEqual(35);
      expect(result.slopScore).toBeGreaterThanOrEqual(35);
    });
  });

  describe("Legitimate reports — no false positive regression", () => {
    it("Real HackerOne report with valid HTTP request stays clean (heuristic)", () => {
      const text = `Hi there, I found a vulnerability which allows me to close a report as duplicate of another program report.
Steps To Reproduce:
1. Create a Sandbox program
2. Invite a user with Report and Engagement access
3. Check any report and select Close as duplicate
POST /reports/bulk HTTP/2
Host: hackerone.com
Cookie: <USER B Cookies>
message=s&substate=duplicate&original_report_id=TARGET_ID
Impact: Attacker can make public reports appear to have duplicates.`;

      const result = analyzeReport(text);
      expect(result.breakdown.substanceAxis).toBe(0);
      expect(result.slopScore).toBeLessThanOrEqual(30);
    });

    it("Real HackerOne report with valid LLM substance stays clean", () => {
      const text = `Hi there, I found a vulnerability which allows me to close a report as duplicate of another program report.
Steps To Reproduce: POST /reports/bulk HTTP/2 Host: hackerone.com
Impact: Attacker can make public reports appear to have duplicates.`;

      const result = analyzeReport(text, makeLegitLlm());
      expect(result.breakdown.substanceAxis).toBe(0);
      expect(result.slopScore).toBeLessThanOrEqual(30);
    });

    it("Terse expert report with commit SHA stays clean (heuristic)", () => {
      const text = `Found a double-free in Curl_setopt when setting CURLOPT_HTTPHEADER.
Commit a1b2c3d introduced the regression. The issue is in lib/setopt.c:245.
\`\`\`c
CURL *curl = curl_easy_init();
struct curl_slist *headers = curl_slist_append(NULL, "X-Test: 1");
curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
curl_slist_free_all(headers);
curl_easy_cleanup(curl);
\`\`\`
ASan confirms: double-free at lib/setopt.c:245 in Curl_setopt.
Affects 8.11.0+, fixed in master.`;

      const result = analyzeReport(text);
      expect(result.breakdown.substanceAxis).toBe(0);
      expect(result.slopScore).toBeLessThanOrEqual(30);
    });

    it("Terse expert report with valid LLM stays clean", () => {
      const text = `Found a double-free in Curl_setopt when setting CURLOPT_HTTPHEADER. Commit a1b2c3d introduced regression. Issue is in lib/setopt.c:245. Affects 8.11.0+.`;

      const result = analyzeReport(text, makeLegitLlm());
      expect(result.breakdown.substanceAxis).toBe(0);
      expect(result.slopScore).toBeLessThanOrEqual(30);
    });
  });

  describe("Single strong substance signal regression", () => {
    it("Single hallucinated function + LLM PoC mismatch crosses 50", () => {
      const text = `The ws_frame_handshake() function in curl's WebSocket implementation has a buffer overflow.
Proof of Concept: python exploit.py
Impact: Remote code execution.`;

      const llm = makeFabricatedLlm();
      llm.llmSubstance!.domainCoherence = 45;
      const result = analyzeReport(text, llm);
      expect(result.breakdown.substanceAxis).toBeGreaterThanOrEqual(50);
      expect(result.slopScore).toBeGreaterThanOrEqual(50);
    });
  });
});
