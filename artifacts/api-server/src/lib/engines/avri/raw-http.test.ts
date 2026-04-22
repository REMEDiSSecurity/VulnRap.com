import { describe, it, expect } from "vitest";
import { evaluateRawHttpRequest } from "./raw-http.js";
import { runEngine2Avri } from "./engine2-avri.js";
import { FAMILIES_BY_ID } from "./families.js";
import { extractSignals } from "../extractors.js";

const SMUG = FAMILIES_BY_ID.REQUEST_SMUGGLING;
const AUTHN = FAMILIES_BY_ID.AUTHN_AUTHZ;
const INJ = FAMILIES_BY_ID.INJECTION;

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
