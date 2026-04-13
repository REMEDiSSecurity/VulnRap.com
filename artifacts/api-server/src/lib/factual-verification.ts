export interface FactualResult {
  score: number;
  severityInflationScore: number;
  placeholderScore: number;
  fabricatedOutputScore: number;
  evidence: FactualEvidence[];
}

export interface FactualEvidence {
  type: string;
  description: string;
  weight: number;
  matched?: string;
}

const PLACEHOLDER_DOMAINS = [
  "example.com",
  "example.org",
  "example.net",
  "target.com",
  "vulnerable-server.com",
  "vulnerable-app.com",
  "victim.com",
  "attacker.com",
  "evil.com",
  "malicious.com",
  "test.com",
  "testsite.com",
  "yoursite.com",
  "yourapp.com",
  "yourdomain.com",
  "company.com",
  "acme.com",
  "foo.com",
  "bar.com",
  "webapp.com",
  "myapp.com",
  "site.com",
  "localhost",
  "192.168.1.1",
  "10.0.0.1",
  "127.0.0.1",
];

const PLACEHOLDER_PATHS = [
  "/api/v1/users",
  "/api/v1/admin",
  "/api/endpoint",
  "/admin/dashboard",
  "/login",
  "/api/users/1",
  "/upload",
  "/api/data",
  "/search?q=",
];

