// Task #1327 — government/CERT impersonation + typosquat detection.
//
// fake_X claims fire only when the sender domain is itself confusable
// with the claimed brand (impersonating label or Levenshtein-near
// root). Domains that simply *mention* CERT/CC or FBI in their body
// from an unrelated sender (rr-062 cert.example.org, rr-094
// university.edu) are not flagged.

import { buildFire, type RuleFire, type RuleInput } from "./types";

const KNOWN_GOOD_DOMAINS = [
  "hackerone.com",
  "h1.com",
  "bugcrowd.com",
  "intigriti.com",
  "yeswehack.com",
  "cert.org",
  "kb.cert.org",
  "cisa.gov",
  "us-cert.gov",
  "fbi.gov",
  "ic3.gov",
  "ncsc.gov.uk",
  "anthropic.com",
  "openai.com",
  "google.com",
  "microsoft.com",
  "github.com",
];

const RESERVED_TLD_RE = /\.(?:example|test|invalid|localhost)$/i;

const IMPERSONATION_CLAIMS: Array<{
  flag: string;
  claim: RegExp;
  brands: string[];
}> = [
  { flag: "fake_cert_cc", claim: /\bCERT[\/\s-]?CC\b/i, brands: ["cert"] },
  { flag: "fake_hackerone", claim: /\bHackerOne\b/i, brands: ["hackerone", "h1"] },
  { flag: "fake_cisa", claim: /\bCISA\b/i, brands: ["cisa", "us-cert"] },
  {
    flag: "fake_fbi",
    claim: /\bFBI\b|\bFederal\s+Bureau\s+of\s+Investigation\b/i,
    brands: ["fbi", "ic3"],
  },
];

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const v0 = new Array<number>(b.length + 1);
  const v1 = new Array<number>(b.length + 1);
  for (let i = 0; i <= b.length; i++) v0[i] = i;
  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }
  return v0[b.length];
}

// Brand appears as part of a larger label (e.g. "hackerone-platform" or
// "cert-cc"), not as its own complete label. A label that equals the
// brand exactly (e.g. cert.example.org) is treated as a corpus
// stand-in, not impersonation.
function hasBrandInLargerLabel(domain: string, brand: string): boolean {
  const labels = domain.toLowerCase().split(".");
  return labels.some((l) => l !== brand && l.includes(brand));
}

function isTyposquat(
  domain: string,
): { good: string; kind: "brand_embed" | "levenshtein" } | null {
  const d = domain.toLowerCase();
  for (const good of KNOWN_GOOD_DOMAINS) {
    if (d === good || d.endsWith(`.${good}`)) return null;
  }
  for (const good of KNOWN_GOOD_DOMAINS) {
    const brand = good.split(".")[0];
    if (brand.length >= 5 && hasBrandInLargerLabel(d, brand)) {
      return { good, kind: "brand_embed" };
    }
    const root = d.split(".").slice(0, -1).join(".");
    const goodRoot = good.split(".").slice(0, -1).join(".");
    if (root.length >= 4 && goodRoot.length >= 4) {
      const dist = levenshtein(root, goodRoot);
      if (dist > 0 && dist <= 2) return { good, kind: "levenshtein" };
    }
  }
  return null;
}

function senderImpersonates(domain: string, brands: string[]): boolean {
  for (const brand of brands) {
    if (hasBrandInLargerLabel(domain, brand)) return true;
  }
  return false;
}

export function evaluateGovernmentImpersonation(
  input: RuleInput,
): RuleFire[] {
  const fires: RuleFire[] = [];
  const seen = new Set<string>();
  const domain = input.senderDomain;
  if (!domain) return fires;

  if (RESERVED_TLD_RE.test(domain)) {
    seen.add("reserved_tld_sender");
    fires.push(
      buildFire(
        "government_impersonation",
        "reserved_tld_sender",
        `From: ...@${domain}`,
        1,
      ),
    );
  }
  const sq = isTyposquat(domain);
  if (sq) {
    seen.add("typosquat_domain");
    fires.push(
      buildFire(
        "government_impersonation",
        "typosquat_domain",
        `${domain} (typosquats ${sq.good})`,
        sq.kind === "levenshtein" ? 3 : 2,
      ),
    );
  }

  for (const { flag, claim, brands } of IMPERSONATION_CLAIMS) {
    if (!claim.test(input.rawText)) continue;
    if (!senderImpersonates(domain, brands)) continue;
    if (seen.has(flag)) continue;
    seen.add(flag);
    fires.push(
      buildFire(
        "government_impersonation",
        flag,
        `${domain} claims ${flag.replace(/^fake_/, "")}`,
        3,
      ),
    );
  }
  return fires;
}
