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
//   - the request bytes have no CRLF line endings at all even though
//     they span multiple header lines (smuggling depends on byte-precise
//     framing, so an LF-only paste with placeholder bodies is implausible
//     coming from a reporter who actually reproduced the desync),
//   - or a credential-bearing header (Authorization / Cookie /
//     Set-Cookie / X-Auth-Token / X-Api-Key) carries a token that is
//     syntactically real-looking but semantically fabricated: a JWT
//     with an empty or placeholder-claim payload and/or a no-entropy
//     signature, or a cookie/raw-token value that is just a long run
//     of zeros, X's, or a single repeated character.
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
  /** Number of credential-bearing headers (Authorization, Cookie,
   * Set-Cookie, X-Auth-Token, X-Api-Key) parsed across all blocks. */
  credentialHeaders: number;
  /** Of those, how many carry a fabricated credential value (empty /
   * placeholder-claim JWT, no-entropy signature, all-zero cookie, etc). */
  fakeCredentialHeaders: number;
  /** Number of detected request blocks whose body content is itself a
   * placeholder (e.g. "<sql payload here>", `q=<inject>`, `{ "q": "<inject>" }`).
   * Real exploit payloads never contain `<...>` slot markers, so a body made
   * up of those is evidence the "payload" was never actually sent. */
  placeholderBodies: number;
  /** Number of prose-level placeholder payload mentions detected outside of
   * raw HTTP request bodies (e.g. "Payload: `<sql payload here>`",
   * "Run: `<inject>`", "exec: `<command here>`"). Slop authors use these to
   * gesture at a payload without naming one; if the family's payload-class
   * gold signal happens to match unrelated tokens elsewhere in the report,
   * the engine re-tests the signal pattern against text with these prose
   * ranges stripped and revokes the point if no real match remains. */
  prosePlaceholderPayloads: number;
  /** Byte ranges (start, end half-open) of bodies and prose snippets that
   * look like placeholders. Used by the AVRI engine to revoke payload-class
   * gold signals whose only match was inside one of these ranges. */
  placeholderBodyRanges: ReadonlyArray<{ start: number; end: number }>;
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

// Headers whose values carry the credential the slop author is claiming
// to have swapped/replayed. AUTHN_AUTHZ's `authorization_header_swap`
// gold signal fires on the byte-shape of these lines, so we audit the
// values themselves to catch syntactically real-looking but fabricated
// tokens.
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-auth-token",
  "x-api-key",
  "x-session-token",
]);

// Standard placeholder identities slop authors paste into JWT claims.
// We compare claim values case-insensitively.
const PLACEHOLDER_CLAIM_VALUES = new Set([
  "admin",
  "administrator",
  "root",
  "user",
  "username",
  "userid",
  "guest",
  "test",
  "testuser",
  "example",
  "placeholder",
  "todo",
  "tbd",
  "fixme",
  "null",
  "none",
  "string",
]);

// Decode a base64url segment to UTF-8. Returns null on any decoding
// failure (so the caller can decide how to interpret a malformed JWT).
function decodeBase64Url(seg: string): string | null {
  try {
    const cleaned = seg.replace(/-/g, "+").replace(/_/g, "/");
    const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
    return Buffer.from(padded, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

// Returns a human-readable reason if the JWT-looking token is
// fabricated, or null if it survives the checks. We only run this when
// the value already has the three-segment shape; non-JWT bearer tokens
// are scored separately.
function inspectJwtToken(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerSeg, payloadSeg, sigSeg] = parts;
  if (!headerSeg || !payloadSeg || !sigSeg) {
    return "JWT has an empty header/payload/signature segment";
  }
  const payloadJson = decodeBase64Url(payloadSeg);
  if (payloadJson === null) {
    return "JWT payload is not valid base64url";
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return "JWT payload is not valid JSON";
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return "JWT payload is not a JSON object";
  }
  const entries = Object.entries(payload as Record<string, unknown>);
  if (entries.length === 0) return "JWT payload is empty (no claims)";
  for (const [k, v] of entries) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed.length === 0) continue;
    if (/^<[^>\n]{0,40}>$/.test(trimmed)) {
      return `JWT claim "${k}" is a placeholder ("${trimmed}")`;
    }
    if (PLACEHOLDER_CLAIM_VALUES.has(trimmed.toLowerCase())) {
      return `JWT claim "${k}" is a placeholder identity ("${trimmed}")`;
    }
    if (/^(?:X{3,}|N{3,}|Z{3,}|Y{3,}|0{3,})$/i.test(trimmed)) {
      return `JWT claim "${k}" is a placeholder run ("${trimmed}")`;
    }
  }
  // Signature entropy: a real HS256 / RS256 signature is at least 32
  // bytes (≈43 base64url chars). Anything shorter than 16 chars is
  // implausible; anything that decodes to ≤2 distinct characters is a
  // hand-typed run like "AAAAAA" or "00000000".
  const sigClean = sigSeg.replace(/=+$/, "");
  if (sigClean.length < 16) {
    return `JWT signature is implausibly short (${sigClean.length} chars)`;
  }
  if (new Set(sigClean).size <= 2) {
    return "JWT signature has no entropy (single repeated character)";
  }
  return null;
}

