// Task #662 — Per-signal explainer metadata. Centralizes the data used by
// the /signals index page and /signals/:id detail page. The `id` field
// matches the evidence row `type` persisted on a report (see
// lib/db/src/schema/reports.ts → EvidenceItem.type), so the per-signal
// precision/recall endpoint can be joined on `id` directly.
//
// Categories:
//   • hallucination — Negative-evidence detectors that dock points when a
//     report shows internal inconsistencies a real artifact never has.
//   • avri-gold     — Positive-evidence rubric signals from the AVRI
//     family rubrics (memory corruption, injection, web client, …).
//   • substance     — Engine 2 substance-density flags surfaced into the
//     evidence list when claims are mismatched with proof.

export type SignalCategory =
  | "hallucination"
  | "avri-gold"
  | "substance";

export interface SignalCitation {
  label: string;
  href: string;
}

export interface SignalExample {
  title: string;
  snippet: string;
  why: string;
}

export interface SignalMeta {
  id: string;
  title: string;
  category: SignalCategory;
  /** AVRI family this signal belongs to, when category = "avri-gold". */
  family?: string;
  /** Plain-English one-liner shown on the index card and at the top of the page. */
  description: string;
  /** Why a triager should care. */
  whyItMatters: string;
  /** Deeper technical detail for engineers. */
  technicalDetail: string;
  citations: SignalCitation[];
  examples: SignalExample[];
}

const RFC9110: SignalCitation = {
  label: "RFC 9110 — HTTP Semantics",
  href: "https://www.rfc-editor.org/rfc/rfc9110",
};
const RFC7230: SignalCitation = {
  label: "RFC 7230 — HTTP/1.1 Message Syntax & Routing",
  href: "https://www.rfc-editor.org/rfc/rfc7230",
};
const GRAPHQL_SPEC: SignalCitation = {
  label: "GraphQL Spec — Response Format",
  href: "https://spec.graphql.org/October2021/#sec-Response-Format",
};
const ASAN_DOC: SignalCitation = {
  label: "AddressSanitizer — algorithm & report format",
  href: "https://github.com/google/sanitizers/wiki/AddressSanitizer",
};

// ---------------------------------------------------------------------------
// Hallucination signals (mirrors hallucination-detector.ts).
// ---------------------------------------------------------------------------

