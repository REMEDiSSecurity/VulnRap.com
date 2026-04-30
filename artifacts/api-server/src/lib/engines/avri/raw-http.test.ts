import { describe, it, expect } from "vitest";
import {
  evaluateRawHttpRequest,
  evaluateRawHttpResponse,
  findProsePlaceholderPayloadRanges,
  isPlaceholderBody,
  isSuspiciousJsonBody,
  stripFakeResponses,
  stripPlaceholderBodies,
} from "./raw-http.js";
import { runEngine2Avri } from "./engine2-avri.js";
import { FAMILIES_BY_ID } from "./families.js";
import { extractSignals } from "../extractors.js";

const SMUG = FAMILIES_BY_ID.REQUEST_SMUGGLING;
const AUTHN = FAMILIES_BY_ID.AUTHN_AUTHZ;
const INJ = FAMILIES_BY_ID.INJECTION;
const WEB = FAMILIES_BY_ID.WEB_CLIENT;

// Legitimate TE.CL smuggling fixture: real Host, integer Content-Length,
// literal "chunked" Transfer-Encoding, CRLFs preserved, smuggled second
// request after the chunked terminator. Names a specific frontend/backend
// combo (CloudFront + nginx) so the family rubric also fires the
// `specific_proxy_or_server` gold signal.
const LEGIT_SMUGGLING_FIXTURE = [
  "# CL.TE smuggling on shop.example.com (CloudFront -> nginx)",
  "",
  "The CloudFront frontend uses Content-Length while the nginx backend",
  "honors Transfer-Encoding: chunked, allowing a smuggled second request",
  "to be prefixed onto the next pooled connection. CWE-444.",
  "",
  "```http",
  "POST / HTTP/1.1\r",
  "Host: shop.example.com\r",
  "Content-Length: 13\r",
  "Transfer-Encoding: chunked\r",
  "\r",
  "0\r",
  "\r",
  "GPOST / HTTP/1.1\r",
  "Host: shop.example.com\r",
  "Content-Length: 10\r",
  "\r",
  "x=1",
  "```",
  "",
  "Repro: send the bytes above twice; the second connection in the pool",
  "serves the smuggled `GPOST / HTTP/1.1` to a different victim user.",
].join("\n");

// Slop fixture: looks shaped like a smuggling report but the bytes are
// pure placeholders — Host: <target>, non-numeric Content-Length,
// non-"chunked" Transfer-Encoding, no CRLFs, and the "smuggled" second
// request is also placeholder-laden.
const SLOP_SMUGGLING_FIXTURE = [
  "# Critical HTTP request smuggling on the production frontend",
  "",
  "The proxy and backend disagree on framing, allowing TE.CL desync.",
  "CWE-444. Severity: Critical. Affects the entire production fleet.",
  "",
  "```http",
  "POST / HTTP/1.1",
  "Host: <target>",
  "Content-Length: XX",
  "Transfer-Encoding: <chunked>",
  "",
  "0",
  "",
  "GPOST / HTTP/1.1",
  "Host: <target>",
  "Content-Length: NNNN",
  "",
  "<smuggled body here>",
  "```",
  "",
  "Repro: any modern HTTP/1.1 frontend will exhibit this against any",
  "compliant backend. The smuggled second request lands on the next",
  "pooled connection.",
].join("\n");

describe("evaluateRawHttpRequest", () => {
  it("does not flag a legitimate smuggling fixture", () => {
    const r = evaluateRawHttpRequest(LEGIT_SMUGGLING_FIXTURE);
    expect(r.requestsAnalyzed).toBeGreaterThanOrEqual(2);
    expect(r.totalHeaders).toBeGreaterThanOrEqual(5);
    expect(r.placeholderHeaders).toBe(0);
    expect(r.crlfPresent).toBe(true);
    expect(r.teClConflicts).toBeGreaterThanOrEqual(1);
    expect(r.teClBroken).toBe(0);
    expect(r.isFake).toBe(false);
    expect(r.reason).toBeNull();
  });

  it("flags placeholder-bytes slop with <target>/XX/NNNN values", () => {
    const r = evaluateRawHttpRequest(SLOP_SMUGGLING_FIXTURE);
    expect(r.requestsAnalyzed).toBeGreaterThanOrEqual(2);
    expect(r.placeholderHeaders).toBeGreaterThanOrEqual(4);
    expect(r.isFake).toBe(true);
    expect(r.reason).toMatch(/placeholder|incoherent|CRLF|real value/);
  });

  it("flags an incoherent TE/CL conflict (non-numeric CL, non-chunked TE)", () => {
    const fixture = [
      "POST / HTTP/1.1\r",
      "Host: example.com\r",
      "Content-Length: ABC\r",
      "Transfer-Encoding: identity\r",
      "\r",
      "",
    ].join("\n");
    const r = evaluateRawHttpRequest(fixture);
    expect(r.teClConflicts).toBe(1);
    expect(r.teClBroken).toBe(1);
    expect(r.isFake).toBe(true);
    expect(r.reason).toMatch(/incoherent|integer|chunked/);
  });

  it("flags an LF-only request even when header values look real", () => {
    // Realistic Host/Content-Length/Transfer-Encoding values, coherent
    // TE/CL conflict, but no CRLFs anywhere — smuggling depends on
    // byte-precise framing, so the raw-bytes gold signals must not be
    // awarded.
    const fixture = [
      "POST / HTTP/1.1",
      "Host: shop.example.com",
      "Content-Length: 13",
      "Transfer-Encoding: chunked",
      "",
      "0",
      "",
      "GPOST / HTTP/1.1",
      "Host: shop.example.com",
      "Content-Length: 10",
      "",
      "x=1",
    ].join("\n");
    const r = evaluateRawHttpRequest(fixture, { strictCrlf: true });
    expect(r.requestsAnalyzed).toBeGreaterThanOrEqual(2);
    expect(r.placeholderHeaders).toBe(0);
    expect(r.crlfPresent).toBe(false);
    expect(r.isFake).toBe(true);
    expect(r.reason).toMatch(/CRLF|byte-precise framing/);

    // Without strictCrlf (the default for AUTHN_AUTHZ / INJECTION),
    // realistic LF-only bytes are tolerated — markdown transcription
    // routinely strips CRLFs and those families don't depend on
    // byte-precise framing.
    const lenient = evaluateRawHttpRequest(fixture);
    expect(lenient.isFake).toBe(false);
  });

  it("returns 0 requests for prose with no raw HTTP bytes", () => {
    const r = evaluateRawHttpRequest("There is a smuggling bug somewhere.");
    expect(r.requestsAnalyzed).toBe(0);
    expect(r.isFake).toBe(false);
  });
});

// AUTHN_AUTHZ slop fixture: looks like an authorization-header-swap
// IDOR/session-fixation report, but the pasted raw HTTP request is a
// shell of placeholders — Host: <target>, Authorization: Bearer
// <jwt-token-here>, Cookie: sessionid=XXXX, no CRLFs. The
// `authorization_header_swap` gold signal regex still fires (it matches
// the literal "Authorization: Bearer ..." substring), so the validator
// must revoke it once the surrounding bytes are flagged as fake.
const SLOP_AUTHN_FIXTURE = [
  "# Critical IDOR / session swap on /api/account",
  "",
  "User A can swap their Authorization header for User B's bearer token",
  "and read another tenant's invoices. CWE-639. Severity: Critical.",
  "Affects all customers in production.",
  "",
  "```http",
  "GET /api/account/invoices HTTP/1.1",
  "Host: <target>",
  "Authorization: Bearer <jwt-token-here>",
  "Cookie: sessionid=XXXX",
  "X-Auth-Token: <token>",
  "",
  "<request body here>",
  "```",
  "",
  "Repro: replay the request with another user's bearer token from the",
  "same login flow; the response leaks invoices belonging to that user.",
].join("\n");

// INJECTION slop fixture: looks like a SQLi/cmd injection report with
// a "POST /search?q=' OR 1=1--" request line and placeholder headers.
// The `specific_endpoint_param` gold signal regex matches the request
// line, but every header value is a placeholder and there are no CRLFs,
// so the raw-HTTP validator flags the bytes as fake and the
// endpoint-param point must be revoked. Other injection signals
// (concrete_payload, cwe_correct_class) remain because they're
// substantiated outside the request bytes.
const SLOP_INJECTION_FIXTURE = [
  "# Critical SQL injection on /search",
  "",
  "The `q` parameter is concatenated directly into the SQL query,",
  "allowing UNION SELECT / OR 1=1 attacks. CWE-89. Severity: Critical.",
  "",
  "Vulnerable construction:",
  "    query = \"SELECT * FROM products WHERE name='\" + q + \"'\"",
  "",
  "```http",
  "POST /search?q=foo HTTP/1.1",
  "Host: <target>",
  "Content-Type: <type>",
  "Content-Length: NNN",
  "Cookie: <session>",
  "",
  "q=' UNION SELECT password FROM users--",
  "```",
  "",
  "Payload: `' UNION SELECT password FROM users--` returns the full",
  "user table. Any modern database backend will exhibit this.",
].join("\n");

