// Sprint 11 — AVRI rubric families.
// Each family captures CWE-class-specific evidence rubric: what gold-standard
// signals MUST be present, which "absence penalties" apply when missing,
// expected file/path patterns, contradicted phrases that demote the score,
// and which verification mode is appropriate for that class.

export type FamilyId =
  | "MEMORY_CORRUPTION"
  | "INJECTION"
  | "WEB_CLIENT"
  | "AUTHN_AUTHZ"
  | "CRYPTO"
  | "DESERIALIZATION"
  | "RACE_CONCURRENCY"
  | "REQUEST_SMUGGLING"
  | "FLAT";

export type VerificationMode = "SOURCE_CODE" | "ENDPOINT" | "MANUAL_ONLY" | "GENERIC";

export interface FamilyRubric {
  id: FamilyId;
  displayName: string;
  /** Gold-standard tokens/regex that *strongly* indicate authentic evidence. */
  goldSignals: GoldSignal[];
  /** Tokens/phrases that, if missing, dock points (after normalization). */
  absencePenalties: AbsencePenalty[];
  /** Phrases that contradict membership (e.g. "alert(1)" inside MEMORY_CORRUPTION). */
  contradictionPhrases: string[];
  /** Reproduction expectation, used by Engine 3 family-vs-reproduction check. */
  reproductionExpectation: string;
  /** Active verification mode. */
  verificationMode: VerificationMode;
  /** Member CWE prefixes (without "CWE-"). */
  memberCwes: string[];
}

export interface GoldSignal {
  id: string;
  description: string;
  /** Regex matched against the (lower-cased) report text. */
  pattern: RegExp;
  /** Points awarded when present. */
  points: number;
}

export interface AbsencePenalty {
  id: string;
  description: string;
  /** When this regex DOES NOT match, deduct `points`. */
  pattern: RegExp;
  points: number;
}

const MEMORY_CORRUPTION: FamilyRubric = {
  id: "MEMORY_CORRUPTION",
  displayName: "Memory corruption / unsafe C",
  goldSignals: [
    { id: "asan_or_sanitizer", description: "AddressSanitizer / MSan / UBSan / TSAN crash output", pattern: /==\d+==error: \w*sanitizer|addresssanitizer:|memorysanitizer:|undefinedbehaviorsanitizer:|threadsanitizer:/i, points: 22 },
    { id: "valgrind", description: "Valgrind error trace", pattern: /==\d+== (?:invalid|conditional jump|use of uninitialised|definitely lost)/i, points: 18 },
    { id: "stack_trace_with_offset", description: "Crash stack trace with hex offsets", pattern: /#\d+\s+0x[0-9a-f]{6,}/i, points: 12 },
    { id: "specific_alloc_function", description: "Reference to specific allocator function (malloc/calloc/strdup/g_malloc/free)", pattern: /\b(malloc|calloc|strdup|realloc|g_malloc|g_strdup|g_free|free|operator new|delete\[\])\s*\(/i, points: 8 },
    { id: "memory_op_with_size", description: "memcpy/memmove/strncpy/snprintf with explicit size", pattern: /\b(memcpy|memmove|strncpy|snprintf|memset|memcmp)\s*\([^)]*,\s*[^,]+,\s*[^)]+\)/i, points: 8 },
    { id: "specific_struct_field", description: "Specific C struct field access (e.g. obj->buf, ptr->len)", pattern: /\b\w+->\w+\b/, points: 6 },
    { id: "code_diff_in_c", description: "Diff/patch hunk against a .c/.h/.cpp file", pattern: /^---\s+\S+\.(c|h|cc|cpp|cxx)|^\+\+\+\s+\S+\.(c|h|cc|cpp|cxx)/im, points: 12 },
    { id: "cwe_correct_class", description: "Mentions CWE-119/120/121/122/125/787/416/590/672/762", pattern: /cwe-(119|120|121|122|125|787|416|590|672|762)/i, points: 4 },
  ],
  absencePenalties: [
    { id: "no_crash_or_sanitizer", description: "No sanitizer/valgrind crash output", pattern: /sanitizer|valgrind|segmentation fault|sigsegv|sigabrt|core dumped|stack-buffer-overflow|heap-buffer-overflow|use-after-free|double-free/i, points: 8 },
    { id: "no_size_or_offset", description: "No explicit byte/size/offset value", pattern: /\b(size|len|length|offset|bytes?)\s*[:=]?\s*\d+|\b\d+\s*bytes?\b/i, points: 5 },
    { id: "no_c_source_reference", description: "No C/C++ source file reference", pattern: /\.(c|h|cc|cpp|cxx|hpp)(\b|:)/i, points: 5 },
  ],
  contradictionPhrases: [
    "alert(1)", "alert('xss')", "<script>", "document.cookie", "innerhtml",
    "select * from", "union select", "or 1=1", "drop table",
    "csrf token", "samesite=lax",
  ],
  reproductionExpectation: "Memory corruption requires a sanitizer trace OR a debugger/coredump session showing the bad write/read.",
  verificationMode: "SOURCE_CODE",
  memberCwes: ["119", "120", "121", "122", "125", "787", "416", "590", "672", "762", "806"],
};

