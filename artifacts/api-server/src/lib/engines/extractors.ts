// Sprint 9: Deterministic signal extractors shared across the 3 engines.
// All extractors take raw report text and return structured signals.
// Designed to be cheap, side-effect free, and unit-testable.

export interface CodeBlock {
  lang: string | null;
  body: string;
}

export interface ExtractedSignals {
  // Structural
  sectionHeaderCount: number;
  numberedStepSequences: number;
  hasExecutiveSummary: boolean;
  hasFormalSalutation: boolean;
  placeholderUrlCount: number;
  avgSentenceLength: number;
  completenessScore: number; // 0-6
  hasDepthIndicators: boolean;

  // Lexical
  hedgingPhraseCount: number;
  fillerPhraseCount: number;
  vocabularyRichness: number; // type-token ratio
  genericRemediationCount: number;
  overClaimCount: number;
  technicalTermDensity: number;

  // Uniformity
  sentenceLengthCV: number;
  paragraphLengthCV: number;
  burstinessScore: number;

  // Behavioral / evidence
  claimsPoCPresent: boolean;
  codeBlockCount: number;
  codeBlocks: CodeBlock[];
  realUrlCount: number;
  functionCallReferences: number;
  memoryAddressCount: number;
  filePathCount: number;
  inlineCodeReferenceCount: number;
  hasShellPromptIndicators: boolean;
  hasActualCommandOutput: boolean;
  hasRealErrorMessages: boolean;
  hasSpecificMemoryAddresses: boolean;
  variableNamesAreGeneric: boolean;
  codeBlockLanguageSpecificRatio: number; // 0..1

  // References
  lineNumberCount: number;
  specificEndpointCount: number;
  versionMentionCount: number;
  externalCveReferences: number;

  // Reproducibility
  hasStepsToReproduce: boolean;
  hasEnvironmentSpec: boolean;
  hasScreenshotReference: boolean;
  specificVulnerableCodeContext: boolean;
  vulnerabilityReproducibilityScore: number; // 0..1

  // Claims & evidence
  claimCount: number;
  evidenceCount: number;
  claimEvidenceRatio: number;

  // Tokens
  wordCount: number;
  termTokens: string[]; // lowercase tokens for CWE coherence
  claimedCwes: string[];
}

const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "example.net",
  "target.com", "vulnerable-server.com", "vulnerable-app.com",
  "victim.com", "attacker.com", "evil.com", "malicious.com",
  "test.com", "testsite.com", "yoursite.com", "yourapp.com",
  "yourdomain.com", "company.com", "acme.com", "foo.com",
  "bar.com", "webapp.com", "myapp.com", "site.com", "placeholder.com",
]);

const HEDGING_PHRASES = [
  "may", "might", "could potentially", "it is possible that",
  "this could lead to", "potentially allowing", "may allow an attacker",
  "appears to", "seems to",
];

const FILLER_PHRASES = [
  "it is important to note that", "please note that", "importantly",
  "it should be noted", "it is worth mentioning", "as we can see",
  "this is a critical", "this vulnerability could potentially allow",
];

const GENERIC_REMEDIATION = [
  "use strong passwords", "update regularly", "install patches",
  "enable authentication", "use encryption", "apply security updates",
  "validate input", "sanitize data", "implement firewalls",
  "follow best practices", "implement proper", "ensure proper",
  "regularly update", "keep software up to date",
];

const OVER_CLAIM = [
  "will lead to", "can potentially cause", "would allow attackers to",
  "this enables full", "complete compromise", "catastrophic",
  "massive data breach", "total system takeover",
];