// Returns a reason string if a raw token / cookie value is a no-entropy
// placeholder run, or null otherwise. We only flag values that are
// long enough (≥8 chars) to plausibly be a real token — short values
// like "abc" are not punished.
function inspectOpaqueToken(label: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length < 8) return null;
  const cleaned = trimmed.replace(/[^A-Za-z0-9]/g, "");
  if (cleaned.length < 8) return null;
  if (new Set(cleaned).size <= 2) {
    return `${label} value has no entropy (single repeated character: "${trimmed.slice(0, 24)}${trimmed.length > 24 ? "…" : ""}")`;
  }
  return null;
}

// Inspect a Cookie / Set-Cookie header value, which may carry several
// `name=value` pairs. We flag the header as fabricated when every
// parsed pair fails the opaque-token entropy check (so a single real
// session cookie alongside a fake CSRF token is not punished).
function inspectCookieHeader(value: string): string | null {
  const pairs = value
    .split(/;\s*/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (pairs.length === 0) return null;
  let total = 0;
  let fake = 0;
  let lastReason = "";
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    if (val.length === 0) continue;
    // Strip an optional surrounding quoting (Set-Cookie may quote).
    const unquoted = val.replace(/^"(.*)"$/, "$1");
    total++;
    const r = inspectOpaqueToken(`Cookie pair "${name}"`, unquoted);
    if (r !== null) {
      fake++;
      lastReason = r;
    }
  }
  if (total > 0 && fake === total) return lastReason;
  return null;
}

// Top-level credential-header dispatcher. Returns a fabrication reason
// or null. The header name is passed in lower-cased.
function inspectCredentialHeader(name: string, value: string): string | null {
  const v = value.trim();
  if (v.length === 0) return null;
  if (name === "authorization" || name === "proxy-authorization") {
    const m = /^(Bearer|Token|JWT)\s+(\S.*)$/i.exec(v);
    if (m) {
      const tok = m[2].trim();
      if (tok.split(".").length === 3) return inspectJwtToken(tok);
      return inspectOpaqueToken("Authorization token", tok);
    }
    // Basic <base64>: decode and look for "user:password"-style placeholders.
    const basic = /^Basic\s+(\S+)$/i.exec(v);
    if (basic) {
      const decoded = decodeBase64Url(basic[1].replace(/=+$/, ""));
      if (decoded !== null && /^(admin|user|test|root|guest):.{0,40}$/i.test(decoded)) {
        return `Basic auth credential is a placeholder ("${decoded}")`;
      }
    }
    return null;
  }
  if (name === "cookie" || name === "set-cookie") {
    return inspectCookieHeader(v);
  }
  // X-Auth-Token / X-Api-Key / X-Session-Token: a single opaque token.
  return inspectOpaqueToken(`${name} header`, v);
}

// Vocabulary that, when seen inside a `<...>` slot in a request body, marks
// that slot as a placeholder rather than a real attacker-supplied byte. Real
// SQLi / cmd / NoSQL / LDAP / template payloads never contain `<...>` slot
// markers — when a slop author "shows" a payload they reach for these.
const BODY_PLACEHOLDER_KEYWORDS =
  /(?:payload|inject|sqli?|cmd|command|shell|body|here|placeholder|insert|fill|target|host|value|your|jwt|token|hex|crlf|length|chunked|smuggled|attack(?:er)?|victim|exploit|malicious|user[\s_-]?input|param(?:eter)?|fixme|todo|tbd|secret|admin|password|hash|nosql|ldap|template|xpath|xxe|filename|filepath|file[\s_-]?path)/i;

/** True iff the request body content looks like a placeholder rather than an
 * actual attacker payload. Detects the common slop shapes:
 *   - whole body is `<sql payload here>` / `<inject>` / `<request body here>`
 *   - form body whose every value is `<inject>`: `q=<sql payload here>`
 *   - JSON body whose every value is a `<...>` slot: `{ "q": "<inject>" }`
 *   - bare TBD/TODO/FIXME bodies
 *
 * A real exploit body (`q=' UNION SELECT password FROM users--`,
 * `id=1; cat /etc/passwd`, `{"$ne": null}`) returns false. */
export function isPlaceholderBody(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) return false;
  // Bare admit-this-is-a-placeholder body.
  if (/^(?:tbd|todo|fixme|placeholder|n\/?a)$/i.test(trimmed)) return true;
  // [your payload] / [insert here] style square-bracket placeholders.
  if (/\[(?:your|insert|placeholder|fill|todo|tbd|payload|inject|here)\b[^\]]*\]/i.test(trimmed)) {
    return true;
  }
  // Find every angle-bracketed token in the body. Real exploit payloads
  // don't contain `<foo>` slot markers (XSS payloads do, but XSS is the
  // WEB_CLIENT family — INJECTION bodies don't carry HTML).
  const angle = trimmed.match(/<[^>\n]{1,80}>/g);
  if (!angle || angle.length === 0) return false;
  for (const tok of angle) {
    const inner = tok.slice(1, -1).trim();
    if (inner.length === 0) continue;
    // Slot whose inner text is a slop-vocabulary word — clearly a placeholder.
    if (BODY_PLACEHOLDER_KEYWORDS.test(inner)) return true;
    // Bare short identifier slot (`<foo>`, `<bar>`) — also a placeholder.
    if (/^[a-z][a-z0-9_\-\s]{0,30}$/i.test(inner)) return true;
  }
  return false;
}

