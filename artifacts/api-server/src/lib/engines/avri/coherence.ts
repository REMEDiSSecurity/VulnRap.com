// Sprint 11 Part 7 — semantic coherence checks for AVRI Engine 3.
// Cheap, regex-driven family-vs-impact / family-vs-reproduction / cvss-vs-family
// consistency checks. Each issue contributes a penalty (capped per check)
// surfaced through Engine 3's signalBreakdown.

import type { FamilyRubric, FamilyId } from "./families";

export interface CoherenceIssue {
  id: string;
  description: string;
  penalty: number;
}

interface CvssVector {
  AV?: string; AC?: string; PR?: string; UI?: string;
  S?: string; C?: string; I?: string; A?: string;
  baseScore?: number;
}

function parseCvss(text: string): CvssVector | null {
  const vec = text.match(/CVSS:?\s*3\.\d\/?([A-Z:\/]+)/i);
  if (!vec) {
    // Try a bare base score like "CVSS 9.8".
    const sc = text.match(/cvss[^0-9]{0,8}(10(?:\.0)?|[0-9](?:\.\d)?)/i);
    return sc ? { baseScore: parseFloat(sc[1]) } : null;
  }
  const fields = vec[1].split("/").reduce<Record<string, string>>((acc, s) => {
    const [k, v] = s.split(":");
    if (k && v) acc[k] = v;
    return acc;
  }, {});
  const score = text.match(/cvss[^0-9]{0,12}(10(?:\.0)?|[0-9](?:\.\d)?)/i);
  return { ...(fields as CvssVector), baseScore: score ? parseFloat(score[1]) : undefined };
}

const IMPACT_PHRASES_PER_FAMILY: Partial<Record<FamilyId, RegExp>> = {
  MEMORY_CORRUPTION: /\b(?:memory\s+corruption|crash|denial\s+of\s+service|remote\s+code\s+execution|info\s*leak|read\s+out[-\s]of[-\s]bounds|arbitrary\s+(?:read|write))\b/i,
  INJECTION: /\b(?:data\s+(?:exfil|exposure)|database\s+access|command\s+execution|rce\b|file\s+(?:read|write)|account\s+takeover)\b/i,
  WEB_CLIENT: /\b(?:cookie\s+theft|session\s+hijack|account\s+takeover|csrf\b|phishing|ui\s+redress|user\s+interaction|stored\s+xss|reflected\s+xss)\b/i,
  AUTHN_AUTHZ: /\b(?:account\s+takeover|privilege\s+escalation|access\s+(?:another|other)\s+user|authorization\s+bypass|authentication\s+bypass|read\s+other\s+user)\b/i,
  CRYPTO: /\b(?:plaintext\s+recovery|key\s+recovery|forge|forgery|signature\s+bypass|downgrade|collision|weak\s+random)\b/i,
  DESERIALIZATION: /\b(?:remote\s+code\s+execution|rce\b|gadget|arbitrary\s+command|reverse\s+shell)\b/i,
  RACE_CONCURRENCY: /\b(?:double[-\s]*spend|double[-\s]*write|inconsistent\s+state|atomicity|race\s+window)\b/i,
  REQUEST_SMUGGLING: /\b(?:cache\s+poisoning|request\s+hijack|auth\s+bypass|session\s+hijack|backend\s+confusion)\b/i,
};

const REPRO_HINTS_PER_FAMILY: Partial<Record<FamilyId, RegExp>> = {
  MEMORY_CORRUPTION: /\b(?:asan|sanitizer|valgrind|coredump|gdb|lldb|sigsegv|backtrace|stack\s+trace|crash)\b/i,
  INJECTION: /\b(?:payload|curl\s|wget\s|http\s+request|sleep\(|union\s+select|;\s*(?:cat|ls|id)|burp\s+suite|sqlmap)\b/i,
  WEB_CLIENT: /\b(?:browser|chrome|firefox|safari|<script|javascript:|alert\(|burp\s+suite|fetch\(|xhr\b)\b/i,
  AUTHN_AUTHZ: /\b(?:account\s+a|account\s+b|user\s+a|user\s+b|alice|bob|two\s+(?:accounts?|sessions?|users?)|swap\s+token)\b/i,
  CRYPTO: /\b(?:test\s+vector|kat|known\s+answer|nonce|iv|encryption\s+key|hash\s+output|sage|python.*hashlib|openssl\s+(?:enc|dgst))\b/i,
  DESERIALIZATION: /\b(?:ysoserial|marshalsec|pickle\.loads?|yaml\.load|payload\.bin|gadget\s+chain)\b/i,
  RACE_CONCURRENCY: /\b(?:two\s+threads|interleav|race\s+window|repeat\s+\d+\s+times|loop\s+\d+|tsan|helgrind)\b/i,
  REQUEST_SMUGGLING: /\b(?:raw\s+http|content-length|transfer-encoding|\bcrlf\b|burp\s+suite|smuggler)\b/i,
};

export function checkCoherence(
  text: string,
  family: FamilyRubric,
): CoherenceIssue[] {
  const issues: CoherenceIssue[] = [];
  if (family.id === "FLAT") return issues;

  // Family-vs-impact: report should describe an impact relevant to this class.
  const impactRe = IMPACT_PHRASES_PER_FAMILY[family.id];
  if (impactRe && !impactRe.test(text)) {
    issues.push({
      id: "FAMILY_VS_IMPACT",
      description: `Report does not describe an impact typical for ${family.displayName} (no relevant impact phrasing).`,
      penalty: 6,
    });
  }

  // Family-vs-reproduction: reproduction section should mention class-specific tooling.
  const reproRe = REPRO_HINTS_PER_FAMILY[family.id];
  if (reproRe && !reproRe.test(text)) {
    issues.push({
      id: "FAMILY_VS_REPRO",
      description: `Reproduction does not mention typical ${family.displayName} tooling/patterns.`,
      penalty: 8,
    });
  }

  // CVSS sanity vs family. Specifically: WEB_CLIENT XSS without UI:R/N + S, or
  // memory-corruption without AV:N/L is unusual.
  const cvss = parseCvss(text);
  if (cvss) {
    if (family.id === "WEB_CLIENT" && cvss.UI && cvss.UI === "N" && /xss|reflected|stored|dom\b/i.test(text)) {
      issues.push({
        id: "CVSS_VS_FAMILY",
        description: "XSS reports almost always require UI:R; report claims UI:N.",
        penalty: 5,
      });
    }
    if (family.id === "MEMORY_CORRUPTION" && cvss.AV && cvss.AV !== "N" && cvss.AV !== "L") {
      issues.push({
        id: "CVSS_VS_FAMILY",
        description: `Memory-corruption with AV:${cvss.AV} is unusual (expected AV:N or AV:L).`,
        penalty: 5,
      });
    }
    if (family.id === "AUTHN_AUTHZ" && cvss.PR === "N" && /privilege|admin|elevated/i.test(text)) {
      issues.push({
        id: "CVSS_VS_FAMILY",
        description: "Privilege-escalation usually requires PR:L (some auth required); report claims PR:N.",
        penalty: 4,
      });
    }
    if (cvss.baseScore != null && cvss.baseScore >= 9.0 && /\b(theoretical|could\s+(?:potentially|possibly)|might\s+(?:be|allow))\b/i.test(text)) {
      issues.push({
        id: "CVSS_VS_LANGUAGE",
        description: `Critical CVSS (${cvss.baseScore.toFixed(1)}) paired with hedged "could potentially / might allow" language.`,
        penalty: 6,
      });
    }
  }

  return issues;
}