describe("runEngine2Avri — REQUEST_SMUGGLING raw-HTTP integration", () => {
  it("keeps gold hits and a high AVRI score for a legitimate smuggling report", () => {
    const sig = extractSignals(LEGIT_SMUGGLING_FIXTURE);
    const result = runEngine2Avri(sig, LEGIT_SMUGGLING_FIXTURE, SMUG);
    const goldIds = result.detail.goldHits.map((g) => g.id);
    expect(goldIds).toContain("raw_http_request");
    expect(goldIds).toContain("te_or_cl_conflict");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).not.toContain("FAKE_RAW_HTTP");
    expect(result.detail.rawAvriScore).toBeGreaterThanOrEqual(40);
  });

  it("revokes raw-HTTP gold hits and pushes AVRI down for a fabricated smuggling report", () => {
    const sig = extractSignals(SLOP_SMUGGLING_FIXTURE);
    const result = runEngine2Avri(sig, SLOP_SMUGGLING_FIXTURE, SMUG);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("raw_http_request");
    expect(survivingIds).not.toContain("te_or_cl_conflict");
    expect(survivingIds).not.toContain("smuggled_second_request");
    expect(result.detail.rawAvriScore).toBeLessThan(40);
  });
});

// Legitimate AUTHN_AUTHZ fixture: realistic two-account IDOR proof
// with real (looking) bearer tokens, real Host, real Cookie value, but
// LF-only line endings — this is the common markdown transcription
// shape and must NOT be flagged as fake (CRLF strictness is reserved
// for REQUEST_SMUGGLING).
const LEGIT_AUTHN_FIXTURE = [
  "# IDOR on /api/users/{id}/invoices via Authorization swap",
  "",
  "Alice (uid 4011) can read Bob's (uid 4012) invoices simply by",
  "swapping in Bob's bearer token. CWE-639.",
  "",
  "```http",
  "GET /api/users/4012/invoices HTTP/1.1",
  "Host: shop.example.com",
  "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0MDExIn0.kQ8sV0o7c_w2J9xq",
  "Cookie: sessionid=s%3A4f7a9c0b3e1d2; csrftoken=oH9Kp2m",
  "User-Agent: curl/8.4.0",
  "",
  "```",
  "",
  "Repro: log in as Alice, capture her bearer, then GET",
  "/api/users/4012/invoices — the response is Bob's invoice list.",
].join("\n");

// Legitimate INJECTION fixture: realistic POST with a real Host and
// real Content-Type/Length, LF-only line endings, concrete payload
// inline. Must NOT be flagged as fake.
const LEGIT_INJECTION_FIXTURE = [
  "# SQL injection on POST /search via the q parameter",
  "",
  "The `q` form field is concatenated into a SQL query unsanitized.",
  "CWE-89.",
  "",
  "```http",
  "POST /search HTTP/1.1",
  "Host: shop.example.com",
  "Content-Type: application/x-www-form-urlencoded",
  "Content-Length: 47",
  "",
  "q=foo'+UNION+SELECT+password+FROM+users--",
  "```",
  "",
  "The response leaks the password column for every row in users.",
].join("\n");

describe("runEngine2Avri — AUTHN_AUTHZ raw-HTTP integration", () => {
  it("flags fabricated Authorization/Cookie bytes and revokes the header-swap gold hit", () => {
    const r = evaluateRawHttpRequest(SLOP_AUTHN_FIXTURE);
    expect(r.requestsAnalyzed).toBeGreaterThanOrEqual(1);
    expect(r.isFake).toBe(true);

    const sig = extractSignals(SLOP_AUTHN_FIXTURE);
    const result = runEngine2Avri(sig, SLOP_AUTHN_FIXTURE, AUTHN);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeInd = indicators.find((s) => s === "FAKE_RAW_HTTP");
    expect(fakeInd).toBeDefined();
    const fakeIndObj = result.engine.triggeredIndicators.find((i) => i.signal === "FAKE_RAW_HTTP");
    expect(fakeIndObj?.explanation).toMatch(/AUTHN_AUTHZ/);
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("authorization_header_swap");
  });

  it("does not flag a realistic LF-only AUTHN_AUTHZ report", () => {
    const sig = extractSignals(LEGIT_AUTHN_FIXTURE);
    const result = runEngine2Avri(sig, LEGIT_AUTHN_FIXTURE, AUTHN);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).not.toContain("FAKE_RAW_HTTP");
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).toContain("authorization_header_swap");
  });
});

// Fabricated-JWT slop fixture: every visible header carries a real
// (looking) value — Host: shop.example.com, User-Agent: curl/8.4.0,
// Accept: application/json — so the placeholder-ratio branch does NOT
// fire. The Authorization line, however, carries a JWT whose payload
// decodes to {"sub":"admin"} and whose signature is the literal run
// "AAAAAA". The credential-value audit must catch that and revoke
// `authorization_header_swap`.
const FAKE_JWT_AUTHN_FIXTURE = [
  "# IDOR via JWT swap on /api/account/invoices",
  "",
  "Any user can swap their bearer token for an admin token below and",
  "read another tenant's invoices. CWE-639. Severity: Critical.",
  "",
  "```http",
  "GET /api/account/invoices HTTP/1.1",
  "Host: shop.example.com",
  "User-Agent: curl/8.4.0",
  "Accept: application/json",
  "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.AAAAAA",
  "",
  "```",
  "",
  "Repro: replay the request with the bearer above; the response is",
  "the admin user's invoices.",
].join("\n");

// Fabricated-cookie slop fixture: real Host / User-Agent / Accept,
// LF-only line endings (so CRLF strict-mode would not apply), but the
// Cookie header carries `sessionid=00000000000000000000` — a 20-char
// run of zeros that is implausible as a real session id. The
// credential-value audit must revoke the header-swap gold hit.
const FAKE_COOKIE_AUTHN_FIXTURE = [
  "# Session fixation: predictable sessionid grants admin access",
  "",
  "The session id below logs in as the admin tenant. CWE-384.",
  "",
  "```http",
  "GET /admin/dashboard HTTP/1.1",
  "Host: shop.example.com",
  "User-Agent: Mozilla/5.0",
  "Accept: text/html",
  "Cookie: sessionid=00000000000000000000",
  "",
  "```",
  "",
  "Repro: send the cookie above and you are logged in as admin.",
].join("\n");

describe("evaluateRawHttpRequest — fabricated credential values", () => {
  it("flags a JWT whose payload claims are placeholders and whose signature has no entropy", () => {
    const r = evaluateRawHttpRequest(FAKE_JWT_AUTHN_FIXTURE);
    // Every header value is non-placeholder, so the placeholder-ratio
    // branch must not be the one that fires.
    expect(r.placeholderHeaders).toBe(0);
    expect(r.credentialHeaders).toBeGreaterThanOrEqual(1);
    expect(r.fakeCredentialHeaders).toBeGreaterThanOrEqual(1);
    expect(r.isFake).toBe(true);
    expect(r.reason).toMatch(/JWT/);
  });

  it("flags a Cookie value that is a long run of zeros", () => {
    const r = evaluateRawHttpRequest(FAKE_COOKIE_AUTHN_FIXTURE);
    expect(r.placeholderHeaders).toBe(0);
    expect(r.credentialHeaders).toBeGreaterThanOrEqual(1);
    expect(r.fakeCredentialHeaders).toBeGreaterThanOrEqual(1);
    expect(r.isFake).toBe(true);
    expect(r.reason).toMatch(/Cookie|entropy/i);
  });

  it("does not flag a realistic JWT and cookie pair", () => {
    const r = evaluateRawHttpRequest(LEGIT_AUTHN_FIXTURE);
    expect(r.fakeCredentialHeaders).toBe(0);
    expect(r.isFake).toBe(false);
  });

  it("flags a Set-Cookie whose value is fake even when surrounded by Path/HttpOnly attributes", () => {
    // Set-Cookie carries cookie attributes (Path=, Max-Age=, HttpOnly,
    // Secure, SameSite=) that aren't credential values themselves.
    // Short attributes (Path=/, Max-Age=3600) are below the 8-char
    // entropy floor and HttpOnly/Secure have no '=' at all, so the
    // parser only counts the real cookie value — and correctly flags
    // the fabricated all-zero sessionid.
    const fixture = [
      "HTTP/1.1 200 OK",
      "Server: nginx/1.25",
      "Content-Type: text/html",
      "Set-Cookie: sessionid=00000000000000000000; Path=/; HttpOnly; Secure; SameSite=Strict",
      "",
      "",
      // Include a request line so the validator finds a block to analyse.
      "GET /admin HTTP/1.1",
      "Host: shop.example.com",
      "Cookie: sessionid=00000000000000000000",
      "",
      "",
    ].join("\n");
    const r = evaluateRawHttpRequest(fixture);
    expect(r.fakeCredentialHeaders).toBeGreaterThanOrEqual(1);
    expect(r.isFake).toBe(true);
    expect(r.reason).toMatch(/Cookie|entropy/i);
  });

  it("flags a JWT with an empty payload {}", () => {
    const fixture = [
      "GET /api/me HTTP/1.1",
      "Host: shop.example.com",
      "User-Agent: curl/8.4.0",
      "Accept: application/json",
      // header.payload.signature where payload decodes to "{}"
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.kQ8sV0o7c_w2J9xqAbCdEf",
      "",
      "",
    ].join("\n");
    const r = evaluateRawHttpRequest(fixture);
    expect(r.fakeCredentialHeaders).toBe(1);
    expect(r.isFake).toBe(true);
    expect(r.reason).toMatch(/empty|no claims/i);
  });
});

