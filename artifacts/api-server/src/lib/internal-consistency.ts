export interface ConsistencyIssue {
  type: string;
  description: string;
  weight: number;
}

export interface InternalConsistencyResult {
  score: number;
  issues: ConsistencyIssue[];
}

function detectVulnClass(text: string): string | null {
  if (/buffer\s*overflow|heap\s*overflow|stack\s*overflow|out.of.bounds/i.test(text)) return "buffer_overflow";
  if (/sql\s*injection|sqli/i.test(text)) return "sqli";
  if (/cross.?site\s*scripting|xss/i.test(text)) return "xss";
  if (/use.after.free/i.test(text)) return "use_after_free";
  if (/remote\s*code\s*execution|rce/i.test(text)) return "rce";
  if (/denial.of.service|dos/i.test(text)) return "dos";
  if (/information\s*(?:disclosure|leak)/i.test(text)) return "info_leak";
  if (/ssrf|server.side\s*request/i.test(text)) return "ssrf";
  if (/csrf|cross.site\s*request\s*forgery/i.test(text)) return "csrf";
  if (/xxe|xml\s*external\s*entity/i.test(text)) return "xxe";
  if (/deserialization/i.test(text)) return "deserialization";
  if (/prototype\s*pollution/i.test(text)) return "prototype_pollution";
  if (/path\s*traversal|directory\s*traversal/i.test(text)) return "path_traversal";
  if (/privilege\s*escalation|privesc/i.test(text)) return "privesc";
  return null;
}

function detectLanguage(text: string): string | null {
  if (/(?:python|\.py\b|pip|django|flask)/i.test(text)) return "python";
  if (/(?:\.c\b|\.h\b|gcc|clang|malloc|free\s*\(|#include)/i.test(text)) return "c";
  if (/(?:node\.?js|npm|express|require\s*\(|\.js\b)/i.test(text)) return "javascript";
  if (/(?:\.java\b|maven|gradle|spring|javax)/i.test(text)) return "java";
  if (/(?:\.go\b|golang|go\s+mod)/i.test(text)) return "go";
  if (/(?:\.rs\b|cargo|rust)/i.test(text)) return "rust";
  if (/(?:\.php\b|composer|laravel)/i.test(text)) return "php";
  if (/(?:\.rb\b|ruby|rails|gem)/i.test(text)) return "ruby";
  return null;
}

export function computeInternalConsistency(text: string): InternalConsistencyResult {
  const issues: ConsistencyIssue[] = [];

  const vulnType = detectVulnClass(text);
  const language = detectLanguage(text);

  if (vulnType === "buffer_overflow" && language === "python" && !/c\s+extension|ctypes|cffi/i.test(text)) {
    issues.push({
      type: "vuln_language_mismatch",
      description: "Claims buffer overflow in Python code without mentioning C extensions",
      weight: 15,
    });
  }

  if (vulnType === "sqli" && /(?:cli|command.?line|terminal)/i.test(text) && !/web|http|api/i.test(text)) {
    issues.push({
      type: "vuln_context_mismatch",
      description: "Claims SQL injection in CLI tool with no web interface mentioned",
      weight: 12,
    });
  }

  const cvssMatch = text.match(/CVSS[:\s]*(\d+\.?\d*)/i);
  if (cvssMatch) {
    const cvss = parseFloat(cvssMatch[1]);
    const hasRCE = /remote\s+code\s+execution|RCE/i.test(text);
    const hasDoS = /denial\s+of\s+service|DoS/i.test(text);
    const hasInfoLeak = /information\s+(?:disclosure|leak)/i.test(text);

    if (hasInfoLeak && !hasRCE && cvss >= 9.0) {
      issues.push({
        type: "cvss_impact_mismatch",
        description: `Claims CVSS ${cvss} for information disclosure without RCE — inflated severity`,
        weight: 10,
      });
    }
    if (hasDoS && !hasRCE && cvss >= 9.0) {
      issues.push({
        type: "cvss_dos_inflated",
        description: `Claims CVSS ${cvss} for DoS without code execution — maximum DoS CVSS is typically 7.5`,
        weight: 8,
      });
    }
  }

  const cwes = text.match(/CWE-\d+/gi) || [];
  if (cwes.length >= 3) {
    issues.push({
      type: "cwe_overload",
      description: `Lists ${cwes.length} CWE references for a single vulnerability — typical of AI-generated reports`,
      weight: 6,
    });
  }

  if (vulnType === "xss" && language === "c" && !/cgi|web|http/i.test(text)) {
    issues.push({
      type: "vuln_language_mismatch",
      description: "Claims XSS in C code without mentioning web server context",
      weight: 12,
    });
  }

  if (vulnType === "prototype_pollution" && language && !["javascript", null].includes(language)) {
    issues.push({
      type: "vuln_language_mismatch",
      description: `Claims prototype pollution in ${language} — this is a JavaScript-specific vulnerability`,
      weight: 15,
    });
  }

  const consistencyScore = Math.max(0, 100 - issues.reduce((sum, i) => sum + i.weight * 3, 0));
  return { score: consistencyScore, issues };
}
