// Sprint 12 / Task #174 — additional default-path GOLD_SIGNAL detectors.
//
// Extends the three categories the legacy Engine 2 already emits in
// engines.ts (real_crash_trace, real_raw_http, code_diff — added in
// Task #170) with category-specific strong-evidence patterns the AVRI
// Engine 2 family rubrics already reward (avri/families.ts). Bringing
// equivalent rewards into the default path lets more genuinely
// well-evidenced reports clear the +6 BEHAVIORAL_MATCH_REWARD bonus and
// keeps the reward pathway stable when the AVRI flag is eventually
// retired.
//
// Each detector returns at most ONE indicator per category. Detectors
// run their own placeholder/fabrication validators so a slop report
// whose only "evidence" is a `<sql payload here>` slot or a
// `<!ENTITY xxe SYSTEM "<placeholder>">` does NOT earn a gold signal.
//
// Validators that need to discount placeholder bodies (`q=<inject>`)
// reuse the raw-HTTP placeholder evaluator + `stripPlaceholderBodies`
// already used by AVRI Engine 2 — so the two scoring paths agree on
// what counts as a fabricated payload.

import {
  evaluateRawHttpRequest,
  stripPlaceholderBodies,
} from "./avri/raw-http";

// Task #467 — re-export the shared plain-English labels for the gold
// category ids alongside `GOLD_SIGNAL_WEIGHTS` below so server-side
// callers can pick them up from the same module that defines the
// weights. Single source of truth lives in `@workspace/avri-rubric` so
// the vulnrap diagnostics panel and this server module cannot drift;
// the sync test in `gold-signals.test.ts` guarantees every weight key
// has a matching label.
export { GOLD_SIGNAL_LABELS } from "@workspace/avri-rubric";

export interface AdditionalGoldSignal {
  /** Stable id surfaced as the GOLD_SIGNAL indicator value. */
  id: string;
  /** Indicator strength used by the composite reward gate. */
  strength: "HIGH" | "MEDIUM" | "LOW";
  /** Human-readable explanation surfaced in diagnostics. */
  explanation: string;
}

// ---------------------------------------------------------------------------
// Per-category placeholder-body strip.
// ---------------------------------------------------------------------------

/** Lazily compute the placeholder-stripped variant of `text` so payload
 * detectors that reject placeholder-only matches all share one pass.
 * AVRI uses the same evaluator; passing `strictCrlf: false` matches the
 * AUTHN_AUTHZ / INJECTION setting used in engine2-avri.ts. */
function strippedText(text: string): string {
  const httpEval = evaluateRawHttpRequest(text, { strictCrlf: false });
  return stripPlaceholderBodies(text, httpEval);
}

// ---------------------------------------------------------------------------
// AUTHN_AUTHZ — authorization_header_swap
// ---------------------------------------------------------------------------

const AUTH_TOKEN_PLACEHOLDER_RE =
  /^(?:<[^>]*>|x{4,}|\.{3,}|y(?:our)?[_\-]?(?:token|jwt|bearer)|jwt[_\-]?token|bearer[_\-]?token|placeholder|todo|tbd|fixme|n\/?a|null|none|example|sample|fake|test)$/i;

const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

const AUTH_HEADER_BEARER_RE =
  /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._\-+/=]{8,})/i;

const SESSION_COOKIE_RE =
  /(?:Set-)?Cookie\s*:[^\n]*?(?:session(?:id)?|sid|auth|token|jwt)\s*=\s*([A-Za-z0-9._\-+/=%]{8,})/i;