describe("runEngine2Avri — AUTHN_AUTHZ fabricated-credential integration", () => {
  it("revokes authorization_header_swap when the JWT is a placeholder/no-entropy fake", () => {
    const sig = extractSignals(FAKE_JWT_AUTHN_FIXTURE);
    const result = runEngine2Avri(sig, FAKE_JWT_AUTHN_FIXTURE, AUTHN);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeIndObj = result.engine.triggeredIndicators.find((i) => i.signal === "FAKE_RAW_HTTP");
    expect(fakeIndObj?.explanation).toMatch(/AUTHN_AUTHZ/);
    expect(fakeIndObj?.explanation).toMatch(/JWT/);
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("authorization_header_swap");
  });

  it("revokes authorization_header_swap when the Cookie value is all zeros", () => {
    const sig = extractSignals(FAKE_COOKIE_AUTHN_FIXTURE);
    const result = runEngine2Avri(sig, FAKE_COOKIE_AUTHN_FIXTURE, AUTHN);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("authorization_header_swap");
  });
});

describe("runEngine2Avri — INJECTION raw-HTTP integration", () => {
  it("flags fabricated POST request bytes and revokes the endpoint-param gold hit", () => {
    const r = evaluateRawHttpRequest(SLOP_INJECTION_FIXTURE);
    expect(r.requestsAnalyzed).toBeGreaterThanOrEqual(1);
    expect(r.isFake).toBe(true);

    const sig = extractSignals(SLOP_INJECTION_FIXTURE);
    const result = runEngine2Avri(sig, SLOP_INJECTION_FIXTURE, INJ);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeIndObj = result.engine.triggeredIndicators.find((i) => i.signal === "FAKE_RAW_HTTP");
    expect(fakeIndObj?.explanation).toMatch(/INJECTION/);
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("specific_endpoint_param");
  });

  it("does not flag a realistic LF-only INJECTION report", () => {
    const sig = extractSignals(LEGIT_INJECTION_FIXTURE);
    const result = runEngine2Avri(sig, LEGIT_INJECTION_FIXTURE, INJ);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).not.toContain("FAKE_RAW_HTTP");
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).toContain("specific_endpoint_param");
  });
});

// SQLi slop fixture whose request HEADERS look real (real Host, real
// Content-Type, integer Content-Length) but whose request BODY is a
// placeholder slot (`q=<sql payload here>`) and whose prose names no real
// payload. The header-fakeness checks all pass — only the body-payload
// check can catch it. The injection family's `concrete_payload` and
// `vulnerable_query_construction` gold signals must both be revoked
// because they would otherwise be earned from the placeholder body.
const SLOP_SQLI_PLACEHOLDER_BODY_FIXTURE = [
  "# Critical SQL injection on /search via the q parameter",
  "",
  "The q parameter is concatenated directly into a database query,",
  "leading to a UNION-based exfiltration. CWE-89. Severity: Critical.",
  "Affects all customers in production.",
  "",
  "```http",
  "POST /search HTTP/1.1",
  "Host: shop.example.com",
  "Content-Type: application/x-www-form-urlencoded",
  "Content-Length: 27",
  "",
  "q=<sql payload here>",
  "```",
  "",
  "Replay the request above with any modern database backend; the",
  "response will include sensitive rows.",
].join("\n");

// Command-injection slop fixture: real-looking JSON POST headers, a JSON
// body where every value is a `<...>` slot, and prose that talks about
// "shell command injection" without naming a concrete command. Both
// payload-class gold signals must be revoked.
const SLOP_CMDI_PLACEHOLDER_BODY_FIXTURE = [
  "# Critical command injection on POST /api/exec",
  "",
  "The `cmd` field is passed straight to a shell, allowing arbitrary",
  "command execution. CWE-78. Severity: Critical.",
  "",
  "```http",
  "POST /api/exec HTTP/1.1",
  "Host: api.example.com",
  "Content-Type: application/json",
  "Content-Length: 42",
  "",
  '{ "cmd": "<command here>", "args": "<args>" }',
  "```",
  "",
  "Any modern shell will exhibit this. Severe risk to the production",
  "fleet — please prioritize.",
].join("\n");

describe("isPlaceholderBody", () => {
  it("flags placeholder bodies (slot markers, TBD, [insert ...])", () => {
    expect(isPlaceholderBody("<sql payload here>")).toBe(true);
    expect(isPlaceholderBody("<inject>")).toBe(true);
    expect(isPlaceholderBody("q=<sql payload here>")).toBe(true);
    expect(isPlaceholderBody('{ "q": "<inject>" }')).toBe(true);
    expect(isPlaceholderBody('{ "cmd": "<command here>" }')).toBe(true);
    expect(isPlaceholderBody("[your payload]")).toBe(true);
    expect(isPlaceholderBody("TBD")).toBe(true);
    expect(isPlaceholderBody("<smuggled body here>")).toBe(true);
  });

  it("does not flag real exploit payloads", () => {
    expect(isPlaceholderBody("q=' UNION SELECT password FROM users--")).toBe(false);
    expect(isPlaceholderBody("id=1; cat /etc/passwd")).toBe(false);
    expect(isPlaceholderBody('{"$ne": null}')).toBe(false);
    expect(isPlaceholderBody("name=admin' OR 1=1--")).toBe(false);
    expect(isPlaceholderBody("")).toBe(false);
  });
});

describe("evaluateRawHttpRequest — placeholder body detection", () => {
  it("flags a request with real headers but a placeholder body", () => {
    const r = evaluateRawHttpRequest(SLOP_SQLI_PLACEHOLDER_BODY_FIXTURE);
    expect(r.placeholderBodies).toBeGreaterThanOrEqual(1);
    expect(r.placeholderBodyRanges.length).toBeGreaterThanOrEqual(1);
    // The header check shouldn't fire (Host/Content-Type/Length are real).
    expect(r.placeholderHeaders).toBe(0);
    // …but the placeholder-body check on its own marks the bytes as fake.
    expect(r.isFake).toBe(true);
    expect(r.reason).toMatch(/body is a placeholder/i);
  });

  it("does not flag a request whose body is a real exploit payload", () => {
    const r = evaluateRawHttpRequest(LEGIT_INJECTION_FIXTURE);
    expect(r.placeholderBodies).toBe(0);
    expect(r.placeholderBodyRanges).toEqual([]);
  });

  it("strips the placeholder body byte range from the surrounding text", () => {
    const r = evaluateRawHttpRequest(SLOP_SQLI_PLACEHOLDER_BODY_FIXTURE);
    const stripped = stripPlaceholderBodies(SLOP_SQLI_PLACEHOLDER_BODY_FIXTURE, r);
    expect(stripped).not.toContain("<sql payload here>");
    // Surrounding prose / headers survive.
    expect(stripped).toContain("# Critical SQL injection");
    expect(stripped).toContain("Host: shop.example.com");
  });
});

describe("runEngine2Avri — INJECTION placeholder-body integration", () => {
  it("revokes concrete_payload when the only payload is a SQLi placeholder body", () => {
    const sig = extractSignals(SLOP_SQLI_PLACEHOLDER_BODY_FIXTURE);
    const result = runEngine2Avri(sig, SLOP_SQLI_PLACEHOLDER_BODY_FIXTURE, INJ);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeIndObj = result.engine.triggeredIndicators.find(
      (i) => i.signal === "FAKE_RAW_HTTP",
    );
    expect(fakeIndObj?.explanation).toMatch(/INJECTION/);
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    // request-line `POST /search HTTP/1.1` only carries the endpoint, no
    // ?param=, so specific_endpoint_param doesn't fire here either.
  });

  it("revokes both payload-class gold signals for a command-injection placeholder body", () => {
    const sig = extractSignals(SLOP_CMDI_PLACEHOLDER_BODY_FIXTURE);
    const result = runEngine2Avri(sig, SLOP_CMDI_PLACEHOLDER_BODY_FIXTURE, INJ);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    expect(survivingIds).not.toContain("vulnerable_query_construction");
  });

  it("keeps concrete_payload when a real payload lives in a code fence alongside a prose placeholder mention", () => {
    // Prose says "Payload: `<sql payload here>`" (placeholder phrase), but a
    // separate fenced code block carries the real payload. The real payload
    // survives the strip-and-retest pass and concrete_payload stays.
    const fixture = [
      "# SQL injection on POST /search",
      "",
      "The q parameter is concatenated into a database query (CWE-89).",
      "Payload: `<sql payload here>` — see proof below.",
      "",
      "```",
      "q=' UNION SELECT password FROM users--",
      "```",
    ].join("\n");
    const sig = extractSignals(fixture);
    const result = runEngine2Avri(sig, fixture, INJ);
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).toContain("concrete_payload");
  });

  it("keeps concrete_payload when prose carries a real payload alongside the placeholder body", () => {
    // Same shape as the SQLi placeholder fixture, but the prose names a
    // real `' UNION SELECT password FROM users--` payload outside the
    // request bytes — that match must survive the body-stripping pass.
    const fixture = [
      "# SQL injection on POST /search",
      "",
      "Payload `' UNION SELECT password FROM users--` returns the full",
      "user table. CWE-89.",
      "",
      "```http",
      "POST /search HTTP/1.1",
      "Host: shop.example.com",
      "Content-Type: application/x-www-form-urlencoded",
      "Content-Length: 27",
      "",
      "q=<sql payload here>",
      "```",
    ].join("\n");
    const sig = extractSignals(fixture);
    const result = runEngine2Avri(sig, fixture, INJ);
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).toContain("concrete_payload");
  });
});

