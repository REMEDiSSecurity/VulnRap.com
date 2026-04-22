// Engine 0 — Classification.
// Decides which rubric family a report belongs to, using (in order):
//   1. Claimed CWE → direct family lookup, then parent-chain walk
//   2. Detected vulnerability type from the existing extractors
//   3. Family-specific keyword fallback over the report text
// If none match with sufficient confidence, returns FLAT.

import { detectVulnerabilityType } from "../extractors";
import { FAMILIES, FLAT_FAMILY, familyForCweNumber, type FamilyId, type FamilyRubric } from "./families";
import { ancestorsOf, normalizeCweId } from "./hierarchy";

export type ClassificationConfidence = "HIGH" | "MEDIUM" | "LOW";

export interface ClassificationResult {
  family: FamilyRubric;
  confidence: ClassificationConfidence;
  reason: string;
  /** All keyword/CWE evidence that contributed to the classification. */
  evidence: string[];
  /** When CWE-based, the parent-chain that landed us in this family. */
  parentChain?: string[];
  /** Detected technology/language context (informational). */
  technology: string | null;
  /** The first claimed/cited CWE id (numeric string), or null if none cited. */
  cweId: string | null;
  /** The family that the cited CWE maps to (may differ from `family` when off-topic). */
  citedFamily: FamilyId | null;
  /**
   * Family inferred from the report's *content* (vulnerability-type detector,
   * then keyword fallback) — independent of the cited CWE. When the cited CWE
   * family disagrees with this evidence family, Engine 3 applies the spec
   * Part 4 off-family ceiling. Null when neither extractor nor keywords match.
   */
  evidenceFamily: FamilyId | null;
  /** Confidence of the evidence-based family inference (HIGH/MEDIUM/LOW). */
  evidenceConfidence: ClassificationConfidence | null;
}

const TECH_PATTERNS: Array<{ tech: string; pattern: RegExp }> = [
  { tech: "python", pattern: /\b(?:python|django|flask|fastapi|\.py\b|pip\s+install|venv|requirements\.txt)\b/i },
  { tech: "node", pattern: /\b(?:node\.?js|npm\s|yarn\s|express|nestjs|next\.?js|package\.json|\.js\b|\.ts\b)\b/i },
  { tech: "go", pattern: /\b(?:golang|\bgo\s+(?:run|build|test|mod)\b|go\.mod|\.go\b)\b/i },
  { tech: "rust", pattern: /\b(?:rust|cargo|crates?\.io|\.rs\b)\b/i },
  { tech: "java", pattern: /\b(?:java|spring(?:\s|\.boot)|jvm|jar|maven|gradle|\.java\b|servlet|tomcat|jetty)\b/i },
  { tech: "ruby", pattern: /\b(?:ruby|rails|rack|sinatra|gemfile|\.rb\b)\b/i },
  { tech: "php", pattern: /\b(?:php|laravel|symfony|composer|wordpress|drupal|\.php\b)\b/i },
  { tech: "c_cpp", pattern: /\b(?:libcurl|openssl|nginx\b|kernel|\.c\b|\.cpp\b|\.cc\b|\.h\b|gcc\b|clang\b)\b/i },
  { tech: "kotlin_swift", pattern: /\b(?:kotlin|swift|xcode|android sdk|\.kt\b|\.swift\b)\b/i },
];

function detectTechnology(text: string): string | null {
  const hits: Array<{ tech: string; count: number }> = [];
  for (const { tech, pattern } of TECH_PATTERNS) {
    const matches = text.match(new RegExp(pattern, "g"));
    if (matches && matches.length >= 1) hits.push({ tech, count: matches.length });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.count - a.count);
  return hits[0].tech;
}

interface FallbackKeywords {
  family: FamilyId;
  keywords: RegExp[];
  /** Each match contributes 1 to the family score; family wins if score ≥ minScore. */
  minScore: number;
}