const HALLUCINATION: SignalMeta[] = [
  {
    id: "hallucination_structural_fabrication",
    title: "Structural fabrication in crash trace",
    category: "hallucination",
    description:
      "Crash output contains structural tells (round offsets, impossible PIDs, overlapping memory maps) that a real sanitizer never prints.",
    whyItMatters:
      "LLMs reproduce the visual shape of an ASan/TSan trace without internalizing the invariants. A real sanitizer dump cross-checks itself; a fabricated one does not.",
    technicalDetail:
      "Nine independent predicates run on fenced crash blocks: round function offsets, frame-numbering gaps, missing ==PID== anchor, round-and-hex heap region size, function offsets outside realistic prologue bounds, thread/PID identifiers outside the Linux/sanitizer range, register dumps with textbook-round values, and /proc/self/maps listings whose ranges overlap or are not 4 KiB page-aligned. Two or more markers fire together to clear the moderate-tier weight; a single marker still surfaces as an informational signal (weight 4).",
    citations: [
      ASAN_DOC,
      { label: "Linux kernel — proc(5)", href: "https://man7.org/linux/man-pages/man5/proc.5.html" },
    ],
    examples: [
      {
        title: "Round function offset",
        snippet: "#0 0x00007ffff7a00000 in malloc+0x100\n#1 0x00007ffff7a00000 in __libc_start_main+0x200",
        why: "Real ASan offsets are not round — they reflect the exact instruction inside the function.",
      },
      {
        title: "Missing PID anchor",
        snippet: "==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x00006020001000",
        why: "Genuine ASan output always prefixes the error line with the process id (e.g. ==12345==ERROR:).",
      },
    ],
  },
  {
    id: "hallucination_impossible_http_response",
    title: "Impossible HTTP response",
    category: "hallucination",
    description:
      "A pasted HTTP excerpt contains arrangements no real HTTP stack would emit — e.g. \"200 Not Found\", a Cookie header on a response, or a 204 with a body.",
    whyItMatters:
      "Reporters often paste plausible-looking HTTP blocks to \"prove\" the bug. The small details give away whether they ran a real request or hand-typed a transcript.",
    technicalDetail:
      "Five predicates run independently on fenced HTTP blocks: status line text disagreeing with its code (e.g. 200 Not Found), Content-Length disagreeing with the labelled body bytes, Set-Cookie on a request, Cookie on a response, HEAD answered with a body, and 204/304 carrying a body. Per-marker weight matches structural_fabrication so the two compose cleanly when both fire on the same report.",
    citations: [
      RFC9110,
      RFC7230,
      { label: "RFC 6265 — HTTP State Management", href: "https://www.rfc-editor.org/rfc/rfc6265" },
    ],
    examples: [
      {
        title: "Mismatched status text",
        snippet: "HTTP/1.1 200 Not Found\nContent-Type: text/html\nContent-Length: 0",
        why: "Status code 200 is hard-bound to reason phrase \"OK\" in §15.3.1 of RFC 9110. Real servers never substitute \"Not Found\".",
      },
      {
        title: "204 with a body",
        snippet: "HTTP/1.1 204 No Content\nContent-Length: 42\n\n{\"error\":\"unauthorized\"}",
        why: "RFC 9110 §15.3.5 forbids a body on 204. Any real server (nginx, envoy, apache) strips it.",
      },
    ],
  },
  {
    id: "hallucination_impossible_graphql_response",
    title: "Impossible GraphQL response",
    category: "hallucination",
    description:
      "A pasted GraphQL response body violates the spec: empty errors[], path naming a non-null data field, or extensions.code describing an attack outcome.",
    whyItMatters:
      "GraphQL response shape is rigidly defined. A fabricated response usually trips one of the four spec requirements that real servers (Apollo, Hasura, GitHub) enforce automatically.",
    technicalDetail:
      "Inspects fenced JSON blocks that look like a GraphQL response (top-level data or errors with a GraphQL-shaped errors[] entry, or an explicit graphql fence label). Four predicates: data: null with no errors; an empty errors array; an error path naming a field that is non-null in data or absent from data; an extensions.code value describing an attack outcome (e.g. \"SQL_INJECTION_SUCCESS\") rather than a server error condition.",
    citations: [
      GRAPHQL_SPEC,
      { label: "Apollo — Errors", href: "https://www.apollographql.com/docs/apollo-server/data/errors" },
    ],
    examples: [
      {
        title: "data: null with no errors",
        snippet: "{ \"data\": null }",
        why: "Per the spec, if data is null because of an error, errors must be present and non-empty.",
      },
    ],
  },
  {
    id: "hallucination_fabricated_stack_trace",
    title: "Fabricated stack trace",
    category: "hallucination",
    description:
      "More than half the frames in the stack trace are duplicates of one another — real call chains rarely repeat.",
    whyItMatters:
      "A real backtrace shows distinct frames as the call descended through the program. High repetition suggests the trace was generated by template completion, not captured.",
    technicalDetail:
      "Extracts frames matching #N 0xADDR in SYMBOL, normalizes the frame number, and computes (1 - unique/total). When that ratio exceeds 50% on ≥3 frames the signal fires (weight 15).",
    citations: [ASAN_DOC],
    examples: [
      {
        title: "Repeated frames",
        snippet: "#0 0x401000 in foo\n#1 0x401000 in foo\n#2 0x401000 in foo\n#3 0x401000 in foo",
        why: "Real recursion shows distinct call sites or at least varying offsets.",
      },
    ],
  },
  {
    id: "hallucination_fabricated_addresses",
    title: "Fabricated memory addresses",
    category: "hallucination",
    description:
      "More than half the memory addresses in the report are round (≥3 trailing zeros) or sequential (dead/beef/cafe), with no corroborating real-crash markers.",
    whyItMatters:
      "Real heap addresses come from ASLR and allocator state — they are noisy. Round/sequential values are the calling card of hand-typed evidence.",
    technicalDetail:
      "Pulls all 0x[0-9a-f]{8,16} matches and counts those with ≥3 trailing zeros or containing dead/beef/cafe/face. Fires only when the ratio exceeds 50% AND no SUMMARY: AddressSanitizer / GDB session header is present (weight 10).",
    citations: [ASAN_DOC],
    examples: [
      {
        title: "Sequential placeholders",
        snippet: "Buffer at 0xdeadbeef, freed at 0xcafebabe, accessed at 0xfacefeed",
        why: "Memorable hex words are markers used in tutorials, never real allocator output.",
      },
    ],
  },
  {
    id: "hallucination_phantom_exploit_script",
    title: "Phantom exploit script",
    category: "hallucination",
    description:
      "Report references an exploit script (e.g. exploit.py, poc.sh) but the script body is never shown.",
    whyItMatters:
      "If the reporter actually ran the script, pasting it costs nothing. Citing without showing it suggests it does not exist.",
    technicalDetail:
      "Looks for tokens of shape (exploit|poc|trigger|crash)\\.(py|sh|c|rb|js) outside fenced code blocks, then fails the signal only if no fenced block in the report contains source code.",
    citations: [],
    examples: [
      {
        title: "Reference without source",
        snippet: "Run python exploit.py to trigger the vulnerability.",
        why: "No code block contains the body of exploit.py — there is nothing to verify.",
      },
    ],
  },
  {
    id: "hallucination_incomplete_asan",
    title: "Incomplete ASan report",
    category: "hallucination",
    description:
      "Report claims ASan detected the bug but contains none of the structural anchors a real ASan dump always emits.",
    whyItMatters:
      "Genuine ASan output is verbose and self-anchoring. Claims of \"AddressSanitizer caught it\" with no SUMMARY:, no frame addresses, no shadow-byte map, are uncorroborated.",
    technicalDetail:
      "Triggers when the text contains \"addresssanitizer\" or \"asan\" but lacks at least one of: SUMMARY: AddressSanitizer line, ==PID==ERROR: anchor, shadow-byte map, READ/WRITE of size header, or stack frames with hex offsets.",
    citations: [ASAN_DOC],
    examples: [
      {
        title: "Bare claim",
        snippet: "Compiling with -fsanitize=address shows AddressSanitizer detects the overflow.",
        why: "No actual ASan output is included to verify the claim.",
      },
    ],
  },
  {
    id: "hallucination_phantom_functions",
    title: "Phantom functions",
    category: "hallucination",
    description:
      "Report names internal functions or APIs but never shows code defining or calling them.",
    whyItMatters:
      "Function names are easy to invent. Without a code snippet showing the call site, the names cannot be verified against the project's source.",
    technicalDetail:
      "Extracts identifiers of shape some_function() or Foo::bar() from prose, and fails when no fenced code block contains any of those identifiers.",
    citations: [],
    examples: [
      {
        title: "Unsourced function name",
        snippet: "The bug is in handle_packet_v2() which is called from net_worker_loop().",
        why: "Neither identifier appears in any code snippet — they cannot be located in the codebase.",
      },
    ],
  },
  {
    id: "hallucination_fabricated_pid",
    title: "Fabricated PIDs",
    category: "hallucination",
    description:
      "Report contains multiple textbook PIDs (12345, 1234, 9999) where real captures would show distinct, large process ids.",
    whyItMatters:
      "Linux PIDs are assigned sequentially per-boot and quickly grow into the tens of thousands. Round, repeated PIDs are an artifact of LLM completion.",
    technicalDetail:
      "Counts ==N== anchors and PID-shaped tokens with values ≤9999 or matching the textbook set {12345, 1234, 9999}; fires when ≥3 distinct fabricated-shape PIDs appear.",
    citations: [],
    examples: [
      {
        title: "Textbook PIDs",
        snippet: "==12345==ERROR …\n==1234==ERROR …",
        why: "Two captures during one bug session would share a PID; two different PIDs that round-tripped from a textbook is the giveaway.",
      },
    ],
  },
  {
    id: "hallucination_implausible_version",
    title: "Implausible version numbers",
    category: "hallucination",
    description:
      "Affected version field uses an implausible patch number (e.g. nginx 1.21.523, openssl 3.0.999).",
    whyItMatters:
      "Real software follows tight semver discipline. Fabricated version numbers are a tell.",
    technicalDetail:
      "Matches NAME X.Y.Z patterns and flags when Z exceeds typical project ceilings, OR when the major.minor combination does not match any released version of well-known projects.",
    citations: [],
    examples: [
      {
        title: "Patch overflow",
        snippet: "Affected: nginx 1.21.523",
        why: "nginx 1.21.x stopped at 1.21.6. A 523 patch level cannot exist.",
      },
    ],
  },
  {
    id: "hallucination_impact_escalation",
    title: "Implausible impact escalation",
    category: "hallucination",
    description:
      "Report claims a high-impact outcome (RCE, full takeover) from a low-impact primitive (reflected XSS) without bridging the gap.",
    whyItMatters:
      "LLMs love to up-weight findings to \"critical / RCE\" without showing how the primitive escalates.",
    technicalDetail:
      "Looks for prose claiming RCE / full account takeover / arbitrary code execution alongside a payload that demonstrates only XSS / open redirect / disclosure, and fires when the chain to escalation is not shown.",
    citations: [],
    examples: [
      {
        title: "XSS → RCE jump",
        snippet: "The reflected XSS allows full remote code execution on the server.",
        why: "Reflected XSS runs in the victim browser. Server RCE requires a separate primitive that is not shown.",
      },
    ],
  },
  {
    id: "hallucination_language_confusion",
    title: "Language ecosystem confusion",
    category: "hallucination",
    description:
      "A single report references three or more unrelated language ecosystems (e.g. Python, Java, Go, Rust) where real bug surfaces are usually one or two.",
    whyItMatters:
      "Real reports stay within the project's stack. Reports that flit between ecosystems usually stitched together unrelated snippets.",
    technicalDetail:
      "Counts distinct ecosystem markers (file extensions, import statements, package manager prose) and fires when ≥3 unrelated ecosystems appear without explicit cross-ecosystem framing.",
    citations: [],
    examples: [
      {
        title: "Ecosystem soup",
        snippet: "Open requirements.txt, then run go mod tidy, then mvn install.",
        why: "No real project ships with Python, Go and Java build manifests at the same root.",
      },
    ],
  },
  {
    id: "hallucination_repeated_sentences",
    title: "Repeated sentences",
    category: "hallucination",
    description:
      "Same sentence appears verbatim multiple times in the report — a copy-paste artifact common in LLM expansion.",
    whyItMatters:
      "Real human prose varies wording across sections. Verbatim repetition usually means a model expanded a section by re-emitting an earlier paragraph.",
    technicalDetail:
      "Splits prose on sentence boundaries, normalizes whitespace, and counts (sentence, count) pairs. Fires when ≥2 distinct sentences each repeat ≥2 times.",
    citations: [],
    examples: [],
  },
  {
    id: "hallucination_empty_disclosure_claim",
    title: "Empty disclosure-timeline claim",
    category: "hallucination",
    description:
      "Report claims coordinated disclosure (e.g. \"reported to vendor on …\") but no actual dates or correspondence are shown.",
    whyItMatters:
      "A real disclosure timeline cites concrete dates and vendor responses. A claim without specifics is unverifiable.",
    technicalDetail:
      "Matches \"reported to (vendor|maintainer|security team)\" / \"coordinated disclosure\" / \"CVE assigned\" prose, then fails when no dates or vendor identifiers appear in surrounding context.",
    citations: [],
    examples: [],
  },
];