// SQLi slop fixture: prose only — no fake bytes, no fenced code, just a
// "Payload: `<sql payload here>`" mention plus an incidental "UNION SELECT"
// token in the CWE description prose. The injection family's
// `concrete_payload` gold signal would happily fire on the incidental token,
// so the prose-placeholder check must revoke it.
const SLOP_SQLI_PROSE_PLACEHOLDER_FIXTURE = [
  "# Critical SQL injection on /search via the q parameter",
  "",
  "The q parameter is concatenated directly into a database query.",
  "This is the canonical UNION SELECT class of attacks (CWE-89).",
  "Severity: Critical. Affects all customers in production.",
  "",
  "Payload: `<sql payload here>`.",
  "",
  "Replay against any modern database backend; the response will",
  "include sensitive rows.",
].join("\n");

// Command-injection slop fixture: prose only, "Run: `<command here>`" plus
// an incidental "; cat /etc/passwd" token in the CWE description.
const SLOP_CMDI_PROSE_PLACEHOLDER_FIXTURE = [
  "# Critical command injection on POST /api/exec",
  "",
  "The cmd field is passed straight to a shell, allowing arbitrary",
  "command execution. Per CWE-78, exploitation typically uses",
  "separators like ; cat /etc/passwd to chain commands.",
  "Severity: Critical.",
  "",
  "Run: `<command here>`.",
  "",
  "Any modern shell will exhibit this. Severe risk to the production",
  "fleet — please prioritize.",
].join("\n");

// SQLi slop fixture using the no-colon dodge: prose says "the payload
// `<sql payload here>` was tried" — same gesture as "Payload: `<...>`",
// but the colon-form regex would miss it. The injection family's
// `concrete_payload` gold signal would happily fire on the incidental
// "UNION SELECT" token in the CWE description, so the inline-form
// prose-placeholder check must revoke it.
const SLOP_SQLI_PROSE_PLACEHOLDER_NOCOLON_FIXTURE = [
  "# Critical SQL injection on /search via the q parameter",
  "",
  "The q parameter is concatenated directly into a database query.",
  "This is the canonical UNION SELECT class of attacks (CWE-89).",
  "Severity: Critical. Affects all customers in production.",
  "",
  "We confirmed the issue end-to-end: the payload `<sql payload here>`",
  "was tried against /search and returned the full user table.",
  "",
  "Replay against any modern database backend; the response will",
  "include sensitive rows.",
].join("\n");

// Command-injection slop fixture using the no-colon dodge: "send
// `<inject>` to /api/exec" — slop author leans on the inline-code span
// to make the slot look like a literal payload while skipping the
// "Run:" / "Payload:" label.
const SLOP_CMDI_PROSE_PLACEHOLDER_NOCOLON_FIXTURE = [
  "# Critical command injection on POST /api/exec",
  "",
  "The cmd field is passed straight to a shell, allowing arbitrary",
  "command execution. Per CWE-78, exploitation typically uses",
  "separators like ; cat /etc/passwd to chain commands.",
  "Severity: Critical.",
  "",
  "To reproduce, send `<inject>` to the cmd field on /api/exec.",
  "",
  "Any modern shell will exhibit this. Severe risk to the production",
  "fleet — please prioritize.",
].join("\n");

// SQLi slop fixture using the bare-angle dodge: prose says "the payload
// <sql payload here> was tried" — no colon AND no backticks. The slot's
// inner text is slop vocabulary so the bare-angle prose-placeholder
// check must still revoke `concrete_payload`.
const SLOP_SQLI_PROSE_PLACEHOLDER_BARE_FIXTURE = [
  "# Critical SQL injection on /search via the q parameter",
  "",
  "The q parameter is concatenated directly into a database query.",
  "This is the canonical UNION SELECT class of attacks (CWE-89).",
  "Severity: Critical. Affects all customers in production.",
  "",
  "We confirmed the issue end-to-end: the payload <sql payload here>",
  "was tried against /search and returned the full user table.",
  "",
  "Replay against any modern database backend; the response will",
  "include sensitive rows.",
].join("\n");

// SQLi slop fixture using the post-slot dodge: prose puts the slot
// FIRST and the payload-context word AFTER — "`<sql payload here>`
// was the SQLi payload tried". Both the colon-form regex and the
// word-then-slot inline form would miss this; the post-slot regex must
// still revoke the incidental `concrete_payload` match in the CWE
// description.
const SLOP_SQLI_PROSE_PLACEHOLDER_POSTSLOT_FIXTURE = [
  "# Critical SQL injection on /search via the q parameter",
  "",
  "The q parameter is concatenated directly into a database query.",
  "This is the canonical UNION SELECT class of attacks (CWE-89).",
  "Severity: Critical. Affects all customers in production.",
  "",
  "`<sql payload here>` was the SQLi payload tried against /search,",
  "and it returned the full user table.",
  "",
  "Replay against any modern database backend; the response will",
  "include sensitive rows.",
].join("\n");

// Command-injection slop fixture using the post-slot dodge: "`<inject>`
// is the command we ran against /api/exec". Slot-as-subject phrasing
// — the trigger word "command" appears after the inline-code slot
// rather than before it.
const SLOP_CMDI_PROSE_PLACEHOLDER_POSTSLOT_FIXTURE = [
  "# Critical command injection on POST /api/exec",
  "",
  "The cmd field is passed straight to a shell, allowing arbitrary",
  "command execution. Per CWE-78, exploitation typically uses",
  "separators like ; cat /etc/passwd to chain commands.",
  "Severity: Critical.",
  "",
  "`<inject>` is the command we ran against /api/exec to confirm.",
  "",
  "Any modern shell will exhibit this. Severe risk to the production",
  "fleet — please prioritize.",
].join("\n");

// SQLi slop fixture using the no-slot LABEL dodge: prose says "Payload:
// TBD" — no `<...>` slot at all, just a label and a slop term. The
// injection family's `concrete_payload` gold signal would happily fire
// on the incidental "UNION SELECT" token in the CWE description, so the
// no-slot label check must revoke it.
const SLOP_SQLI_PROSE_PLACEHOLDER_NOSLOT_LABEL_FIXTURE = [
  "# Critical SQL injection on /search via the q parameter",
  "",
  "The q parameter is concatenated directly into a database query.",
  "This is the canonical UNION SELECT class of attacks (CWE-89).",
  "Severity: Critical. Affects all customers in production.",
  "",
  "Payload: TBD.",
  "",
  "Replay against any modern database backend; the response will",
  "include sensitive rows.",
].join("\n");

// SQLi slop fixture using the no-slot SQUARE-BRACKET dodge: "Payload:
// [insert here]" — the value is a bracketed placeholder rather than a
// `<...>` slot. Same revocation expectation as the bare-term form.
const SLOP_SQLI_PROSE_PLACEHOLDER_NOSLOT_BRACKET_FIXTURE = [
  "# Critical SQL injection on /search via the q parameter",
  "",
  "The q parameter is concatenated directly into a database query.",
  "This is the canonical UNION SELECT class of attacks (CWE-89).",
  "Severity: Critical. Affects all customers in production.",
  "",
  "Payload: [insert here].",
  "",
  "Replay against any modern database backend; the response will",
  "include sensitive rows.",
].join("\n");

// Command-injection slop fixture using the no-slot PARENTHETICAL dodge:
// "the payload (to be added)" — payload-context noun followed by a
// parenthetical deferral instead of a slot. The incidental
// "; cat /etc/passwd" token in the CWE description should be revoked.
const SLOP_CMDI_PROSE_PLACEHOLDER_NOSLOT_PARENS_FIXTURE = [
  "# Critical command injection on POST /api/exec",
  "",
  "The cmd field is passed straight to a shell, allowing arbitrary",
  "command execution. Per CWE-78, exploitation typically uses",
  "separators like ; cat /etc/passwd to chain commands.",
  "Severity: Critical.",
  "",
  "We confirmed the issue end-to-end with the payload (to be added)",
  "against /api/exec.",
  "",
  "Any modern shell will exhibit this. Severe risk to the production",
  "fleet — please prioritize.",
].join("\n");

// SQLi slop fixture using the no-slot PASSIVE-FUTURE dodge: "the
// payload will be added later" — a copula + deferral verb in place of
// any slot. Same revocation expectation as the parenthetical form.
const SLOP_SQLI_PROSE_PLACEHOLDER_NOSLOT_DEFERRED_FIXTURE = [
  "# Critical SQL injection on /search via the q parameter",
  "",
  "The q parameter is concatenated directly into a database query.",
  "This is the canonical UNION SELECT class of attacks (CWE-89).",
  "Severity: Critical. Affects all customers in production.",
  "",
  "We confirmed the issue end-to-end against /search; the payload",
  "will be added later.",
  "",
  "Replay against any modern database backend; the response will",
  "include sensitive rows.",
].join("\n");

// Command-injection slop fixture using the no-slot ACTIVE-PROMISE
// dodge: "I'll add the actual payload later" — a first-person promise
// to deliver the payload, with the "actual" qualifier doing the heavy
// lifting.
const SLOP_CMDI_PROSE_PLACEHOLDER_NOSLOT_PROMISE_FIXTURE = [
  "# Critical command injection on POST /api/exec",
  "",
  "The cmd field is passed straight to a shell, allowing arbitrary",
  "command execution. Per CWE-78, exploitation typically uses",
  "separators like ; cat /etc/passwd to chain commands.",
  "Severity: Critical.",
  "",
  "I confirmed the issue against /api/exec; I'll add the actual",
  "payload later.",
  "",
  "Any modern shell will exhibit this. Severe risk to the production",
  "fleet — please prioritize.",
].join("\n");


