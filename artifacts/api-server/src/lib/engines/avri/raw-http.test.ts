import { describe, it, expect } from "vitest";
import { evaluateRawHttpRequest } from "./raw-http.js";
import { runEngine2Avri } from "./engine2-avri.js";
import { FAMILIES_BY_ID } from "./families.js";
import { extractSignals } from "../extractors.js";

const SMUG = FAMILIES_BY_ID.REQUEST_SMUGGLING;

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
    const r = evaluateRawHttpRequest(fixture);
    expect(r.requestsAnalyzed).toBeGreaterThanOrEqual(2);
    expect(r.placeholderHeaders).toBe(0);
    expect(r.crlfPresent).toBe(false);
    expect(r.isFake).toBe(true);
    expect(r.reason).toMatch(/CRLF|byte-precise framing/);
  });

  it("returns 0 requests for prose with no raw HTTP bytes", () => {
    const r = evaluateRawHttpRequest("There is a smuggling bug somewhere.");
    expect(r.requestsAnalyzed).toBe(0);
    expect(r.isFake).toBe(false);
  });
});

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