// ---------------------------------------------------------------------------
// AVRI gold signals (subset — the most common across all families).
// ---------------------------------------------------------------------------

const AVRI_GOLD: SignalMeta[] = [
  {
    id: "asan_or_sanitizer",
    title: "Sanitizer crash output",
    category: "avri-gold",
    family: "MEMORY_CORRUPTION",
    description:
      "Genuine AddressSanitizer / MSan / UBSan / TSan / Valgrind crash output is present.",
    whyItMatters:
      "A real sanitizer trace is the gold standard for memory-safety bugs — it pins the exact bytes and stack frames involved.",
    technicalDetail:
      "Matches lines of shape ==N==ERROR: AddressSanitizer / MemorySanitizer / UndefinedBehaviorSanitizer / ThreadSanitizer / Valgrind variants. Worth +22 in the Memory Corruption rubric.",
    citations: [ASAN_DOC],
    examples: [
      {
        title: "ASan heap-buffer-overflow",
        snippet: "==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000001234 at pc 0x000000401234",
        why: "Canonical ASan banner with PID anchor, error class, faulting address and PC.",
      },
    ],
  },
  {
    id: "stack_trace_with_offset",
    title: "Stack trace with hex offsets",
    category: "avri-gold",
    family: "MEMORY_CORRUPTION",
    description: "Crash backtrace with hex offsets (e.g. #0 0x7ffff7a01234 in foo).",
    whyItMatters:
      "Frame addresses and symbol+offset pairs are the second-strongest evidence after a sanitizer SUMMARY line.",
    technicalDetail: "Matches #\\d+\\s+0x[0-9a-f]{6,} on ≥1 frame. Worth +12 in the Memory Corruption rubric.",
    citations: [ASAN_DOC],
    examples: [
      {
        title: "Frame with symbol",
        snippet: "#0 0x7ffff7a01234 in handle_packet src/net.c:142",
        why: "Frame number, hex address, symbol and source location all line up.",
      },
    ],
  },
  {
    id: "concrete_payload",
    title: "Concrete injection or XSS payload",
    category: "avri-gold",
    family: "INJECTION / WEB_CLIENT",
    description:
      "A specific payload is shown (e.g. ' OR 1=1 --, <script>alert(1)</script>, ${jndi:ldap://...}).",
    whyItMatters:
      "Triagers cannot verify an injection bug without the exact bytes. Vague descriptions of \"the attacker injects SQL\" are not actionable.",
    technicalDetail:
      "Different family rubrics scan for different payload shapes: SQLi (UNION SELECT, OR 1=1, sleep()), command injection (; cat /etc/passwd, $(id)), XSS (<script>, on*= handlers), JNDI ($\\{jndi:), template injection ({{7*7}}), etc.",
    citations: [
      { label: "OWASP — Cross Site Scripting Prevention", href: "https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html" },
      { label: "OWASP — SQL Injection Prevention", href: "https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html" },
    ],
    examples: [
      {
        title: "SQL injection payload",
        snippet: "POST /login\nemail=test%40example.com' OR 1=1 --",
        why: "Reproducible by hand: paste into curl and observe the auth bypass.",
      },
      {
        title: "XSS payload",
        snippet: "GET /search?q=<svg onload=alert(1)>",
        why: "Specific payload, specific endpoint, specific parameter.",
      },
    ],
  },
  {
    id: "vulnerable_query_construction",
    title: "Vulnerable query construction shown",
    category: "avri-gold",
    family: "INJECTION",
    description: "Source code showing the unsafe SQL/command construction (string concat, format(), exec()).",
    whyItMatters:
      "The fix-vs-no-fix verdict hinges on whether the sink uses parameterization. Showing the unsafe construction tells the maintainer exactly what to change.",
    technicalDetail:
      "Matches string concatenation into SQL keywords (\"\" + var + \" SELECT \"), f-strings around SELECT, format(\"SELECT…\"), exec()/system()/popen()/child_process.exec invocations.",
    citations: [
      { label: "OWASP — Injection", href: "https://owasp.org/www-community/Injection_Theory" },
    ],
    examples: [
      {
        title: "Python format SQL",
        snippet: "cursor.execute(f\"SELECT * FROM users WHERE email='{email}'\")",
        why: "Direct interpolation of untrusted input into a SQL statement — the fix is parameterization.",
      },
    ],
  },
  {
    id: "specific_endpoint_param",
    title: "Specific endpoint and parameter",
    category: "avri-gold",
    family: "INJECTION / WEB_CLIENT",
    description: "Names a concrete HTTP method, path and parameter where the bug surfaces.",
    whyItMatters:
      "Without an endpoint and parameter, a triager cannot reproduce the request. \"There is XSS somewhere\" is not actionable.",
    technicalDetail:
      "Matches (GET|POST|PUT|DELETE|PATCH) /path?param=… patterns, or prose of shape \"parameter `name`\" / \"field `name`\".",
    citations: [],
    examples: [
      {
        title: "Endpoint + param",
        snippet: "GET /api/v1/orders?status=<payload>",
        why: "Reproducible directly from curl with the named query parameter.",
      },
    ],
  },
  {
    id: "reflection_or_dom_proof",
    title: "Reflection or DOM proof",
    category: "avri-gold",
    family: "WEB_CLIENT",
    description: "Shows where in the response or DOM the payload lands (innerHTML, attribute value, response body).",
    whyItMatters:
      "Reflected XSS is only exploitable if the payload reaches an executable sink. Proof of reflection bridges the gap from \"input echoed\" to \"code runs\".",
    technicalDetail:
      "Matches response/DOM excerpts containing the payload, or prose like \"reflected in response\", \"injected into DOM\", \"rendered in template\".",
    citations: [
      { label: "OWASP — DOM-based XSS", href: "https://owasp.org/www-community/attacks/xss/" },
    ],
    examples: [
      {
        title: "DOM reflection",
        snippet: "Response body contains: <input value=\"<svg onload=alert(1)>\">",
        why: "Payload is reflected unescaped into an attribute context — alert fires on render.",
      },
    ],
  },
  {
    id: "ssrf_internal_metadata",
    title: "SSRF internal-metadata target",
    category: "avri-gold",
    family: "WEB_CLIENT",
    description:
      "Concrete cloud-metadata or RFC1918 SSRF target URL (169.254.169.254, metadata.google.internal, …).",
    whyItMatters:
      "Generic \"the server fetches a URL\" prose is not exploitable. A concrete metadata endpoint shows the impact.",
    technicalDetail:
      "Matches AWS IMDS (169.254.169.254/latest/meta-data/), GCP (metadata.google.internal/computeMetadata/v1/), Azure (169.254.169.254/metadata/instance).",
    citations: [
      { label: "AWS — Instance metadata", href: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html" },
      { label: "GCP — Metadata server", href: "https://cloud.google.com/compute/docs/metadata/overview" },
    ],
    examples: [
      {
        title: "AWS IMDS hit",
        snippet: "GET /fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/",
        why: "Reaching IMDS from a server-side fetch is the canonical SSRF impact demonstration.",
      },
    ],
  },
  {
    id: "path_traversal_payload",
    title: "Path-traversal payload",
    category: "avri-gold",
    family: "WEB_CLIENT",
    description: "Concrete traversal payload reaching a sensitive file (../../etc/passwd, ..%2f, %252e%252e/).",
    whyItMatters:
      "Path-traversal claims need both the encoding and the file reached. Otherwise the report cannot be reproduced or scoped.",
    technicalDetail:
      "Matches ../ / ..%2f / %252e%252e/ patterns followed within 80 chars by passwd, shadow, hosts, boot.ini, /etc/, /proc/, .aws/, id_rsa, web.config.",
    citations: [
      { label: "OWASP — Path Traversal", href: "https://owasp.org/www-community/attacks/Path_Traversal" },
    ],
    examples: [
      {
        title: "Encoded traversal",
        snippet: "GET /download?file=..%2f..%2f..%2fetc%2fpasswd",
        why: "Specific encoding + specific target file — directly verifiable.",
      },
    ],
  },
  {
    id: "two_account_proof",
    title: "Two-account proof",
    category: "avri-gold",
    family: "AUTHN_AUTHZ",
    description: "Demonstrates access between two distinct accounts/users (Alice, Bob, user_a, user_b).",
    whyItMatters:
      "Authorization bugs are by definition cross-tenant. Without two distinct identities the report cannot prove the boundary was crossed.",
    technicalDetail:
      "Matches paired identifiers in the report prose (alice…bob, user_a…user_b, account_1…account_2).",
    citations: [],
    examples: [
      {
        title: "Cross-account read",
        snippet: "Logged in as alice@…, called GET /api/orders/42 → returned bob's order.",
        why: "Two named identities, one boundary-crossing request, one observed leak.",
      },
    ],
  },
  {
    id: "idor_object_id",
    title: "IDOR object-id swap",
    category: "avri-gold",
    family: "AUTHN_AUTHZ",
    description: "Shows changing an object id in a URL to access another resource.",
    whyItMatters:
      "IDOR is the most common authorization bug. The report needs the request that crosses the boundary.",
    technicalDetail: "Matches /users/N, /orders/N, /invoices/N path segments or ?id=N query patterns.",
    citations: [
      { label: "OWASP — IDOR", href: "https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html" },
    ],
    examples: [
      {
        title: "Numeric id swap",
        snippet: "GET /api/invoices/1001 (mine) → 200 OK\nGET /api/invoices/1002 (someone else's) → 200 OK",
        why: "Two requests, two ids, response shows the cross-tenant leak.",
      },
    ],
  },
  {
    id: "specific_algo_or_lib",
    title: "Specific crypto algorithm / library",
    category: "avri-gold",
    family: "CRYPTO",
    description:
      "Names a specific algorithm/mode/library (AES-128-CBC, MD5, OpenSSL, libsodium, …).",
    whyItMatters:
      "Crypto findings without the algorithm are unfixable. \"Encryption is weak\" is not actionable; \"AES-128-ECB on user data\" is.",
    technicalDetail:
      "Matches AES-{128,192,256}-{CBC,ECB,GCM,CTR,CFB,OFB}, DES/3DES/RC4, MD5/SHA-1, HMAC-*, RSA-*, ECDSA, P-256, ChaCha20/Poly1305, Argon2/bcrypt/scrypt/PBKDF2, OpenSSL/libsodium/BouncyCastle/cryptography.hazmat.",
    citations: [
      { label: "NIST SP 800-131A — Algorithms & Key Lengths", href: "https://csrc.nist.gov/pubs/sp/800/131/a/r2/final" },
    ],
    examples: [
      {
        title: "ECB misuse",
        snippet: "Cipher.getInstance(\"AES/ECB/PKCS5Padding\")",
        why: "ECB mode reveals patterns in plaintext — the named algorithm makes the bug concrete.",
      },
    ],
  },
  {
    id: "kat_or_test_vector",
    title: "KAT / known-answer test vector",
    category: "avri-gold",
    family: "CRYPTO",
    description: "Provides a known-answer test or named cryptographic constants (IV, nonce, key).",
    whyItMatters:
      "A KAT lets the maintainer reproduce the cryptographic break deterministically. Without one, breaks are hard to verify.",
    technicalDetail: "Matches \"test vector\", \"KAT\", \"known answer\", or hex key/IV/nonce assignments.",
    citations: [
      { label: "NIST CAVP — KATs", href: "https://csrc.nist.gov/projects/cryptographic-algorithm-validation-program" },
    ],
    examples: [],
  },
  {
    id: "concrete_gadget_or_payload",
    title: "Deserialization gadget / payload",
    category: "avri-gold",
    family: "DESERIALIZATION",
    description:
      "Concrete gadget chain or payload (ysoserial, marshalsec, pickle.loads, yaml.unsafe_load, …).",
    whyItMatters:
      "Insecure deserialization is only exploitable with a working gadget chain. The chain is the proof.",
    technicalDetail:
      "Matches ysoserial, marshalsec, pickle.loads, yaml.unsafe_load, ObjectInputStream, fastjson, jackson-databind polymorphic.",
    citations: [
      { label: "OWASP — Deserialization", href: "https://owasp.org/www-community/vulnerabilities/Deserialization_of_untrusted_data" },
    ],
    examples: [],
  },
  {
    id: "xxe_doctype_entity",
    title: "XXE DOCTYPE / ENTITY declaration",
    category: "avri-gold",
    family: "DESERIALIZATION",
    description:
      "Concrete XXE payload with a <!DOCTYPE> + <!ENTITY ... SYSTEM \"file:|http:|gopher:\"> declaration.",
    whyItMatters:
      "XXE is a structurally specific bug — the payload either includes an external entity or it does not.",
    technicalDetail: "Matches <!DOCTYPE … [ <!ENTITY … SYSTEM \"file:|http:|gopher:|ftp:\" …",
    citations: [
      { label: "OWASP — XXE", href: "https://cheatsheetseries.owasp.org/cheatsheets/XML_External_Entity_Prevention_Cheat_Sheet.html" },
    ],
    examples: [
      {
        title: "File-read XXE",
        snippet: "<!DOCTYPE foo [ <!ENTITY xxe SYSTEM \"file:///etc/passwd\"> ]><foo>&xxe;</foo>",
        why: "Canonical file-read XXE — directly testable against the parser.",
      },
    ],
  },
  {
    id: "tsan_or_helgrind",
    title: "ThreadSanitizer / Helgrind output",
    category: "avri-gold",
    family: "RACE_CONCURRENCY",
    description: "ThreadSanitizer / Helgrind / DRD output evidencing a data race.",
    whyItMatters:
      "Race conditions are notoriously hard to reproduce. A TSan/Helgrind dump is the strongest non-manual evidence.",
    technicalDetail: "Matches ThreadSanitizer / TSAN: / Helgrind / ==N== possible data race / DRD: prefixes.",
    citations: [
      { label: "ThreadSanitizer", href: "https://github.com/google/sanitizers/wiki/ThreadSanitizerCppManual" },
    ],
    examples: [],
  },
  {
    id: "raw_http_request",
    title: "Raw HTTP/1.1 request bytes",
    category: "avri-gold",
    family: "REQUEST_SMUGGLING",
    description:
      "Raw HTTP/1.1 request bytes with explicit headers (Host:, Content-Length:, Transfer-Encoding:).",
    whyItMatters:
      "Request smuggling lives in CRLF-level details. The raw bytes are not optional — paraphrased prose loses the bug.",
    technicalDetail: "Matches POST /…HTTP/1.1\\r\\n followed by Host: / Content-Length: / Transfer-Encoding: headers.",
    citations: [RFC7230, RFC9110],
    examples: [],
  },
  {
    id: "te_or_cl_conflict",
    title: "TE.CL / CL.TE conflict",
    category: "avri-gold",
    family: "REQUEST_SMUGGLING",
    description: "Both Transfer-Encoding: chunked and Content-Length: present in the same request.",
    whyItMatters:
      "Smuggling exploits the disagreement between two parsers about which header to honor. Showing both headers is the primitive.",
    technicalDetail:
      "Matches Transfer-Encoding: chunked together with Content-Length: <digit> in the same request block, in either order.",
    citations: [RFC7230],
    examples: [
      {
        title: "TE.CL desync",
        snippet: "POST / HTTP/1.1\nHost: example.com\nContent-Length: 6\nTransfer-Encoding: chunked\n\n0\n\nGPOST",
        why: "Front-end honors TE → forwards \"0\\r\\n\\r\\n\". Back-end honors CL → reads \"GPOST\" as the start of the next request.",
      },
    ],
  },
  {
    id: "code_diff",
    title: "Diff / patch hunk",
    category: "avri-gold",
    family: "FLAT",
    description: "A unified-diff hunk (--- / +++ / @@ -N,N +N,N @@) is included.",
    whyItMatters:
      "A patch is the strongest fix proposal — it shows the exact change and lets the maintainer apply it directly.",
    technicalDetail: "Matches --- / +++ / @@ headers in unified diff format.",
    citations: [],
    examples: [],
  },
  {
    id: "file_with_line",
    title: "File path with line number",
    category: "avri-gold",
    family: "FLAT",
    description: "A source file path with an explicit line reference (src/foo.c:142, lib/bar.py#L88).",
    whyItMatters:
      "Pin-pointing the line lets a maintainer jump straight to the bug.",
    technicalDetail:
      "Matches FILE.EXT[:#L@]N for common source extensions (c, h, cpp, js, ts, py, rb, go, rs, java, kt, swift, php, cs, m, mm, sh, yml, yaml, json, xml).",
    citations: [],
    examples: [],
  },
  {
    id: "cwe_correct_class",
    title: "CWE matches the family",
    category: "avri-gold",
    description:
      "The cited CWE matches the family of evidence in the report (e.g. CWE-89 for SQL injection).",
    whyItMatters:
      "A CWE that matches the family signals the reporter classified the bug correctly. A mismatched CWE is a smell that the bug was misunderstood.",
    technicalDetail:
      "Each AVRI family has a member CWE list. Matching cwe-N for any N in the family list earns +4.",
    citations: [
      { label: "MITRE — CWE List", href: "https://cwe.mitre.org/data/index.html" },
    ],
    examples: [],
  },
];

// ---------------------------------------------------------------------------
// Substance / cross-cutting evidence flags.
// ---------------------------------------------------------------------------

const SUBSTANCE: SignalMeta[] = [
  {
    id: "substance_poc_mismatch",
    title: "PoC does not match the claim",
    category: "substance",
    description:
      "A PoC is included, but it does not exercise the library or vulnerability the report claims.",
    whyItMatters:
      "A wrong PoC is worse than no PoC — it suggests the reporter cargo-culted code from elsewhere.",
    technicalDetail:
      "Engine 2 cross-checks the libraries and APIs named in the prose against those imported / called inside the fenced code blocks.",
    citations: [],
    examples: [],
  },
  {
    id: "substance_domain_incoherent",
    title: "Claims show domain incoherence",
    category: "substance",
    description:
      "The report claims an attack on a project type or architecture the project does not have.",
    whyItMatters:
      "E.g. claiming SSRF on a static-site generator, or SQLi on a schema-less file store. These are categorically wrong.",
    technicalDetail:
      "Engine 2 cross-references the project type (when known) against the claimed bug class.",
    citations: [],
    examples: [],
  },
  {
    id: "substance_ai_low_quality",
    title: "AI-disclosed + low substance",
    category: "substance",
    description:
      "The reporter discloses they used an AI assistant, and the substance score is low.",
    whyItMatters:
      "AI assistance can produce great reports — but only when paired with real evidence. The combination of disclosure + thin evidence is the worst-case for triage.",
    technicalDetail:
      "Fires when AI-disclosure phrases are detected and the Engine 2 substance score is below the configured floor.",
    citations: [],
    examples: [],
  },
  {
    id: "substance_irrelevant_compliance",
    title: "Irrelevant compliance citations",
    category: "substance",
    description:
      "Compliance frameworks (SOC2, PCI, HIPAA) are cited but are not relevant to the project type.",
    whyItMatters:
      "Compliance buzzwords are a tell of a templated, low-substance report — they are pasted in to add weight, not because they apply.",
    technicalDetail:
      "Engine 2 cross-references cited frameworks against the project type and flags the mismatch.",
    citations: [],
    examples: [],
  },
];

export const ALL_SIGNALS: SignalMeta[] = [
  ...HALLUCINATION,
  ...AVRI_GOLD,
  ...SUBSTANCE,
];

export const SIGNALS_BY_ID: Record<string, SignalMeta> = Object.fromEntries(
  ALL_SIGNALS.map((s) => [s.id, s]),
);

export const SIGNAL_CATEGORIES: Array<{
  id: SignalCategory;
  label: string;
  description: string;
}> = [
  {
    id: "hallucination",
    label: "Hallucination signals",
    description:
      "Negative-evidence detectors. They dock points when a report contains internal inconsistencies a real artifact never has.",
  },
  {
    id: "avri-gold",
    label: "AVRI gold signals",
    description:
      "Positive-evidence rubric signals from the AVRI family rubrics — what reproducible reports of each bug class look like.",
  },
  {
    id: "substance",
    label: "Substance flags",
    description:
      "Engine 2 substance-density flags surfaced when claims are mismatched with proof.",
  },
];

export function getSignalsByCategory(category: SignalCategory): SignalMeta[] {
  return ALL_SIGNALS.filter((s) => s.category === category);
}
