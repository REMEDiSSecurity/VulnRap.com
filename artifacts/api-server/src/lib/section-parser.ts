import crypto from "crypto";

export interface ReportSection {
  title: string;
  content: string;
  hash: string;
  weight: number;
}

export interface SectionAnalysis {
  sections: ReportSection[];
  sectionHashes: Record<string, string>;
}

const HIGH_VALUE_SECTIONS = new Set([
  "vulnerability", "description", "summary", "impact", "severity",
  "steps to reproduce", "reproduction", "poc", "proof of concept",
  "exploit", "payload", "attack", "technical details", "details",
  "root cause", "remediation", "mitigation", "fix", "recommendation",
]);

const MEDIUM_VALUE_SECTIONS = new Set([
  "environment", "setup", "configuration", "prerequisites",
  "affected", "scope", "references", "timeline", "disclosure",
  "expected behavior", "observed behavior", "actual behavior",
]);

function classifyWeight(title: string): number {
  const lower = title.toLowerCase().trim();
  for (const key of HIGH_VALUE_SECTIONS) {
    if (lower.includes(key)) return 3;
  }
  for (const key of MEDIUM_VALUE_SECTIONS) {
    if (lower.includes(key)) return 2;
  }
  return 1;
}

function hashSection(content: string): string {
  const normalized = content.toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

export function parseSections(text: string): SectionAnalysis {
  const sections: ReportSection[] = [];

  const headerPattern = /^(#{1,4})\s+(.+)$/gm;
  const headers: Array<{ title: string; start: number; end: number }> = [];

  let match;
  while ((match = headerPattern.exec(text)) !== null) {
    headers.push({
      title: match[2].trim(),
      start: match.index + match[0].length,
      end: text.length,
    });
  }

  if (headers.length > 0) {
    for (let i = 0; i < headers.length; i++) {
      const nextStart = i < headers.length - 1 ? headers[i + 1].start - headers[i + 1].title.length - 3 : text.length;
      headers[i].end = nextStart;
    }

    const preContent = text.substring(0, headers[0].start - headers[0].title.length - 2).trim();
    if (preContent.length > 20) {
      sections.push({
        title: "Preamble",
        content: preContent,
        hash: hashSection(preContent),
        weight: 1,
      });
    }

    for (const header of headers) {
      const content = text.substring(header.start, header.end).trim();
      if (content.length > 10) {
        sections.push({
          title: header.title,
          content,
          hash: hashSection(content),
          weight: classifyWeight(header.title),
        });
      }
    }
  } else {
    const paragraphs = text.split(/\n{2,}/).filter(p => p.trim().length > 10);

    if (paragraphs.length <= 1) {
      sections.push({
        title: "Full Report",
        content: text.trim(),
        hash: hashSection(text),
        weight: 2,
      });
    } else {
      const labelPatterns = [
        { pattern: /(?:vulnerability|description|summary|overview)/i, label: "Description" },
        { pattern: /(?:step|reproduce|poc|proof)/i, label: "Reproduction Steps" },
        { pattern: /(?:impact|severity|risk|consequence)/i, label: "Impact Assessment" },
        { pattern: /(?:fix|remediat|mitigat|patch|recommend)/i, label: "Remediation" },
        { pattern: /(?:code|payload|exploit|script|curl|http)/i, label: "Technical Details" },
      ];

      for (let i = 0; i < paragraphs.length; i++) {
        const para = paragraphs[i].trim();
        let title = `Section ${i + 1}`;

        for (const { pattern, label } of labelPatterns) {
          if (pattern.test(para.substring(0, 100))) {
            title = label;
            break;
          }
        }

        sections.push({
          title,
          content: para,
          hash: hashSection(para),
          weight: classifyWeight(title),
        });
      }
    }
  }

  const sectionHashes: Record<string, string> = {};
  for (const section of sections) {
    sectionHashes[section.title] = section.hash;
  }

  sectionHashes["__full_document"] = hashSection(text);

  return { sections, sectionHashes };
}

export interface SectionMatch {
  sectionTitle: string;
  matchedReportId: number;
  matchedSectionTitle: string;
  similarity: number;
}

export function findSectionMatches(
  newSectionHashes: Record<string, string>,
  existingReports: Array<{ id: number; sectionHashes: Record<string, string> }>,
): SectionMatch[] {
  const matches: SectionMatch[] = [];

  for (const [title, hash] of Object.entries(newSectionHashes)) {
    if (title === "__full_document") continue;

    for (const report of existingReports) {
      if (!report.sectionHashes) continue;
      for (const [existingTitle, existingHash] of Object.entries(report.sectionHashes)) {
        if (existingTitle === "__full_document") continue;
        if (hash === existingHash) {
          matches.push({
            sectionTitle: title,
            matchedReportId: report.id,
            matchedSectionTitle: existingTitle,
            similarity: 100,
          });
        }
      }
    }
  }

  return matches;
}