const FALLBACK_KEYWORDS: FallbackKeywords[] = [
  {
    family: "MEMORY_CORRUPTION",
    minScore: 2,
    keywords: [
      /\b(buffer|heap|stack)[-\s]*(?:overflow|underflow|over[-\s]*read|under[-\s]*read)\b/i,
      /\buse[-\s]*after[-\s]*free\b/i,
      /\bdouble[-\s]*free\b/i,
      /\bnull[-\s]*pointer\s+(?:dereference|deref)\b/i,
      /\bsegmentation\s+fault|sigsegv|sigabrt|core\s+dumped\b/i,
      /addresssanitizer|memorysanitizer|valgrind/i,
      /\bmemcpy\(|strcpy\(|sprintf\(|gets\(/i,
    ],
  },
  {
    family: "INJECTION",
    minScore: 2,
    keywords: [
      /\bsql\s+injection|sqli\b/i,
      /\bcommand\s+injection|os\s+command|os\.system|child_process\.exec/i,
      /\bldap\s+injection|nosql\s+injection|xpath\s+injection/i,
      /\bunion\s+select|or\s+1\s*=\s*1|;\s*drop\s+table/i,
      /\$\{jndi:|log4shell|log4j/i,
    ],
  },
  {
    family: "WEB_CLIENT",
    minScore: 2,
    keywords: [
      /\bcross[-\s]*site\s+scripting|\bxss\b|stored\s+xss|reflected\s+xss|dom[-\s]*based\s+xss/i,
      /\bcross[-\s]*site\s+request\s+forgery|\bcsrf\b/i,
      /\bclickjacking|x-frame-options/i,
      /\bopen\s+redirect|unvalidated\s+redirect/i,
      /<script|javascript:|onerror=|onload=|document\.cookie/i,
    ],
  },
  {
    family: "AUTHN_AUTHZ",
    minScore: 2,
    keywords: [
      /\bidor\b|insecure\s+direct\s+object\s+reference/i,
      /\bbroken\s+access\s+control|missing\s+authorization|authorization\s+bypass/i,
      /\bauthentication\s+bypass|authn\s+bypass/i,
      /\bprivilege\s+escalation|privesc/i,
      /\bjwt\b|bearer\s+token|sessionid|set-cookie/i,
    ],
  },
  {
    family: "CRYPTO",
    minScore: 2,
    keywords: [
      /\bweak\s+(?:hash|cipher|encryption|crypto|prng|random)/i,
      /\bhardcoded\s+(?:key|secret|credential)/i,
      /\bstatic\s+(?:iv|nonce|salt)|reused\s+(?:iv|nonce)/i,
      /\bmd5\b|\bsha-?1\b|\brc4\b|\bdes\b|\becb\s+mode\b/i,
      /\btls\s*1\.[01]|\bssl\s*v?[23]\b/i,
    ],
  },
  {
    family: "DESERIALIZATION",
    minScore: 2,
    keywords: [
      /\bdeserialization|unsafe\s+deserialize|object\s+injection/i,
      /\bysoserial|marshalsec|pickle\.loads?\(|yaml\.(?:unsafe_)?load\(/i,
      /\bobjectinputstream|readobject\(|fastjson|jackson(?:databind)?/i,
      /\bnode-serialize|funcster\b/i,
    ],
  },
  {
    family: "RACE_CONCURRENCY",
    minScore: 2,
    keywords: [
      /\brace\s*condition\b|toctou\b|time[-\s]*of[-\s]*check[-\s]*time[-\s]*of[-\s]*use\b/i,
      /\bdouble[-\s]*spend|atomicity\s+violation/i,
      /\bdata\s+race|threadsanitizer|tsan\b|helgrind/i,
      /\bmutex|lock\s+contention|spinlock/i,
    ],
  },
  {
    family: "REQUEST_SMUGGLING",
    minScore: 1,
    keywords: [
      /\brequest\s+smuggling|http\s+smuggling|http\s+desync/i,
      /\bte\.cl\b|\bcl\.te\b|\btransfer-encoding.*content-length\b/i,
      /\bpipelined\s+request|smuggled\s+request|prefix\s+attack/i,
      /\bconnection\s+pool\s+poisoning|cache\s+poisoning/i,
    ],
  },
];

/** Walk the cited CWEs and return the first one that maps to any rubric family,
 * along with that family. Used so engine 3 can apply same-family vs off-family
 * scoring even when the *detected* family (via keywords/extractors) differs. */
function citedCweFamily(claimedCwes: string[] | undefined): { cweId: string | null; family: FamilyId | null } {
  if (!claimedCwes || claimedCwes.length === 0) return { cweId: null, family: null };
  for (const raw of claimedCwes) {
    const id = normalizeCweId(raw);
    if (!id) continue;
    const direct = familyForCweNumber(id);
    if (direct) return { cweId: id, family: direct };
    for (const ancestor of ancestorsOf(id)) {
      const famId = familyForCweNumber(ancestor);
      if (famId) return { cweId: id, family: famId };
    }
    return { cweId: id, family: null };
  }
  return { cweId: null, family: null };
}

function classifyByCwe(claimedCwes: string[] | undefined): ClassificationResult | null {
  if (!claimedCwes || claimedCwes.length === 0) return null;
  for (const raw of claimedCwes) {
    const id = normalizeCweId(raw);
    if (!id) continue;
    const direct = familyForCweNumber(id);
    if (direct) {
      const fam = FAMILIES.find((f) => f.id === direct)!;
      return {
        family: fam,
        confidence: "HIGH",
        reason: `Claimed CWE-${id} is a member of ${fam.displayName}.`,
        evidence: [`CWE-${id}`],
        parentChain: [id],
        technology: null,
        cweId: id,
        citedFamily: direct,
        evidenceFamily: null,
        evidenceConfidence: null,
      };
    }
    // Walk ancestors.
    const chain = ancestorsOf(id);
    for (const ancestor of chain) {
      const famId = familyForCweNumber(ancestor);
      if (famId) {
        const fam = FAMILIES.find((f) => f.id === famId)!;
        return {
          family: fam,
          confidence: "MEDIUM",
          reason: `Claimed CWE-${id} maps to ${fam.displayName} via ancestor CWE-${ancestor}.`,
          evidence: [`CWE-${id}`, `→ CWE-${ancestor}`],
          parentChain: chain,
          technology: null,
          cweId: id,
          citedFamily: famId,
          evidenceFamily: null,
          evidenceConfidence: null,
        };
      }
    }
  }
  return null;
}

function classifyByVulnType(text: string): ClassificationResult | null {
  const t = detectVulnerabilityType(text);
  if (!t) return null;
  const map: Record<string, FamilyId | undefined> = {
    "XSS": "WEB_CLIENT",
    "SQL Injection": "INJECTION",
    "Command Injection": "INJECTION",
    "Path Traversal": "WEB_CLIENT",
    "SSRF": "WEB_CLIENT",
    "CSRF": "WEB_CLIENT",
    "Open Redirect": "WEB_CLIENT",
    "IDOR": "AUTHN_AUTHZ",
    "Authentication Bypass": "AUTHN_AUTHZ",
    "Authorization": "AUTHN_AUTHZ",
    "Buffer Overflow": "MEMORY_CORRUPTION",
    "Use After Free": "MEMORY_CORRUPTION",
    "Memory Corruption": "MEMORY_CORRUPTION",
    "Deserialization": "DESERIALIZATION",
    "Cryptographic": "CRYPTO",
    "Race Condition": "RACE_CONCURRENCY",
    "Request Smuggling": "REQUEST_SMUGGLING",
  };
  const famId = map[t];
  if (!famId) return null;
  const fam = FAMILIES.find((f) => f.id === famId)!;
  return {
    family: fam,
    confidence: "MEDIUM",
    reason: `Vulnerability type detector matched "${t}" → ${fam.displayName}.`,
    evidence: [`vuln-type:${t}`],
    technology: null,
    cweId: null,
    citedFamily: null,
    evidenceFamily: null,
    evidenceConfidence: null,
  };
}

function classifyByKeywords(text: string): ClassificationResult | null {
  const lowered = text.toLowerCase();
  let best: { fam: FamilyRubric; score: number; matches: string[] } | null = null;
  for (const fk of FALLBACK_KEYWORDS) {
    const matches: string[] = [];
    for (const re of fk.keywords) {
      const m = lowered.match(re);
      if (m) matches.push(m[0]);
    }
    if (matches.length >= fk.minScore) {
      const fam = FAMILIES.find((f) => f.id === fk.family)!;
      if (!best || matches.length > best.score) {
        best = { fam, score: matches.length, matches };
      }
    }
  }
  if (!best) return null;
  return {
    family: best.fam,
    confidence: best.score >= 3 ? "MEDIUM" : "LOW",
    reason: `Keyword fallback matched ${best.score} ${best.fam.displayName} terms.`,
    evidence: best.matches.slice(0, 6),
    technology: null,
    cweId: null,
    citedFamily: null,
    evidenceFamily: null,
    evidenceConfidence: null,
  };
}

/** Independent of cited CWEs: returns the family inferred purely from report
 * content (vulnerability-type detector first, then keyword fallback). Used by
 * Engine 3 so the off-family ceiling can fire when the cited CWE belongs to a
 * different family than the actual content. */
function classifyByEvidenceOnly(text: string): { family: FamilyId; confidence: ClassificationConfidence } | null {
  const byType = classifyByVulnType(text);
  if (byType) return { family: byType.family.id, confidence: byType.confidence };
  const byKw = classifyByKeywords(text);
  if (byKw) return { family: byKw.family.id, confidence: byKw.confidence };
  return null;
}

export function classifyReport(
  text: string,
  claimedCwes: string[] | undefined,
): ClassificationResult {
  const technology = detectTechnology(text);
  // Always compute the cited-CWE family up front so off-family detection works
  // even when the *selected* family came from the cited CWE itself.
  const cited = citedCweFamily(claimedCwes);
  const evidence = classifyByEvidenceOnly(text);
  const evidenceFamily = evidence?.family ?? null;
  const evidenceConfidence = evidence?.confidence ?? null;

  const byCwe = classifyByCwe(claimedCwes);
  if (byCwe) return { ...byCwe, technology, evidenceFamily, evidenceConfidence };
  const byType = classifyByVulnType(text);
  if (byType) return { ...byType, technology, cweId: cited.cweId, citedFamily: cited.family, evidenceFamily, evidenceConfidence };
  const byKw = classifyByKeywords(text);
  if (byKw) return { ...byKw, technology, cweId: cited.cweId, citedFamily: cited.family, evidenceFamily, evidenceConfidence };
  return {
    family: FLAT_FAMILY,
    confidence: "LOW",
    reason: "No CWE / vulnerability-type / keyword evidence — falling back to generic rubric.",
    evidence: [],
    technology,
    cweId: cited.cweId,
    citedFamily: cited.family,
    evidenceFamily,
    evidenceConfidence,
  };
}