// Prose-level placeholder payload reference: a payload-context word
// ("Payload:", "Inject:", "Exec:", "Run:", "Command:", "Shell:", "SQLi:")
// followed by a `<...>` slot like `<sql payload here>` / `<inject>` /
// `<command here>`, optionally wrapped in inline-code or quote markers.
// Slop authors drop these in prose to gesture at a payload without naming
// one — symmetric to the placeholder-body check, but for the prose path.
//
// The label list intentionally mirrors the body-placeholder vocabulary
// (payload, inject, exec, run, command, cmd, shell, plus the injection
// sub-families sqli/nosql/ldap/xpath/template) so a slop author can't
// dodge by relabelling the slot.
const PROSE_PAYLOAD_PLACEHOLDER_RE =
  /\b(?:payloads?|inject(?:ion|ed|s)?|exec(?:ute|s)?|runs?|commands?|cmd|shells?|sqli?|nosql|ldap|xpath|template)\s*[:=]\s*[`'"]?(<[^>\n]{1,80}>)[`'"]?/gi;

// Same gesture, no colon/equals: a payload-context word followed by
// whitespace and an inline-code `<...>` slot. Slop authors dodge the
// colon-form check above by writing prose like "the payload `<inject>`
// was sent" or "send `<sql payload here>` against the endpoint" — the
// inline-code span makes the slot still look like a literal payload
// even though there's no "Payload:" label. The verb list extends the
// noun vocabulary with the most common "deliver-the-payload" verbs
// (send/sent/sending/sends) so slop can't hide behind `send <inject>`.
//
// The opening backtick is required (without it the pattern would be too
// aggressive — phrases like "the payload <unknown> was rejected" should
// not be flagged). The closing backtick is also required so we don't
// match unterminated code spans that bleed into surrounding prose.
const PROSE_PAYLOAD_PLACEHOLDER_INLINE_RE =
  /\b(?:payloads?|inject(?:ion|ed|s)?|exec(?:ute|s)?|runs?|commands?|cmd|shells?|sqli?|nosql|ldap|xpath|template|send(?:s|ing|t)?)\s+`(<[^>\n`]{1,80}>)`/gi;

// Same gesture, neither colon nor backticks: a payload-context word
// followed by whitespace and a bare `<...>` slot. Slop authors dodge
// both prior checks by dropping the backticks too — "the payload
// <inject> was sent against the endpoint" still gestures at a payload
// without naming one. Without the backticks the pattern would happily
// match neutral prose ("the payload <unknown> was rejected", which
// legitimately calls out a server-supplied identifier rather than a
// hidden exploit), so the bare-angle form is filtered down in
// `findProsePlaceholderPayloadRanges`: only slots whose inner text is
// in the slop-payload vocabulary (BODY_PLACEHOLDER_KEYWORDS) qualify.
// A bare short identifier like `<unknown>` / `<x>` is NOT enough on
// its own here, even though it is for the colon and inline-code forms.
//
// The separator class between the payload word and the slot accepts
// whitespace, commas, parentheses, en-dashes (U+2013), and em-dashes
// (U+2014) so the same dodge written as "the payload, <inject>, was
// sent", "the payload (<inject>) was sent", or "the payload — <inject>
// — was sent" is still caught. Letters, digits, backticks, and other
// non-separator characters break the run, so incidental adjacency
// like "payload-injected" or "payload `<x>`" stays safe (and the
// inline-code form keeps its own match for the backticked shape).
// The slop-vocab guard above is what keeps neutral prose like "the
// payload, <unknown>, was rejected" off the list.
const PROSE_PAYLOAD_PLACEHOLDER_BARE_RE =
  /\b(?:payloads?|inject(?:ion|ed|s)?|exec(?:ute|s)?|runs?|commands?|cmd|shells?|sqli?|nosql|ldap|xpath|template|send(?:s|ing|t)?)[\s,(\u2013\u2014]+(<[^>\n`]{1,80}>)/gi;

// Same gesture, but the slot is wrapped in bare double-quotes instead
// of backticks: "the payload \"<inject>\" was sent" / "we exec
// \"<command here>\" against the host". Symmetric to the bare-angle
// dodge above with a different fence character — slop authors reach
// for double-quotes when they want the slot to read as a literal
// string without using markdown's inline-code fence. The verb/noun
// vocabulary mirrors the inline-code form (send/sent/run/exec join
// payload/inject/command/etc).
//
// Without the slop-vocab guard this would happily false-positive on
// neutral prose like "the payload \"<unknown>\" was rejected" where a
// server-supplied identifier is being quoted, so the bare-quote form
// is filtered down in `findProsePlaceholderPayloadRanges`: only slots
// whose inner text is in the slop-payload vocabulary
// (BODY_PLACEHOLDER_KEYWORDS) qualify — same rule as the bare-angle
// form.
const PROSE_PAYLOAD_PLACEHOLDER_DQUOTE_RE =
  /\b(?:payloads?|inject(?:ion|ed|s)?|exec(?:ute|s)?|runs?|commands?|cmd|shells?|sqli?|nosql|ldap|xpath|template|send(?:s|ing|t)?)\s+"(<[^>\n"]{1,80}>)"/gi;

// Same gesture, but the slot is wrapped in bare square brackets:
// "the payload [<inject>] was sent" / "run [<command here>] on the
// host". Same fence-substitution dodge as the double-quote form —
// the brackets stand in for the markdown inline-code fence. Same
// verb/noun vocabulary and same slop-vocab guard so neutral prose
// like "the payload [<unknown>] was rejected" stays safe.
const PROSE_PAYLOAD_PLACEHOLDER_SQBRACKET_RE =
  /\b(?:payloads?|inject(?:ion|ed|s)?|exec(?:ute|s)?|runs?|commands?|cmd|shells?|sqli?|nosql|ldap|xpath|template|send(?:s|ing|t)?)\s+\[(<[^>\n\]]{1,80}>)\]/gi;

