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
  };
}

export function classifyReport(
  text: string,
  claimedCwes: string[] | undefined,
): ClassificationResult {
  const technology = detectTechnology(text);
  const byCwe = classifyByCwe(claimedCwes);
  if (byCwe) return { ...byCwe, technology };
  const byType = classifyByVulnType(text);
  if (byType) return { ...byType, technology };
  const byKw = classifyByKeywords(text);
  if (byKw) return { ...byKw, technology };
  return {
    family: FLAT_FAMILY,
    confidence: "LOW",
    reason: "No CWE / vulnerability-type / keyword evidence — falling back to generic rubric.",
    evidence: [],
    technology,
  };
}
