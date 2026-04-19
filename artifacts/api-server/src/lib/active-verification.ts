import { createHash } from "crypto";
import { registerCvePublicationDate } from "./triage-recommendation";
import { persistentCacheGet, persistentCacheSet, type TtlCategory } from "./cache-service";

export interface VerificationCheck {
  type: string;
  target: string;
  result: "verified" | "not_found" | "warning" | "error" | "skipped" | "info";
  detail: string;
  weight: number;
  cacheSource?: "l1" | "db" | "fresh";
}

export interface VerificationSummary {
  verified: number;
  notFound: number;
  warnings: number;
  errors: number;
}

export interface CacheMetadata {
  hits: { l1: number; db: number; fresh: number };
}

export interface VerificationResult {
  checks: VerificationCheck[];
  summary: VerificationSummary;
  triageNotes: string[];
  score: number;
  detectedProjects: DetectedProject[];
  cacheMetadata?: CacheMetadata;
}

interface DetectedProject {
  name: string;
  repoSlug: string;
  source: string;
}

const cacheTracker = { l1: 0, db: 0, fresh: 0 };

function resetCacheTracker(): void {
  cacheTracker.l1 = 0;
  cacheTracker.db = 0;
  cacheTracker.fresh = 0;
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

  const npmRe = new RegExp(NPM_PACKAGE_RE.source, "g");
  while ((m = npmRe.exec(text)) !== null) {
    const pkg = m[1].replace(/['"].*$/, "").trim();
    if (pkg && !seen.has(`npm:${pkg}`) && pkg.length > 1 && pkg.length <= 100) {
      seen.add(`npm:${pkg}`);
      projects.push({ name: pkg, repoSlug: pkg, source: "npm_package" });
    }
  }

  const pypiRe = new RegExp(PYPI_PACKAGE_RE.source, "g");
  while ((m = pypiRe.exec(text)) !== null) {
    const pkg = m[1].trim();
    const PYTHON_STDLIB = new Set(["os", "sys", "re", "json", "time", "datetime", "math", "random", "io", "typing", "collections", "itertools", "functools", "pathlib", "subprocess", "socket", "http", "urllib", "hashlib", "base64", "struct", "copy", "enum", "abc", "logging", "unittest", "argparse", "csv", "xml", "html", "string", "textwrap", "shutil", "glob", "tempfile", "threading", "multiprocessing", "asyncio", "contextlib", "dataclasses", "inspect", "traceback", "warnings", "signal", "ctypes"]);
    if (pkg && !seen.has(`pypi:${pkg}`) && pkg.length > 1 && pkg.length <= 100 && !PYTHON_STDLIB.has(pkg.toLowerCase())) {
      seen.add(`pypi:${pkg}`);
      projects.push({ name: pkg, repoSlug: pkg, source: "pypi_package" });
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

type GhResult = { ok: boolean; status: number; data?: unknown };

function classifyGithubTtl(url: string): TtlCategory {
  if (/\/tags\b/.test(url) || /\/releases\b/.test(url)) return "immutable";
  if (/\/contents\//.test(url) && /ref=/.test(url)) return "immutable";
  if (/\/contents\//.test(url)) return "mutable";
  if (/\/search\//.test(url)) return "mutable";
  return "mutable";
}

async function githubFetch(url: string): Promise<GhResult & { cacheSource?: "l1" | "db" | "fresh" }> {
  const cacheKey = "gh:" + url;
  const cached = await persistentCacheGet<GhResult>(cacheKey);
  if (cached) {
    cacheTracker[cached.source]++;
    return { ...cached.value, cacheSource: cached.source };
  }

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

    const result: GhResult = {
      ok: resp.ok,
      status: resp.status,
      data: resp.ok ? await resp.json() : undefined,
    };

    if (resp.ok || resp.status === 404) {
      const ttlCategory = classifyGithubTtl(url);
      await persistentCacheSet(cacheKey, result, ttlCategory);
    }

    cacheTracker.fresh++;
    return { ...result, cacheSource: "fresh" };
  } catch {
    cacheTracker.fresh++;
    return { ok: false, status: 0, cacheSource: "fresh" };
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

    const encodedPath = fp.split("/").map(encodeURIComponent).join("/");
    const url = `https://api.github.com/repos/${repoSlug}/contents/${encodedPath}`;
    const resp = await githubFetch(url);
    await delay(200);

    if (resp.status === 0) {
      checks.push({
        type: "github_api_error",
        target: `${repoSlug}:${fp}`,
        result: "error",
        detail: `GitHub API unreachable while verifying "${fp}"`,
        weight: 0,
        cacheSource: resp.cacheSource,
      });
      continue;
    } else if (resp.ok) {
      checks.push({
        type: "github_file_verified",
        target: `${repoSlug}:${fp}`,
        result: "verified",
        detail: `File path "${fp}" exists in ${repoSlug}`,
        weight: -8,
        cacheSource: resp.cacheSource,
      });
    } else if (resp.status === 404) {
      checks.push({
        type: "github_file_missing",
        target: `${repoSlug}:${fp}`,
        result: "not_found",
        detail: `File path "${fp}" does not exist in ${repoSlug}`,
        weight: 20,
        cacheSource: resp.cacheSource,
      });
    } else if (resp.status === 403) {
      checks.push({
        type: "github_rate_limited",
        target: repoSlug,
        result: "error",
        detail: "GitHub API rate limit reached",
        weight: 0,
        cacheSource: resp.cacheSource,
      });
      break;
    } else {
      checks.push({
        type: "github_api_error",
        target: `${repoSlug}:${fp}`,
        result: "error",
        detail: `GitHub API returned ${resp.status} while verifying "${fp}"`,
        weight: 0,
        cacheSource: resp.cacheSource,
      });
    }
  }

  for (const fn of refs.functions) {
    if (checksPerformed >= MAX_CHECKS) break;
    checksPerformed++;

    const searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(fn)}+repo:${repoSlug}&per_page=1`;
    const resp = await githubFetch(searchUrl);
    await delay(200);

    if (resp.status === 0) {
      checks.push({
        type: "github_api_error",
        target: `${repoSlug}:${fn}`,
        result: "error",
        detail: `GitHub API unreachable while searching for "${fn}"`,
        weight: 0,
        cacheSource: resp.cacheSource,
      });
      continue;
    } else if (resp.ok && resp.data) {
      const d = resp.data as { total_count?: number };
      if ((d.total_count ?? 0) > 0) {
        checks.push({
          type: "github_function_verified",
          target: `${repoSlug}:${fn}`,
          result: "verified",
          detail: `Function/symbol "${fn}" found in ${repoSlug}`,
          weight: -8,
          cacheSource: resp.cacheSource,
        });
      } else {
        checks.push({
          type: "github_function_missing",
          target: `${repoSlug}:${fn}`,
          result: "not_found",
          detail: `Function/symbol "${fn}" not found in ${repoSlug}`,
          weight: 20,
          cacheSource: resp.cacheSource,
        });
      }
    } else if (resp.status === 403) {
      checks.push({
        type: "github_rate_limited",
        target: repoSlug,
        result: "error",
        detail: "GitHub API rate limit reached",
        weight: 0,
        cacheSource: resp.cacheSource,
      });
      break;
    } else {
      checks.push({
        type: "github_api_error",
        target: `${repoSlug}:${fn}`,
        result: "error",
        detail: `GitHub API returned ${resp.status} while searching for "${fn}"`,
        weight: 0,
        cacheSource: resp.cacheSource,
      });
    }
  }

  return checks;
}

const CVE_ID_RE = /CVE-(\d{4})-(\d{4,})/g;

interface NvdVulnerability {
  cve?: {
    id?: string;
    published?: string;
    descriptions?: Array<{ lang?: string; value?: string }>;
  };
}

type NvdResult = { found: boolean; description?: string; published?: string; error?: boolean; cacheSource?: "l1" | "db" | "fresh" };

async function nvdFetch(cveId: string): Promise<NvdResult> {
  const cacheKey = "nvd:" + cveId;
  const cached = await persistentCacheGet<Omit<NvdResult, "cacheSource">>(cacheKey);
  if (cached) {
    cacheTracker[cached.source]++;
    return { ...cached.value, cacheSource: cached.source };
  }

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
      if (resp.status === 404) {
        const result = { found: false };
        await persistentCacheSet(cacheKey, result, "nvd");
        cacheTracker.fresh++;
        return { ...result, cacheSource: "fresh" };
      }
      cacheTracker.fresh++;
      return { found: false, error: true, cacheSource: "fresh" };
    }

    const data = (await resp.json()) as { vulnerabilities?: NvdVulnerability[] };
    const vulns = data.vulnerabilities ?? [];
    if (vulns.length === 0) {
      const result = { found: false };
      await persistentCacheSet(cacheKey, result, "nvd");
      cacheTracker.fresh++;
      return { ...result, cacheSource: "fresh" };
    }

    const desc = vulns[0]?.cve?.descriptions?.find((d) => d.lang === "en")?.value ?? "";
    const published = vulns[0]?.cve?.published ?? undefined;
    const result = { found: true, description: desc, published };
    await persistentCacheSet(cacheKey, result, "nvd");
    cacheTracker.fresh++;
    return { ...result, cacheSource: "fresh" };
  } catch {
    cacheTracker.fresh++;
    return { found: false, error: true, cacheSource: "fresh" };
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
    if (year > currentYear + 1 || year < 1999) {
      checks.push({
        type: "invalid_cve_year",
        target: cveId,
        result: "not_found",
        detail: `${cveId} has an implausible year (${year}) — likely fabricated`,
        weight: 25,
      });
      continue;
    }

    const nvdResult = await nvdFetch(cveId);
    await delay(300);

    if (nvdResult.error) {
      checks.push({
        type: "nvd_api_error",
        target: cveId,
        result: "error",
        detail: `NVD API error while looking up ${cveId} — skipped verification`,
        weight: 0,
        cacheSource: nvdResult.cacheSource,
      });
    } else if (!nvdResult.found) {
      const currentYear = new Date().getFullYear();
      const yearsOld = currentYear - year;

      let freshWeight: number;
      let freshType: string;
      let freshReason: string;

      if (yearsOld > 2) {
        freshWeight = 20;
        freshType = "fabricated_cve";
        freshReason = `${cveId} not found in NVD and is ${yearsOld} years old — likely fabricated`;
      } else if (yearsOld > 1) {
        freshWeight = 12;
        freshType = "stale_missing_cve";
        freshReason = `${cveId} not found in NVD (${yearsOld}yr old) — unusual but could be delayed publication`;
      } else {
        freshWeight = 3;
        freshType = "recent_cve_not_yet_published";
        freshReason = `${cveId} not yet in NVD — likely recently assigned (coordinated disclosure lag is normal)`;
      }

      checks.push({
        type: freshType,
        target: cveId,
        result: yearsOld <= 1 ? "info" : "not_found",
        detail: freshReason,
        weight: freshWeight,
        cacheSource: nvdResult.cacheSource,
      });
    } else {
      if (nvdResult.published) {
        registerCvePublicationDate(cveId, nvdResult.published);
      }
      const similarity = nvdResult.description ? computePhraseSimilarity(text, nvdResult.description) : 0;

      if (similarity > 30) {
        checks.push({
          type: "nvd_plagiarism",
          target: cveId,
          result: "warning",
          detail: `Report shares ${similarity}% phrase overlap with NVD description for ${cveId} — possible copy-paste from NVD`,
          weight: 15,
          cacheSource: nvdResult.cacheSource,
        });
      } else {
        checks.push({
          type: "verified_cve",
          target: cveId,
          result: "verified",
          detail: `${cveId} confirmed in NVD with independent description (${similarity}% overlap)`,
          weight: -5,
          cacheSource: nvdResult.cacheSource,
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
  let positiveSignals = 0;
  let negativeSignals = 0;
  let totalAdjustment = 0;

  for (const check of checks) {
    totalAdjustment += check.weight;
    if (check.weight > 0) negativeSignals++;
    else if (check.weight < 0) positiveSignals++;
  }

  const SINGLE_SIGNAL_CAP = 40;
  if (negativeSignals < 2 && totalAdjustment > 0) {
    const cappedScore = Math.min(NEUTRAL + totalAdjustment, SINGLE_SIGNAL_CAP);
    totalAdjustment = cappedScore - NEUTRAL;
  }

  if (positiveSignals >= 3 && negativeSignals === 0) {
    return Math.max(0, 10 - positiveSignals * 5);
  }

  const score = Math.max(0, Math.min(100, NEUTRAL + totalAdjustment));
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
  const cached = await persistentCacheGet<VerificationResult>(cacheKey);
  if (cached) {
    return { ...cached.value, cacheMetadata: { hits: { l1: cached.source === "l1" ? 1 : 0, db: cached.source === "db" ? 1 : 0, fresh: 0 } } };
  }

  resetCacheTracker();

  const detectedProjects = detectProjects(text);
  const codeRefs = extractCodeReferences(text);
  const allChecks: VerificationCheck[] = [];

  const githubProjects = detectedProjects.filter(
    (p) => p.source === "github_url" || p.source === "known_project"
  );
  const nonGithubProjects = detectedProjects.filter(
    (p) => p.source === "gitlab_url" || p.source === "npm_package" || p.source === "pypi_package"
  );

  for (const project of nonGithubProjects) {
    allChecks.push({
      type: "project_detected",
      target: project.name,
      result: "skipped",
      detail: `Detected ${project.source.replace("_", " ")} "${project.name}" — GitHub verification not applicable`,
      weight: 0,
    });
  }

  if (githubProjects.length > 0 && (codeRefs.functions.length > 0 || codeRefs.filePaths.length > 0)) {
    let totalGhChecks = 0;
    const MAX_TOTAL_GH_CHECKS = 5;
    for (const project of githubProjects) {
      if (totalGhChecks >= MAX_TOTAL_GH_CHECKS) break;
      const remainingBudget = MAX_TOTAL_GH_CHECKS - totalGhChecks;
      const limitedRefs = {
        filePaths: codeRefs.filePaths.slice(0, remainingBudget),
        functions: codeRefs.functions.slice(0, Math.max(0, remainingBudget - codeRefs.filePaths.length)),
      };
      const ghChecks = await verifyGitHubReferences(project.repoSlug, limitedRefs);
      allChecks.push(...ghChecks);
      totalGhChecks += ghChecks.length;
    }
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

  const cacheMetadata: CacheMetadata = {
    hits: { ...cacheTracker },
  };

  const result: VerificationResult = {
    checks: allChecks,
    summary,
    triageNotes,
    score,
    detectedProjects,
    cacheMetadata,
  };

  await persistentCacheSet(cacheKey, result, "mutable");
  return result;
}