// Same gesture, but with the payload-context word AFTER the inline-code
// `<...>` slot. Slop authors dodge both the colon-form and the
// word-then-slot inline form above by flipping the order: "`<inject>`
// is the payload we sent" or "`<sql payload here>` was the SQLi payload
// tried" puts the trigger word after the slot. The slot is still an
// inline-code `<...>` placeholder; the surrounding clause just labels
// it after the fact instead of before.
//
// We require a copula (is/was/were/are/seems/appears) immediately after
// the closing backtick so we only fire on slot-as-subject phrasings,
// not on incidental adjacency like "`<x>` and the payload above"
// where there's no syntactic claim that the slot is the payload. The
// copula is then followed by up to 25 intermediate characters (letters,
// spaces, hyphens) leading into the payload noun, which is enough room
// for natural connectors like "the", "the SQLi", or "used as the SQLi"
// while still cutting off long wedge clauses like "rejected immediately
// because the payload was wrong" before they reach the noun.
//
// Both backticks are required for the same reason as the inline form:
// without them, "`<unknown>` was the payload" would expand to bare
// "<unknown> was the payload" and false-positive on legitimate prose.
const PROSE_PAYLOAD_PLACEHOLDER_POSTSLOT_RE =
  /`(<[^>\n`]{1,80}>)`\s+(?:is|was|were|are|seems|appears)[a-zA-Z \-]{1,25}?\b(?:payloads?|inject(?:ion|ed|s)?|exec(?:ute|s)?|runs?|commands?|cmd|shells?|sqli?|nosql|ldap|xpath|template)\b/gi;

/** Find prose snippets shaped like "Payload: `<sql payload here>`",
 * "the payload `<inject>` was sent", the no-backticks dodge "the
 * payload <inject> was sent", the alternate-fence dodges "the payload
 * \"<inject>\" was sent" / "the payload [<inject>] was sent", or the
 * post-slot dodge "`<inject>` is the payload" whose `<...>` slot is
 * itself a placeholder.
 *
 * The colon, inline-code, and post-slot forms all accept either slop
 * vocabulary or any bare short identifier in the slot (the surrounding
 * `Payload:` label, backtick fence, or copula clause is itself enough
 * of a payload-context tell). The bare-angle, double-quote, and
 * square-bracket forms are stricter and only fire when the slot's
 * inner text is slop vocabulary, so neutral prose like "the payload
 * \"<unknown>\" was rejected" is left alone.
 *
 * Returns the byte ranges of the full match so the caller can strip
 * them before re-testing payload-class gold signals. */
export function findProsePlaceholderPayloadRanges(
  text: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const cases: Array<{ re: RegExp; requireSlopVocab: boolean }> = [
    { re: PROSE_PAYLOAD_PLACEHOLDER_RE, requireSlopVocab: false },
    { re: PROSE_PAYLOAD_PLACEHOLDER_INLINE_RE, requireSlopVocab: false },
    { re: PROSE_PAYLOAD_PLACEHOLDER_BARE_RE, requireSlopVocab: true },
    { re: PROSE_PAYLOAD_PLACEHOLDER_DQUOTE_RE, requireSlopVocab: true },
    { re: PROSE_PAYLOAD_PLACEHOLDER_SQBRACKET_RE, requireSlopVocab: true },
    { re: PROSE_PAYLOAD_PLACEHOLDER_POSTSLOT_RE, requireSlopVocab: false },
  ];
  for (const { re, requireSlopVocab } of cases) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const slot = m[1];
      const inner = slot.slice(1, -1).trim();
      if (inner.length === 0) continue;
      const looksPlaceholder = requireSlopVocab
        ? BODY_PLACEHOLDER_KEYWORDS.test(inner)
        : BODY_PLACEHOLDER_KEYWORDS.test(inner) ||
          /^[a-z][a-z0-9_\-\s]{0,30}$/i.test(inner);
      if (!looksPlaceholder) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      // Dedupe against any range already added (the six regexes are
      // disjoint by design — one requires `[:=]`, one requires word +
      // whitespace + backtick, one requires word + whitespace + bare
      // angle bracket, two require word + whitespace + a `"`/`[` fence
      // around the slot, and the post-slot one requires backtick +
      // slot + copula after — but a future edit could broaden any of
      // them, so we still skip overlapping ranges to keep the
      // byte-strip pass idempotent).
      const overlaps = ranges.some(
        (r) => start < r.end && end > r.start,
      );
      if (!overlaps) ranges.push({ start, end });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  return ranges;
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
  // Prose-level placeholder payload mentions are scanned regardless of
  // whether any raw HTTP request blocks are present — the slop dodge here
  // is to drop "Payload: `<inject>`" in plain prose with no fake bytes
  // alongside it.
  const proseRanges = findProsePlaceholderPayloadRanges(text);
  if (blocks.length === 0) {
    return {
      requestsAnalyzed: 0,
      totalHeaders: 0,
      placeholderHeaders: 0,
      crlfPresent: false,
      teClConflicts: 0,
      teClBroken: 0,
      credentialHeaders: 0,
      fakeCredentialHeaders: 0,
      placeholderBodies: 0,
      prosePlaceholderPayloads: proseRanges.length,
      placeholderBodyRanges: proseRanges,
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
  let credentialHeaders = 0;
  let fakeCredentialHeaders = 0;
  let firstFakeCredentialReason: string | null = null;
  let placeholderBodies = 0;
  const placeholderBodyRanges: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const nextBound =
      i + 1 < blocks.length ? blocks[i + 1].start : text.length;
    const headerSection = text.slice(block.headerStart, nextBound);
    // Header section ends at the first blank line (CRLF CRLF or LF LF).
    const blankMatch = /\r?\n\r?\n/.exec(headerSection);
    const blankIdx = blankMatch ? blankMatch.index : -1;
    const headerOnly =
      blankIdx >= 0 ? headerSection.slice(0, blankIdx) : headerSection;

    // Body section: everything after the blank-line terminator and before
    // the next request-block, bounded by a closing markdown fence (``` on
    // its own line) when present so we don't slurp surrounding prose.
    if (blankIdx >= 0 && blankMatch) {
      const bodyStart =
        block.headerStart + blankIdx + blankMatch[0].length;
      let bodyEnd = nextBound;
      const bodySlice = text.slice(bodyStart, bodyEnd);
      const fenceIdx = bodySlice.search(/(^|\n)```/);
      if (fenceIdx >= 0) {
        bodyEnd = bodyStart + fenceIdx;
      }
      const body = text.slice(bodyStart, bodyEnd);
      if (isPlaceholderBody(body)) {
        placeholderBodies++;
        placeholderBodyRanges.push({ start: bodyStart, end: bodyEnd });
      }
    }

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

      // Credential-value audit: even when the header value is not a
      // recognised placeholder string, the token inside it can still be
      // a fabricated JWT/cookie that the AUTHN_AUTHZ gold-signal regex
      // happily matches. We only inspect non-placeholder values (the
      // placeholder branch already covers <jwt-token-here> / XXXX).
      if (CREDENTIAL_HEADER_NAMES.has(name) && !isPlaceholderValue(value)) {
        credentialHeaders++;
        const credReason = inspectCredentialHeader(name, value);
        if (credReason !== null) {
          fakeCredentialHeaders++;
          if (firstFakeCredentialReason === null) {
            firstFakeCredentialReason = credReason;
          }
        }
      }
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
  } else if (fakeCredentialHeaders > 0 && firstFakeCredentialReason !== null) {
    // Credential-value tell: the surrounding bytes look real (no
    // placeholder ratio, real Host/UA/etc.) but the Authorization or
    // Cookie header carries a fabricated token. Slop reports lean on
    // these exact headers to trigger AUTHN_AUTHZ's
    // `authorization_header_swap` gold signal, so we revoke the
    // raw-bytes points whenever even a single credential header fails
    // the audit.
    isFake = true;
    reason = firstFakeCredentialReason;
  } else if (placeholderBodies > 0 && placeholderBodies === blocks.length) {
    // Every detected request block has a placeholder body (`<sql payload
    // here>`, `q=<inject>`, `{ "q": "<inject>" }`). The request bytes are
    // fabricated even if the headers happen to look real — a reporter
    // who actually sent the payload would paste the bytes that were sent.
    isFake = true;
    reason = `Raw HTTP request body is a placeholder (${placeholderBodies}/${blocks.length} request block(s))`;
  }

  // Merge prose-level placeholder payload ranges into placeholderBodyRanges
  // so the engine's strip-and-retest pass covers prose placeholders too.
  // Skip any prose range that falls inside an already-tracked body range
  // (the body range is broader and would double-strip the same bytes).
  for (const r of proseRanges) {
    const overlaps = placeholderBodyRanges.some(
      (existing) => r.start < existing.end && r.end > existing.start,
    );
    if (!overlaps) placeholderBodyRanges.push(r);
  }

  return {
    requestsAnalyzed: blocks.length,
    totalHeaders,
    placeholderHeaders,
    crlfPresent,
    teClConflicts,
    teClBroken,
    credentialHeaders,
    fakeCredentialHeaders,
    placeholderBodies,
    prosePlaceholderPayloads: proseRanges.length,
    placeholderBodyRanges,
    isFake,
    reason,
  };
}

/** Return `text` with every placeholder-body byte range replaced by spaces.
 * Used by the AVRI engine to re-evaluate payload-class gold signals
 * (`concrete_payload`, `vulnerable_query_construction`) after the raw-HTTP
 * validator has flagged a body / prose mention as a placeholder: if the
 * signal pattern only matched inside that range, the gold point must be
 * revoked.
 *
 * When `prosePlaceholderPayloads > 0` (the prose itself contains a
 * "Payload: `<inject>`"-shape placeholder mention), the function additionally
 * blanks bare prose tokens — but PRESERVES the contents of triple-backtick
 * code fences AND single-backtick inline code spans, since that is where a
 * legitimate reporter pastes the actual exploit bytes / payload. This stops
 * an incidental `UNION SELECT` / `; cat` token in CWE description prose
 * from carrying a slop report past the payload-class gold threshold, while
 * still letting a real payload survive when it lives in `inline code` or a
 * fenced block alongside the placeholder mention. */
export function stripPlaceholderBodies(
  text: string,
  evaluation: RawHttpEvaluation,
): string {
  const chars = text.split("");

  // Step 1: blank placeholder-body ranges (length-preserving).
  if (evaluation.placeholderBodyRanges.length > 0) {
    for (const r of evaluation.placeholderBodyRanges) {
      const end = Math.min(r.end, chars.length);
      for (let i = r.start; i < end; i++) chars[i] = " ";
    }
  }

  if (evaluation.prosePlaceholderPayloads === 0) return chars.join("");

  // Step 2: identify ranges to PRESERVE (code fences + inline code spans).
  // Anything outside these survives only if the placeholder-body strip
  // already left it intact; bare prose bytes get blanked.
  const preserve: Array<{ start: number; end: number }> = [];
  const FENCE_RE = /```[\s\S]*?```/g;
  let fm: RegExpExecArray | null;
  while ((fm = FENCE_RE.exec(text)) !== null) {
    preserve.push({ start: fm.index, end: fm.index + fm[0].length });
  }
  const INLINE_RE = /`[^`\n]+`/g;
  let im: RegExpExecArray | null;
  while ((im = INLINE_RE.exec(text)) !== null) {
    const start = im.index;
    const end = im.index + im[0].length;
    const insideFence = preserve.some(
      (r) => start >= r.start && end <= r.end,
    );
    if (!insideFence) preserve.push({ start, end });
  }
  preserve.sort((a, b) => a.start - b.start);

  // Walk the buffer once, blanking any byte outside both the preserve
  // ranges and the original-text fence/inline ranges.
  let pIdx = 0;
  for (let i = 0; i < chars.length; i++) {
    while (pIdx < preserve.length && i >= preserve[pIdx].end) pIdx++;
    const inPreserve =
      pIdx < preserve.length &&
      i >= preserve[pIdx].start &&
      i < preserve[pIdx].end;
    if (!inPreserve) chars[i] = " ";
  }
  return chars.join("");
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

/** Per-family map of gold-signal IDs that are payload-class — they reward a
 * concrete attacker payload or unsafe sink construction (`concrete_payload`,
 * `vulnerable_query_construction` in the INJECTION rubric). These signals
 * match against the full report text, so they can be earned from prose or
 * from the body of a placeholder POST (e.g. `q=<sql payload here>`). When
 * the raw-HTTP validator flags a request body as a placeholder, these IDs
 * are re-evaluated against the body-stripped text — if the signal pattern
 * no longer matches, the gold point must be revoked because the only
 * "payload" was the placeholder body.
 *
 * INJECTION: `concrete_payload` and `vulnerable_query_construction` are the
 *   two payload-class gold signals. A slop SQLi/cmd report whose POST body
 *   is `<sql payload here>` / `cmd=<command>` shouldn't earn either point
 *   when no real payload appears anywhere in the prose. */
export const RAW_HTTP_BODY_PAYLOAD_GOLD_SIGNAL_IDS_BY_FAMILY: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  INJECTION: new Set([
    "concrete_payload",
    "vulnerable_query_construction",
  ]),
};

export function rawHttpBodyPayloadGoldSignalIdsFor(
  familyId: string,
): ReadonlySet<string> | null {
  return RAW_HTTP_BODY_PAYLOAD_GOLD_SIGNAL_IDS_BY_FAMILY[familyId] ?? null;
}

// =====================================================================
// Sprint 13B-3 — raw HTTP RESPONSE plausibility validator.
//
// Slop authors learned that a `HTTP/1.1 200 OK` block with a JSON body
// is enough to "show" the response evidence side of an injection, XSS,
// or IDOR report — and several family gold signals reward exactly that
// shape (INJECTION's `request_response_diff` "side-by-side normal vs
// injected request showing differing behavior" matches when the prose
// references a baseline + injection pair, and WEB_CLIENT's
// `reflection_or_dom_proof` matches HTML reflected in the response).
// A real server response carries enough incidental fields (Date header
// inserted by the HTTP stack, Server header, X-Request-Id from the
// front-end LB, Content-Length, Cache-Control, Set-Cookie on stateful
// endpoints) and a JSON body shape (incidental ids, timestamps, links,
// pagination meta) that LLM-fabricated narrative-tailored responses
// cannot reliably synthesize.
//
// The validator inspects each `HTTP/1.x 200 OK`-style block and counts
// four plausibility markers:
//   1. missing Date header,
//   2. missing Server header,
//   3. suspiciously clean JSON body (≤2 top-level fields, no incidental
//      id/uuid/timestamp/created_at/_links/meta key, value contains
//      vulnerability narrative vocabulary),
//   4. incidental-field absence (NONE of X-Request-Id, Content-Length,
//      Cache-Control, Set-Cookie present).
//
// When ≥2 markers fire on a single response block we treat that
// response as fabricated. The engine then re-tests the family's
// response-class gold signals against text with the fake response
// bytes stripped — surviving matches in surrounding prose keep their
// points; matches that only existed inside the fabricated bytes get
// revoked.

export interface RawHttpResponseEvaluation {
  /** Number of `HTTP/1.x NNN ReasonPhrase` response blocks detected
   * with at least one parseable header line following. */
  responsesAnalyzed: number;
  /** Of those, how many fired ≥2 plausibility markers. */
  responsesFlagged: number;
  /** Total parsed `Header: value` lines across all analyzed responses. */
  totalHeaders: number;
  /** Per-marker counters across all analyzed responses, surfaced in
   * diagnostics so reviewers see WHICH plausibility check fired most. */
  responsesMissingDate: number;
  responsesMissingServer: number;
  responsesWithSuspiciousJsonBody: number;
  responsesMissingIncidentals: number;
  /** True iff at least one analyzed response fired ≥2 markers. */
  isFake: boolean;
  /** Human-readable explanation, set when isFake. */
  reason: string | null;
  /** Byte ranges (start, end half-open) of response blocks (status line
   * through end of body) flagged as fabricated. Used by the engine to
   * strip and re-test response-class gold signals. */
  fakeResponseRanges: ReadonlyArray<{ start: number; end: number }>;
}

// HTTP/1.x status-line: `HTTP/1.x SP NNN SP Reason-Phrase CRLF`.
// We constrain the reason phrase to letters / spaces / dashes / dots,
// 1–40 chars, so a shell-escaped single-line `printf 'HTTP/1.1 200
// OK\\r\\n...'` does NOT match (the literal backslashes after "OK"
// aren't valid reason-phrase characters and the regex requires a true
// CR/LF immediately after the phrase).
const RESPONSE_LINE_RE = /(^|\n)HTTP\/1\.[01][ \t]+(\d{3})[ \t]+([A-Za-z][A-Za-z0-9 .\-]{0,40})\r?\n/g;

interface ResponseBlock {
  /** Offset in `text` of the start of the status-line. */
  start: number;
  /** Offset in `text` just past the status-line CRLF/LF. */
  headerStart: number;
  /** 3-digit status code parsed from the status-line. */
  statusCode: number;
}

function findResponseBlocks(text: string): ResponseBlock[] {
  const out: ResponseBlock[] = [];
  RESPONSE_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RESPONSE_LINE_RE.exec(text)) !== null) {
    const leadOffset = m[1] === "\n" ? 1 : 0;
    const start = m.index + leadOffset;
    out.push({
      start,
      headerStart: m.index + m[0].length,
      statusCode: Number(m[2]),
    });
  }
  return out;
}

