export interface ClaimSpecificityMarker {
  type: string;
  description?: string;
  weight: number;
}

export interface ClaimSpecificityResult {
  score: number;
  markers: ClaimSpecificityMarker[];
}

export function computeClaimSpecificity(text: string): ClaimSpecificityResult {
  let score = 0;
  const markers: ClaimSpecificityMarker[] = [];

  const hasProject = /(?:curl|nginx|apache|django|flask|react|express|wordpress|linux|kernel|openssl|libxml2|sqlite|redis|postgresql|mysql|mongodb|docker|kubernetes|jenkins|grafana|kibana|elasticsearch|tomcat|spring|struts|log4j|jackson|netty)/i.test(text);
  const hasCVE = /CVE-\d{4}-\d+/.test(text);
  const hasVersion = /v?\d+\.\d+\.\d+/.test(text);
  const hasFilePath = /(?:\/[\w.-]+){2,}\.(?:c|h|py|js|go|rs|java|php|rb|ts|cpp|hpp)/i.test(text);
  const hasFunction = /\b\w+(?:_\w+){1,}\s*\(/.test(text);
  const hasEndpoint = /(?:GET|POST|PUT|DELETE|PATCH)\s+\/\S+/i.test(text);
  const hasHTTPRequest = /(?:Host:|Content-Type:|Cookie:|Authorization:)/i.test(text);
  const hasCommitSHA = /[0-9a-f]{40}/i.test(text);
  const hasGHSA = /GHSA-[\w-]+/.test(text);

  if (hasProject) { score += 10; markers.push({ type: "named_project", weight: -5 }); }
  if (hasCVE) { score += 15; markers.push({ type: "cve_referenced", weight: -8 }); }
  if (hasVersion) { score += 8; markers.push({ type: "version_specified", weight: -4 }); }
  if (hasFilePath) { score += 12; markers.push({ type: "file_path_cited", weight: -6 }); }
  if (hasFunction) { score += 10; markers.push({ type: "function_named", weight: -5 }); }
  if (hasEndpoint) { score += 10; markers.push({ type: "endpoint_specified", weight: -5 }); }
  if (hasHTTPRequest) { score += 12; markers.push({ type: "http_request_included", weight: -6 }); }
  if (hasCommitSHA) { score += 15; markers.push({ type: "commit_sha_referenced", weight: -8 }); }
  if (hasGHSA) { score += 12; markers.push({ type: "ghsa_referenced", weight: -6 }); }

  const hasPreRedacted = /\[REDACTED\]|\[REMOVED\]|\[CENSORED\]|\[MASKED\]|\[HIDDEN\]/i.test(text);
  if (/your-?(?:app|server|domain)/i.test(text)) {
    score -= 10;
    markers.push({ type: "generic_placeholder", description: "Uses your-app/your-server placeholder instead of actual target name", weight: 8 });
  }
  if (/the\s+application|your\s+(?:code|system|infrastructure)/i.test(text) && !hasProject) {
    score -= 10;
    markers.push({ type: "unnamed_target", description: "No specific project named", weight: 8 });
  }

  return { score: Math.max(0, Math.min(100, score)), markers };
}