describe("findProsePlaceholderPayloadRanges", () => {
  it("flags Payload:/Inject:/Exec:/Run: <slot> in prose", () => {
    expect(
      findProsePlaceholderPayloadRanges("Payload: `<sql payload here>`").length,
    ).toBe(1);
    expect(findProsePlaceholderPayloadRanges("inject: <inject>").length).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("exec: `<command here>`").length,
    ).toBe(1);
    expect(findProsePlaceholderPayloadRanges("Run: `<inject>`").length).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("Command: <shell command here>").length,
    ).toBe(1);
  });

  it("does not flag prose without a placeholder slot", () => {
    expect(
      findProsePlaceholderPayloadRanges(
        "Payload: ' UNION SELECT password FROM users--",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("exec: cat /etc/passwd").length,
    ).toBe(0);
  });

  it("does not flag <slot> without a payload-context word", () => {
    expect(
      findProsePlaceholderPayloadRanges("the value <unknown> means it failed")
        .length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("Host: <target> in a request").length,
    ).toBe(0);
  });

  it("flags inline-code <slot> after a payload-context word with no colon/equals", () => {
    // Slop dodge: drop the "Payload:" / "Run:" label and just lean on the
    // inline-code span to make the slot look like a literal payload.
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload `<inject>` was sent to /search",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "send `<sql payload here>` against the endpoint",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload `<sql payload here>` was tried successfully",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "we run `<command here>` to confirm the issue",
      ).length,
    ).toBe(1);
  });

  it("does not flag inline-code <slot> without a payload-context word", () => {
    // The inline-code form requires a payload-context word before the
    // backtick, otherwise prose like "the value `<unknown>` failed" or
    // "the field `<x>` was empty" would be punished.
    expect(
      findProsePlaceholderPayloadRanges("the value `<unknown>` was rejected")
        .length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("the field `<x>` was empty").length,
    ).toBe(0);
  });

  it("does not flag inline-code with a real payload after a payload-context word", () => {
    // No `<...>` slot means no placeholder — the inline-code span carries
    // a real exploit string.
    expect(
      findProsePlaceholderPayloadRanges(
        "send `' UNION SELECT password FROM users--` to /search",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload `; cat /etc/passwd` was tried",
      ).length,
    ).toBe(0);
  });

  it("does not double-count when both regexes could match the same slot", () => {
    // The colon-form regex would match "Payload: `<inject>`"; the inline
    // form needs `\s+` between the word and the backtick. They are
    // disjoint by design, but the function still dedupes overlapping
    // ranges so a future relax of either pattern stays idempotent.
    const ranges = findProsePlaceholderPayloadRanges(
      "Payload: `<inject>` and Run: `<command here>`.",
    );
    expect(ranges.length).toBe(2);
  });

  it("flags bare-angle <slot> after a payload-context word with no colon and no backticks", () => {
    // Slop dodge: drop the backticks AND the colon. "the payload <inject>
    // was sent" still gestures at a payload without naming one. The slot
    // must contain slop vocabulary for the bare-angle form to fire (no
    // backtick fence to lean on as a payload-context tell).
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload <inject> was sent against the endpoint",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "we send <sql payload here> to /search",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "exec <command here> to confirm RCE",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "run <shell command here> on the host",
      ).length,
    ).toBe(1);
  });

  it("does not flag bare-angle <slot> when the slot is a neutral identifier", () => {
    // The bare-angle form is intentionally stricter than the colon and
    // inline-code forms: without backticks, a bare short identifier in
    // the slot is NOT enough on its own. "the payload <unknown> was
    // rejected" legitimately calls out a server-supplied identifier
    // rather than gesturing at a hidden exploit, and must not be
    // flagged.
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload <unknown> was rejected",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "the command <foo> was not recognised",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "we send <ack> as part of the handshake",
      ).length,
    ).toBe(0);
  });

  it("flags double-quote-fenced <slot> after a payload-context word", () => {
    // Slop dodge: wrap the slot in bare double-quotes instead of
    // backticks. Symmetric to the bare-angle form but with `"` fences;
    // the slop-vocab guard mirrors the bare-angle form, so only slots
    // whose inner text is in BODY_PLACEHOLDER_KEYWORDS qualify.
    expect(
      findProsePlaceholderPayloadRanges(
        'the payload "<inject>" was sent against the endpoint',
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        'we send "<sql payload here>" to /search',
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        'exec "<command here>" to confirm RCE',
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        'run "<shell command here>" on the host',
      ).length,
    ).toBe(1);
  });

  it("does not flag double-quote-fenced <slot> when the slot is a neutral identifier", () => {
    // Same slop-vocab guard as the bare-angle form: a neutral
    // server-supplied identifier wrapped in quotes ("the payload
    // \"<unknown>\" was rejected") is legitimate prose and must not
    // be flagged. Only slop vocabulary inside the slot qualifies.
    expect(
      findProsePlaceholderPayloadRanges(
        'the payload "<unknown>" was rejected',
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        'the command "<foo>" was not recognised',
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        'we send "<ack>" as part of the handshake',
      ).length,
    ).toBe(0);
  });

  it("flags square-bracket-fenced [<slot>] after a payload-context word", () => {
    // Slop dodge: wrap the slot in bare square brackets instead of
    // backticks. Symmetric to the double-quote form with `[`/`]`
    // fences; the slop-vocab guard mirrors the bare-angle form.
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload [<inject>] was sent against the endpoint",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "we send [<sql payload here>] to /search",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "exec [<command here>] to confirm RCE",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "run [<shell command here>] on the host",
      ).length,
    ).toBe(1);
  });

  it("does not flag square-bracket-fenced [<slot>] when the slot is a neutral identifier", () => {
    // Same slop-vocab guard as the bare-angle and double-quote forms:
    // bare square brackets around a neutral identifier ("the payload
    // [<unknown>] was rejected") read as a server-supplied placeholder
    // and must not be flagged.
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload [<unknown>] was rejected",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "the command [<foo>] was not recognised",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "we send [<ack>] as part of the handshake",
      ).length,
    ).toBe(0);
  });

  it("does not flag fenced <slot> without a payload-context word", () => {
    // Same rule as the bare-angle form: the fence character (quote or
    // bracket) is not enough on its own — the slot must be preceded
    // by a payload/inject/exec/run/command/send word to count.
    expect(
      findProsePlaceholderPayloadRanges('the value "<inject>" was rejected')
        .length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("the field [<sql payload here>] failed")
        .length,
    ).toBe(0);
  });

  it("does not flag bare-angle <slot> without a payload-context word", () => {
    // The verb/noun list is what makes the slot a payload mention.
    // Without one of those words in front, the bare angle bracket is
    // ordinary prose markup and stays safe — even if the slot itself
    // is slop vocabulary.
    expect(
      findProsePlaceholderPayloadRanges("the value <inject> was rejected")
        .length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("the field <sql payload here> failed")
        .length,
    ).toBe(0);
  });

  it("flags bare-angle <slot> when a comma separates the payload word from the slot", () => {
    // Slop dodge: drop the backticks AND insert a comma between the
    // payload-context word and the `<...>` slot. "the payload,
    // <inject>, was sent" is the same gesture as "the payload <inject>
    // was sent" — the comma separator must not let it slip past.
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload, <inject>, was sent against the endpoint",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "we send,<sql payload here>, to /search",
      ).length,
    ).toBe(1);
  });

  it("flags bare-angle <slot> when the slot is wrapped in parentheses", () => {
    // Slop dodge: parenthesize the slot. "the payload (<inject>) was
    // sent" wraps the slot in `(...)` so there is no whitespace
    // immediately before `<`, only an opening paren after a space.
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload (<inject>) was sent against the endpoint",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "exec (<command here>) to confirm RCE",
      ).length,
    ).toBe(1);
  });

  it("flags bare-angle <slot> when an em-dash separates the payload word from the slot", () => {
    // Slop dodge: em-dash (U+2014) between the payload word and the
    // slot. "the payload — <inject> — was sent" is the same gesture
    // dressed up with typographic dashes; the separator class must
    // accept em-dashes so the dodge is caught.
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload \u2014 <inject> \u2014 was sent against the endpoint",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "we send \u2014 <sql payload here> \u2014 to /search",
      ).length,
    ).toBe(1);
  });

  it("flags bare-angle <slot> when an en-dash separates the payload word from the slot", () => {
    // Same as the em-dash form, but with en-dash (U+2013). Slop
    // authors paste from sources that auto-convert hyphens to en-dashes
    // too, so both shapes need to be caught.
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload \u2013 <inject> \u2013 was sent against the endpoint",
      ).length,
    ).toBe(1);
  });

  it("does not flag punctuation-separated bare-angle prose with a neutral identifier", () => {
    // The slop-vocab guard on the bare-angle form must still hold
    // when separators other than whitespace are in play. "the payload,
    // <unknown>, was rejected" and "the payload (<unknown>) was
    // rejected" both legitimately call out a server-supplied identifier
    // and must not be flagged just because we relaxed the separator
    // class.
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload, <unknown>, was rejected",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload (<unknown>) was rejected",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload \u2014 <unknown> \u2014 was rejected",
      ).length,
    ).toBe(0);
  });

  it("does not flag punctuation-separated bare-angle prose without a payload-context word", () => {
    // Without a payload-context word in front of the separator, the
    // slot is ordinary prose markup and stays safe even when the
    // separator is comma / paren / em-dash.
    expect(
      findProsePlaceholderPayloadRanges(
        "the value, <inject>, was rejected",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "the field (<sql payload here>) failed validation",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "the value \u2014 <inject> \u2014 was rejected",
      ).length,
    ).toBe(0);
  });

  it("does not flag bare-angle prose where letters intervene between the payload word and the slot", () => {
    // The relaxed separator class only contains whitespace and
    // punctuation — letters and digits between the payload word and
    // `<` still break the run. Compound words like "payload-injected"
    // and parenthetical noun phrases like "payload (args) <inject>"
    // must therefore not light up.
    expect(
      findProsePlaceholderPayloadRanges("payload-injected-into <foo>").length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("the payload (args) <inject>").length,
    ).toBe(0);
  });

  it("does not double-count the bare-angle form against the inline-code form", () => {
    // The bare-angle regex doesn't require backticks, but it does
    // require whitespace immediately before `<`, so the backticked
    // form ("the payload `<inject>`") has a backtick between the
    // verb and `<` and only the inline form matches. Guard against a
    // future relax that would let both patterns match the same slot.
    const ranges = findProsePlaceholderPayloadRanges(
      "the payload `<inject>` was sent",
    );
    expect(ranges.length).toBe(1);
  });

  it("flags inline-code <slot> when the payload-context word comes AFTER the slot", () => {
    // Slop dodge: flip the order so the trigger word follows the slot.
    // "`<inject>` is the payload" / "`<sql payload here>` was the SQLi
    // payload tried" both put the payload-context word after the slot
    // and would otherwise slip past the colon-form and the
    // word-then-slot inline form.
    expect(
      findProsePlaceholderPayloadRanges(
        "`<inject>` is the payload we sent",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "`<sql payload here>` was the SQLi payload tried",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "`<sql payload here>` was the payload tried",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "`<command here>` is the command we ran",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "`<inject>` was used as the SQLi payload",
      ).length,
    ).toBe(1);
  });

  it("does not flag post-slot phrasings without a payload-context noun", () => {
    // Copula after the slot is necessary but not sufficient — the
    // sentence must actually label the slot as a payload/inject/command/
    // etc. Generic "is the value" / "was rejected" / "is the username"
    // sentences do not get flagged.
    expect(
      findProsePlaceholderPayloadRanges(
        "`<unknown>` is the username they tried",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "`<x>` was rejected because the field was empty",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "`<value>` is the response code we got back",
      ).length,
    ).toBe(0);
  });

  it("does not flag post-slot phrasings where the payload word is too far away", () => {
    // The connector window between the copula and the payload noun is
    // capped at 25 characters of letters/spaces/hyphens. A trailing
    // mention later in the sentence ("...rejected immediately because
    // the payload was wrong") sits past that window and must not be
    // swept in.
    expect(
      findProsePlaceholderPayloadRanges(
        "`<x>` was rejected immediately because the payload was wrong",
      ).length,
    ).toBe(0);
  });

  it("also catches the bare copula+noun form (no article between)", () => {
    // The connector window {1,25} of letters/spaces/hyphens is satisfied
    // by the single separating space between "is" and "payload", so the
    // stripped-down form is also caught. This is intentional broadening:
    // it makes the dodge surface smaller without obviously expanding
    // false positives, since the slot must still be wrapped in
    // backticks and immediately followed by a copula.
    expect(
      findProsePlaceholderPayloadRanges("`<inject>` is payload").length,
    ).toBe(1);
  });

  it("requires backticks around the slot in the post-slot form", () => {
    // Without the backticks, "`<unknown>` is the payload" would expand
    // to bare "<unknown> is the payload" and false-positive on
    // legitimate prose like "the missing field <unknown> is the
    // payload-related setting" — same safety rationale as the
    // word-then-slot inline form.
    expect(
      findProsePlaceholderPayloadRanges("<inject> is the payload we sent")
        .length,
    ).toBe(0);
  });

  // ===================================================================
  // No-slot dodge variants — payload mentions that don't use angle-
  // bracket slots at all. Slop authors dodge the slot-based checks by
  // skipping the `<...>` entirely: "Payload: TBD", "the payload (to be
  // added)", "I'll add the actual payload later", "[insert payload
  // here]". Each of these is a no-payload gesture and must still feed
  // the strip-and-retest pass.

  it("flags the labelled no-slot dodge with a bare slop term", () => {
    // "Payload: TBD" / "Payload: TODO" / "payload = N/A" — the label is
    // followed by a standalone slop term in place of any slot.
    expect(
      findProsePlaceholderPayloadRanges("Payload: TBD").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("Payload: TODO").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("payload = N/A").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("Command: FIXME").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("Inject: placeholder").length,
    ).toBe(1);
  });

  it("flags the labelled no-slot dodge with a square-bracket placeholder", () => {
    // "Payload: [insert here]" / "Payload: [your payload]" — the label
    // is followed by a square-bracket placeholder whose first word is
    // slop vocabulary.
    expect(
      findProsePlaceholderPayloadRanges("Payload: [insert here]").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("Payload: [your payload]").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("payload: [todo]").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "Command: [insert the actual command here]",
      ).length,
    ).toBe(1);
  });

  it("does not flag the labelled form when the value is a real payload or non-slop bracket", () => {
    // A real exploit string after the label is not a placeholder — the
    // bare-term branch requires a closed slop word and the bracket
    // branch requires a slop-vocab first word.
    expect(
      findProsePlaceholderPayloadRanges(
        "Payload: ' UNION SELECT password FROM users--",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("payload = 1234").length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("command: [GET /api/users]").length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("Payload: [1234]").length,
    ).toBe(0);
  });

  it("flags the parenthetical no-slot dodge", () => {
    // "the payload (to be added)" / "the payload (TBD)" — a payload-
    // context noun followed by a parenthetical whose first word is a
    // deferral gesture.
    expect(
      findProsePlaceholderPayloadRanges("the payload (to be added)").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("the payload (TBD)").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("the command (placeholder)").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload (will be filled in below)",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "the exploit (to be provided in a follow-up)",
      ).length,
    ).toBe(1);
  });

  it("does not flag neutral parentheticals after a payload word", () => {
    // The parenthetical's first word must come from the closed slop
    // list; size annotations, position references, and other neutral
    // parentheticals stay safe.
    expect(
      findProsePlaceholderPayloadRanges("the payload (200 bytes)").length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("the command (above)").length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload (see appendix A) was sent",
      ).length,
    ).toBe(0);
  });

  it("flags the passive-future no-slot dodge", () => {
    // "the payload will be added later" / "the actual payload was
    // provided" — payload-context noun phrase followed by a copula and
    // a deferral verb.
    expect(
      findProsePlaceholderPayloadRanges(
        "the payload will be added later",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "the actual payload will be provided",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "the command was filled in below",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("the exploit is to be shared").length,
    ).toBe(1);
  });

  it("does not flag factual passive prose after a payload word", () => {
    // The deferral-verb list is intentionally narrow — rejected /
    // returned / blocked / accepted are not deferral verbs and must
    // stay safe.
    expect(
      findProsePlaceholderPayloadRanges("the payload was rejected").length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "the command returned a 500 response",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("the payload was blocked").length,
    ).toBe(0);
  });

  it("flags the active-promise no-slot dodge", () => {
    // "I'll add the actual payload later" — first-person promise to
    // deliver the payload. The qualifier (actual/real/exact/...)
    // OR a deferral keyword after the noun is required.
    expect(
      findProsePlaceholderPayloadRanges(
        "I'll add the actual payload later",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "we'll provide the exact command shortly",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "I will share the payload in a follow-up",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "I plan to insert the real exploit later",
      ).length,
    ).toBe(1);
  });

  it("does not flag a promise to deliver the payload mid-construction", () => {
    // Without a qualifier (actual/real/exact/...) AND without a
    // deferral keyword (later/soon/shortly/...), a promise to "add the
    // payload" is just a reporter narrating payload construction — not
    // a deferral.
    expect(
      findProsePlaceholderPayloadRanges(
        "I'll add the payload to the request body",
      ).length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges(
        "we'll add the payload after the prefix",
      ).length,
    ).toBe(0);
  });

  it("flags a bare square-bracket payload placeholder with no surrounding label", () => {
    // "[insert payload here]" — the bracket itself contains both a slop
    // directive word AND a payload-context noun, so it qualifies even
    // without a "Payload:" label in front.
    expect(
      findProsePlaceholderPayloadRanges(
        "Replace [insert payload here] with the SQL string",
      ).length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges("[your sql payload]").length,
    ).toBe(1);
    expect(
      findProsePlaceholderPayloadRanges(
        "Use [add the actual command here] in the cmd field",
      ).length,
    ).toBe(1);
  });

  it("does not flag bare brackets without both slop directive AND payload noun", () => {
    // Brackets that are only slop-direction ("[insert your name]") or
    // only payload-noun ("[payload]") don't qualify on their own —
    // both are too easy to false-positive on.
    expect(
      findProsePlaceholderPayloadRanges("[insert your name]").length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("[your address]").length,
    ).toBe(0);
    expect(
      findProsePlaceholderPayloadRanges("see [your settings]").length,
    ).toBe(0);
  });

  it("does not double-count when slot-based and no-slot regexes could overlap", () => {
    // The slot-based and no-slot regexes target disjoint shapes (one
    // requires `<...>`, the others require bare slop terms or
    // brackets), but the dedup keeps the strip pass idempotent if a
    // future broadening accidentally lets both fire on the same span.
    const ranges = findProsePlaceholderPayloadRanges(
      "Payload: TBD and Payload: `<inject>`.",
    );
    expect(ranges.length).toBe(2);
  });
});