// Vocabulary that, when seen anywhere inside a JSON response body, marks
// the body as "narrative-tailored" rather than a real payload an API
// would emit. Real responses say things like `{"id": 4012, "name":
// "bob", "balance": 250.00}`; fabricated ones say things like `{"error":
// "SQL injection in users.id parameter"}` or `{"data": "user account
// compromised by the attacker"}`. The wordlist mirrors the report-side
// vulnerability vocabulary so a slop author can't dodge by relabelling.
const NARRATIVE_BODY_VOCAB =
  /\b(?:vulnerab|injection|injected|exploit|exploited|attack|attacker|payload|leaked|leak|unauthor|bypass|smuggl|csrf|xss|sqli|rce|breach|compromis|malicious|fabricat|forged|hacked|shell|hijack)/i;

// JSON keys that real APIs almost always include alongside the data
// they're returning. If any of these are present at the top level of
// the parsed object, the body is treated as plausible regardless of
// length.
const INCIDENTAL_JSON_KEYS = new Set([
  "id",
  "uuid",
  "guid",
  "_id",
  "request_id",
  "requestid",
  "trace_id",
  "traceid",
  "created_at",
  "updated_at",
  "createdat",
  "updatedat",
  "created",
  "updated",
  "timestamp",
  "ts",
  "version",
  "_links",
  "links",
  "meta",
  "metadata",
  "pagination",
  "next",
  "prev",
  "page",
  "count",
  "total",
  "etag",
  "self",
]);

