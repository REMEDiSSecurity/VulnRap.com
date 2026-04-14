export interface EvidenceQualityMarker {
  type: string;
  description: string;
  weight: number;
}

export interface EvidenceQualityResult {
  score: number;
  markers: EvidenceQualityMarker[];
}

export function computeEvidenceQuality(text: string): EvidenceQualityResult {
  let score = 0;
  const markers: EvidenceQualityMarker[] = [];

  const hasFullHTTP = /^(GET|POST|PUT|DELETE|PATCH)\s+\/\S+\s+HTTP\/[\d.]+/m.test(text);
  if (hasFullHTTP) {
    score += 20;
    markers.push({ type: "full_http_request", description: "Complete HTTP request with method and path", weight: -10 });
  } else if (/(?:Host|Cookie|Authorization|Content-Type):\s+\S/i.test(text)) {
    score += 10;
    markers.push({ type: "http_headers", description: "HTTP headers present", weight: -5 });
  }

  const curlCommands = text.match(/curl\s+(?:-[A-Za-z]+\s+)*['"]?https?:\/\/\S+/g) || [];
  if (curlCommands.length > 0) {
    score += 15;
    markers.push({ type: "curl_command", description: `${curlCommands.length} curl command(s) included`, weight: -8 });
  }

  const hasRealCode = /^(?:import\s+|from\s+\S+\s+import|require\s*\(|#include\s*[<"]|using\s+)/m.test(text);
  if (hasRealCode) {
    score += 15;
    markers.push({ type: "structured_code", description: "Code with imports/includes — appears executable", weight: -8 });
  }

  const hasDiff = /^[+-]{3}\s+[ab]\//m.test(text) || /^@@\s+-\d+,?\d*\s+\+\d+/m.test(text);
  if (hasDiff) {
    score += 20;
    markers.push({ type: "patch_format", description: "Diff/patch included — demonstrates root cause understanding", weight: -12 });
  }

  const stackFrames = text.match(/#\d+\s+0x[0-9a-f]+\s+in\s+\S+/gi) || [];
  const pyTracebacks = text.match(/File\s+"[^"]+",\s+line\s+\d+/g) || [];
  if (stackFrames.length >= 3 || pyTracebacks.length >= 2) {
    score += 12;
    markers.push({ type: "stack_trace", description: "Stack trace included", weight: -6 });
  }

  const commandOutputPairs = text.match(/^\$\s+.+\n(?!\$).+/gm) || [];
  if (commandOutputPairs.length > 0) {
    score += 10;
    markers.push({ type: "command_output", description: `${commandOutputPairs.length} command/output pair(s)`, weight: -5 });
  }

  const evidenceURLs = text.match(/https?:\/\/(?:github\.com|gitlab\.com|hackerone\.com|bugcrowd\.com|nvd\.nist\.gov|cve\.org|curl\.se\/docs)\S+/gi) || [];
  if (evidenceURLs.length > 0) {
    score += 12;
    markers.push({ type: "evidence_urls", description: `${evidenceURLs.length} external evidence URL(s)`, weight: -6 });
  }

  const namedResearcher = /(?:(?:Credit|Report(?:ed)?|Found|Discover(?:ed)?)\s+by|Author)[:\s]+([A-Z][a-z]+\s+[A-Z][a-z]+)/i.test(text);
  const genericResearcher = /(?:Credit|Report(?:ed)?)\s+(?:by)?[:\s]+Security\s+Researcher/i.test(text);
  if (namedResearcher && !genericResearcher) {
    score += 8;
    markers.push({ type: "named_researcher", description: "Attributed to a named researcher", weight: -4 });
  } else if (genericResearcher) {
    score -= 5;
    markers.push({ type: "generic_researcher", description: 'Attributed to generic "Security Researcher" — no real identity', weight: 3 });
  }

  const hasStepsSection = /steps?\s+to\s+reproduce|how\s+to\s+reproduce/i.test(text);
  const hasCommandSteps = /^\s*(?:\$|>|curl|wget|python|node|npm|docker|git)\s+/m.test(text);
  if (hasStepsSection && !hasCommandSteps && curlCommands.length === 0) {
    score -= 10;
    markers.push({ type: "prose_only_steps", description: "Steps to reproduce are prose-only — no executable commands", weight: 5 });
  }

  const genericRemediation = /(?:update\s+to\s+the\s+latest\s+version|apply\s+(?:the\s+)?(?:latest\s+)?(?:security\s+)?patch|implement\s+(?:proper\s+)?input\s+(?:validation|sanitization))/i.test(text);
  const specificFix = /(?:fixed\s+in\s+(?:v|version\s+)[\d.]+|commit\s+[0-9a-f]{7,}|PR\s+#\d+|patch\s+applied)/i.test(text);
  if (genericRemediation && !specificFix) {
    score -= 8;
    markers.push({ type: "generic_remediation", description: 'Remediation is boilerplate ("update to latest version") with no specific fix reference', weight: 4 });
  }

  const textbookPhrases = (text.match(/(?:is\s+a\s+(?:type|class|form)\s+of\s+(?:vulnerability|attack)|(?:OWASP|CWE)\s+defines?\s+(?:this|it)\s+as|according\s+to\s+(?:OWASP|NIST|MITRE))/gi) || []).length;
  if (textbookPhrases >= 2) {
    score -= 10;
    markers.push({ type: "textbook_padding", description: `${textbookPhrases} textbook definitions used as padding`, weight: 6 });
  }

  return { score: Math.max(0, Math.min(100, score)), markers };
}