function analyzeSeverityInflation(text: string): { score: number; evidence: FactualEvidence[] } {
  const evidence: FactualEvidence[] = [];
  let totalWeight = 0;

  const criticalClaims = text.match(/(?:cvss\s*(?:score\s*)?(?::|of|=)\s*(?:9\.[0-9]|10\.0)|critical\s+(?:severity|vulnerability)|(?:remote\s+code\s+execution|rce)\s+vulnerability)/gi);

  if (criticalClaims && criticalClaims.length > 0) {
    const hasRceEvidence = /(?:exec\(|system\(|eval\(|spawn\(|popen|subprocess|os\.system|Runtime\.exec|ProcessBuilder|shell_exec|passthru|`[^`]*\$)/i.test(text);
    const hasAuthBypassEvidence = /(?:(?:bypass|skip|circumvent)\s+(?:auth|authentication|authorization)|(?:jwt|token|session)\s+(?:forge|tamper|manipulat))/i.test(text);
    const hasSqliEvidence = /(?:(?:union\s+select|or\s+1\s*=\s*1|'\s*(?:or|and)\s*'|sqlmap|injection\s+point)\s)/i.test(text);
    const hasWorkingExploit = /```[\s\S]*?(?:curl|wget|python|ruby|perl|bash|sh|nc|ncat)[\s\S]*?```/i.test(text);

    if (!hasRceEvidence && !hasAuthBypassEvidence && !hasSqliEvidence && !hasWorkingExploit) {
      totalWeight += 15;
      evidence.push({
        type: "severity_inflation",
        description: `Claims critical/high severity (${criticalClaims[0].trim()}) but report lacks concrete exploit code or technical evidence supporting the severity level`,
        weight: 15,
        matched: criticalClaims[0].trim(),
      });
    }
  }

  const cvssPattern = /cvss\s*(?:v?3(?:\.1)?)?[\s:]*(?:score\s*)?(?::|of|=|is)?\s*(\d+\.?\d*)/gi;
  let match;
  while ((match = cvssPattern.exec(text)) !== null) {
    const score = parseFloat(match[1]);
    if (score > 10.0) {
      totalWeight += 10;
      evidence.push({
        type: "invalid_cvss",
        description: `Invalid CVSS score: ${score} (maximum is 10.0)`,
        weight: 10,
        matched: match[0],
      });
    }
  }

  const cweReferences = text.match(/cwe-?\d+/gi) || [];
  const owasp = /owasp\s+top\s+(?:10|ten)/gi.test(text);
  const hasSpecificVulnClass = /(?:(?:cross-site\s+scripting|xss|sql\s+injection|sqli|buffer\s+overflow|heap\s+overflow|use[\s-]after[\s-]free|double[\s-]free|race\s+condition|toctou|ssrf|csrf|xxe|deserialization|prototype\s+pollution))/i.test(text);

  if (cweReferences.length >= 5 && !hasSpecificVulnClass) {
    totalWeight += 8;
    evidence.push({
      type: "cwe_stuffing",
      description: `${cweReferences.length} CWE references without specific vulnerability class details — possible taxonomy padding`,
      weight: 8,
    });
  }

  if (owasp && cweReferences.length >= 3 && !hasSpecificVulnClass) {
    totalWeight += 6;
    evidence.push({
      type: "taxonomy_padding",
      description: "OWASP Top 10 reference combined with multiple CWEs but no specific technical vulnerability evidence",
      weight: 6,
    });
  }

  const score = Math.min(100, Math.round(30 * Math.log1p(totalWeight)));
  return { score, evidence };
}

function analyzePlaceholderUrls(text: string): { score: number; evidence: FactualEvidence[] } {
  const evidence: FactualEvidence[] = [];
  let totalWeight = 0;

  const lowerText = text.toLowerCase();

  for (const domain of PLACEHOLDER_DOMAINS) {
    if (lowerText.includes(domain)) {
      const isInCodeBlock = new RegExp("```[\\s\\S]*?" + domain.replace(/\./g, "\\.") + "[\\s\\S]*?```").test(text);
      const weight = isInCodeBlock ? 6 : 12;
      totalWeight += weight;
      evidence.push({
        type: "placeholder_url",
        description: `Placeholder domain "${domain}" found${isInCodeBlock ? " (in code block)" : ""} — real reports reference actual target systems`,
        weight,
        matched: domain,
      });
    }
  }

  for (const path of PLACEHOLDER_PATHS) {
    const pathRegex = new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (pathRegex.test(text)) {
      const alreadyHasPlaceholderDomain = evidence.some(e => e.type === "placeholder_url");
      if (alreadyHasPlaceholderDomain) {
        totalWeight += 4;
        evidence.push({
          type: "generic_path",
          description: `Generic API path "${path}" combined with placeholder domain`,
          weight: 4,
          matched: path,
        });
      }
    }
  }

  const score = Math.min(100, Math.round(30 * Math.log1p(totalWeight)));
  return { score, evidence };
}

function analyzeFabricatedOutput(text: string): { score: number; evidence: FactualEvidence[] } {
  const evidence: FactualEvidence[] = [];
  let totalWeight = 0;

  const asanPattern = /==\d+==\s*ERROR:\s*AddressSanitizer/;
  if (asanPattern.test(text)) {
    const roundAddresses = text.match(/0x[0-9a-f]*0{4,}/gi);
    if (roundAddresses && roundAddresses.length >= 2) {
      totalWeight += 15;
      evidence.push({
        type: "fake_asan",
        description: `ASan output with suspiciously round memory addresses (${roundAddresses.slice(0, 2).join(", ")}) — real addresses are rarely this uniform`,
        weight: 15,
        matched: roundAddresses[0],
      });
    }
  }

  const stackFrames = text.match(/#\d+\s+0x[0-9a-f]+\s+in\s+\w+/gi) || [];
  if (stackFrames.length >= 3) {
    const functions = stackFrames.map(f => {
      const m = f.match(/in\s+(\w+)/i);
      return m ? m[1] : "";
    });
    const uniqueFunctions = new Set(functions);
    if (uniqueFunctions.size === 1 && functions.length >= 3) {
      totalWeight += 12;
      evidence.push({
        type: "repeating_stack",
        description: `Stack trace has ${functions.length} frames all calling the same function "${functions[0]}" — likely fabricated`,
        weight: 12,
      });
    }
  }

  const gdbRegisters = text.match(/(?:rax|rbx|rcx|rdx|rsi|rdi|rsp|rbp|rip|eax|ebx|ecx|edx|esi|edi|esp|ebp|eip)\s*(?:=|:)\s*0x[0-9a-f]+/gi);
  if (gdbRegisters && gdbRegisters.length >= 4) {
    const values = gdbRegisters.map(r => {
      const m = r.match(/0x([0-9a-f]+)/i);
      return m ? m[1] : "";
    });
    const allSameLength = values.every(v => v.length === values[0].length);
    const sequentialPattern = values.every((v, i) => {
      if (i === 0) return true;
      const prev = parseInt(values[i - 1], 16);
      const curr = parseInt(v, 16);
      return Math.abs(curr - prev) < 0x100;
    });

    if (allSameLength && sequentialPattern && values.length >= 4) {
      totalWeight += 12;
      evidence.push({
        type: "fake_registers",
        description: "GDB register dump with suspiciously sequential/uniform values — real register dumps show varied values",
        weight: 12,
      });
    }
  }

  const httpResponses = text.match(/HTTP\/[\d.]+\s+\d{3}/g);
  if (httpResponses && httpResponses.length >= 3) {
    const statusCodes = httpResponses.map(r => r.match(/\d{3}/)?.[0] || "");
    const allSame = statusCodes.every(c => c === statusCodes[0]);
    if (allSame && statusCodes[0] === "200") {
      totalWeight += 5;
      evidence.push({
        type: "uniform_http",
        description: "Multiple HTTP responses all showing 200 OK — real testing typically shows varied responses",
        weight: 5,
      });
    }
  }

  const score = Math.min(100, Math.round(30 * Math.log1p(totalWeight)));
  return { score, evidence };
}

function analyzeCveReferences(text: string): { score: number; evidence: FactualEvidence[] } {
  const evidence: FactualEvidence[] = [];
  let totalWeight = 0;

  const cvePattern = /CVE-(\d{4})-(\d{4,})/g;
  let match;
  const cves: Array<{ full: string; year: number; id: number }> = [];

  while ((match = cvePattern.exec(text)) !== null) {
    cves.push({
      full: match[0],
      year: parseInt(match[1]),
      id: parseInt(match[2]),
    });
  }

  const currentYear = new Date().getFullYear();
  for (const cve of cves) {
    if (cve.year > currentYear + 1) {
      totalWeight += 20;
      evidence.push({
        type: "future_cve",
        description: `${cve.full} references a future year (${cve.year}) — CVE does not exist`,
        weight: 20,
        matched: cve.full,
      });
    }

    if (cve.year < 1999) {
      totalWeight += 15;
      evidence.push({
        type: "invalid_cve_year",
        description: `${cve.full} references year ${cve.year} — CVE program started in 1999`,
        weight: 15,
        matched: cve.full,
      });
    }
  }

  if (cves.length >= 5) {
    const years = cves.map(c => c.year);
    const uniqueYears = new Set(years);
    if (uniqueYears.size === 1 && cves.length >= 5) {
      totalWeight += 8;
      evidence.push({
        type: "cve_cluster",
        description: `${cves.length} CVEs all from year ${years[0]} — suspiciously uniform clustering`,
        weight: 8,
      });
    }
  }

  const score = Math.min(100, Math.round(30 * Math.log1p(totalWeight)));
  return { score, evidence };
}

function analyzeFabricatedCves(text: string): { score: number; evidence: FactualEvidence[] } {
  const evidence: FactualEvidence[] = [];
  let totalWeight = 0;

  const cvePattern = /CVE-(\d{4})-(\d{4,})/g;
  let match;
  const cveIds: Array<{ full: string; year: number; id: number }> = [];

  while ((match = cvePattern.exec(text)) !== null) {
    cveIds.push({ full: match[0], year: parseInt(match[1]), id: parseInt(match[2]) });
  }

  if (cveIds.length >= 2) {
    const ids = cveIds.map(c => c.id).sort((a, b) => a - b);
    let sequentialCount = 0;
    for (let i = 1; i < ids.length; i++) {
      if (ids[i] - ids[i - 1] === 1) sequentialCount++;
    }
    if (sequentialCount >= 2) {
      const currentYear = new Date().getFullYear();
      const allRecent = cveIds.every(c => currentYear - c.year <= 1);
      const hasNamedResearcher = /(?:reported|discovered|found|credited)\s+(?:by|to)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?/i.test(text)
        || /(?:X41|Trail of Bits|Google Project Zero|Qualys|Rapid7|Tenable|Snyk|Synopsys|Checkmarx|HackerOne|Bugcrowd)/i.test(text);
      const hasTemplateMarkers = /(?:dear\s+(?:security|sir|team)|i\s+(?:hope|would like)|best\s+regards|sincerely)/i.test(text);

      let seqWeight: number;
      let seqDesc: string;

      if (hasNamedResearcher && allRecent) {
        seqWeight = 0;
        seqDesc = `${sequentialCount + 1} sequential CVE IDs detected (${cveIds.slice(0, 3).map(c => c.full).join(", ")}) — consistent with coordinated multi-vuln disclosure from named researcher`;
      } else if (hasTemplateMarkers) {
        seqWeight = 12;
        seqDesc = `${sequentialCount + 1} CVE IDs with sequential numbering (${cveIds.slice(0, 3).map(c => c.full).join(", ")}) in templated report — suspicious`;
      } else {
        seqWeight = 5;
        seqDesc = `${sequentialCount + 1} sequential CVE IDs detected (${cveIds.slice(0, 3).map(c => c.full).join(", ")}) — may indicate coordinated disclosure or fabrication`;
      }

      totalWeight += seqWeight;
      evidence.push({
        type: "fabricated_cve",
        description: seqDesc,
        weight: seqWeight,
      });
    }

    const roundIds = cveIds.filter(c => c.id % 1000 === 0);
    if (roundIds.length >= 2) {
      totalWeight += 10;
      evidence.push({
        type: "fabricated_cve",
        description: `Multiple CVE IDs with suspiciously round numbers (${roundIds.map(c => c.full).join(", ")})`,
        weight: 10,
      });
    }
  }

  for (const cve of cveIds) {
    if (/^\d{4,}$/.test(String(cve.id)) && String(cve.id).length > 7) {
      totalWeight += 8;
      evidence.push({
        type: "fabricated_cve",
        description: `${cve.full} has an unusually long ID number — most real CVEs have 4-7 digit IDs`,
        weight: 8,
        matched: cve.full,
      });
    }
  }

  const score = Math.min(100, Math.round(30 * Math.log1p(totalWeight)));
  return { score, evidence };
}

function analyzeHallucinatedFunctions(text: string): { score: number; evidence: FactualEvidence[] } {
  const evidence: FactualEvidence[] = [];
  let totalWeight = 0;

  const stackFuncPattern = /(?:in|at|from)\s+([a-zA-Z_][a-zA-Z0-9_]{2,}(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\(/g;
  let match;
  const extractedFunctions: string[] = [];

  while ((match = stackFuncPattern.exec(text)) !== null) {
    extractedFunctions.push(match[1]);
  }

  const codeRefPattern = /(?:function|method|routine|handler)\s+`?([a-zA-Z_][a-zA-Z0-9_:]*)`?/gi;
  while ((match = codeRefPattern.exec(text)) !== null) {
    extractedFunctions.push(match[1]);
  }

  const unique = [...new Set(extractedFunctions)];

  for (const fn of unique) {
    const parts = fn.split(/(?=[A-Z])|_/).filter(Boolean);
    if (parts.length >= 5) {
      const hasNonsense = parts.some(p => /^(?:process|handle|execute|validate|check|verify|parse|manage|init|create|update|delete|get|set|do|run|perform|ensure|apply)$/i.test(p));
      const genericCount = parts.filter(p => /^(?:data|input|output|request|response|buffer|stream|object|item|value|result|context|state|config|info|util|helper|service|manager|handler|controller|processor|validator|factory|builder|wrapper|adapter|decorator|observer|listener|callback|resolver|provider|consumer|producer|dispatcher|scheduler|executor|coordinator|orchestrator)$/i.test(p)).length;

      if (hasNonsense && genericCount >= 2) {
        totalWeight += 10;
        evidence.push({
          type: "hallucinated_function",
          description: `Function "${fn}" appears to be hallucinated — composed of generic programming terms without domain specificity`,
          weight: 10,
          matched: fn,
        });
      }
    }
  }

  if (unique.length >= 5) {
    const camelCaseCount = unique.filter(fn => /^[a-z]+(?:[A-Z][a-z]+){3,}$/.test(fn)).length;
    const snakeCaseCount = unique.filter(fn => /^[a-z]+(?:_[a-z]+){3,}$/.test(fn)).length;
    if (camelCaseCount >= 3 && snakeCaseCount >= 3) {
      totalWeight += 8;
      evidence.push({
        type: "hallucinated_function",
        description: "Function names mix camelCase and snake_case conventions inconsistently — suggests fabricated rather than observed function names",
        weight: 8,
      });
    }
  }

  const score = Math.min(100, Math.round(30 * Math.log1p(totalWeight)));
  return { score, evidence };
}

export function analyzeFactual(text: string): FactualResult {
  const severity = analyzeSeverityInflation(text);
  const placeholders = analyzePlaceholderUrls(text);
  const fabricated = analyzeFabricatedOutput(text);
  const cveCheck = analyzeCveReferences(text);
  const fabricatedCves = analyzeFabricatedCves(text);
  const hallucinatedFuncs = analyzeHallucinatedFunctions(text);

  const combinedScore = Math.min(100, Math.round(
    severity.score * 0.25 +
    placeholders.score * 0.20 +
    fabricated.score * 0.20 +
    cveCheck.score * 0.15 +
    fabricatedCves.score * 0.10 +
    hallucinatedFuncs.score * 0.10
  ));

  return {
    score: combinedScore,
    severityInflationScore: severity.score,
    placeholderScore: placeholders.score,
    fabricatedOutputScore: fabricated.score,
    evidence: [
      ...severity.evidence,
      ...placeholders.evidence,
      ...fabricated.evidence,
      ...cveCheck.evidence,
      ...fabricatedCves.evidence,
      ...hallucinatedFuncs.evidence,
    ],
  };
}