/** True iff the response body is "suspiciously clean" — JSON-shaped with
 * ≤2 top-level keys, no incidental id/timestamp/links/meta key, and a
 * value that contains vulnerability-narrative vocabulary. Real API
 * responses either carry incidental fields or have neutral data; fake
 * responses are the narrative writer's gloss of what "should" come back.
 *
 * Returns false for non-JSON bodies (free text, HTML, binary), bodies
 * that don't parse as JSON, arrays of non-objects, and any object that
 * carries an incidental key. Conservative on purpose so a real
 * `{"id":4012,"username":"bob"}` excerpt isn't mis-flagged. */
export function isSuspiciousJsonBody(body: string): boolean {
  const trimmed = body.trim();
  if (trimmed.length === 0) return false;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object") return false;
  // Vulnerability-narrative vocabulary somewhere in the serialized body.
  const valuesText = JSON.stringify(parsed);
  if (!NARRATIVE_BODY_VOCAB.test(valuesText)) return false;
  if (Array.isArray(parsed)) {
    // A 1-element array carrying a single narrative string is the
    // common slop shape: `["SQL injection in users.id"]`.
    return parsed.length <= 1;
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) return false;
  if (entries.length > 2) return false;
  for (const [k] of entries) {
    if (INCIDENTAL_JSON_KEYS.has(k.toLowerCase())) return false;
  }
  return true;
}

