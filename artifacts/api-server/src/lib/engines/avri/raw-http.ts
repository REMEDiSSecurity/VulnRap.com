// Raw-HTTP-bytes validator for REQUEST_SMUGGLING reports.
//
// Smuggling reports (CWE-444/436/116/113/115) lean almost entirely on the
// raw HTTP/1.1 bytes the reporter pastes in: the parser disagreement only
// makes sense if the framing (CRLFs, Content-Length, Transfer-Encoding) is
// shown literally. This makes those reports easy to fake — slop authors
// can paste a plausible-looking `POST / HTTP/1.1` block with placeholder
// header values, no CRLFs, or a TE/CL "conflict" whose values don't
// actually conflict, and the family's gold-signal regexes will fire.
//
// This validator inspects each request-shaped block in the report and
// flags it as fake when:
//   - the headers carry placeholder values (e.g. "Host: <target>",
//     "Content-Length: XX", "Transfer-Encoding: <chunked>") for the
//     majority of header lines,
//   - a TE/CL conflict is claimed but the Content-Length value is not a
//     plain integer or the Transfer-Encoding value does not actually
//     contain "chunked",
//   - or the request bytes have no CRLF line endings at all even though
//     they span multiple header lines (smuggling depends on byte-precise
//     framing, so an LF-only paste with placeholder bodies is implausible
//     coming from a reporter who actually reproduced the desync).
//
// A legitimate smuggling fixture — copied from Burp or a real HTTP
// proxy log — has real header values, an integer Content-Length, an
// actual "chunked" Transfer-Encoding, and (usually) CRLFs preserved.

export interface RawHttpEvaluation {
  /** Number of `METHOD /path HTTP/1.x` request-lines detected. */
  requestsAnalyzed: number;
  /** Total `Header: value` lines parsed across all detected requests. */
  totalHeaders: number;
  /** Headers whose value is empty or matches a placeholder pattern. */
  placeholderHeaders: number;
  /** True iff at least one detected request block uses CRLF line endings. */
  crlfPresent: boolean;
  /** Number of detected requests that carry both TE and CL headers. */
  teClConflicts: number;
  /** Of those, how many have a non-numeric CL or non-"chunked" TE. */
  teClBroken: number;
  /** True iff the raw request bytes look fabricated. */
  isFake: boolean;
  /** Human-readable explanation, set when isFake. */
  reason: string | null;
}

// Request-line: METHOD SP request-target SP HTTP/1.x. We accept any 3–10
// uppercase letter token so smuggled "GPOST" / fabricated methods are
// still picked up (they are themselves a smuggling-tell, not a parser
// error here).
const REQUEST_LINE_RE = /(^|\n)([A-Z]{3,10})[ \t]+(\S+)[ \t]+HTTP\/1\.[01]\r?\n/g;

// Header-line shape: name ":" OWS value OWS.
const HEADER_LINE_RE = /^([A-Za-z][A-Za-z0-9\-_]*)\s*:\s*(.*?)\s*$/;

// Tokens that mark a header value as a placeholder rather than a real,
// reporter-supplied value.
const PLACEHOLDER_VALUE_PATTERNS: RegExp[] = [
  // Angle-bracketed placeholders: <target>, <host>, <value here>,
  // <chunked>, <length>, <your-host>, <insert ...>.
  /<[^>\n]{0,40}(?:target|host|value|here|your|insert|placeholder|fill|chunked|length|hex|crlf|payload|body)[^>\n]{0,40}>/i,
  // Bare angle bracket placeholder under 12 chars: <foo>, <bar>.
  /^<[^>\s]{1,12}>$/,
  // Square-bracket placeholders: [your host], [insert chunked here].
  /\[(?:your|insert|placeholder|fill|todo|tbd)[^\]]*\]/i,
  // ALL-CAPS placeholder runs: XX, XXXX, NNNN, ZZZZZZ, YYYY (≥2).
  /^(?:X{2,}|N{2,}|Z{2,}|Y{2,})$/,
  // Triple-question-mark placeholder.
  /\?\?\?+/,
  // Common slop tokens.
  /\b(?:tbd|todo|fixme|placeholder)\b/i,
];

