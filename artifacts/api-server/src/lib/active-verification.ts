import { createHash } from "crypto";

export interface VerificationCheck {
  type: string;
  target: string;
  result: "verified" | "not_found" | "warning" | "error" | "skipped";
  detail: string;
  weight: number;
}

export interface VerificationSummary {
  verified: number;
  notFound: number;
  warnings: number;
  errors: number;
}

export interface VerificationResult {
  checks: VerificationCheck[];
  summary: VerificationSummary;
  triageNotes: string[];
  score: number;
  detectedProjects: DetectedProject[];
}

interface DetectedProject {
  name: string;
  repoSlug: string;
  source: string;
}

interface CacheEntry<T> {
  value: T;
  ts: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const apiCache = new Map<string, CacheEntry<unknown>>();

function cacheGet<T>(key: string): T | undefined {
  const entry = apiCache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    apiCache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function cacheSet<T>(key: string, value: T): void {
  apiCache.set(key, { value, ts: Date.now() });
  if (apiCache.size > 500) {
    const oldest = [...apiCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < 100; i++) apiCache.delete(oldest[i][0]);
  }
}

function contentCacheKey(prefix: string, text: string): string {
  return prefix + ":" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

const KNOWN_PROJECTS: Record<string, string> = {
  curl: "curl/curl",
  openssl: "openssl/openssl",
  nginx: "nginx/nginx",
  linux: "torvalds/linux",
  node: "nodejs/node",
  nodejs: "nodejs/node",
  django: "django/django",
  flask: "pallets/flask",
  express: "expressjs/express",
  react: "facebook/react",
  wordpress: "WordPress/WordPress",
  apache: "apache/httpd",
  redis: "redis/redis",
  postgresql: "postgres/postgres",
  mysql: "mysql/mysql-server",
  mongodb: "mongodb/mongo",
  git: "git/git",
  python: "python/cpython",
  ruby: "ruby/ruby",
  php: "php/php-src",
  tensorflow: "tensorflow/tensorflow",
  pytorch: "pytorch/pytorch",
  kubernetes: "kubernetes/kubernetes",
  docker: "moby/moby",
  elasticsearch: "elastic/elasticsearch",
  grafana: "grafana/grafana",
  jenkins: "jenkinsci/jenkins",
  chromium: "nicedoc/chromium",
  firefox: "nicedoc/gecko-dev",
  sqlite: "nicedoc/sqlite",
  tomcat: "apache/tomcat",
  spring: "spring-projects/spring-framework",
  rails: "rails/rails",
  laravel: "laravel/laravel",
  vue: "vuejs/core",
  angular: "angular/angular",
  nextjs: "vercel/next.js",
  webpack: "webpack/webpack",
  babel: "babel/babel",
  lodash: "lodash/lodash",
  axios: "axios/axios",
  jquery: "jquery/jquery",
  bootstrap: "twbs/bootstrap",
};

const GITHUB_URL_RE = /(?:https?:\/\/)?github\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)/g;
const GITLAB_URL_RE = /(?:https?:\/\/)?gitlab\.com\/([a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+)/g;
const NPM_PACKAGE_RE = /(?:npm\s+(?:install|i)\s+|require\s*\(\s*['"]|from\s+['"])(@?[a-zA-Z0-9][\w./-]*)/g;
const PYPI_PACKAGE_RE = /(?:pip\s+install\s+|import\s+|from\s+)([a-zA-Z0-9][\w.-]*)/g;

export function detectProjects(text: string): DetectedProject[] {
  const projects: DetectedProject[] = [];
  const seen = new Set<string>();

  let m: RegExpExecArray | null;

  const ghRe = new RegExp(GITHUB_URL_RE.source, "g");
  while ((m = ghRe.exec(text)) !== null) {
    const slug = m[1].replace(/\.git$/, "").replace(/\/+$/, "");
    if (!seen.has(slug)) {
      seen.add(slug);
      projects.push({ name: slug.split("/")[1], repoSlug: slug, source: "github_url" });
    }
  }

  const glRe = new RegExp(GITLAB_URL_RE.source, "g");
  while ((m = glRe.exec(text)) !== null) {
    const slug = m[1].replace(/\.git$/, "").replace(/\/+$/, "");
    if (!seen.has(slug)) {
      seen.add(slug);
      projects.push({ name: slug.split("/")[1], repoSlug: slug, source: "gitlab_url" });
    }
  }

  const lower = text.toLowerCase();
  for (const [name, slug] of Object.entries(KNOWN_PROJECTS)) {
    if (seen.has(slug)) continue;
    const wordRe = new RegExp(`\\b${name}\\b`, "i");
    if (wordRe.test(lower)) {
      seen.add(slug);
      projects.push({ name, repoSlug: slug, source: "known_project" });
    }
  }

  return projects.slice(0, 10);
}

const COMMON_STDLIB = new Set([
  "main", "init", "setup", "test", "run", "start", "stop", "open", "close",
  "read", "write", "print", "println", "printf", "sprintf", "log", "error",
  "exit", "return", "break", "continue", "if", "else", "for", "while",
  "switch", "case", "try", "catch", "throw", "new", "delete", "sizeof",
  "typeof", "instanceof", "import", "export", "require", "include",
  "malloc", "free", "realloc", "calloc", "memcpy", "memset", "strlen",
  "strcmp", "strcpy", "strcat", "atoi", "atof",
]);

function extractCodeReferences(text: string): { functions: string[]; filePaths: string[] } {
  const functions: string[] = [];
  const filePaths: string[] = [];
  const seenFns = new Set<string>();
  const seenPaths = new Set<string>();

  const fnPatterns = [
    /(?:function|method|routine|handler|callback)\s+[`']?([a-zA-Z_]\w{2,}(?:::\w+)*)[`']?\s*\(/g,
    /(?:in|at|from)\s+([a-zA-Z_]\w{2,}(?:::\w+)*)\s*\(/g,
    /([a-zA-Z_]\w{2,}(?:::\w+)*)\s*\([^)]*\)\s*(?:\{|=>|:)/g,
  ];

  for (const pattern of fnPatterns) {
    const re = new RegExp(pattern.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const fn = m[1];
      if (!COMMON_STDLIB.has(fn.toLowerCase()) && !seenFns.has(fn) && fn.length <= 80) {
        seenFns.add(fn);
        functions.push(fn);
      }
    }
  }

  const filePathRe = /(?:^|\s|`|'|"|\/)((?:[a-zA-Z0-9_.-]+\/){1,8}[a-zA-Z0-9_.-]+\.[a-zA-Z]{1,6})(?:\s|`|'|"|:|$|,|\))/gm;
  let pm: RegExpExecArray | null;
  while ((pm = filePathRe.exec(text)) !== null) {
    const fp = pm[1];
    if (!seenPaths.has(fp) && fp.length <= 200 && !fp.startsWith("http")) {
      seenPaths.add(fp);
      filePaths.push(fp);
    }
  }

  return { functions: functions.slice(0, 20), filePaths: filePaths.slice(0, 20) };
}

async function githubFetch(url: string): Promise<{ ok: boolean; status: number; data?: unknown }> {
  const cacheKey = "gh:" + url;
  const cached = cacheGet<{ ok: boolean; status: number; data?: unknown }>(cacheKey);
  if (cached) return cached;

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "VulnRap/2.1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeout);

    const result = {
      ok: resp.ok,
      status: resp.status,
      data: resp.ok ? await resp.json() : undefined,
    };
    cacheSet(cacheKey, result);
    return result;
  } catch {
    return { ok: false, status: 0 };
  }
}

async function verifyGitHubReferences(
  repoSlug: string,
  refs: { functions: string[]; filePaths: string[] }
): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  let checksPerformed = 0;
  const MAX_CHECKS = 5;

  for (const fp of refs.filePaths) {
    if (checksPerformed >= MAX_CHECKS) break;
    checksPerformed++;

    const url = `https://api.github.com/repos/${repoSlug}/contents/${encodeURIComponent(fp)}`;
    const resp = await githubFetch(url);
    await delay(200);

    if (resp.ok) {
      checks.push({
        type: "github_file_verified",
        target: `${repoSlug}:${fp}`,
        result: "verified",
        detail: `File path "${fp}" exists in ${repoSlug}`,
        weight: -8,
      });
    } else if (resp.status === 404) {
      checks.push({
        type: "github_file_missing",
        target: `${repoSlug}:${fp}`,
        result: "not_found",
        detail: `File path "${fp}" does not exist in ${repoSlug}`,
        weight: 20,
      });
    } else if (resp.status === 403) {
      checks.push({
        type: "github_rate_limited",
        target: repoSlug,
        result: "error",
        detail: "GitHub API rate limit reached",
        weight: 0,
      });
      break;
    }
  }

  for (const fn of refs.functions) {
    if (checksPerformed >= MAX_CHECKS) break;
    checksPerformed++;

    const searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(fn)}+repo:${repoSlug}&per_page=1`;
    const resp = await githubFetch(searchUrl);
    await delay(200);

    if (resp.ok && resp.data) {
      const d = resp.data as { total_count?: number };
      if ((d.total_count ?? 0) > 0) {
        checks.push({
          type: "github_function_verified",
          target: `${repoSlug}:${fn}`,
          result: "verified",
          detail: `Function/symbol "${fn}" found in ${repoSlug}`,
          weight: -8,
        });
      } else {
        checks.push({
          type: "github_function_missing",
          target: `${repoSlug}:${fn}`,
          result: "not_found",
          detail: `Function/symbol "${fn}" not found in ${repoSlug}`,
          weight: 20,
        });
      }
    } else if (resp.status === 403) {
      checks.push({
        type: "github_rate_limited",
        target: repoSlug,
        result: "error",
        detail: "GitHub API rate limit reached",
        weight: 0,
      });
      break;
    }
  }

  return checks;
}

const CVE_ID_RE = /CVE-(\d{4})-(\d{4,})/g;

interface NvdVulnerability {
  cve?: {
    id?: string;
    descriptions?: Array<{ lang?: string; value?: string }>;
  };
}

async function nvdFetch(cveId: string): Promise<{ found: boolean; description?: string }> {
  const cacheKey = "nvd:" + cveId;
  const cached = cacheGet<{ found: boolean; description?: string }>(cacheKey);
  if (cached) return cached;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const url = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cveId}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "VulnRap/2.1" },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const result = { found: false };
      if (resp.status === 404 || resp.status === 200) cacheSet(cacheKey, result);
      return result;
    }

    const data = (await resp.json()) as { vulnerabilities?: NvdVulnerability[] };
    const vulns = data.vulnerabilities ?? [];
    if (vulns.length === 0) {
      const result = { found: false };
      cacheSet(cacheKey, result);
      return result;
    }

    const desc = vulns[0]?.cve?.descriptions?.find((d) => d.lang === "en")?.value ?? "";
    const result = { found: true, description: desc };
    cacheSet(cacheKey, result);
    return result;
  } catch {
    return { found: false };
  }
}

function computePhraseSimilarity(reportText: string, nvdDescription: string): number {
  if (!nvdDescription || nvdDescription.length < 20) return 0;

  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
  const reportNorm = normalize(reportText);
  const nvdNorm = normalize(nvdDescription);

  const nvdWords = nvdNorm.split(/\s+/).filter((w) => w.length > 3);
  if (nvdWords.length < 4) return 0;

  const PHRASE_LEN = 4;
  const nvdPhrases = new Set<string>();
  for (let i = 0; i <= nvdWords.length - PHRASE_LEN; i++) {
    nvdPhrases.add(nvdWords.slice(i, i + PHRASE_LEN).join(" "));
  }

  const reportWords = reportNorm.split(/\s+/).filter((w) => w.length > 3);
  let matched = 0;
  for (let i = 0; i <= reportWords.length - PHRASE_LEN; i++) {
    const phrase = reportWords.slice(i, i + PHRASE_LEN).join(" ");
    if (nvdPhrases.has(phrase)) matched++;
  }

  const totalPhrases = Math.max(1, nvdPhrases.size);
  return Math.round((matched / totalPhrases) * 100);
}

async function verifyCveReferences(text: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = [];
  const cveRe = new RegExp(CVE_ID_RE.source, "g");
  const cves: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;

  while ((m = cveRe.exec(text)) !== null) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      cves.push(m[0]);
    }
  }

  for (const cveId of cves.slice(0, 3)) {
    const year = parseInt(cveId.split("-")[1]);
    const currentYear = new Date().getFullYear();
    if (year > currentYear + 1 || year < 1999) continue;

    const result = await nvdFetch(cveId);
    await delay(300);

    if (!result.found) {
      checks.push({
        type: "cve_not_in_nvd",
        target: cveId,
        result: "not_found",
        detail: `${cveId} not found in NVD — may be recently assigned, reserved, or non-existent`,
        weight: 20,
      });
    } else {
      const similarity = result.description ? computePhraseSimilarity(text, result.description) : 0;

      if (similarity > 30) {
        checks.push({
          type: "nvd_plagiarism",
          target: cveId,
          result: "warning",
          detail: `Report shares ${similarity}% phrase overlap with NVD description for ${cveId} — possible copy-paste from NVD`,
          weight: 15,
        });
      } else {
        checks.push({
          type: "verified_cve",
          target: cveId,
          result: "verified",
          detail: `${cveId} confirmed in NVD with independent description (${similarity}% overlap)`,
          weight: -5,
        });
      }
    }
  }

  return checks;
}

const TEXTBOOK_PAYLOADS = [
  /alert\s*\(\s*['"]?(?:1|xss|document\.cookie)['"]?\s*\)/i,
  /(?:'\s*(?:or|and)\s+['"]?1['"]?\s*=\s*['"]?1|or\s+1\s*=\s*1|union\s+select)/i,
  /(?:\/etc\/passwd|\/etc\/shadow|\/proc\/self)/i,
  /(?:169\.254\.169\.254|metadata\.google|100\.100\.100\.200)/i,
  /(?:<script>alert\(|<img\s+src=x\s+onerror=)/i,
  /(?:\$\{jndi:|%24%7Bjndi)/i,
  /(?:nc\s+-(?:e|lvp)|\/bin\/(?:sh|bash)\s+-i)/i,
];

const PLACEHOLDER_DOMAINS_SET = new Set([
  "example.com", "example.org", "example.net", "target.com",
  "vulnerable-server.com", "vulnerable-app.com", "victim.com",
  "attacker.com", "evil.com", "malicious.com", "test.com",
  "testsite.com", "yoursite.com", "yourapp.com", "yourdomain.com",
  "company.com", "acme.com", "foo.com", "bar.com", "webapp.com",
  "myapp.com", "site.com",
]);

function checkPocPlausibility(text: string): VerificationCheck[] {
  const checks: VerificationCheck[] = [];

  const curlWgetBlocks = text.match(/(?:curl|wget|python|ruby|perl)\s+[^\n]{10,}/gi) ?? [];

  for (const cmd of curlWgetBlocks.slice(0, 10)) {
    const cmdLower = cmd.toLowerCase();
    const hasPlaceholderDomain = [...PLACEHOLDER_DOMAINS_SET].some((d) => cmdLower.includes(d));
    const hasTextbookPayload = TEXTBOOK_PAYLOADS.some((p) => p.test(cmd));

    if (hasPlaceholderDomain && hasTextbookPayload) {
      checks.push({
        type: "poc_placeholder_textbook",
        target: cmd.slice(0, 100),
        result: "warning",
        detail: "PoC combines a placeholder domain with a textbook payload — likely templated, not from real testing",
        weight: 12,
      });
    }
  }

  const httpResponseBlocks = text.match(/HTTP\/[\d.]+\s+\d{3}[\s\S]*?(?:\n\n|\r\n\r\n|$)/g) ?? [];

  for (const block of httpResponseBlocks.slice(0, 5)) {
    const hasDate = /^date:\s/im.test(block);
    const hasServer = /^server:\s/im.test(block);
    const hasContentLength = /^content-length:\s/im.test(block);
    const headerCount = (block.match(/^[a-zA-Z][\w-]*:\s/gm) ?? []).length;

    if (headerCount < 2 && !hasDate && !hasServer && !hasContentLength) {
      checks.push({
        type: "poc_fabricated_response",
        target: block.slice(0, 80),
        result: "warning",
        detail: "HTTP response lacks realistic headers (Date, Server, Content-Length) — possibly fabricated",
        weight: 10,
      });
    }
  }

  return checks;
}

function computeVerificationScore(checks: VerificationCheck[]): number {
  const NEUTRAL = 50;
  let adjustment = 0;

  for (const check of checks) {
    adjustment += check.weight;
  }

  const score = Math.max(0, Math.min(100, NEUTRAL + adjustment));
  return score;
}

function buildTriageNotes(checks: VerificationCheck[], projects: DetectedProject[]): string[] {
  const notes: string[] = [];

  const verified = checks.filter((c) => c.result === "verified");
  const notFound = checks.filter((c) => c.result === "not_found");
  const warnings = checks.filter((c) => c.result === "warning");

  if (verified.length > 0) {
    notes.push(
      `${verified.length} reference(s) verified against external sources — indicates real research.`
    );
  }

  if (notFound.length > 0) {
    const targets = notFound.map((c) => c.target).join(", ");
    notes.push(
      `${notFound.length} reference(s) could not be verified: ${targets}. Consider asking the reporter for clarification.`
    );
  }

  const nvdPlag = warnings.filter((c) => c.type === "nvd_plagiarism");
  if (nvdPlag.length > 0) {
    notes.push(
      "Report text closely matches NVD description(s) — may be a copy-paste rather than original analysis."
    );
  }

  const pocIssues = warnings.filter(
    (c) => c.type === "poc_placeholder_textbook" || c.type === "poc_fabricated_response"
  );
  if (pocIssues.length > 0) {
    notes.push(
      "PoC evidence appears templated or fabricated. Request the reporter to demonstrate against the actual target."
    );
  }

  if (projects.length > 0 && verified.length === 0 && notFound.length === 0) {
    notes.push(
      `Report references ${projects.map((p) => p.name).join(", ")} but no specific code references could be automatically verified.`
    );
  }

  return notes;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function performActiveVerification(text: string): Promise<VerificationResult> {
  const cacheKey = contentCacheKey("verify", text);
  const cached = cacheGet<VerificationResult>(cacheKey);
  if (cached) return cached;

  const detectedProjects = detectProjects(text);
  const codeRefs = extractCodeReferences(text);
  const allChecks: VerificationCheck[] = [];

  const githubProjects = detectedProjects.filter(
    (p) => p.source === "github_url" || p.source === "known_project"
  );

  if (githubProjects.length > 0 && (codeRefs.functions.length > 0 || codeRefs.filePaths.length > 0)) {
    const topProject = githubProjects[0];
    const ghChecks = await verifyGitHubReferences(topProject.repoSlug, codeRefs);
    allChecks.push(...ghChecks);
  }

  const cveChecks = await verifyCveReferences(text);
  allChecks.push(...cveChecks);

  const pocChecks = checkPocPlausibility(text);
  allChecks.push(...pocChecks);

  const score = computeVerificationScore(allChecks);
  const triageNotes = buildTriageNotes(allChecks, detectedProjects);

  const summary: VerificationSummary = {
    verified: allChecks.filter((c) => c.result === "verified").length,
    notFound: allChecks.filter((c) => c.result === "not_found").length,
    warnings: allChecks.filter((c) => c.result === "warning").length,
    errors: allChecks.filter((c) => c.result === "error").length,
  };

  const result: VerificationResult = {
    checks: allChecks,
    summary,
    triageNotes,
    score,
    detectedProjects,
  };

  cacheSet(cacheKey, result);
  return result;
}