export function evaluateRawHttpResponse(
  text: string,
): RawHttpResponseEvaluation {
  const blocks = findResponseBlocks(text);
  const empty: RawHttpResponseEvaluation = {
    responsesAnalyzed: 0,
    responsesFlagged: 0,
    totalHeaders: 0,
    responsesMissingDate: 0,
    responsesMissingServer: 0,
    responsesWithSuspiciousJsonBody: 0,
    responsesMissingIncidentals: 0,
    isFake: false,
    reason: null,
    fakeResponseRanges: [],
  };
  if (blocks.length === 0) return empty;

  let responsesAnalyzed = 0;
  let responsesFlagged = 0;
  let totalHeaders = 0;
  let respMissingDate = 0;
  let respMissingServer = 0;
  let respSuspiciousJson = 0;
  let respMissingIncidentals = 0;
  const fakeResponseRanges: Array<{ start: number; end: number }> = [];
  let firstReason: string | null = null;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const nextBound =
      i + 1 < blocks.length ? blocks[i + 1].start : text.length;
    const headerSection = text.slice(block.headerStart, nextBound);
    const blankMatch = /\r?\n\r?\n/.exec(headerSection);
    const blankIdx = blankMatch ? blankMatch.index : -1;
    const headerOnly =
      blankIdx >= 0 ? headerSection.slice(0, blankIdx) : headerSection;

    // Bound the analyzed block at the first closing markdown fence so
    // surrounding prose isn't slurped into the body.
    let blockEnd = nextBound;
    let bodyStart = nextBound;
    let body = "";
    if (blankIdx >= 0 && blankMatch) {
      bodyStart = block.headerStart + blankIdx + blankMatch[0].length;
      const bodySlice = text.slice(bodyStart, nextBound);
      const fenceIdx = bodySlice.search(/(^|\n)```/);
      if (fenceIdx >= 0) blockEnd = bodyStart + fenceIdx;
      body = text.slice(bodyStart, blockEnd);
    } else {
      // No blank line — bound at fence in the header section itself.
      const fenceIdx = headerSection.search(/(^|\n)```/);
      if (fenceIdx >= 0) blockEnd = block.headerStart + fenceIdx;
    }

    const headerLines = headerOnly
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const headers = new Map<string, string>();
    for (const line of headerLines) {
      const hm = HEADER_LINE_RE.exec(line);
      if (!hm) continue;
      headers.set(hm[1].toLowerCase(), hm[2]);
      totalHeaders++;
    }
    // A naked status-line with no parseable headers is not a real
    // response excerpt — skip it (e.g. a single-line snippet in a
    // shell command block).
    if (headers.size === 0) continue;
    responsesAnalyzed++;

    const missingDate = !headers.has("date");
    const missingServer = !headers.has("server");
    const suspiciousJson = isSuspiciousJsonBody(body);
    const missingIncidentals =
      !headers.has("x-request-id") &&
      !headers.has("content-length") &&
      !headers.has("cache-control") &&
      !headers.has("set-cookie");

    if (missingDate) respMissingDate++;
    if (missingServer) respMissingServer++;
    if (suspiciousJson) respSuspiciousJson++;
    if (missingIncidentals) respMissingIncidentals++;

    let markerCount = 0;
    const fired: string[] = [];
    if (missingDate) {
      markerCount++;
      fired.push("missing Date header");
    }
    if (missingServer) {
      markerCount++;
      fired.push("missing Server header");
    }
    if (suspiciousJson) {
      markerCount++;
      fired.push("suspiciously clean JSON body");
    }
    if (missingIncidentals) {
      markerCount++;
      fired.push(
        "no X-Request-Id/Content-Length/Cache-Control/Set-Cookie",
      );
    }

    if (markerCount >= 2) {
      responsesFlagged++;
      fakeResponseRanges.push({ start: block.start, end: blockEnd });
      if (firstReason === null) {
        firstReason = `Raw HTTP response is fabricated (${fired.join(", ")})`;
      }
    }
  }

  const isFake = responsesFlagged > 0;
  return {
    responsesAnalyzed,
    responsesFlagged,
    totalHeaders,
    responsesMissingDate: respMissingDate,
    responsesMissingServer: respMissingServer,
    responsesWithSuspiciousJsonBody: respSuspiciousJson,
    responsesMissingIncidentals: respMissingIncidentals,
    isFake,
    reason: firstReason,
    fakeResponseRanges,
  };
}