function detectAuthToken(text: string): AdditionalGoldSignal | null {
  // A bona fide JWT anywhere in the report is sufficient on its own.
  if (JWT_RE.test(text)) {
    return {
      id: "auth_token",
      strength: "HIGH",
      explanation:
        "Authentication footprint: concrete JWT (header.payload.signature) present.",
    };
  }
  const bearer = AUTH_HEADER_BEARER_RE.exec(text);
  if (bearer) {
    const token = bearer[1].trim();
    if (!AUTH_TOKEN_PLACEHOLDER_RE.test(token) && token.length >= 16) {
      return {
        id: "auth_token",
        strength: "HIGH",
        explanation: `Authentication footprint: Authorization Bearer header with concrete ${token.length}-char token.`,
      };
    }
  }
  const cookie = SESSION_COOKIE_RE.exec(text);
  if (cookie) {
    const value = cookie[1].trim();
    if (!AUTH_TOKEN_PLACEHOLDER_RE.test(value) && value.length >= 12) {
      return {
        id: "auth_token",
        strength: "HIGH",
        explanation: `Authentication footprint: session cookie with concrete ${value.length}-char value.`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// INJECTION — concrete_payload (SQL subset)
// ---------------------------------------------------------------------------

const SQL_INJECTION_PAYLOAD_RE =
  /\b(?:union\s+(?:all\s+)?select|or\s+(?:1|true)\s*=\s*(?:1|true)|;\s*drop\s+table|sleep\s*\(\s*\d+\s*\)|benchmark\s*\(\s*\d+\s*,|xp_cmdshell|extractvalue\s*\(|updatexml\s*\(|pg_sleep\s*\(\s*\d+\s*\))/i;

function detectSqlInjectionPayload(
  text: string,
  stripped: string,
): AdditionalGoldSignal | null {
  if (!SQL_INJECTION_PAYLOAD_RE.test(text)) return null;
  // Re-test against placeholder-stripped text: if the only match was
  // inside a `<sql payload here>` slot or `Payload: <inject>` prose, the
  // stripped variant won't match and we drop the gold signal.
  if (!SQL_INJECTION_PAYLOAD_RE.test(stripped)) return null;
  return {
    id: "sql_injection_payload",
    strength: "HIGH",
    explanation: "SQL injection payload bytes present (UNION SELECT / OR 1=1 / SLEEP / BENCHMARK / xp_cmdshell / etc.).",
  };
}

// ---------------------------------------------------------------------------
// INJECTION — concrete_payload (command/JNDI subset)
// ---------------------------------------------------------------------------

// Opening backtick + $(...) command substitution, OR ;cmd, OR JNDI.
const CMD_INJECTION_PAYLOAD_RE =
  /(?:;\s*(?:cat|ls|id|whoami|uname|nc|wget|curl|bash|sh|chmod|chown)\s|\|\s*(?:cat|ls|id|whoami|nc|sh|bash)\b|\$\([^)\n]{2,}\)|`[^`\n]*\$\([^)\n]{2,}\)[^`\n]*`|\$\{jndi:(?:ldap|rmi|dns)s?:\/\/)/i;

function detectCommandInjectionPayload(
  text: string,
  stripped: string,
): AdditionalGoldSignal | null {
  if (!CMD_INJECTION_PAYLOAD_RE.test(text)) return null;
  if (!CMD_INJECTION_PAYLOAD_RE.test(stripped)) return null;
  return {
    id: "command_injection_payload",
    strength: "HIGH",
    explanation: "Command/JNDI injection payload bytes present (e.g. ;cat /etc/passwd, $(...), ${jndi:ldap://...}).",
  };
}

// ---------------------------------------------------------------------------
// WEB_CLIENT — concrete_payload (XSS)
// ---------------------------------------------------------------------------

// Real XSS payloads embed an active sink: alert/prompt/confirm/cookie/fetch.
const XSS_PAYLOAD_RE =
  /<script\b[^>]*>[\s\S]{0,200}?(?:alert|prompt|confirm|document\.cookie|document\.location|window\.location|fetch\s*\(|eval\s*\()|<img\b[^>]+onerror\s*=\s*["']?[^"'<>\n]{1,80}\(|<svg\b[^>]+onload\s*=\s*["']?[^"'<>\n]{1,80}\(|<iframe\b[^>]+srcdoc\s*=\s*["']?[^"'\n]{1,80}<script|javascript:\s*(?:alert|prompt|document\.cookie|fetch)\s*\(/i;

function detectXssPayload(
  text: string,
  stripped: string,
): AdditionalGoldSignal | null {
  if (!XSS_PAYLOAD_RE.test(text)) return null;
  if (!XSS_PAYLOAD_RE.test(stripped)) return null;
  return {
    id: "xss_payload",
    strength: "HIGH",
    explanation: "Concrete XSS payload with active sink (alert/cookie/fetch/onerror/etc.).",
  };
}

// ---------------------------------------------------------------------------
// WEB_CLIENT — ssrf_internal_metadata
// ---------------------------------------------------------------------------

// Concrete cloud-metadata target with a path component (mirrors the AVRI
// rubric, which itself encodes the placeholder check by demanding the
// path).
const SSRF_METADATA_RE =
  /https?:\/\/169\.254\.169\.254\/[\w\-./]+|metadata\.google\.internal\/computeMetadata\/v\d[\w\-./]*|169\.254\.169\.254\/latest\/meta-data\/[\w\-./]+|metadata\.azure\.com\/metadata\/[\w\-./]+/i;

function detectSsrfMetadataTarget(text: string): AdditionalGoldSignal | null {
  if (!SSRF_METADATA_RE.test(text)) return null;
  return {
    id: "ssrf_metadata_target",
    strength: "HIGH",
    explanation: "SSRF target: cloud-metadata URL with concrete path (e.g. /latest/meta-data/iam/...).",
  };
}

// ---------------------------------------------------------------------------
// WEB_CLIENT — path_traversal_payload
// ---------------------------------------------------------------------------

// Mirrors AVRI's path-traversal pattern: a traversal sequence reaching a
// known-sensitive file. The sensitive-file requirement IS the placeholder
// guard — `../<placeholder>` won't match.
const PATH_TRAVERSAL_PAYLOAD_RE =
  /(?:\.\.\/|\.\.\\|\.\.%2f|\.\.%5c|%2e%2e[\/]|%252e%252e[\/%]).{0,80}(?:passwd|shadow|hosts|boot\.ini|win\.ini|\/etc\/|\/proc\/|secret|\.aws\/|id_rsa|web\.config|\.ssh\/)/i;

function detectPathTraversalPayload(
  text: string,
  stripped: string,
): AdditionalGoldSignal | null {
  if (!PATH_TRAVERSAL_PAYLOAD_RE.test(text)) return null;
  if (!PATH_TRAVERSAL_PAYLOAD_RE.test(stripped)) return null;
  return {
    id: "path_traversal_payload",
    strength: "HIGH",
    explanation: "Path traversal payload reaching a sensitive file (e.g. ../../etc/passwd).",
  };
}

// ---------------------------------------------------------------------------
// DESERIALIZATION — xxe_doctype_entity
// ---------------------------------------------------------------------------

// XXE DOCTYPE/ENTITY with a concrete file:/http:/gopher:/ftp:/expect: URI.
// We require a non-placeholder URI body — angle-bracketed slot markers,
// "PLACEHOLDER", "<file path>", etc. don't count.
const XXE_DOCTYPE_RE =
  /<!doctype\b[^\[]*\[[\s\S]*?<!entity\s+\w+\s+system\s+["'](?<uri>(?:file|http|gopher|ftp|expect):[^"'\n>]+)["']/i;

const XXE_URI_PLACEHOLDER_RE =
  /<[^>]*>|placeholder|your[_\-]?(?:file|host|target)|insert|tbd|todo|fixme|example\.com\/?$/i;

function detectXxeExternalEntity(text: string): AdditionalGoldSignal | null {
  const m = XXE_DOCTYPE_RE.exec(text);
  if (!m) return null;
  const uri = (m.groups?.uri ?? "").trim();
  if (!uri) return null;
  if (XXE_URI_PLACEHOLDER_RE.test(uri)) return null;
  // Sanity: file: / http: / gopher: needs at least a path or host beyond
  // the scheme.
  if (/^(?:file|http|gopher|ftp|expect):\/?\/?$/.test(uri)) return null;
  return {
    id: "xxe_external_entity",
    strength: "HIGH",
    explanation: `XML external entity declaration with concrete URI (${uri.slice(0, 60)}${uri.length > 60 ? "…" : ""}).`,
  };
}

// ---------------------------------------------------------------------------
// DESERIALIZATION — concrete_gadget_or_payload
// ---------------------------------------------------------------------------

// Concrete gadget/sink invocation. Mere mentions of "ysoserial" or
// "deserialization gadget" without a chain or call site don't count.
const DESERIALIZATION_GADGET_RE =
  /\bysoserial\b[^\n]*\bCommonsCollections\d+|\bmarshalsec\b[^\n]*\b(?:JSON|YAML|XML)\b|\bpickle\.loads?\s*\(\s*b['"]\\x|\byaml\.unsafe_load\s*\(|\bnew\s+ObjectInputStream\s*\([\s\S]{0,80}?\.readObject\s*\(|\bnode-serialize\b[\s\S]{0,80}?unserialize\s*\(|\bfastjson\b[\s\S]{0,80}?@type/i;

function detectDeserializationGadget(text: string): AdditionalGoldSignal | null {
  if (!DESERIALIZATION_GADGET_RE.test(text)) return null;
  return {
    id: "deserialization_gadget",
    strength: "HIGH",
    explanation: "Concrete deserialization gadget chain or unsafe-load sink invocation present.",
  };
}

// ---------------------------------------------------------------------------
// CRYPTO — specific_misuse
// ---------------------------------------------------------------------------

// Specific misuse: static/hardcoded/zero IV/nonce/key/salt; ECB mode;
// MD5( / SHA1( call; explicit DES/3DES/RC4 use.
const CRYPTO_MISUSE_RE =
  /\b(?:static|hardcoded|reused|fixed|null|zero|all[\s_-]?zeros?)\s+(?:iv|nonce|key|salt)\b|\bECB\s+mode\b|\bAES[-_]?\d*[-_]?ECB\b|\bMD5\s*\(|\bSHA-?1\s*\(|new\s+Cipher\s*\(\s*["'](?:DES|3DES|RC4|AES\/ECB)|Cipher\.getInstance\s*\(\s*["'](?:DES|RC4|AES\/ECB)|hashlib\.(?:md5|sha1)\s*\(/i;

const CRYPTO_PLACEHOLDER_RE =
  /<(?:key|iv|nonce|salt|hash)[^>]*>|YOUR_[A-Z_]+_(?:KEY|IV|HASH)/i;

function detectCryptoMisuse(text: string): AdditionalGoldSignal | null {
  if (!CRYPTO_MISUSE_RE.test(text)) return null;
  // Look for the matched substring; if the only context around it is a
  // placeholder slot, drop the signal. We re-test the match against a
  // window of surrounding text — when that window only contains the
  // placeholder vocabulary, no gold.
  const m = CRYPTO_MISUSE_RE.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - 40);
  const end = Math.min(text.length, m.index + m[0].length + 40);
  const window = text.slice(start, end);
  if (CRYPTO_PLACEHOLDER_RE.test(window) && !/[a-f0-9]{16,}/i.test(window)) {
    // Window contains a placeholder marker AND no concrete hex value —
    // most likely a slop "uses MD5(<HASH>)" reference.
    return null;
  }
  return {
    id: "crypto_misuse",
    strength: "MEDIUM",
    explanation: "Concrete crypto misuse pattern (static IV/nonce, hardcoded key, ECB mode, MD5/SHA1, DES/3DES/RC4).",
  };
}

// ---------------------------------------------------------------------------
// RACE_CONCURRENCY — filesystem_toctou
// ---------------------------------------------------------------------------

// Mirrors AVRI's filesystem_toctou pattern: access/stat/lstat/fstatat
// followed within ~200 chars by open/fopen/openat/symlink. Real code OR
// shell-script style (`stat /path` … `openat AT_FDCWD /path`), not just
// claims of TOCTOU. Each "call" is either:
//   - paren-form:   access(path), stat(path)
//   - command-form: stat /path, openat AT_FDCWD /path
const TOCTOU_CHECK_RE =
  /\b(?:access|stat|lstat|fstatat)\s*(?:\([^)\n]+\)|\s+(?:[\/\$\w][^\n;()]{0,80}))/.source;
const TOCTOU_USE_RE =
  /\b(?:open|fopen|openat|symlink|creat)\s*(?:\(|\s+(?:[\/\$\w]|AT_FDCWD\b))/.source;
const FILESYSTEM_TOCTOU_RE = new RegExp(
  `${TOCTOU_CHECK_RE}[\\s\\S]{0,200}${TOCTOU_USE_RE}`,
  "i",
);

// Reject when the access/stat/open argument itself is a placeholder
// slot — slop authors write "TOCTOU pattern: access(<file>) … open(<file>)"
// or shell-form "stat <file> ; open <file>".
const FILESYSTEM_TOCTOU_PLACEHOLDER_RE =
  /\b(?:access|stat|lstat|fstatat|open|fopen|openat|symlink)\s*(?:\(\s*<[^>)]*>\s*\)|\s+<[^>\n]*>)/i;

function detectFilesystemToctou(text: string): AdditionalGoldSignal | null {
  if (!FILESYSTEM_TOCTOU_RE.test(text)) return null;
  if (FILESYSTEM_TOCTOU_PLACEHOLDER_RE.test(text)) return null;
  return {
    id: "filesystem_toctou",
    strength: "MEDIUM",
    explanation: "Filesystem TOCTOU pattern: stat()/access() followed by open()/symlink() on related paths.",
  };
}

// ---------------------------------------------------------------------------
// Per-category substance score weights (Task #240).
// ---------------------------------------------------------------------------
//
// AVRI Engine 2 (avri/engine2-avri.ts) awards each family gold signal between
// 8 and 22 points, normalizes by `calibratedMax = totalPossible * 0.55`, and
// blends 50/50 with the legacy substance score. The default Engine 2 path
// has no such blend, so the weights below translate AVRI's per-signal points
// into a smaller bonus on top of the legacy substance score (capped to keep
// the path bounded).
//
// Scaling rule of thumb (AVRI source weight in parentheses):
//   AVRI 22 → 5pt    AVRI 18-20 → 4pt    AVRI 12-14 → 3pt    AVRI ≤10 → 2pt
//
// The cap (GOLD_SIGNAL_BONUS_CAP, applied in engines.ts) keeps even a
// fully-evidenced report's bonus bounded, mirroring the strengthBonus
// (max +15) and the AVRI baseScore cap (max 84). The combined effect on
// substance is therefore bounded by ~25pt, which is consistent with how
// far a maximally-evidenced report can move under AVRI alone.
//
// Per-category rationale:
//   - sql_injection_payload  (5)  INJECTION/concrete_payload=22.
//     A real UNION SELECT, OR 1=1, SLEEP(), or BENCHMARK() payload IS the
//     textbook injection rubric proof — strongest weight.
//   - command_injection_payload (5)  INJECTION/concrete_payload=22.
//     `;cat /etc/passwd`, `$(...)`, JNDI Log4Shell — same rubric tier as
//     sql_injection_payload.
//   - xss_payload            (5)  WEB_CLIENT/concrete_payload=22.
//     `<script>alert(document.cookie)</script>` or onerror payloads with
//     active sinks — strongest WEB_CLIENT proof.
//   - ssrf_metadata_target   (4)  WEB_CLIENT/ssrf_internal_metadata=20.
//     Concrete cloud-metadata URL with path is highly specific; one notch
//     below the payload-class triad because the URL alone doesn't show
//     exploitation.
//   - path_traversal_payload (4)  WEB_CLIENT/path_traversal_payload=18.
//     `../../etc/passwd`-style with sensitive-file landing — mirrors AVRI 1:1.
//   - xxe_external_entity    (4)  DESERIALIZATION/xxe_doctype_entity=18.
//     `<!ENTITY xxe SYSTEM "file:///etc/passwd">` is the canonical XXE
//     proof — same tier as path_traversal_payload.
//   - deserialization_gadget (4)  DESERIALIZATION/concrete_gadget_or_payload=18.
//     ysoserial CommonsCollections1 / pickle.loads(b'\x...') / yaml.unsafe_load
//     — actual sink invocation, not just a name-drop.
//   - real_crash_trace       (5)  MEMORY_CORRUPTION/asan_or_sanitizer=22 +
//     stack_trace_with_offset=12. A non-stripped sanitizer trace with ≥3
//     resolved frames is the strongest MEMORY_CORRUPTION rubric proof.
//   - real_raw_http          (4)  REQUEST_SMUGGLING/raw_http_request=18.
//     Non-fabricated HTTP/1.x request bytes; gold-tier smuggling proof and
//     also strengthens INJECTION / AUTHN_AUTHZ reports.
//   - auth_token             (3)  AUTHN_AUTHZ/authorization_header_swap=12.
//     Concrete bearer/cookie value shows real session evidence rather than
//     a hand-wavy "use your token here" template.
//   - code_diff              (3)  FLAT/code_diff=12, also MEMORY_CORRUPTION
//     /code_diff_in_c=12 and WEB_CLIENT/code_diff_for_fix=10. Present
//     across nearly every family; meaningful but lower per-category weight
//     because diff hunks alone don't characterize the vulnerability class.
//   - crypto_misuse          (2)  CRYPTO/specific_misuse=10.
//     Static IV / ECB / hashlib.md5() — important but only one of three
//     crypto rubric prongs (specific_algo_or_lib + kat_or_test_vector
//     remain default-path absent), so deliberately lower than payload-class.
//   - filesystem_toctou      (2)  RACE_CONCURRENCY/filesystem_toctou=10.
//     access(2)→open(2) sequence — same reasoning as crypto_misuse: it's a
//     supporting prong, not the strongest proof of a race (TSan / two-thread
//     interleaving carry more weight in AVRI).
export const GOLD_SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  // Curated three (Task #170).
  real_crash_trace: 5,
  real_raw_http: 4,
  code_diff: 3,
  // Additional ten (Task #174).
  sql_injection_payload: 5,
  command_injection_payload: 5,
  xss_payload: 5,
  ssrf_metadata_target: 4,
  path_traversal_payload: 4,
  xxe_external_entity: 4,
  deserialization_gadget: 4,
  auth_token: 3,
  crypto_misuse: 2,
  filesystem_toctou: 2,
};

/** Cap for the summed per-category bonus applied to the substance score.
 * Keeps a bounded translation from AVRI per-signal points into the default
 * Engine 2 path (mirrors the +15 strengthBonus cap).
 *
 * Calibration evidence (Task #333, Apr 2026 — gold-signal-calibration.test.ts):
 *
 *   Real-cohort distribution over the 11 benchmark fixtures (5 slop + 2
 *   curl-slop + 3 legit + 1 borderline) under the legacy AVRI-off path:
 *     - rawSum range  : 0..5
 *     - rawSum max    : 5pt (single HIGH-weight category fires)
 *     - cap-hits      : 0/11 (no real fixture approaches 12)
 *     - 8/11 fixtures fire ZERO gold signals — slop intentionally excluded
 *       by the per-category placeholder/fabrication validators.
 *     - 3/11 fixtures (2 legit, 1 borderline) fire exactly one HIGH
 *       category. Legit floor stays at composite ≥ 50 on the legacy path.
 *
 *   Synthetic anchors (gold-signal-calibration.test.ts) extend the cohort
 *   to exercise the cap shape — real bug reports in the corpus today
 *   never multi-fire categories:
 *     - rich-legit (auth bearer + SQLi UNION + diff): rawSum=11, bonus=11.
 *       Sits 1pt under the cap, leaving headroom for a 4th category. Final
 *       composite=69 (PROMISING) on the legacy path.
 *     - max-stuffed (6 categories incl. crash trace, raw HTTP, diff, auth,
 *       SQLi, command injection, traversal): rawSum=25, bonus=12 (cap
 *       clips). Final composite=81 (STRONG) — the -13pt cap suppression
 *       does NOT push richly-evidenced reports out of the STRONG band.
 *
 *   Conclusion: weights and cap remain at #240's values. The cap of 12
 *   is correctly positioned: above any single-category bonus (max=5),
 *   reachable by a realistic 3-category combination (≥10), and tight
 *   enough to bound the unrealistic chained-exploit upper bound (25 → 12)
 *   without over-suppressing the report. Re-run the calibration test
 *   after any weight change or new detector to refresh this evidence. */
export const GOLD_SIGNAL_BONUS_CAP = 12;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/** Run every additional gold-signal detector against the report text and
 * return the indicators that fired (after their per-category fabrication
 * validators). Caller emits these as TriggeredIndicator entries with
 * `signal: "GOLD_SIGNAL"`. */
export function detectAdditionalGoldSignals(text: string): AdditionalGoldSignal[] {
  const stripped = strippedText(text);
  const results: AdditionalGoldSignal[] = [];

  const auth = detectAuthToken(text);
  if (auth) results.push(auth);

  const sql = detectSqlInjectionPayload(text, stripped);
  if (sql) results.push(sql);

  const cmd = detectCommandInjectionPayload(text, stripped);
  if (cmd) results.push(cmd);

  const xss = detectXssPayload(text, stripped);
  if (xss) results.push(xss);

  const ssrf = detectSsrfMetadataTarget(text);
  if (ssrf) results.push(ssrf);

  const traversal = detectPathTraversalPayload(text, stripped);
  if (traversal) results.push(traversal);

  const xxe = detectXxeExternalEntity(text);
  if (xxe) results.push(xxe);

  const gadget = detectDeserializationGadget(text);
  if (gadget) results.push(gadget);

  const crypto = detectCryptoMisuse(text);
  if (crypto) results.push(crypto);

  const toctou = detectFilesystemToctou(text);
  if (toctou) results.push(toctou);

  return results;
}
