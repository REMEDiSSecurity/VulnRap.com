import { describe, it, expect } from "vitest";
import { FAMILIES_BY_ID } from "./families.js";

const SMUG = FAMILIES_BY_ID.REQUEST_SMUGGLING;

function goldSignal(id: string) {
  const sig = SMUG.goldSignals.find((g) => g.id === id);
  if (!sig) throw new Error(`unknown gold signal ${id}`);
  return sig;
}

function absencePenalty(id: string) {
  const ap = SMUG.absencePenalties.find((a) => a.id === id);
  if (!ap) throw new Error(`unknown absence penalty ${id}`);
  return ap;
}

describe("REQUEST_SMUGGLING specific_proxy_or_server gold signal", () => {
  const signal = goldSignal("specific_proxy_or_server");

  // Existing recognized products keep firing.
  for (const name of [
    "haproxy",
    "nginx",
    "envoy",
    "apache",
    "cloudflare",
    "varnish",
    "squid",
    "traefik",
    "tomcat",
    "jetty",
    "undertow",
    "h2o",
    "gunicorn",
    "uvicorn",
    "lighttpd",
  ]) {
    it(`fires on bare product name "${name}"`, () => {
      expect(
        signal.pattern.test(
          `The ${name} backend then forwards the smuggled request`,
        ),
      ).toBe(true);
    });
  }

  // Newly added open-source proxies (Task #426).
  for (const name of ["caddy", "pound", "openresty", "kong"]) {
    it(`fires on newly recognized open-source proxy "${name}"`, () => {
      expect(
        signal.pattern.test(
          `In front of the backend we run ${name} 2.7 as the reverse proxy`,
        ),
      ).toBe(true);
    });
  }

  // Versioned `<vendor>-proxy` shape — the headline use case from the
  // legit-03-request-smuggling fixture (`acme-proxy 2.4.1 - 2.6.3`).
  it("fires on `acme-proxy 2.4.1 - 2.6.3` (the legit-03 fixture string)", () => {
    expect(
      signal.pattern.test(
        "acme-proxy 2.4.1 - 2.6.3, source file `src/http/parser.rs` lines 412-455.",
      ),
    ).toBe(true);
  });

  it("fires on a minimal `<vendor>-proxy <semver>` string", () => {
    expect(signal.pattern.test("acme-proxy 2.4.1")).toBe(true);
    expect(signal.pattern.test("foo_proxy v3.2")).toBe(true);
    expect(signal.pattern.test("upstream-proxy 1.10.4")).toBe(true);
  });

  // `<name>/<semver>` shape — the canonical HTTP `Server` header form.
  it("fires on `<name>/<semver>` server-header style", () => {
    expect(signal.pattern.test("nginx/1.21.0 reverse proxy")).toBe(true);
    expect(signal.pattern.test("envoy/1.27.3 sidecar")).toBe(true);
  });

  // Guard against widening that would credit prose with no vendor or
  // file paths the slop fixtures routinely contain.
  it("does not fire on bare `proxy` mentions without a vendor", () => {
    expect(signal.pattern.test("I found a bug in the proxy")).toBe(false);
    expect(signal.pattern.test("the proxy version 1.0 is unsafe")).toBe(false);
  });

  it("does not fire on source-file paths without a name/semver shape", () => {
    expect(signal.pattern.test("lib/cookie.c at line 712 in 8.10.1")).toBe(
      false,
    );
    expect(signal.pattern.test("src/http/parser.rs lines 412-455")).toBe(false);
    expect(signal.pattern.test("tests/data/testprivkey.pem")).toBe(false);
  });
});

describe("REQUEST_SMUGGLING no_proxy_named absence penalty", () => {
  const ap = absencePenalty("no_proxy_named");

  it("matches when one of the recognized products is named", () => {
    expect(ap.pattern.test("the haproxy fleet was patched")).toBe(true);
    expect(ap.pattern.test("ran into this on caddy 2.7")).toBe(true);
    expect(ap.pattern.test("affects pound v3 in production")).toBe(true);
  });

  it("matches the relaxed versioned shapes so the gold signal isn't double-charged", () => {
    expect(ap.pattern.test("acme-proxy 2.4.1 - 2.6.3")).toBe(true);
    expect(ap.pattern.test("envoy/1.27.3 sidecar")).toBe(true);
  });

  it("does NOT match when no proxy is identified at all", () => {
    expect(
      ap.pattern.test(
        "a generic smuggling bug between the frontend and backend",
      ),
    ).toBe(false);
  });
});