const SECTION_HEADER_RE = /^\s{0,3}(?:#{1,6}\s+\S|[A-Z][A-Za-z0-9 \-/]{2,40}:?\s*$)/m;
const HEADER_LINE_RE = /^\s{0,3}(#{1,6}\s+\S.*|[A-Z][A-Za-z0-9 \-/]{2,40}:\s*$|\*\*[^*]{2,40}\*\*\s*:?$)/gm;
const NUMBERED_STEP_RE = /^\s*(?:\d+[.)]|step\s+\d+)\s+\S/gim;

const EXECUTIVE_SUMMARY_RE = /^\s*(?:#{1,6}\s+)?(?:executive\s+summary|tl;dr|abstract|overview)\s*:?\s*$/im;
const SALUTATION_RE = /^\s*(?:dear\s+(?:security|sir|team|maintainers?|developers?)|hello\s+team|hi\s+(?:team|all))[\s,]/im;

const URL_RE = /https?:\/\/[^\s<>)\]"']+/gi;
// File path: looks like /path/to/file.ext or src/foo/bar.cpp:123 or relative
const FILE_PATH_RE = /(?:^|[\s(`'"])((?:[a-zA-Z]:|\.{1,2})?\/?(?:[A-Za-z0-9_.\-]+\/){1,}[A-Za-z0-9_.\-]+\.[a-zA-Z]{1,6})(?=[\s)`'":,]|$)/gm;
const LINE_NUMBER_RE = /(?::|line\s+|L)(\d{1,5})\b/gi;
// Specific endpoint: route-like strings with at least 2 path segments and method or curl/POST/GET context
const ENDPOINT_RE = /(?:GET|POST|PUT|DELETE|PATCH|HEAD)\s+\/[A-Za-z0-9_/\-{}.:?=&]+/g;
const ENDPOINT_RE2 = /\/(?:api|v\d+|rest|graphql|admin|users?|auth|login|logout|callback|oauth|webhook|search)\/[A-Za-z0-9_/\-{}.:?=&]+/g;
const FUNCTION_CALL_RE = /\b([A-Za-z_][A-Za-z0-9_]{2,}(?:::[A-Za-z_][A-Za-z0-9_]*)*)\s*\(/g;
const MEMORY_ADDR_RE = /0x[0-9a-fA-F]{6,16}/g;
const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/gi;
const CWE_RE = /\bCWE-\d{1,4}\b/gi;
const VERSION_RE = /\b\d+\.\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9]+)?\b/g;
const CODE_BLOCK_RE = /```([A-Za-z0-9_+\-]*)\n([\s\S]*?)```/g;
const INLINE_CODE_RE = /`[^`\n]{2,80}`/g;
const SHELL_PROMPT_RE = /(?:^|\n)\s*(?:\$\s|#\s|>\s|>>>\s|PS\s*[A-Z]:[^>]*>\s)/;
const COMMAND_OUTPUT_INDICATORS = /(?:Connection refused|Permission denied|Segmentation fault|Killed|Aborted|undefined reference|HTTP\/[12]\.[01]\s+\d{3}|TypeError|SyntaxError|exit code|exit status)/i;
const REAL_ERROR_RE = /(?:Error|Exception|Fatal|Panic):\s+\S{4,}/;
const SCREENSHOT_RE = /(?:!\[[^\]]*\]\([^)]+\)|screenshot|attached image|see image|see attached|figure\s*\d+)/i;
const STEPS_RE = /(?:steps?\s+to\s+reproduce|reproduction\s+steps|to\s+reproduce|how\s+to\s+reproduce|repro\s+steps?)/i;
const ENV_RE = /(?:environment|os:|operating system|kernel|version:|browser:|node\.?js|python\s+3|ruby|java\s+\d|gcc|clang|ubuntu|debian|alpine|macos|windows|linux)/i;
const POC_RE = /(?:proof\s+of\s+concept|\bpoc\b|exploit\s+code|reproducer|test\s+case|##\s*reproduction|^\s*reproduction\s*$|how\s+to\s+reproduce|repro(?:duction)?\s+steps?)/im;
const CLAIM_RE = /\b(?:this\s+(?:allows|enables|causes|leads\s+to|results\s+in)|allows?\s+an?\s+attacker\s+to|enables?\s+an?\s+attacker\s+to|can\s+(?:lead|result|cause|allow|enable)|will\s+(?:lead|result|cause|allow|enable)|results\s+in\s+(?:a\s+)?(?:critical|complete|full|total))\b/gi;
const GENERIC_VAR_RE = /\b(?:user_input|target_url|attacker_payload|malicious_payload|payload\d*|target_host|victim_url|exploit_payload)\b/g;
const DEPTH_INDICATOR_RE = /(?:offset\s+0x|sizeof\(|strlen\(|memcpy\(|free\(|malloc\(|kmalloc\(|jmp\s+0x|mov\s+%|push\s+%|sysctl|ASAN|MSAN|UBSAN|valgrind|gdb|lldb|stack\s+trace|backtrace|register\s+r[a-z]+|rip\s*=|rsp\s*=)/i;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) n++;
  return n;
}

function getMatches(text: string, re: RegExp): RegExpExecArray[] {
  re.lastIndex = 0;
  const out: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

export function extractSignals(rawText: string, claimedCwesArg?: string[]): ExtractedSignals {
  const text = rawText || "";
  const lower = text.toLowerCase();

  // Sentences (split on terminal punctuation; keep non-empty)
  const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 0);
  const sentenceLengths = sentences.map(s => s.split(/\s+/).filter(Boolean).length).filter(n => n > 0);
  const wordCount = (text.match(/\b\w+\b/g) || []).length;

  const sentMean = sentenceLengths.length > 0
    ? sentenceLengths.reduce((a, b) => a + b, 0) / sentenceLengths.length : 0;
  const sentVar = sentenceLengths.length > 1
    ? sentenceLengths.reduce((a, b) => a + (b - sentMean) ** 2, 0) / sentenceLengths.length : 0;
  const sentSd = Math.sqrt(sentVar);
  const sentenceLengthCV = sentMean > 0 ? sentSd / sentMean : 0.5;

  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
  const paraLens = paragraphs.map(p => p.length);
  const paraMean = paraLens.length > 0 ? paraLens.reduce((a, b) => a + b, 0) / paraLens.length : 0;
  const paraVar = paraLens.length > 1
    ? paraLens.reduce((a, b) => a + (b - paraMean) ** 2, 0) / paraLens.length : 0;
  const paragraphLengthCV = paraMean > 0 ? Math.sqrt(paraVar) / paraMean : 0.5;

  // Structural signals
  const sectionHeaderCount = countMatches(text, HEADER_LINE_RE);
  const numberedStepSequences = countMatches(text, NUMBERED_STEP_RE);
  const hasExecutiveSummary = EXECUTIVE_SUMMARY_RE.test(text);
  const hasFormalSalutation = SALUTATION_RE.test(text);

  // Placeholder URLs
  const urls = getMatches(text, URL_RE).map(m => m[0]);
  let placeholderUrlCount = 0;
  let realUrlCount = 0;
  for (const url of urls) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (PLACEHOLDER_DOMAINS.has(host) || /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|localhost$)/.test(host)) {
        placeholderUrlCount++;
      } else {
        realUrlCount++;
      }
    } catch {
      // Invalid URL — count as placeholder neutral
    }
  }

  // Code blocks
  const codeBlocks: CodeBlock[] = [];
  CODE_BLOCK_RE.lastIndex = 0;
  let cbMatch: RegExpExecArray | null;
  while ((cbMatch = CODE_BLOCK_RE.exec(text)) !== null) {
    codeBlocks.push({ lang: cbMatch[1] || null, body: cbMatch[2] });
  }
  const codeBlockCount = codeBlocks.length;
  const langSpecificCount = codeBlocks.filter(b => b.lang && b.lang.length > 0 && b.lang !== "text").length;
  const codeBlockLanguageSpecificRatio = codeBlockCount > 0 ? langSpecificCount / codeBlockCount : 0;
  const inlineCodeReferenceCount = countMatches(text, INLINE_CODE_RE);

  // Functions, file paths, line numbers, endpoints
  const functionCallReferences = countMatches(text, FUNCTION_CALL_RE);
  const filePathMatches = getMatches(text, FILE_PATH_RE).map(m => m[1]);
  const filePathCount = new Set(filePathMatches).size;
  const lineNumberCount = countMatches(text, LINE_NUMBER_RE);
  const ep1 = countMatches(text, ENDPOINT_RE);
  const ep2 = countMatches(text, ENDPOINT_RE2);
  const specificEndpointCount = ep1 + ep2;
  const memoryAddressCount = countMatches(text, MEMORY_ADDR_RE);

  // Versions, CVEs
  const versionMentionCount = countMatches(text, VERSION_RE);
  const cveMatches = (text.match(CVE_RE) || []);
  const externalCveReferences = new Set(cveMatches.map(s => s.toUpperCase())).size;

  // Lexical
  let hedgingPhraseCount = 0;
  for (const p of HEDGING_PHRASES) {
    hedgingPhraseCount += countMatches(text, new RegExp("\\b" + escapeRe(p) + "\\b", "gi"));
  }
  let fillerPhraseCount = 0;
  for (const p of FILLER_PHRASES) {
    fillerPhraseCount += countMatches(text, new RegExp(escapeRe(p), "gi"));
  }
  let genericRemediationCount = 0;
  for (const p of GENERIC_REMEDIATION) {
    genericRemediationCount += countMatches(text, new RegExp(escapeRe(p), "gi"));
  }
  let overClaimCount = 0;
  for (const p of OVER_CLAIM) {
    overClaimCount += countMatches(text, new RegExp(escapeRe(p), "gi"));
  }

  // Vocabulary richness (TTR over capped sample)
  const tokens = (text.toLowerCase().match(/\b[a-z][a-z0-9_]*\b/g) || []).slice(0, 4000);
  const uniqueTokens = new Set(tokens);
  const vocabularyRichness = tokens.length > 0 ? uniqueTokens.size / tokens.length : 0;

  // Burstiness: stdev of intervals between technical terms
  const techRegexes = [/\bCVE-\d/gi, /\bCWE-\d/gi, /\bRCE\b/g, /\bSQL/gi, /\bXSS\b/gi, /\boverflow\b/gi];
  const positions: number[] = [];
  for (const r of techRegexes) {
    r.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = r.exec(text)) !== null) positions.push(m.index);
  }
  positions.sort((a, b) => a - b);
  let burstinessScore = 0;
  if (positions.length >= 3) {
    const intervals: number[] = [];
    for (let i = 1; i < positions.length; i++) intervals.push(positions[i] - positions[i - 1]);
    const intMean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const intSd = Math.sqrt(intervals.reduce((a, b) => a + (b - intMean) ** 2, 0) / intervals.length);
    burstinessScore = intMean > 0 ? Math.min(100, (intSd / intMean) * 50) : 0;
  }

  // Behavioral
  const claimsPoCPresent = POC_RE.test(text);
  const hasShellPromptIndicators = SHELL_PROMPT_RE.test(text);
  const hasActualCommandOutput = COMMAND_OUTPUT_INDICATORS.test(text);
  const hasRealErrorMessages = REAL_ERROR_RE.test(text);
  const hasSpecificMemoryAddresses = memoryAddressCount > 0
    && /0x[0-9a-fA-F]*[a-fA-F1-9][0-9a-fA-F]*/.test(text);
  const variableNamesAreGeneric = countMatches(text, GENERIC_VAR_RE) >= 2;

  // Reproducibility
  const hasStepsToReproduce = STEPS_RE.test(text) || numberedStepSequences >= 2;
  const hasEnvironmentSpec = ENV_RE.test(text);
  const hasScreenshotReference = SCREENSHOT_RE.test(text);
  const specificVulnerableCodeContext = filePathCount >= 1 && lineNumberCount >= 1;
  const reproSignals = [hasStepsToReproduce, hasEnvironmentSpec, codeBlockCount > 0, specificVulnerableCodeContext, realUrlCount > 0];
  const vulnerabilityReproducibilityScore = reproSignals.filter(Boolean).length / reproSignals.length;

  // Claims & evidence
  const claimCount = countMatches(text, CLAIM_RE);
  const evidenceCount = codeBlockCount + filePathCount + Math.min(lineNumberCount, 20) + realUrlCount + specificEndpointCount + (hasScreenshotReference ? 1 : 0);
  const claimEvidenceRatio = claimCount / (evidenceCount + 1);

  // Completeness (0-6): title-ish, summary, impact, PoC, remediation, references
  const hasTitleish = /^\s*#\s+\S/.test(text) || (sentences[0] && sentences[0].length < 200) ? true : false;
  const hasSummary = /(?:^|\n)\s*(?:#{1,6}\s+)?(?:summary|description|overview|introduction)\b/i.test(text);
  const hasImpact = /(?:^|\n)\s*(?:#{1,6}\s+)?(?:impact|severity|consequence)\b/i.test(text);
  const hasPocSection = /(?:^|\n)\s*(?:#{1,6}\s+)?(?:poc|proof\s+of\s+concept|exploit|reproduction)\b/i.test(text);
  const hasRemediation = /(?:^|\n)\s*(?:#{1,6}\s+)?(?:remediation|mitigation|fix|recommendation)\b/i.test(text);
  const hasReferences = /(?:^|\n)\s*(?:#{1,6}\s+)?(?:references?|see\s+also|links?)\b/i.test(text);
  const completenessScore = [hasTitleish, hasSummary, hasImpact, hasPocSection, hasRemediation, hasReferences].filter(Boolean).length;
  const hasDepthIndicators = DEPTH_INDICATOR_RE.test(text);

  const technicalTermDensity = wordCount > 0
    ? (cveMatches.length + countMatches(text, CWE_RE) + functionCallReferences) / wordCount * 100 : 0;

  // CWE extraction
  const cweRaw = (text.match(CWE_RE) || []).map(s => s.toUpperCase());
  const claimedCwes = claimedCwesArg && claimedCwesArg.length > 0
    ? claimedCwesArg.map(s => s.toUpperCase())
    : Array.from(new Set(cweRaw)).slice(0, 5);

  return {
    sectionHeaderCount,
    numberedStepSequences,
    hasExecutiveSummary,
    hasFormalSalutation,
    placeholderUrlCount,
    avgSentenceLength: sentMean,
    completenessScore,
    hasDepthIndicators,

    hedgingPhraseCount,
    fillerPhraseCount,
    vocabularyRichness,
    genericRemediationCount,
    overClaimCount,
    technicalTermDensity,

    sentenceLengthCV,
    paragraphLengthCV,
    burstinessScore,

    claimsPoCPresent,
    codeBlockCount,
    codeBlocks,
    realUrlCount,
    functionCallReferences,
    memoryAddressCount,
    filePathCount,
    inlineCodeReferenceCount,
    hasShellPromptIndicators,
    hasActualCommandOutput,
    hasRealErrorMessages,
    hasSpecificMemoryAddresses,
    variableNamesAreGeneric,
    codeBlockLanguageSpecificRatio,

    lineNumberCount,
    specificEndpointCount,
    versionMentionCount,
    externalCveReferences,

    hasStepsToReproduce,
    hasEnvironmentSpec,
    hasScreenshotReference,
    specificVulnerableCodeContext,
    vulnerabilityReproducibilityScore,

    claimCount,
    evidenceCount,
    claimEvidenceRatio,

    wordCount,
    termTokens: tokens,
    claimedCwes,
  };
}