/** Return `text` with every fabricated-response byte range replaced by
 * spaces (length-preserving). The engine uses this to re-test
 * response-class gold signals (`request_response_diff`,
 * `reflection_or_dom_proof`) against text with the fake response bytes
 * removed: matches that only existed inside the fabricated block lose
 * their points; matches in surrounding prose survive. */
export function stripFakeResponses(
  text: string,
  evaluation: RawHttpResponseEvaluation,
): string {
  if (evaluation.fakeResponseRanges.length === 0) return text;
  const chars = text.split("");
  for (const r of evaluation.fakeResponseRanges) {
    const end = Math.min(r.end, chars.length);
    for (let i = r.start; i < end; i++) chars[i] = " ";
  }
  return chars.join("");
}

/** Per-family map of gold-signal IDs whose evidence depends on the raw
 * HTTP RESPONSE bytes being legitimate. When the response-side
 * validator flags ≥2 plausibility markers on a response block, the
 * engine re-tests these signals against text with the fake response
 * stripped — points whose only match was inside the fabricated bytes
 * are revoked.
 *
 * INJECTION: `request_response_diff` rewards a side-by-side baseline
 *   vs injected request/response pair. A fabricated response is the
 *   exact thing slop authors paste to "show" that the injection
 *   produced different behaviour.
 *
 * WEB_CLIENT: `reflection_or_dom_proof` rewards HTML reflected in the
 *   response (the alternation includes `<input value="<` and prose
 *   like "reflected in the response"). A fabricated response with the
 *   payload echoed in the body is the exact slop shape this revocation
 *   targets. */
export const RAW_HTTP_RESPONSE_GOLD_SIGNAL_IDS_BY_FAMILY: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  INJECTION: new Set([
    "request_response_diff",
  ]),
  WEB_CLIENT: new Set([
    "reflection_or_dom_proof",
  ]),
};

export function rawHttpResponseGoldSignalIdsFor(
  familyId: string,
): ReadonlySet<string> | null {
  return RAW_HTTP_RESPONSE_GOLD_SIGNAL_IDS_BY_FAMILY[familyId] ?? null;
}