function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  return PLACEHOLDER_VALUE_PATTERNS.some((re) => re.test(v));
}

interface RequestBlock {
  /** Offset in `text` of the start of the request-line. */
  start: number;
  /** Offset in `text` just past the request-line CRLF/LF. */
  headerStart: number;
}

function findRequestBlocks(text: string): RequestBlock[] {
  const out: RequestBlock[] = [];
  REQUEST_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REQUEST_LINE_RE.exec(text)) !== null) {
    const leadOffset = m[1] === "\n" ? 1 : 0;
    const start = m.index + leadOffset;
    out.push({ start, headerStart: m.index + m[0].length });
  }
  return out;
}

export interface RawHttpEvaluationOptions {
  /** When true, an LF-only multi-header request block is treated as
   * fake (smuggling depends on byte-precise framing). When false (the
   * default for AUTHN_AUTHZ / INJECTION), LF-only blocks are tolerated
   * because markdown transcription routinely strips CRLFs and those
   * families don't depend on byte-precise framing. */
  strictCrlf?: boolean;
}

export function evaluateRawHttpRequest(
  text: string,
  options: RawHttpEvaluationOptions = {},
): RawHttpEvaluation {
  const strictCrlf = options.strictCrlf ?? false;
  const blocks = findRequestBlocks(text);
  if (blocks.length === 0) {
    return {
      requestsAnalyzed: 0,
      totalHeaders: 0,
      placeholderHeaders: 0,
      crlfPresent: false,
      teClConflicts: 0,
      teClBroken: 0,
      isFake: false,
      reason: null,
    };
  }

  let totalHeaders = 0;
  let placeholderHeaders = 0;
  let goodHeaders = 0;
  let crlfPresent = false;
  let crlfRequired = false;
  let teClConflicts = 0;
  let teClBroken = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const nextBound =
      i + 1 < blocks.length ? blocks[i + 1].start : text.length;
    const headerSection = text.slice(block.headerStart, nextBound);
    // Header section ends at the first blank line (CRLF CRLF or LF LF).
    const blankIdx = headerSection.search(/\r?\n\r?\n/);
    const headerOnly =
      blankIdx >= 0 ? headerSection.slice(0, blankIdx) : headerSection;

    // CRLF check: look at the request-line + headers chunk in the original
    // text. We require at least 2 line breaks (request-line + one header)
    // before treating the absence of CRLF as evidence of fabrication —
    // single-line snippets are just too short to judge.
    const blockChunk = text.slice(block.start, block.headerStart + headerOnly.length);
    const lineBreaks = (blockChunk.match(/\n/g) || []).length;
    if (lineBreaks >= 2) {
      crlfRequired = true;
      if (/\r\n/.test(blockChunk)) crlfPresent = true;
    }

    const headerLines = headerOnly
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let teVal: string | null = null;
    let clVal: string | null = null;
    for (const line of headerLines) {
      const hm = HEADER_LINE_RE.exec(line);
      if (!hm) continue;
      totalHeaders++;
      const name = hm[1].toLowerCase();
      const value = hm[2];
      if (isPlaceholderValue(value)) {
        placeholderHeaders++;
      } else {
        goodHeaders++;
      }
      if (name === "transfer-encoding") teVal = value;
      else if (name === "content-length") clVal = value;
    }

    if (teVal !== null && clVal !== null) {
      teClConflicts++;
      const teOk = /\bchunked\b/i.test(teVal);
      const clOk = /^\s*\d+\s*$/.test(clVal);
      if (!teOk || !clOk) teClBroken++;
    }
  }

  // Decide. We fire isFake when any one of these strong signals is true.
  let isFake = false;
  let reason: string | null = null;

  const placeholderRatio =
    totalHeaders > 0 ? placeholderHeaders / totalHeaders : 0;

  if (totalHeaders >= 2 && placeholderRatio >= 0.5) {
    isFake = true;
    reason = `Raw HTTP request has ${placeholderHeaders}/${totalHeaders} headers with placeholder or missing values`;
  } else if (teClConflicts > 0 && teClBroken === teClConflicts) {
    isFake = true;
    reason =
      "Claimed TE/CL conflict has incoherent values (Content-Length is not a plain integer or Transfer-Encoding is not \"chunked\")";
  } else if (strictCrlf && crlfRequired && !crlfPresent && totalHeaders >= 2) {
    // Smuggling depends on byte-precise framing. A request-shaped block
    // that spans multiple header lines without a single CRLF is either
    // fabricated (slop pasted with `\n` only) or has been transcribed in
    // a way that destroys the very framing the report claims to exploit
    // — either way the raw-bytes gold signals don't deserve their
    // points. We require ≥2 parsed headers so single-line snippets and
    // markdown excerpts that lost their CRLFs in editing aren't punished.
    isFake = true;
    reason =
      "Raw HTTP request has no CRLF line endings — smuggling depends on byte-precise framing";
  } else if (totalHeaders >= 3 && goodHeaders === 0) {
    isFake = true;
    reason = "Raw HTTP request has no header with a real value";
  }

  return {
    requestsAnalyzed: blocks.length,
    totalHeaders,
    placeholderHeaders,
    crlfPresent,
    teClConflicts,
    teClBroken,
    isFake,
    reason,
  };
}

