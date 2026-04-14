export interface RedactionResult {
  redactedText: string;
  summary: RedactionSummary;
}

export interface RedactionSummary {
  totalRedactions: number;
  categories: Record<string, number>;
}

const PATTERNS: Array<{ name: string; pattern: RegExp; replacement: string }> = [
  {
    name: "email",
    pattern: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,
    replacement: "[REDACTED_EMAIL]",
  },
  {
    name: "ipv4",
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
    replacement: "[REDACTED_IP]",
  },
  {
    name: "ipv6",
    pattern: /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}\b/g,
    replacement: "[REDACTED_IP]",
  },
  {
    name: "api_key",
    pattern: /\b(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|auth[_-]?token|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{16,}['"]?/gi,
    replacement: "[REDACTED_API_KEY]",
  },
  {
    name: "bearer_token",
    pattern: /Bearer\s+[A-Za-z0-9_\-./+=]{20,}/g,
    replacement: "Bearer [REDACTED_TOKEN]",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_\-+=]+/g,
    replacement: "[REDACTED_JWT]",
  },
  {
    name: "aws_key",
    pattern: /\b(?:AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: "[REDACTED_AWS_KEY]",
  },
  {
    name: "private_key",
    pattern: /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?(?:PRIVATE|EC)\s+KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]",
  },
  {
    name: "password",
    pattern: /(?:password|passwd|pwd|pass)\s*[:=]\s*['"]?[^\s'"]{3,}['"]?/gi,
    replacement: "[REDACTED_PASSWORD]",
  },
  {
    name: "connection_string",
    pattern: /(?:mongodb|postgres|mysql|redis|amqp|jdbc):\/\/[^\s"']+/gi,
    replacement: "[REDACTED_CONNECTION_STRING]",
  },
  {
    name: "url_with_creds",
    pattern: /https?:\/\/[^:@\s]+:[^@\s]+@[^\s"']+/g,
    replacement: "[REDACTED_URL_WITH_CREDS]",
  },
  {
    name: "hex_secret",
    pattern: /\b(?:secret|token|key|hash)\s*[:=]\s*['"]?[0-9a-fA-F]{32,}['"]?/gi,
    replacement: "[REDACTED_SECRET]",
  },
  {
    name: "uuid",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    replacement: "[REDACTED_UUID]",
  },
  {
    name: "phone",
    pattern: /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    replacement: "[REDACTED_PHONE]",
  },
  {
    name: "ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[REDACTED_SSN]",
  },
  {
    name: "credit_card",
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
    replacement: "[REDACTED_CARD]",
  },
  {
    name: "internal_hostname",
    pattern: /\b(?:(?:dev|staging|prod|internal|corp|vpn|admin|db|api|app|web|mail|git|ci|cd)\d*\.)[a-z0-9\-]+\.(?:internal|local|corp|intra|private|lan)\b/gi,
    replacement: "[REDACTED_HOSTNAME]",
  },
  {
    name: "internal_url",
    pattern: /https?:\/\/(?:(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+|localhost)(?::\d+)?[^\s"']*/g,
    replacement: "[REDACTED_INTERNAL_URL]",
  },
];

const COMPANY_INDICATORS = [
  /\b(?:at|for|of|with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:Inc|Corp|LLC|Ltd|Co|Company|Group|Technologies|Solutions|Systems|Labs|Security|Software|Platform)\b/g,
  /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:Inc|Corp|LLC|Ltd|Co)\b\.?/g,
];

const USERNAME_KV_PATTERNS = [
  /\b((?:user(?:name)?|login|account)\s*[:=]\s*)['"]?([^\s'"]{3,})['"]?/gi,
];

const USERNAME_ATTRIBUTION_PATTERNS = [
  /\b((?:reported\s+by|author|researcher|discoverer|finder)\s*[:=]?\s*)['"]?([A-Za-z][A-Za-z0-9._ -]{2,})['"]?/gi,
];

const PLACEHOLDER_PATTERNS = [
  /\[REDACTED\]/gi,
  /\[REMOVED\]/gi,
  /\[CENSORED\]/gi,
  /\[MASKED\]/gi,
  /\[HIDDEN\]/gi,
  /XXXX{4,}/g,
  /\*{4,}/g,
  /█+/g,
];

export interface PlaceholderResult {
  text: string;
  placeholders: Array<{ match: string; offset: number; type: string }>;
}

export function preprocessPlaceholders(text: string): PlaceholderResult {
  let processed = text;
  const placeholders: Array<{ match: string; offset: number; type: string }> = [];

  for (const pattern of PLACEHOLDER_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    processed = processed.replace(regex, (match, offset: number) => {
      placeholders.push({ match, offset, type: "pre_redacted" });
      return "__PLACEHOLDER__";
    });
  }

  return { text: processed, placeholders };
}

export function redactReport(text: string): RedactionResult {
  const categories: Record<string, number> = {};

  const { text: preprocessedText, placeholders } = preprocessPlaceholders(text);
  if (placeholders.length > 0) {
    categories["pre_redacted_placeholders"] = placeholders.length;
  }

  let redactedText = preprocessedText;

  for (const { name, pattern, replacement } of PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let count = 0;
    redactedText = redactedText.replace(regex, () => {
      count++;
      return replacement;
    });
    if (count > 0) {
      categories[name] = (categories[name] || 0) + count;
    }
  }

  for (const companyPattern of COMPANY_INDICATORS) {
    const regex = new RegExp(companyPattern.source, companyPattern.flags);
    let count = 0;
    redactedText = redactedText.replace(regex, (match) => {
      count++;
      return match.replace(/([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(Inc|Corp|LLC|Ltd|Co|Company|Group|Technologies|Solutions|Systems|Labs|Security|Software|Platform)/,
        "[REDACTED_COMPANY] $2");
    });
    if (count > 0) {
      categories["company_name"] = (categories["company_name"] || 0) + count;
    }
  }

  for (const kvPattern of USERNAME_KV_PATTERNS) {
    const regex = new RegExp(kvPattern.source, kvPattern.flags);
    let count = 0;
    redactedText = redactedText.replace(regex, (_match, prefix) => {
      count++;
      return `${prefix}[REDACTED_USERNAME]`;
    });
    if (count > 0) {
      categories["username"] = (categories["username"] || 0) + count;
    }
  }

  for (const attrPattern of USERNAME_ATTRIBUTION_PATTERNS) {
    const regex = new RegExp(attrPattern.source, attrPattern.flags);
    let count = 0;
    redactedText = redactedText.replace(regex, (_match, prefix) => {
      count++;
      return `${prefix}[REDACTED_USERNAME]`;
    });
    if (count > 0) {
      categories["username"] = (categories["username"] || 0) + count;
    }
  }

  const totalRedactions = Object.values(categories).reduce((sum, n) => sum + n, 0);

  return {
    redactedText,
    summary: { totalRedactions, categories },
  };
}
