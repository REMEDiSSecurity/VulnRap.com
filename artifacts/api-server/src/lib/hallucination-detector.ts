import { detectStructuralFabrication } from "./engines/avri/crash-trace";

export interface HallucinationSignal {
  type: string;
  description: string;
  weight: number;
}

export interface HallucinationResult {
  score: number;
  signals: HallucinationSignal[];
  totalWeight: number;
}

export function detectHallucinationSignals(text: string): HallucinationResult {
  const signals: HallucinationSignal[] = [];

  // Sprint 13B-2: structural-fabrication tells against ASan/TSan-style traces.
  // The shared `detectStructuralFabrication` validator runs nine predicates:
  //   • shape (Sprint 13B-2): round function offsets, frame-numbering gaps,
  //     thread-id inconsistency (no `==PID==` anchor), round/hex heap region
  //     size.
  //   • bounds (Task #303): function offsets outside realistic bounds (in the
  //     prologue or implying a 1 MiB+ function), thread/PID identifiers
  //     outside realistic Linux/sanitizer ranges, heap region sizes
  //     incompatible with the access-size header.
  //   • register/map (Task #316): register dumps with textbook-round or
  //     repeated values, /proc/self/maps listings whose ranges overlap, are
  //     zero-size, sit below mmap_min_addr, or are not 4 KiB page-aligned.
  // When ≥2 fire the trace is internally inconsistent in ways a real
  // sanitizer never produces — strong fabrication evidence even when the
  // prose claims well-resolved frames.
  //
  // The signal weight scales with the number of markers so a 2-marker hit
  // lands on the moderate (-10) tier alone while a 4-marker hit (every
  // structural tell firing at once) clears the overwhelming (-25) tier on
  // its own. Per-marker weight 8 was chosen so:
  //   2 markers → 16 (moderate -10)
  //   3 markers → 24 (strong -15)
  //   4 markers → 32 (overwhelming -25)
  const structuralMarkers = detectStructuralFabrication(text);
  if (structuralMarkers.length >= 2) {
    signals.push({
      type: "structural_fabrication",
      description: `Crash trace has ${structuralMarkers.length} structural fabrication markers — ${structuralMarkers.map((m) => m.id).join(", ")}`,
      weight: structuralMarkers.length * 8,
    });
  }

  // Sprint 13B-3 (Task #304): impossible_http_response evaluates raw
  // HTTP request / response excerpts pasted in fenced code blocks for
  // internal consistency. Slop authors paste plausible-looking HTTP
  // blocks to "show" the vulnerability, but the small details — a 204
  // followed by a body, "200 Not Found" as the status line, a
  // Content-Length that flatly disagrees with the body bytes it labels,
  // a Cookie header on a response, Set-Cookie on a request, a HEAD
  // request answered with a body — are arrangements a real HTTP stack
  // never produces. The five predicates here mirror the structural-
  // fabrication design (Sprint 13B-2): each fires independently and
  // weight scales linearly so a single tell lands as a mild signal
  // (8) while a two-tell cluster crosses the moderate-override
  // threshold (16, paired with anything else clears the -10 tier).
  // Per-marker weight matches structural_fabrication so the two
  // detectors compose cleanly when both fire on the same report.
  const httpMarkers = detectImpossibleHttpResponse(text);
  if (httpMarkers.length >= 1) {
    signals.push({
      type: "impossible_http_response",
      description: `HTTP excerpt is internally inconsistent — ${httpMarkers.join(", ")}`,
      weight: httpMarkers.length * 8,
    });
  }

  const stackFrames = text.match(/#\d+\s+0x[0-9a-f]+\s+in\s+\S+/gi) || [];
  if (stackFrames.length >= 3) {
    const uniqueFrames = new Set(stackFrames.map(f => f.replace(/#\d+/, "#N")));
    const repetitionRatio = 1 - (uniqueFrames.size / stackFrames.length);
    if (repetitionRatio > 0.5) {
      signals.push({
        type: "fabricated_stack_trace",
        description: `Stack trace has ${Math.round(repetitionRatio * 100)}% repeated frames — real crashes have varied call chains`,
        weight: 15,
      });
    }
  }

  // Task #206 (Sprint 13B-1): tightened round-address detector. The
  // previous v3.6.0 allowlist exempted broad allocator base ranges
  // (`0x60200000`, `0x10000000`, `0x7f0000000000`, …) that have no
  // citable provenance — they are merely "places real allocators tend to
  // map", not addresses real ASan output ever prints verbatim. Sprint 12
  // Report 82 used `0x000060400000` — one hex digit away from a previously
  // allowlisted base — and slipped past detection. The trailing-zero
  // threshold is also lowered from ≥5 to ≥3 so 12-digit fabricated heap
  // addresses with 4–5 trailing zeros (the typical "looks plausible but
  // is round" shape) get caught. The two outer guards are unchanged
  // (`roundAddresses / addresses > 50%` and `!hasRealCrashIndicators`),
  // so legit ASan dumps that incidentally include a page-aligned address
  // are still safe.
  const KNOWN_ALLOCATOR_ADDRESSES = new Set<string>([
    // Intentionally empty: no entry survived the Sprint 13B-1 audit.
  ]);
  const addresses = text.match(/0x[0-9a-f]{8,16}/gi) || [];
  const roundAddresses = addresses.filter(a => {
    const lower = a.toLowerCase();
    if (KNOWN_ALLOCATOR_ADDRESSES.has(lower)) return false;
    const hex = lower.replace("0x", "");
    const trailing = hex.match(/0+$/)?.[0].length || 0;
    const sequential = /(?:1234|5678|9abc|abcd|dead|beef|cafe|face)/.test(hex);
    return trailing >= 3 || sequential;
  });
  // v3.6.0 §6: Real ASan/gdb crash dumps frequently include some round-looking
  // addresses (allocator boundaries, page-aligned regions). Only flag the
  // round-address pattern when there are no other corroborating real-crash
  // indicators in the surrounding text — otherwise we falsely accuse legit
  // sanitizer reports that happen to land on aligned addresses.
  const hasRealCrashIndicators =
    /SUMMARY:\s*AddressSanitizer/i.test(text) ||
    /==\d+==ERROR:\s*AddressSanitizer/i.test(text) ||
    /Thread\s+\d+\s+received\s+signal\s+SIG/i.test(text) ||
    /Program\s+received\s+signal\s+SIG/i.test(text) ||
    /\(gdb\)\s+(?:bt|backtrace|info\s+registers)/i.test(text) ||
    /==\d+==\s*(?:READ|WRITE)\s+of\s+size\s+\d+/i.test(text);
  if (
    addresses.length >= 2 &&
    roundAddresses.length / addresses.length > 0.5 &&
    !hasRealCrashIndicators
  ) {
    signals.push({
      type: "fabricated_addresses",
      description: `${roundAddresses.length}/${addresses.length} memory addresses appear artificially constructed (round/sequential values)`,
      weight: 10,
    });
  }

  const exploitScripts = text.match(/(?:exploit|payload|poc|attack)\.py/gi) || [];
  if (exploitScripts.length > 0 && !text.includes("import ") && !text.includes("def ")) {
    signals.push({
      type: "phantom_exploit_script",
      description: `References "${exploitScripts[0]}" but provides no actual source code`,
      weight: 8,
    });
  }

  // Task #206 (Sprint 13B-1): `incomplete_asan` now requires positive
  // evidence of structural inconsistency, not just a missing trailing
  // `SUMMARY: AddressSanitizer ...` line. The earlier v3.8.0 (Task #192)
  // pass already suppressed the rule when the excerpt showed any of the
  // authentic ASan-context markers (ERROR header, resolved frames, read/
  // write size header, freed-by trailer, previously-allocated trailer).
  // That removed most false positives, but the rule still fired on a
  // bare prose mention of "AddressSanitizer" without a specific bug-class
  // claim — which is exactly the shape of an honest one-liner like
  // "I tested under AddressSanitizer." The new contract is:
  //   1. The text must claim a specific ASan-detected bug class
  //      (heap-buffer-overflow, use-after-free, stack-buffer-overflow,
  //      double-free, global-buffer-overflow, heap/stack overflow), AND
  //   2. None of the structural anchors that real ASan output emits are
  //      present (SUMMARY line, shadow-bytes section, ERROR header,
  //      resolved file:line frames, READ/WRITE access-size header,
  //      freed-by/previously-allocated trailers).
  // This matches the task description's example: "claims an overflow
  // but shows no shadow bytes." Real bug reports either show one of the
  // structural anchors or describe the bug in their own prose without
  // citing a specific ASan classifier.
  const hasAsan = /AddressSanitizer/i.test(text);
  const claimsAsanBugClass = /(?:heap[-\s]buffer[-\s]overflow|stack[-\s]buffer[-\s]overflow|global[-\s]buffer[-\s]overflow|heap[-\s]use[-\s]after[-\s]free|use[-\s]after[-\s]free|double[-\s]free|heap\s+overflow|stack\s+overflow)/i.test(text);
  const hasAsanDetails = /SUMMARY:\s*AddressSanitizer/i.test(text);
  const hasShadowBytes = /Shadow\s+bytes\s+around/i.test(text);
  const hasAsanErrorHeader = /==\d+==\s*ERROR:\s*AddressSanitizer\s*:/i.test(text);
  const hasResolvedFrame = /#\d+\s+0x[0-9a-f]+\s+in\s+\S[^\n]*\.[A-Za-z0-9_+-]+:\d+/i.test(text);
  const hasReadWriteSize = /(?:READ|WRITE)\s+of\s+size\s+\d+\s+at\s+0x[0-9a-f]+/i.test(text);
  const hasFreedBy = /freed\s+by\s+thread\s+T\d+\s+here/i.test(text);
  const hasPrevAllocated = /previously\s+allocated\s+by\s+thread/i.test(text);
  const hasRealAsanContext =
    hasAsanDetails ||
    hasShadowBytes ||
    hasAsanErrorHeader ||
    hasResolvedFrame ||
    hasReadWriteSize ||
    hasFreedBy ||
    hasPrevAllocated;
  if (hasAsan && claimsAsanBugClass && !hasRealAsanContext) {
    signals.push({
      type: "incomplete_asan",
      description: "ASan excerpt is structurally inconsistent — claims a specific bug class but shows no shadow bytes, ERROR header, resolved frames, READ/WRITE size header, or freed-by trailer that real ASan produces",
      weight: 12,
    });
  }

  const functionRefs = text.match(/\b(\w+(?:_\w+)+)\s*\(/g) || [];
  const codeBlocks = text.match(/```[\s\S]*?```/g) || [];
  const codeContent = codeBlocks.join(" ");

  if (functionRefs.length >= 3) {
    const phantomFunctions = functionRefs.filter(f => {
      const name = f.replace(/\s*\($/, "");
      return !codeContent.includes(name);
    });
    if (phantomFunctions.length >= 3 && codeBlocks.length === 0) {
      signals.push({
        type: "phantom_functions",
        description: `References ${phantomFunctions.length} specific functions but provides no code showing them — claims may be fabricated`,
        weight: 10,
      });
    }
  }

  // v3.8.0 (Task #192): the magic-PID rule used to fire on any single
  // textbook PID in `==N==` form (12345, 11111, 99999, 10000, 54321). Those
  // numbers — especially 12345 — are widely used as placeholder PIDs in real
  // bug reports (the curl, libcurl, and Firefox legit fixtures all use one).
  // We now require either:
  //   (a) two or more distinct magic PIDs in the same report, or
  //   (b) a single magic PID accompanied by another fabrication signal
  //       already detected above (fabricated stack trace, fabricated/round
  //       addresses, phantom exploit script, phantom functions).
  // This keeps the rule firing on every T4 fabrication fixture that ever
  // tripped it before while sparing legit ASan excerpts that just happen to
  // pick a textbook PID. Note: this block runs AFTER `phantom_functions` is
  // computed so that signal can also corroborate a magic PID.
  const MAGIC_PIDS = new Set(["12345", "11111", "99999", "10000", "54321"]);
  const PRIMARY_FABRICATION_TYPES = new Set([
    "fabricated_stack_trace",
    "fabricated_addresses",
    "phantom_exploit_script",
    "phantom_functions",
    // Sprint 13B-2: structural-fabrication tells (round offsets, frame gaps,
    // missing PID anchor, hex/round region size) corroborate magic PIDs the
    // same way fabricated stacks/addresses do.
    "structural_fabrication",
  ]);
  const pidMatches = text.match(/==(\d+)==/g) || [];
  const distinctMagicPids = new Set(
    pidMatches.map((p) => p.replace(/==/g, "")).filter((p) => MAGIC_PIDS.has(p)),
  );
  if (distinctMagicPids.size >= 2) {
    signals.push({
      type: "fabricated_pid",
      description: `Multiple textbook PIDs (${[...distinctMagicPids].join(", ")}) appear in the same report — real crashes have arbitrary numbers`,
      weight: 6,
    });
  } else if (distinctMagicPids.size === 1) {
    const hasOtherFabrication = signals.some((s) => PRIMARY_FABRICATION_TYPES.has(s.type));
    if (hasOtherFabrication) {
      const pid = [...distinctMagicPids][0];
      signals.push({
        type: "fabricated_pid",
        description: `Process ID "${pid}" is a textbook example PID and the report carries other fabrication signals`,
        weight: 6,
      });
    }
  }

  const versions = text.match(/(?:version\s+|v)((\d+)\.(\d+)\.(\d+))/gi) || [];
  for (const ver of versions) {
    const parts = ver.match(/(\d+)\.(\d+)\.(\d+)/);
    if (parts) {
      const [, majorStr, , patchStr] = parts;
      const major = Number(majorStr);
      const patch = Number(patchStr);
      if (patch > 200 && major < 10) {
        signals.push({
          type: "implausible_version",
          description: `Version "${parts[0]}" has an unusually high patch number — may be fabricated`,
          weight: 5,
        });
      }
    }
  }

  const hasXSS = /(?:cross.?site\s+scripting|XSS)/i.test(text);
  const claimsRCE = /(?:remote\s+code\s+execution|RCE|arbitrary\s+code\s+execution)/i.test(text);
  if (hasXSS && claimsRCE && !/(?:electron|node|server.?side|SSR)/i.test(text)) {
    signals.push({
      type: "impact_escalation",
      description: "Claims RCE from XSS without mentioning a server-side or Electron context — typical AI overstatement",
      weight: 8,
    });
  }

  const mentionsPython = /(?:python|\.py|pip|django|flask)/i.test(text);
  const mentionsJS = /(?:node\.?js|npm|express|\.js\b|require\s*\()/i.test(text);
  const mentionsC = /(?:\.c\b|\.h\b|gcc|malloc|free\s*\(|#include)/i.test(text);
  const languageCount = [mentionsPython, mentionsJS, mentionsC].filter(Boolean).length;
  if (languageCount >= 3) {
    signals.push({
      type: "language_confusion",
      description: "Report references Python, JavaScript, AND C/C++ — a single vulnerability rarely spans 3 language ecosystems",
      weight: 8,
    });
  }

  const sentencesArr = text.split(/[.!?]+/).map(s => s.trim().toLowerCase()).filter(s => s.length > 20);
  const seen = new Map<string, number>();
  let duplicates = 0;
  for (const s of sentencesArr) {
    const normalized = s.replace(/\s+/g, " ");
    if (seen.has(normalized)) {
      duplicates++;
    }
    seen.set(normalized, (seen.get(normalized) || 0) + 1);
  }
  if (duplicates >= 2) {
    signals.push({
      type: "repeated_sentences",
      description: `${duplicates} duplicate sentences detected — may indicate copy-paste generation artifacts`,
      weight: 6,
    });
  }

  const hasResponsibleDisclosure = /responsible\s+disclosure/i.test(text);
  const hasTimeline = /(?:reported|disclosed|notified|contacted)\s+(?:on|at)?\s*\d{4}[-/]\d{2}[-/]\d{2}/i.test(text);
  const hasVendorContact = /(?:vendor|maintainer|developer)\s+(?:response|confirmed|acknowledged)/i.test(text);
  if (hasResponsibleDisclosure && !hasTimeline && !hasVendorContact) {
    signals.push({
      type: "empty_disclosure_claim",
      description: 'Claims "responsible disclosure" but provides no disclosure timeline or vendor communication — boilerplate padding',
      weight: 5,
    });
  }

  const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
  const score = Math.max(0, 100 - totalWeight * 2);

  return { score, signals, totalWeight };
}

// =============================================================================
// Sprint 13B-3 (Task #304): impossible_http_response helper.
//
// Walks every fenced code block in `text` and returns a deduplicated list
// of marker IDs for HTTP request/response excerpts whose status, headers,
// and body are arranged in ways a real HTTP stack never produces. The
// caller wraps the markers into a single `impossible_http_response`
// signal whose weight scales with the marker count.
//
// Scoping: this validator only inspects HTTP excerpts inside fenced
// code blocks (```http or bare ```). Real bug reports — including the
// curl/HackerOne legit cohort — paste their HTTP excerpts inside
// fences; running outside fences would risk false-positives on prose
// that incidentally mentions header names. The AVRI raw-HTTP family
// validator (`raw-http.ts`) already handles structural fakeness
// (placeholder values, broken TE/CL conflicts, fabricated response
// shape) inside the SMUGGLING / response-class gold-signal path; this
// signal is complementary, focused on bytes that *cannot exist* per
// the HTTP/1.1 spec rather than on bytes that merely *look fake*.
// =============================================================================

// Status code → expected reason phrase(s), lowercase. We only enumerate
// phrases that have a single canonical wording (or two well-known
// alternates). Comparison is case-insensitive after collapsing inner
// whitespace, so "OK" / "ok" / "Ok" all match the canonical "ok".
const STATUS_REASON_PHRASES: Readonly<Record<number, ReadonlyArray<string>>> = {
  100: ["continue"],
  101: ["switching protocols"],
  200: ["ok"],
  201: ["created"],
  202: ["accepted"],
  203: ["non-authoritative information"],
  204: ["no content"],
  205: ["reset content"],
  206: ["partial content"],
  301: ["moved permanently"],
  302: ["found", "moved temporarily"],
  303: ["see other"],
  304: ["not modified"],
  307: ["temporary redirect"],
  308: ["permanent redirect"],
  400: ["bad request"],
  401: ["unauthorized"],
  403: ["forbidden"],
  404: ["not found"],
  405: ["method not allowed"],
  406: ["not acceptable"],
  408: ["request timeout"],
  409: ["conflict"],
  410: ["gone"],
  411: ["length required"],
  413: ["payload too large", "request entity too large", "content too large"],
  414: ["uri too long", "request-uri too long"],
  415: ["unsupported media type"],
  418: ["i'm a teapot", "im a teapot"],
  422: ["unprocessable entity", "unprocessable content"],
  429: ["too many requests"],
  500: ["internal server error"],
  501: ["not implemented"],
  502: ["bad gateway"],
  503: ["service unavailable"],
  504: ["gateway timeout"],
  505: ["http version not supported"],
};

// Headers a real HTTP stack only emits in one direction. We deliberately
// pick the strongest cases (RFC 6265 §3 — Cookie request-only,
// Set-Cookie response-only; RFC 7231/7232 — Location/WWW-Authenticate
// response-only, Referer/Origin/Range request-only) so an unusual but
// permitted shape (Server header on a request, Host on a response) does
// NOT trip the detector.
const REQUEST_ONLY_HEADERS = new Set<string>([
  "cookie",
  "referer",
  "origin",
  "range",
  "if-none-match",
  "if-modified-since",
]);
const RESPONSE_ONLY_HEADERS = new Set<string>([
  "set-cookie",
  "www-authenticate",
  "proxy-authenticate",
  "location",
]);

interface HttpMessage {
  kind: "request" | "response";
  method?: string;
  statusCode?: number;
  reasonPhrase?: string;
  headers: Map<string, string>;
  body: string;
}

// Match a request-line OR a status-line at start of line. We allow any
// 3–10 uppercase ASCII method token (so smuggled methods are not
// excluded), and constrain the reason phrase to ≤80 visible chars
// (printf-escaped lines whose "phrase" is a backslash sequence won't
// match — the trailing CRLF requirement enforces real line breaks).
const HTTP_MESSAGE_START_RE =
  /(^|\n)(?:(HTTP\/1\.[01])[ \t]+(\d{3})[ \t]+([^\r\n]{1,80})|([A-Z]{3,10})[ \t]+(\S+)[ \t]+(HTTP\/1\.[01]))\r?\n/g;

const FENCED_BLOCK_RE = /```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)\r?\n```/g;

const HEADER_LINE_HALLUCINATION_RE = /^([A-Za-z][A-Za-z0-9\-_]*)\s*:\s*(.*?)\s*$/;

function parseHttpMessages(block: string): HttpMessage[] {
  HTTP_MESSAGE_START_RE.lastIndex = 0;
  type Start = {
    msgStart: number;
    headerStart: number;
    kind: "request" | "response";
    method?: string;
    statusCode?: number;
    reasonPhrase?: string;
  };
  const starts: Start[] = [];
  let m: RegExpExecArray | null;
  while ((m = HTTP_MESSAGE_START_RE.exec(block)) !== null) {
    const lead = m[1] === "\n" ? 1 : 0;
    const msgStart = m.index + lead;
    const headerStart = m.index + m[0].length;
    if (m[2]) {
      starts.push({
        msgStart,
        headerStart,
        kind: "response",
        statusCode: Number(m[3]),
        reasonPhrase: m[4],
      });
    } else if (m[5]) {
      starts.push({
        msgStart,
        headerStart,
        kind: "request",
        method: m[5],
      });
    }
  }
  const out: HttpMessage[] = [];
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    const nextStart = i + 1 < starts.length ? starts[i + 1].msgStart : block.length;
    const tail = block.slice(s.headerStart, nextStart);
    let headerSection = tail;
    let body = "";
    // The status/request-line CRLF was already consumed by the
    // message-start regex, so `tail` begins with the next line. If that
    // next line is itself blank, the message has zero headers and the
    // body starts immediately — this is the canonical shape for
    // "HTTP/1.1 100 Continue" or any 204/304 message that paste authors
    // type as `STATUS_LINE\n\nBODY`. Without this branch the
    // double-CRLF search below would miss the separator and the body
    // would silently get parsed as a (malformed) header line.
    const leadingBlank = /^\r?\n/.exec(tail);
    if (leadingBlank) {
      headerSection = "";
      body = tail.slice(leadingBlank[0].length);
    } else {
      const blank = /\r?\n\r?\n/.exec(tail);
      if (blank) {
        headerSection = tail.slice(0, blank.index);
        body = tail.slice(blank.index + blank[0].length);
      }
    }
    const headers = new Map<string, string>();
    for (const line of headerSection.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const hm = HEADER_LINE_HALLUCINATION_RE.exec(t);
      if (hm) headers.set(hm[1].toLowerCase(), hm[2]);
    }
    out.push({
      kind: s.kind,
      method: s.method,
      statusCode: s.statusCode,
      reasonPhrase: s.reasonPhrase,
      headers,
      body,
    });
  }
  return out;
}

function inspectMessages(messages: HttpMessage[], markers: Set<string>): void {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const bodyTrimmed = msg.body.trim();
    const bodyLen = bodyTrimmed.length;

    if (msg.kind === "response") {
      const code = msg.statusCode!;

      // Predicate 1: reason-phrase mismatch. We compare the pasted
      // phrase (lowercased, inner whitespace collapsed) against the
      // canonical phrase(s) for the status code. Unknown codes are
      // skipped — the detector only flags codes whose canonical
      // wording is unambiguous.
      const expected = STATUS_REASON_PHRASES[code];
      if (expected && msg.reasonPhrase) {
        const phrase = msg.reasonPhrase.trim().toLowerCase().replace(/\s+/g, " ");
        if (phrase.length > 0 && !expected.includes(phrase)) {
          markers.add(`status_${code}_with_wrong_reason_phrase`);
        }
      }

      // Predicate 2: no-body status with a body. RFC 7230 §3.3.3
      // forbids 1xx / 204 / 304 from carrying a payload body. The
      // 8-char floor on the trimmed body lets through trailing
      // whitespace / a stray newline that the markdown fence
      // boundary may introduce.
      if ((code === 204 || code === 304 || (code >= 100 && code < 200)) && bodyLen >= 8) {
        markers.add(`status_${code}_must_have_no_body`);
      }

      // Predicate 3: Content-Length disagreement. Real responses
      // always agree; slop authors paste round-numbered CL values
      // ("Content-Length: 0" with content present, "Content-Length:
      // 1024" with an empty body) without re-counting the body.
      // We use the raw byte length of the body region (including
      // trailing whitespace inside the fence) when comparing — slop
      // bodies are short enough that the difference is dramatic.
      const cl = msg.headers.get("content-length");
      if (cl !== undefined && /^\d+$/.test(cl.trim())) {
        const declared = Number(cl.trim());
        const actual = msg.body.length;
        if (declared === 0 && bodyLen >= 8) {
          markers.add("content_length_zero_but_body_present");
        } else if (declared >= 100 && bodyLen === 0) {
          markers.add("content_length_declared_but_body_empty");
        } else if (
          declared > 20 &&
          bodyLen > 0 &&
          Math.abs(declared - actual) > Math.max(50, declared * 0.5)
        ) {
          markers.add("content_length_disagrees_with_body");
        }
      }

      // Predicate 4: response carrying a request-only header.
      for (const name of msg.headers.keys()) {
        if (REQUEST_ONLY_HEADERS.has(name)) {
          markers.add(`response_carries_request_only_${name}`);
        }
      }

      // Predicate 5: response to HEAD/CONNECT carrying a body. RFC
      // 7230 §3.3.3 forbids both. We look at the immediately preceding
      // request message in the same fence to pick up the method.
      const prev = i > 0 ? messages[i - 1] : null;
      if (
        prev?.kind === "request" &&
        (prev.method === "HEAD" || prev.method === "CONNECT") &&
        bodyLen >= 8
      ) {
        markers.add(`response_to_${prev.method}_must_have_no_body`);
      }
    } else {
      // Request-side: the only impossibility we flag is a request
      // carrying a response-only header. (Method / version validity
      // is left to other validators; an LLM-fabricated request line
      // is usually caught by the family-level raw-HTTP validator.)
      for (const name of msg.headers.keys()) {
        if (RESPONSE_ONLY_HEADERS.has(name)) {
          markers.add(`request_carries_response_only_${name}`);
        }
      }
    }
  }
}

export function detectImpossibleHttpResponse(text: string): string[] {
  const markers = new Set<string>();
  FENCED_BLOCK_RE.lastIndex = 0;
  let fm: RegExpExecArray | null;
  while ((fm = FENCED_BLOCK_RE.exec(text)) !== null) {
    const inner = fm[1];
    if (!inner) continue;
    const messages = parseHttpMessages(inner);
    if (messages.length === 0) continue;
    inspectMessages(messages, markers);
  }
  return [...markers];
}