/** Per-family map of gold-signal IDs whose value depends on the raw HTTP
 * bytes being legitimate. When the raw-HTTP validator flags the request
 * as fake, points awarded for these signals must be revoked.
 *
 * REQUEST_SMUGGLING: `raw_http_request`, `te_or_cl_conflict`, and
 *   `smuggled_second_request` all match purely structural regexes against
 *   the pasted bytes; if those bytes are placeholder-padded, missing
 *   CRLFs, or carry an incoherent TE/CL conflict, the gold points must
 *   be revoked. Other family signals (`specific_proxy_or_server`,
 *   `cwe_correct_class`) survive because they reflect knowledge that
 *   slop authors can also fake but that don't depend on the raw bytes.
 *
 * AUTHN_AUTHZ: `authorization_header_swap` matches Authorization /
 *   Set-Cookie / sessionid header lines, which are exactly the bytes a
 *   slop author fabricates when they paste a fake `Authorization:
 *   Bearer <jwt-token-here>` or `Cookie: sessionid=XXXX` block. When the
 *   surrounding raw HTTP request is placeholder-padded the header swap
 *   is fake too. Prose-grounded signals (`two_account_proof`,
 *   `policy_or_check_function`, `cwe_correct_class`, `idor_object_id`,
 *   `specific_endpoint`) survive.
 *
 * INJECTION: `specific_endpoint_param` is the only injection gold signal
 *   tied to the request-line bytes (`POST /endpoint?param=` shape). A
 *   slop report that pastes a fake POST request with placeholder headers
 *   and a `<payload here>` body shouldn't earn this point; injection
 *   payload / sink-construction signals stay because they can be
 *   substantiated in code or prose independently of the raw bytes.
 */
export const RAW_HTTP_GOLD_SIGNAL_IDS_BY_FAMILY: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  REQUEST_SMUGGLING: new Set([
    "raw_http_request",
    "te_or_cl_conflict",
    "smuggled_second_request",
  ]),
  AUTHN_AUTHZ: new Set([
    "authorization_header_swap",
  ]),
  INJECTION: new Set([
    "specific_endpoint_param",
  ]),
};

export function rawHttpGoldSignalIdsFor(
  familyId: string,
): ReadonlySet<string> | null {
  return RAW_HTTP_GOLD_SIGNAL_IDS_BY_FAMILY[familyId] ?? null;
}