const INJECTION: FamilyRubric = {
  id: "INJECTION",
  displayName: "Injection (SQLi / Command / LDAP / NoSQL)",
  goldSignals: [
    { id: "concrete_payload", description: "Concrete injection payload", pattern: /(union\s+select|or\s+1\s*=\s*1|;\s*drop\s+table|sleep\(\s*\d+\s*\)|benchmark\(|xp_cmdshell|;\s*(?:cat|ls|id|whoami|uname)\b|\$\{jndi:|`?\$\(.*\)`?)/i, points: 22 },
    { id: "vulnerable_query_construction", description: "Shows the unsafe query/exec construction", pattern: /(["']\s*\+\s*\w+|f["']\s*select|format\s*\(\s*["']\s*select|exec\s*\(\s*\w+|popen\s*\(|system\s*\(|child_process\.exec|os\.system)/i, points: 14 },
    { id: "request_response_diff", description: "Side-by-side normal vs injected request showing differing behavior", pattern: /(normal request|baseline)[\s\S]{0,300}(?:injection|payload|attack)/i, points: 10 },
    { id: "specific_endpoint_param", description: "Names a specific endpoint + parameter", pattern: /(?:get|post|put|delete|patch)\s+\/[\w\-\/\.{}]+.*\?\w+=|param(?:eter)?\s+`?\w+`?|field\s+`?\w+`?/i, points: 8 },
    { id: "cwe_correct_class", description: "Mentions CWE-89/77/78/91/943/917", pattern: /cwe-(89|77|78|91|943|917|624)/i, points: 4 },
    { id: "code_diff_for_fix", description: "Diff showing parameterized fix", pattern: /(prepare\s*\(|parameterized|placeholder|\?\s*,|escape_string|shell_escape|shlex\.quote)/i, points: 6 },
  ],
  absencePenalties: [
    { id: "no_payload", description: "No concrete injection payload", pattern: /(union|drop\s+table|sleep\(|benchmark\(|;\s*(?:cat|ls|id|whoami)|`\$\(|jndi:)/i, points: 12 },
    { id: "no_endpoint", description: "No specific URL or endpoint named", pattern: /https?:\/\/|\/api\/|\/v\d+\/|GET\s+\/|POST\s+\//i, points: 6 },
  ],
  contradictionPhrases: [
    "stack-buffer-overflow", "heap-buffer-overflow", "use-after-free",
    "addresssanitizer", "valgrind", "memcpy(", "strcpy(",
    "alert(1)", "<script>", "innerhtml",
  ],
  reproductionExpectation: "Injection requires the exact payload and target parameter (e.g. POST /login with email='test' OR 1=1--).",
  verificationMode: "ENDPOINT",
  memberCwes: ["77", "78", "89", "90", "91", "94", "943", "917", "624", "501"],
};

const WEB_CLIENT: FamilyRubric = {
  id: "WEB_CLIENT",
  displayName: "Web client (XSS / CSRF / clickjacking / open redirect)",
  goldSignals: [
    { id: "concrete_payload", description: "Concrete XSS/JS payload", pattern: /<script[^>]*>|<img[^>]+onerror=|<svg[^>]+onload=|javascript:|on(?:click|error|load|mouseover)\s*=|alert\s*\(\s*[`'"]?\d|document\.cookie|document\.location|window\.location/i, points: 22 },
    { id: "reflection_or_dom_proof", description: "Shows the response/DOM where the payload is reflected", pattern: /(?:reflected|rendered|injected|stored)\s+(?:in|at|inside|into)\s+(?:the\s+)?(?:response|dom|page|html|template)|<input[^>]+value=\s*["']<|innerhtml\s*=/i, points: 12 },
    { id: "specific_dom_sink", description: "Names a specific DOM sink/source", pattern: /\b(innerhtml|outerhtml|document\.write|eval\(|setattribute\(|location\.hash|location\.search|window\.name|postmessage)/i, points: 10 },
    { id: "endpoint_with_param", description: "Specific endpoint and reflected parameter", pattern: /(?:get|post)\s+\/[\w\-\/\.{}]+.*\?\w+=|\?(?:q|search|name|return|redirect|url|next|callback|cb|jsonp)=/i, points: 8 },
    { id: "csrf_specific_request", description: "(CSRF) shows the cross-origin request being forged", pattern: /<form[^>]+action=|<img[^>]+src=|fetch\s*\(\s*["']https?:|xmlhttprequest|samesite\s*=\s*(?:none|lax|strict)/i, points: 8 },
    { id: "cwe_correct_class", description: "Mentions CWE-79/352/451/601/611/1021", pattern: /cwe-(79|352|451|601|611|1021)/i, points: 4 },
  ],
  absencePenalties: [
    { id: "no_payload", description: "No concrete XSS/CSRF/redirect payload", pattern: /(<script|<img|<svg|javascript:|on\w+\s*=|document\.cookie|<form|<iframe)/i, points: 10 },
    { id: "no_url", description: "No real URL or endpoint", pattern: /https?:\/\/[\w\-\.]+\/[\w\-\/?=&%.{}]*[a-z0-9]/i, points: 5 },
  ],
  contradictionPhrases: [
    "stack-buffer-overflow", "heap-buffer-overflow", "use-after-free",
    "addresssanitizer", "valgrind", "memcpy(", "strcpy(",
    "union select", "or 1=1", "; drop table",
  ],
  reproductionExpectation: "Web-client issues need the payload, the vulnerable endpoint/parameter, and proof of execution (alert/console.log/cookie exfil).",
  verificationMode: "ENDPOINT",
  memberCwes: ["79", "80", "83", "352", "451", "601", "611", "918", "1021"],
};

const AUTHN_AUTHZ: FamilyRubric = {
  id: "AUTHN_AUTHZ",
  displayName: "Authentication / Authorization / Session",
  goldSignals: [
    { id: "two_account_proof", description: "Demonstrates access between two distinct accounts/users", pattern: /(?:user(?:_)?a|account_?a|alice|bob)[\s\S]{0,200}(?:user(?:_)?b|account_?b|bob|alice|other user)/i, points: 16 },
    { id: "authorization_header_swap", description: "Shows swapping authorization headers/tokens", pattern: /authorization:\s*bearer\s+[a-z0-9._-]+|jwt|x-auth-token|set-cookie:\s*\w+session|sessionid=/i, points: 12 },
    { id: "idor_object_id", description: "Shows changing an object id to access another resource", pattern: /\/(?:users?|orders?|invoices?|files?|posts?|messages?|tickets?|api)\/\d+|\?id=\d+|user_?id\s*[:=]/i, points: 10 },
    { id: "specific_endpoint", description: "Names a specific authenticated endpoint", pattern: /(?:get|post|put|delete|patch)\s+\/(?:api|admin|account|profile|settings|users?|orders?|invoices?)\b/i, points: 8 },
    { id: "policy_or_check_function", description: "References specific authz policy/check function", pattern: /\b(check_permission|authorize|has_role|require_admin|policy\.|@requires?_(?:auth|admin|login)|@login_required)\b/i, points: 6 },
    { id: "cwe_correct_class", description: "Mentions CWE-285/287/306/639/862/863/284", pattern: /cwe-(285|287|306|639|862|863|284|522|640)/i, points: 4 },
  ],
  absencePenalties: [
    { id: "no_two_account_proof", description: "No proof that ≥2 accounts/sessions are involved", pattern: /(user(?:_)?a|account_?a|second user|other user|alice|bob|two (?:accounts?|users?|sessions?))/i, points: 8 },
    { id: "no_endpoint", description: "No protected endpoint named", pattern: /https?:\/\/|\/api\/|\/admin\/|\/account\/|GET\s+\/|POST\s+\//i, points: 5 },
  ],
  contradictionPhrases: [
    "stack-buffer-overflow", "addresssanitizer", "valgrind", "memcpy(",
    "<script>", "alert(1)", "document.cookie",
    "union select", "or 1=1",
  ],
  reproductionExpectation: "Authn/authz reports must show two distinct sessions/accounts and the exact request that crosses the boundary.",
  verificationMode: "ENDPOINT",
  memberCwes: ["284", "285", "287", "306", "522", "639", "640", "862", "863"],
};

const CRYPTO: FamilyRubric = {
  id: "CRYPTO",
  displayName: "Cryptography",
  goldSignals: [
    { id: "specific_algo_or_lib", description: "Names a specific algorithm/mode/library", pattern: /\b(aes-?(?:128|192|256)?-?(?:cbc|ecb|gcm|ctr|cfb|ofb)|des|3des|rc4|md5|sha-?1|hmac-?\w+|rsa-?\d+|ecdsa|p-?256|p-?384|chacha20|poly1305|argon2|bcrypt|scrypt|pbkdf2|openssl|libsodium|bouncycastle|cryptography\.hazmat)\b/i, points: 14 },
    { id: "kat_or_test_vector", description: "Provides KAT/test vector/known plaintext-ciphertext pair", pattern: /(?:test\s+vector|kat|known\s+(?:answer|plaintext|ciphertext)|nonce[:=]|iv[:=]|key[:=][a-f0-9]{8,})/i, points: 12 },
    { id: "specific_misuse", description: "Names a specific misuse pattern", pattern: /\b(static|hardcoded|reused|fixed|null|zero|all-?zeros?)\s+(iv|nonce|key|salt)\b|ecb mode|ssl ?v?[23]|tls ?1\.[01]|md5\(|sha1\(/i, points: 10 },
    { id: "code_reference", description: "Specific source/file reference for crypto call", pattern: /(?:cipher|hash|hmac|sign|verify|encrypt|decrypt)\s*\(|new\s+cipher|crypto\.(?:create(?:cipher|hash|hmac|sign)|randombytes)/i, points: 8 },
    { id: "cwe_correct_class", description: "Mentions CWE-327/328/330/338/759/760/916", pattern: /cwe-(327|328|330|331|335|338|339|759|760|798|916|1240)/i, points: 4 },
  ],
  absencePenalties: [
    { id: "no_algo_named", description: "No specific algorithm/mode named", pattern: /\b(aes|des|rc4|md5|sha|hmac|rsa|ecdsa|chacha|argon|bcrypt|scrypt|pbkdf2)\b/i, points: 8 },
    { id: "no_kat", description: "No test vector / observable misuse demonstration", pattern: /(test\s+vector|kat|known\s+answer|nonce|iv|hardcoded|reused|static)/i, points: 6 },
  ],
  contradictionPhrases: [
    "<script>", "alert(1)", "document.cookie",
    "union select", "or 1=1",
    "stack-buffer-overflow", "valgrind",
  ],
  reproductionExpectation: "Crypto findings need the algorithm/mode, the misuse pattern (static IV, weak hash, etc.), and ideally a KAT or observable break.",
  verificationMode: "SOURCE_CODE",
  memberCwes: ["310", "326", "327", "328", "329", "330", "331", "335", "338", "339", "759", "760", "780", "798", "916", "1240"],
};

const DESERIALIZATION: FamilyRubric = {
  id: "DESERIALIZATION",
  displayName: "Insecure deserialization / unsafe parsing",
  goldSignals: [
    { id: "concrete_gadget_or_payload", description: "Concrete gadget chain/payload (ysoserial, marshalsec, pickle, yaml.load)", pattern: /\bysoserial\b|\bmarshalsec\b|\bpickle\.loads?\b|yaml\.(?:unsafe_)?load\b|java(?:x)?\.\w+\.objectinputstream|json\s*-\s*serializer|fastjson\b|jackson(?:databind|polymorphic)/i, points: 18 },
    { id: "exec_or_rce_evidence", description: "Shows arbitrary code/command execution result", pattern: /(?:rce|remote code execution|arbitrary command|getshell|reverse shell|bind shell|\/bin\/(?:sh|bash)|cmd\.exe|powershell)/i, points: 12 },
    { id: "specific_class_or_lib", description: "Names a specific deserialized class/library", pattern: /\b(commons-collections|commons-beanutils|c3p0|aspectjweaver|spring-aop|hibernate|fastjson|jackson|kryo|gson|protobuf|msgpack|bson|cpickle|pyyaml|node-serialize|funcster)\b/i, points: 8 },
    { id: "code_reference", description: "Source code showing the deserialization sink", pattern: /(?:objectinputstream|readobject\(|unmarshal\(|deserialize\(|fromjson\(|fromxml\(|yaml\.load|pickle\.loads|node-serialize)/i, points: 8 },
    { id: "cwe_correct_class", description: "Mentions CWE-502/611/776/827", pattern: /cwe-(502|611|776|827|915)/i, points: 4 },
  ],
  absencePenalties: [
    { id: "no_payload_or_gadget", description: "No payload or gadget chain shown", pattern: /(ysoserial|marshalsec|pickle|yaml\.load|objectinputstream|readobject|deserialize|payload)/i, points: 10 },
    { id: "no_lib_named", description: "No specific library/format named", pattern: /(jackson|fastjson|gson|pyyaml|pickle|java serialization|node-serialize|msgpack|kryo)/i, points: 6 },
  ],
  contradictionPhrases: [
    "<script>", "alert(1)", "innerhtml",
    "stack-buffer-overflow", "valgrind",
    "union select", "or 1=1",
  ],
  reproductionExpectation: "Deserialization findings need the gadget/payload, the deserialization sink (with library), and proof of execution or sensitive read.",
  verificationMode: "SOURCE_CODE",
  memberCwes: ["502", "611", "776", "827", "915"],
};

const RACE_CONCURRENCY: FamilyRubric = {
  id: "RACE_CONCURRENCY",
  displayName: "Race condition / TOCTOU / concurrency",
  goldSignals: [
    { id: "two_thread_or_request_proof", description: "Shows two interleaved threads/requests/transactions", pattern: /(?:thread|request|transaction|process)\s+(?:1|a)\b[\s\S]{0,300}(?:thread|request|transaction|process)\s+(?:2|b)\b|race\s*-?condition|t-?o-?c-?t-?o-?u|toctou|interleav|concurrent(?:ly)?/i, points: 14 },
    { id: "tsan_or_helgrind", description: "ThreadSanitizer / Helgrind / DRD output", pattern: /threadsanitizer|tsan:|helgrind|==\d+== possible data race|drd:/i, points: 16 },
    { id: "lock_or_atomic_reference", description: "References a specific lock/mutex/atomic primitive", pattern: /\b(pthread_mutex|std::mutex|std::atomic|lock_guard|unique_lock|spinlock|rwlock|sync\.mutex|sync\.rwmutex|@synchronized|asyncio\.lock|asyncio\.semaphore|nginx_atomic|atomic_(?:add|sub|cmpxchg|fetch))/i, points: 8 },
    { id: "filesystem_toctou", description: "(File-TOCTOU) shows access(2)/stat(2) followed by open(2)", pattern: /\b(access|stat|lstat|fstatat)\s*\([^)]*\)[\s\S]{0,200}\b(open|fopen|openat|symlink)\s*\(/i, points: 10 },
    { id: "specific_function", description: "Names the specific racing function/handler", pattern: /\b(handle_request|process_\w+|update_\w+|transfer\w*|withdraw|deposit|claim_\w+)\s*\(/i, points: 6 },
    { id: "cwe_correct_class", description: "Mentions CWE-362/363/364/367/833", pattern: /cwe-(362|363|364|367|820|821|833|843)/i, points: 4 },
  ],
  absencePenalties: [
    { id: "no_concurrent_proof", description: "No demonstration of two interleaved actors", pattern: /(thread|request|transaction|process)\s+(1|2|a|b)|race\s*condition|toctou|concurrent|interleav/i, points: 10 },
    { id: "no_function_or_path", description: "No specific function/file path named", pattern: /\.(c|h|cc|cpp|go|rs|py|js|ts|java|rb|php)(\b|:)|\b\w+\s*\(/i, points: 5 },
  ],
  contradictionPhrases: [
    "<script>", "alert(1)", "document.cookie",
    "union select", "or 1=1",
    "stack-buffer-overflow",
  ],
  reproductionExpectation: "Race conditions need two interleaved actors and a measurable observable (sanitizer, double-spend, duplicate row, etc.).",
  verificationMode: "MANUAL_ONLY",
  memberCwes: ["362", "363", "364", "367", "820", "821", "833", "843"],
};

const REQUEST_SMUGGLING: FamilyRubric = {
  id: "REQUEST_SMUGGLING",
  displayName: "HTTP request smuggling / desync / parser confusion",
  goldSignals: [
    { id: "raw_http_request", description: "Raw HTTP/1.1 request bytes with explicit headers", pattern: /post\s+\/[^\s]*\s+http\/1\.[01]\r?\n[\s\S]*?(?:host:|content-length:|transfer-encoding:)/i, points: 18 },
    { id: "te_or_cl_conflict", description: "Both Transfer-Encoding and Content-Length present (TE.CL/CL.TE)", pattern: /(transfer-encoding\s*:[^\n]*\bchunked\b[\s\S]*?content-length\s*:|content-length\s*:[^\n]*\d[\s\S]*?transfer-encoding\s*:[^\n]*\bchunked\b)/i, points: 14 },
    { id: "smuggled_second_request", description: "Shows the smuggled second request (e.g. GPOST / on a new pipeline)", pattern: /\b(?:gpost|smuggled|pipelined|second request|hidden request|prefix)\s+(?:request|attack)|0\r?\n\r?\n[A-Z]+\s+\/[^\s]*\s+http/i, points: 12 },
    { id: "specific_proxy_or_server", description: "Names the specific proxy/server combo", pattern: /\b(haproxy|nginx|envoy|apache|aws elb|cloudfront|fastly|cloudflare|varnish|squid|traefik|f5\b|netscaler|node\.?js|gunicorn|uvicorn|tomcat|jetty|undertow|lighttpd|h2o)\b/i, points: 8 },
    { id: "cwe_correct_class", description: "Mentions CWE-444/436/116", pattern: /cwe-(444|436|116|113|115)/i, points: 4 },
  ],
  absencePenalties: [
    { id: "no_raw_request", description: "No raw HTTP request bytes provided", pattern: /\bhttp\/1\.[01]\b|content-length\s*:|transfer-encoding\s*:/i, points: 10 },
    { id: "no_proxy_named", description: "No specific proxy/server identified", pattern: /(haproxy|nginx|envoy|apache|cloudflare|varnish|squid|tomcat|jetty|node|gunicorn|uvicorn|undertow|h2o)/i, points: 6 },
  ],
  contradictionPhrases: [
    "<script>", "alert(1)", "innerhtml",
    "union select", "or 1=1",
    "addresssanitizer", "valgrind",
  ],
  reproductionExpectation: "Smuggling reports must show the raw HTTP bytes (CRLF preserved), the parser disagreement, and the smuggled request that lands on the backend.",
  verificationMode: "MANUAL_ONLY",
  memberCwes: ["113", "115", "116", "436", "444"],
};

/**
 * Flat fallback used when classification cannot place the report into any
 * specific family. Mirrors the legacy v3.6.0 rubric: generic evidence
 * accumulation with no family-specific gold signals.
 */
const FLAT: FamilyRubric = {
  id: "FLAT",
  displayName: "Generic / unclassified",
  goldSignals: [
    { id: "code_block", description: "Any fenced code block ≥3 lines", pattern: /```[\s\S]{60,}?```/, points: 10 },
    { id: "real_url", description: "Real URL with path", pattern: /https?:\/\/[\w\-\.]+\/[\w\-\/?=&%.{}]*[a-z0-9]/i, points: 6 },
    { id: "file_with_line", description: "File path with line number", pattern: /[\w\-\/]+\.(?:c|h|cc|cpp|cxx|hpp|js|ts|tsx|py|rb|go|rs|java|kt|swift|php|cs|m|mm|sh|yml|yaml|json|xml)\s*[:#L@]\s*\d+/i, points: 8 },
    { id: "code_diff", description: "Diff/patch hunk", pattern: /^---\s+\S+|^\+\+\+\s+\S+|^@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@/m, points: 12 },
  ],
  absencePenalties: [],
  contradictionPhrases: [],
  reproductionExpectation: "Provide step-by-step reproduction with exact inputs and observed outputs.",
  verificationMode: "GENERIC",
  memberCwes: [],
};

export const FAMILIES: FamilyRubric[] = [
  MEMORY_CORRUPTION,
  INJECTION,
  WEB_CLIENT,
  AUTHN_AUTHZ,
  CRYPTO,
  DESERIALIZATION,
  RACE_CONCURRENCY,
  REQUEST_SMUGGLING,
];

export const FAMILIES_BY_ID: Record<FamilyId, FamilyRubric> = {
  MEMORY_CORRUPTION,
  INJECTION,
  WEB_CLIENT,
  AUTHN_AUTHZ,
  CRYPTO,
  DESERIALIZATION,
  RACE_CONCURRENCY,
  REQUEST_SMUGGLING,
  FLAT,
};

export const FLAT_FAMILY: FamilyRubric = FLAT;

/** Build a CWE → family lookup from the rubric memberCwes. */
const CWE_TO_FAMILY: Map<string, FamilyId> = (() => {
  const m = new Map<string, FamilyId>();
  for (const fam of FAMILIES) {
    for (const c of fam.memberCwes) m.set(c, fam.id);
  }
  return m;
})();

/** Look up a family for a normalized CWE number (string, no "CWE-" prefix). */
export function familyForCweNumber(cweNumber: string): FamilyId | null {
  return CWE_TO_FAMILY.get(cweNumber) ?? null;
}