describe("runEngine2Avri — INJECTION prose-placeholder integration", () => {
  it("revokes concrete_payload when prose only gestures at a SQLi payload", () => {
    const sig = extractSignals(SLOP_SQLI_PROSE_PLACEHOLDER_FIXTURE);
    const result = runEngine2Avri(sig, SLOP_SQLI_PROSE_PLACEHOLDER_FIXTURE, INJ);
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeInd = result.engine.triggeredIndicators.find(
      (i) => i.signal === "FAKE_RAW_HTTP",
    );
    expect(fakeInd?.explanation).toMatch(/[Pp]rose payload reference/);
  });

  it("keeps concrete_payload when a real payload sits in an inline code span alongside the prose placeholder", () => {
    // The placeholder phrase says "Payload: `<inject>`", but a separate
    // inline-code span carries the real exploit. The prose-strip pass
    // must preserve inline code spans so the real payload survives the
    // strip-and-retest, and concrete_payload stays.
    const fixture = [
      "# SQL injection on /search via the q parameter",
      "",
      "Payload: `<sql payload here>` — placeholder above. The actual",
      "exploit `' UNION SELECT password FROM users--` returns the full",
      "user table. CWE-89.",
    ].join("\n");
    const sig = extractSignals(fixture);
    const result = runEngine2Avri(sig, fixture, INJ);
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).toContain("concrete_payload");
  });

  it("revokes concrete_payload when prose only gestures at a command-injection payload", () => {
    const sig = extractSignals(SLOP_CMDI_PROSE_PLACEHOLDER_FIXTURE);
    const result = runEngine2Avri(sig, SLOP_CMDI_PROSE_PLACEHOLDER_FIXTURE, INJ);
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
  });

  it("revokes concrete_payload when prose dodges the colon with 'the payload `<...>` was tried'", () => {
    const sig = extractSignals(SLOP_SQLI_PROSE_PLACEHOLDER_NOCOLON_FIXTURE);
    const result = runEngine2Avri(
      sig,
      SLOP_SQLI_PROSE_PLACEHOLDER_NOCOLON_FIXTURE,
      INJ,
    );
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeInd = result.engine.triggeredIndicators.find(
      (i) => i.signal === "FAKE_RAW_HTTP",
    );
    expect(fakeInd?.explanation).toMatch(/[Pp]rose payload reference/);
  });

  it("revokes concrete_payload when prose dodges the colon with 'send `<inject>` to'", () => {
    const sig = extractSignals(SLOP_CMDI_PROSE_PLACEHOLDER_NOCOLON_FIXTURE);
    const result = runEngine2Avri(
      sig,
      SLOP_CMDI_PROSE_PLACEHOLDER_NOCOLON_FIXTURE,
      INJ,
    );
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
  });

  it("revokes concrete_payload when prose drops backticks too: 'the payload <sql payload here> was tried'", () => {
    // The bare-angle dodge: no colon, no backticks, just a payload-context
    // word followed by a slop-vocabulary `<...>` slot. The check must
    // still revoke `concrete_payload` so the incidental "UNION SELECT"
    // token in the CWE prose can't carry the slop report past gold.
    const sig = extractSignals(SLOP_SQLI_PROSE_PLACEHOLDER_BARE_FIXTURE);
    const result = runEngine2Avri(
      sig,
      SLOP_SQLI_PROSE_PLACEHOLDER_BARE_FIXTURE,
      INJ,
    );
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeInd = result.engine.triggeredIndicators.find(
      (i) => i.signal === "FAKE_RAW_HTTP",
    );
    expect(fakeInd?.explanation).toMatch(/[Pp]rose payload reference/);
  });

  it("revokes concrete_payload when prose flips the order to '`<...>` was the SQLi payload tried'", () => {
    // Post-slot dodge: the slot comes first and the payload-context
    // word comes after. The colon-form and the word-then-slot inline
    // form both miss this, but the post-slot regex must still revoke
    // the incidental UNION SELECT match in the CWE description.
    const sig = extractSignals(SLOP_SQLI_PROSE_PLACEHOLDER_POSTSLOT_FIXTURE);
    const result = runEngine2Avri(
      sig,
      SLOP_SQLI_PROSE_PLACEHOLDER_POSTSLOT_FIXTURE,
      INJ,
    );
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeInd = result.engine.triggeredIndicators.find(
      (i) => i.signal === "FAKE_RAW_HTTP",
    );
    expect(fakeInd?.explanation).toMatch(/[Pp]rose payload reference/);
  });

  it("revokes concrete_payload when prose flips the order to '`<inject>` is the command we ran'", () => {
    const sig = extractSignals(SLOP_CMDI_PROSE_PLACEHOLDER_POSTSLOT_FIXTURE);
    const result = runEngine2Avri(
      sig,
      SLOP_CMDI_PROSE_PLACEHOLDER_POSTSLOT_FIXTURE,
      INJ,
    );
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
  });

  it("revokes concrete_payload when prose drops the slot entirely: 'Payload: TBD'", () => {
    // No-slot label dodge: there's no `<...>` slot, just a label
    // followed by a slop term. The incidental "UNION SELECT" token in
    // the CWE description must still lose its `concrete_payload` point.
    const sig = extractSignals(
      SLOP_SQLI_PROSE_PLACEHOLDER_NOSLOT_LABEL_FIXTURE,
    );
    const result = runEngine2Avri(
      sig,
      SLOP_SQLI_PROSE_PLACEHOLDER_NOSLOT_LABEL_FIXTURE,
      INJ,
    );
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeInd = result.engine.triggeredIndicators.find(
      (i) => i.signal === "FAKE_RAW_HTTP",
    );
    expect(fakeInd?.explanation).toMatch(/[Pp]rose payload reference/);
  });

  it("revokes concrete_payload when prose drops the slot entirely: 'Payload: [insert here]'", () => {
    // No-slot square-bracket dodge: the label is followed by a
    // bracketed placeholder rather than a `<...>` slot.
    const sig = extractSignals(
      SLOP_SQLI_PROSE_PLACEHOLDER_NOSLOT_BRACKET_FIXTURE,
    );
    const result = runEngine2Avri(
      sig,
      SLOP_SQLI_PROSE_PLACEHOLDER_NOSLOT_BRACKET_FIXTURE,
      INJ,
    );
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
  });

  it("revokes concrete_payload when prose uses the parenthetical no-slot dodge: 'the payload (to be added)'", () => {
    // No-slot parenthetical dodge: payload-context noun followed by a
    // parenthetical deferral. Same revocation expectation as the
    // labelled forms.
    const sig = extractSignals(
      SLOP_CMDI_PROSE_PLACEHOLDER_NOSLOT_PARENS_FIXTURE,
    );
    const result = runEngine2Avri(
      sig,
      SLOP_CMDI_PROSE_PLACEHOLDER_NOSLOT_PARENS_FIXTURE,
      INJ,
    );
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
  });

  it("revokes concrete_payload when prose defers the payload: 'the payload will be added later'", () => {
    // No-slot passive-future dodge: copula + deferral verb stand in
    // for any slot.
    const sig = extractSignals(
      SLOP_SQLI_PROSE_PLACEHOLDER_NOSLOT_DEFERRED_FIXTURE,
    );
    const result = runEngine2Avri(
      sig,
      SLOP_SQLI_PROSE_PLACEHOLDER_NOSLOT_DEFERRED_FIXTURE,
      INJ,
    );
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
  });

  it("revokes concrete_payload when the reporter promises to add the payload: 'I'll add the actual payload later'", () => {
    // No-slot active-promise dodge: first-person promise to deliver
    // the payload. The "actual" qualifier is the tell.
    const sig = extractSignals(
      SLOP_CMDI_PROSE_PLACEHOLDER_NOSLOT_PROMISE_FIXTURE,
    );
    const result = runEngine2Avri(
      sig,
      SLOP_CMDI_PROSE_PLACEHOLDER_NOSLOT_PROMISE_FIXTURE,
      INJ,
    );
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("concrete_payload");
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
  });
});

