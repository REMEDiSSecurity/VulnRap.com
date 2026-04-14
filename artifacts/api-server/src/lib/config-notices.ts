export interface ConfigImpactNotice {
  setting: string;
  severity: "info" | "warning" | "critical";
  title: string;
  summary: string;
  impact: Record<string, string>;
  recommendation: string;
}

export function generateConfigImpactNotices(options: {
  skipLlm?: boolean;
  skipRedaction?: boolean;
}): ConfigImpactNotice[] {
  const notices: ConfigImpactNotice[] = [];

  if (options.skipLlm) {
    notices.push({
      setting: "skipLlm",
      severity: "warning",
      title: "LLM Analysis Disabled",
      summary: "Running in heuristic-only mode. Detection accuracy is reduced.",
      impact: {
        accuracy_drop: "~15 percentage points (from ~90% to ~75% estimated)",
        false_negative_increase: "Expect 1-2 additional slop reports to score below threshold per 16 reports",
        latency_improvement: "P95 drops from ~15s to <2s (7-10x faster)",
        confidence_reduction: "All confidence values reduced by 15%",
      },
      recommendation: "Acceptable for high-volume pre-screening where speed matters more than precision. Consider re-running flagged reports with LLM for final classification.",
    });
  }

  if (options.skipRedaction) {
    notices.push({
      setting: "skipRedaction",
      severity: "warning",
      title: "PII Redaction Disabled",
      summary: "Personally identifiable information will NOT be masked before analysis or storage.",
      impact: {
        accuracy_change: "None",
        privacy_risk: "HIGH — any PII in the report is exposed in API responses and potentially logged",
        latency_improvement: "Marginal (~10-50ms saved)",
      },
      recommendation: "Only disable redaction in controlled environments where PII exposure is acceptable. Never disable in production when processing reports from external researchers.",
    });
  }

  if (options.skipRedaction && options.skipLlm) {
    notices.push({
      setting: "skipRedaction+skipLlm",
      severity: "info",
      title: "Maximum Speed Mode",
      summary: "Both redaction and LLM disabled — fastest possible analysis.",
      impact: {
        latency: "P95 < 500ms (deterministic heuristics only)",
        accuracy: "~75% estimated (heuristic-only baseline)",
        privacy: "No PII protection",
      },
      recommendation: "Best for batch processing of pre-sanitized reports, CI/CD integration, or real-time pre-screening of high-volume report streams.",
    });
  }

  if (!options.skipLlm && !options.skipRedaction) {
    notices.push({
      setting: "default",
      severity: "info",
      title: "Full Analysis Mode",
      summary: "All analysis stages active including LLM and PII redaction.",
      impact: {
        accuracy: "~90% target (best available)",
        latency: "P95 ~15-20s (LLM analysis is the bottleneck)",
        privacy: "PII redacted before LLM processing and in API responses",
      },
      recommendation: "Production triage of individual reports where accuracy is the priority.",
    });
  }

  return notices;
}