// =====================================================================
// Sprint 13B-3 — raw HTTP RESPONSE plausibility tests.

// Calibration fixture: a fabricated SQLi report whose only "evidence"
// is a trivial `HTTP/1.1 200 OK` block + narrative-tailored JSON body.
// The response carries no Date, no Server, no incidentals, and a
// 1-key JSON body whose value is the vulnerability narrative — all
// four plausibility markers fire.
const SLOP_FABRICATED_RESPONSE_FIXTURE = [
  "# Critical SQL injection on /api/users with response proof",
  "",
  "Sending the payload below as the q parameter triggers a baseline",
  "vs injected response that confirms the injection. CWE-89.",
  "",
  "Baseline:",
  "```http",
  "GET /api/users?q=normal HTTP/1.1",
  "Host: api.example.com",
  "",
  "```",
  "",
  "Server returns:",
  "```http",
  "HTTP/1.1 200 OK",
  "Content-Type: application/json",
  "",
  '{"error": "SQL injection in users.id parameter exposed by attacker payload"}',
  "```",
  "",
  "Compare with the injected request below — the response leaks the",
  "users table because of the SQL injection.",
].join("\n");

// Plausible response excerpt: real headers (Date + Server +",
// X-Request-Id + Content-Length), a JSON body with incidental id and
// timestamp fields. Should not fire any markers.
const PLAUSIBLE_RESPONSE_FIXTURE = [
  "Server returns:",
  "```http",
  "HTTP/1.1 200 OK",
  "Date: Wed, 21 Oct 2026 07:28:00 GMT",
  "Server: nginx/1.18.0",
  "Content-Type: application/json",
  "Content-Length: 142",
  "Cache-Control: no-cache, private",
  "X-Request-Id: 7a8b9c0d-1234-5678-9abc-def012345678",
  "",
  '{"id": 4012, "username": "bob", "created_at": "2026-10-21T07:28:00Z"}',
  "```",
].join("\n");

describe("isSuspiciousJsonBody", () => {
  it("flags single-key narrative JSON bodies", () => {
    expect(
      isSuspiciousJsonBody(
        '{"error": "SQL injection in users.id parameter"}',
      ),
    ).toBe(true);
    expect(
      isSuspiciousJsonBody('{"data": "user account compromised by attacker"}'),
    ).toBe(true);
    expect(isSuspiciousJsonBody('["XSS payload reflected"]')).toBe(true);
  });

  it("does not flag real API responses with incidental fields", () => {
    expect(
      isSuspiciousJsonBody(
        '{"id": 4012, "username": "bob", "balance": 250.00}',
      ),
    ).toBe(false);
    expect(
      isSuspiciousJsonBody('{"uuid": "a-b-c", "data": "leaked"}'),
    ).toBe(false);
    // ≥3 top-level keys — never suspicious regardless of vocab.
    expect(
      isSuspiciousJsonBody(
        '{"a": "vulnerability noted", "b": 1, "c": 2}',
      ),
    ).toBe(false);
  });

  it("does not flag non-JSON bodies, plain prose, or HTML", () => {
    expect(isSuspiciousJsonBody("")).toBe(false);
    expect(isSuspiciousJsonBody("plain text response")).toBe(false);
    expect(isSuspiciousJsonBody("<html><body>...</body></html>")).toBe(false);
    expect(isSuspiciousJsonBody('{"id": 4012, "name": "alice"}')).toBe(false);
  });
});

describe("evaluateRawHttpResponse", () => {
  it("flags a fabricated response with all four plausibility markers", () => {
    const r = evaluateRawHttpResponse(SLOP_FABRICATED_RESPONSE_FIXTURE);
    expect(r.responsesAnalyzed).toBeGreaterThanOrEqual(1);
    expect(r.responsesFlagged).toBeGreaterThanOrEqual(1);
    expect(r.responsesMissingDate).toBeGreaterThanOrEqual(1);
    expect(r.responsesMissingServer).toBeGreaterThanOrEqual(1);
    expect(r.responsesWithSuspiciousJsonBody).toBeGreaterThanOrEqual(1);
    expect(r.responsesMissingIncidentals).toBeGreaterThanOrEqual(1);
    expect(r.isFake).toBe(true);
    expect(r.reason).toMatch(/fabricated|missing|suspicious|incidentals/i);
    expect(r.fakeResponseRanges.length).toBeGreaterThanOrEqual(1);
  });

  it("does not flag a plausible response with Date/Server/X-Request-Id and incidental JSON fields", () => {
    const r = evaluateRawHttpResponse(PLAUSIBLE_RESPONSE_FIXTURE);
    expect(r.responsesAnalyzed).toBe(1);
    expect(r.responsesFlagged).toBe(0);
    expect(r.responsesMissingDate).toBe(0);
    expect(r.responsesMissingServer).toBe(0);
    expect(r.responsesWithSuspiciousJsonBody).toBe(0);
    expect(r.responsesMissingIncidentals).toBe(0);
    expect(r.isFake).toBe(false);
    expect(r.reason).toBeNull();
  });

  it("returns 0 responses for prose with no HTTP/1.x status line", () => {
    const r = evaluateRawHttpResponse(
      "The server returns a 200 OK response.",
    );
    expect(r.responsesAnalyzed).toBe(0);
    expect(r.isFake).toBe(false);
  });

  it("does not match shell-escaped status lines (printf 'HTTP/1.1 200 OK\\\\r\\\\n...')", () => {
    const fixture =
      "Reproduction: printf 'HTTP/1.1 200 OK\\r\\nSet-Cookie: x=1\\r\\n\\r\\n' | nc -l 8080";
    const r = evaluateRawHttpResponse(fixture);
    expect(r.responsesAnalyzed).toBe(0);
    expect(r.isFake).toBe(false);
  });

  it("strips fake response byte ranges", () => {
    const r = evaluateRawHttpResponse(SLOP_FABRICATED_RESPONSE_FIXTURE);
    const stripped = stripFakeResponses(SLOP_FABRICATED_RESPONSE_FIXTURE, r);
    expect(stripped).not.toContain("SQL injection in users.id parameter");
    // Surrounding prose survives.
    expect(stripped).toContain("# Critical SQL injection on /api/users");
    expect(stripped).toContain("Compare with the injected request below");
  });

  it("does not flag a response that only fires one marker (missing Date alone)", () => {
    // Response has Server + Content-Length + Cache-Control — only Date is
    // missing. Single marker shouldn't trip the fake threshold.
    const fixture = [
      "```http",
      "HTTP/1.1 200 OK",
      "Server: nginx/1.18.0",
      "Content-Type: application/json",
      "Content-Length: 80",
      "Cache-Control: no-cache",
      "",
      '{"id": 1, "name": "alice"}',
      "```",
    ].join("\n");
    const r = evaluateRawHttpResponse(fixture);
    expect(r.responsesAnalyzed).toBe(1);
    expect(r.responsesMissingDate).toBe(1);
    expect(r.isFake).toBe(false);
  });
});

describe("runEngine2Avri — INJECTION fabricated-response integration", () => {
  it("revokes request_response_diff when the only response evidence is a fabricated block", () => {
    const sig = extractSignals(SLOP_FABRICATED_RESPONSE_FIXTURE);
    const result = runEngine2Avri(
      sig,
      SLOP_FABRICATED_RESPONSE_FIXTURE,
      INJ,
    );
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeIndObj = result.engine.triggeredIndicators.find(
      (i) => i.signal === "FAKE_RAW_HTTP",
    );
    expect(fakeIndObj?.explanation).toMatch(/FAKE_RAW_HTTP_RESPONSE/);
    const survivingIds = result.detail.goldHits.map((g) => g.id);
    expect(survivingIds).not.toContain("request_response_diff");
  });

  it("does not flag a realistic INJECTION report whose response excerpt has incidental fields", () => {
    const fixture = [
      "# SQL injection on POST /search via the q parameter",
      "",
      "The `q` form field is concatenated into a SQL query unsanitized.",
      "CWE-89.",
      "",
      "```http",
      "POST /search HTTP/1.1",
      "Host: shop.example.com",
      "Content-Type: application/x-www-form-urlencoded",
      "Content-Length: 47",
      "",
      "q=foo'+UNION+SELECT+password+FROM+users--",
      "```",
      "",
      "Baseline response:",
      "```http",
      "HTTP/1.1 200 OK",
      "Date: Wed, 21 Oct 2026 07:28:00 GMT",
      "Server: nginx/1.18.0",
      "Content-Type: application/json",
      "Content-Length: 87",
      "Cache-Control: no-cache",
      "X-Request-Id: 7a8b9c0d-1234",
      "",
      '{"id": 4012, "username": "bob", "email": "bob@example.com"}',
      "```",
    ].join("\n");
    const sig = extractSignals(fixture);
    const result = runEngine2Avri(sig, fixture, INJ);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).not.toContain("FAKE_RAW_HTTP");
  });
});

describe("runEngine2Avri — WEB_CLIENT fabricated-response integration", () => {
  it("revokes reflection_or_dom_proof when the only DOM/response evidence is a fabricated block", () => {
    const fixture = [
      "# Critical reflected XSS in /search response",
      "",
      "The q parameter is reflected into the response. CWE-79.",
      "",
      "Server returns:",
      "```http",
      "HTTP/1.1 200 OK",
      "Content-Type: text/html",
      "",
      '<html><body><input value="<script>alert(\'xss attack injected\')</script>"></body></html>',
      "```",
      "",
      "The XSS payload is reflected in the response above.",
    ].join("\n");
    const sig = extractSignals(fixture);
    const result = runEngine2Avri(sig, fixture, WEB);
    const indicators = result.engine.triggeredIndicators.map((i) => i.signal);
    expect(indicators).toContain("FAKE_RAW_HTTP");
    const fakeIndObj = result.engine.triggeredIndicators.find(
      (i) => i.signal === "FAKE_RAW_HTTP",
    );
    expect(fakeIndObj?.explanation).toMatch(/FAKE_RAW_HTTP_RESPONSE/);
    // The prose "reflected in the response" still survives stripping,
    // so the signal stays. We only test that FAKE_RAW_HTTP fired and
    // the response sub-block is populated.
    const avri = result.engine.signalBreakdown?.avri as
      | { rawHttp?: { response?: { isFake?: boolean; responsesFlagged?: number } } }
      | undefined;
    const rawHttp = avri?.rawHttp;
    expect(rawHttp?.response?.isFake).toBe(true);
    expect(rawHttp?.response?.responsesFlagged ?? 0).toBeGreaterThanOrEqual(1);
  });
});
