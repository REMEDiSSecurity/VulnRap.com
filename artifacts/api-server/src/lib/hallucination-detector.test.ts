// Task #192 — regression tests for the tightened `incomplete_asan` and
// `fabricated_pid` rules.
//
// Before v3.8.0:
//   - `incomplete_asan` (weight 12) fired on any report that mentioned
//     "AddressSanitizer" without a trailing `SUMMARY: AddressSanitizer ...`
//     line, even when the excerpt clearly came from a real ASan dump.
//   - `fabricated_pid` (weight 6) fired on any report whose first `==N==`
//     PID was the textbook `12345` (or 11111/99999/10000/54321) — used
//     widely as a placeholder by legitimate reports.
//
// After v3.8.0 both rules require a real fabrication context. These tests
// pin the new behavior using the canonical legit and fabricated fixtures
// the task description calls out.

import { describe, it, expect } from "vitest";
import { detectHallucinationSignals } from "./hallucination-detector";
import { TEST_FIXTURE_COHORTS } from "../routes/test-fixtures";

const findFixture = (id: string) => {
  const all = [
    ...TEST_FIXTURE_COHORTS.T1,
    ...TEST_FIXTURE_COHORTS.T2,
    ...TEST_FIXTURE_COHORTS.T3,
    ...TEST_FIXTURE_COHORTS.T4,
  ];
  const f = all.find((x) => x.id === id);
  if (!f) throw new Error(`fixture ${id} not found`);
  return f;
};

describe("Task #192: tightened incomplete_asan + fabricated_pid", () => {
  describe("legit fixtures should accumulate near-zero hallucination weight", () => {
    for (const id of [
      "T1-01-uaf-libfoo",
      "T1-AVRI-firefox-uaf",
      "T1-AVRI-cve-2025-0725-curl",
    ]) {
      it(`${id} fires neither incomplete_asan nor fabricated_pid`, () => {
        const r = detectHallucinationSignals(findFixture(id).text);
        const types = r.signals.map((s) => s.type);
        expect(types).not.toContain("incomplete_asan");
        expect(types).not.toContain("fabricated_pid");
        // The composite penalty starts at totalWeight=12. These legit
        // fixtures must stay well clear of that floor.
        expect(r.totalWeight).toBeLessThan(12);
      });
    }
  });

  describe("T4 fabrication fixtures still fire fabricated_pid as before", () => {
    // Each of these fixtures pairs a magic PID in `==N==` form with at
    // least one PRIMARY fabrication signal (round addresses, repeated
    // stack frames, or a phantom exploit script), so the new rule must
    // still flag the PID. Fixtures whose magic PID appeared only in plain
    // text (e.g. T4-08 "PID 12345 reproduces …") were never matched by
    // the `==N==` regex and are intentionally excluded.
    for (const id of [
      "T4-01-fake-cve-fake-fn",
      "T4-07-fake-pid-fake-fn",
      "T4-09-ai-tool-curl-uaf",
    ]) {
      it(`${id} still fires fabricated_pid`, () => {
        const r = detectHallucinationSignals(findFixture(id).text);
        expect(r.signals.map((s) => s.type)).toContain("fabricated_pid");
      });
    }
  });

  describe("incomplete_asan suppression on real ASan-context excerpts", () => {
    it("suppresses on the `==N==ERROR: AddressSanitizer:` header alone", () => {
      const text = `Repro:
==4711==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x611000009f80`;
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).not.toContain("incomplete_asan");
    });

    it("suppresses on a resolved file:line stack frame", () => {
      const text = `AddressSanitizer reported a UAF.
    #0 0x55e9b8c2f3d1 in foo_finalize parser/parse.c:418`;
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).not.toContain("incomplete_asan");
    });

    it("suppresses on the freed-by trailer", () => {
      const text = `AddressSanitizer detected heap-use-after-free.
freed by thread T0 here:`;
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).not.toContain("incomplete_asan");
    });

    it("still fires when AddressSanitizer is mentioned with no context (genuinely fabricated)", () => {
      const text = `The bug crashes under AddressSanitizer with a heap overflow. PoC available on request.`;
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).toContain("incomplete_asan");
    });
  });

  describe("fabricated_pid stricter pattern", () => {
    it("does NOT fire on a single magic PID with no other fabrication signals", () => {
      const text = `==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x611000009f80
    #0 0x55c1aa in inflate_stream lib/content_encoding.c:297`;
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).not.toContain("fabricated_pid");
    });

    it("fires when 2+ distinct magic PIDs appear", () => {
      const text = `==12345==first dump
==54321==second dump`;
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).toContain("fabricated_pid");
    });

    it("fires when a magic PID is paired with a phantom exploit script", () => {
      const text = `==12345==something happened. PoC is in exploit.py (private).`;
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).toContain("fabricated_pid");
    });

    it("fires when a magic PID is paired with phantom_functions (no code blocks)", () => {
      // Three or more `name_with_underscores(` calls with NO code blocks
      // → phantom_functions fires; the magic PID must then corroborate.
      // This pins the contract that PID detection is order-aware and runs
      // AFTER phantom_functions has been added to the signals list.
      const text = `==54321==ERROR: heap corruption observed.
The bug originates in fake_helper_one() and is amplified by
fake_helper_two() before being finalized in fake_helper_three().`;
      const r = detectHallucinationSignals(text);
      const types = r.signals.map((s) => s.type);
      expect(types).toContain("phantom_functions");
      expect(types).toContain("fabricated_pid");
    });
  });
});

describe("Task #206 (Sprint 13B-1): tightened round-address detector", () => {
  // Sprint 12 Report 82 used `0x000060400000`, which slipped past the
  // v3.6.0 detector for two reasons:
  //   1. The round-trailing-zero threshold was ≥5; this address has only
  //      4 trailing hex zeros, so it didn't classify as round.
  //   2. The KNOWN_ALLOCATOR_ADDRESSES allowlist contained `0x60200000`
  //      (one hex digit away), nudging reviewers toward "well, allocator
  //      bases sometimes look like that, must be real".
  // Sprint 13B-1 lowers the trailing-zero threshold to ≥3 and empties
  // the allowlist entirely. These tests pin the new behavior.

  it("flags 0x000060400000 (Sprint 12 Report 82) as a round address", () => {
    // Five distinct round-looking addresses, no real-crash anchors → the
    // detector should fire `fabricated_addresses`.
    const text = `Reviewer notes: the report cites these addresses as the
heap regions involved in the alleged corruption:
  0x000060400000 — claimed allocator base
  0x000060500000 — claimed adjacent chunk
  0x000060600000 — claimed third chunk
  0x000060700000 — claimed fourth chunk
  0x000060800000 — claimed fifth chunk
No SUMMARY line, no shadow bytes, no resolved frames.`;
    const r = detectHallucinationSignals(text);
    expect(r.signals.map((s) => s.type)).toContain("fabricated_addresses");
  });

  it("flags 12-digit addresses with exactly 3 trailing zeros", () => {
    // Threshold is ≥3, so an address ending in `...000` is the boundary
    // case that previously slipped through under the ≥5 rule.
    const text = `Suspicious bases: 0x7f1234567000 and 0x7f1234568000 and
0x7f1234569000 and 0x7f123456a000.`;
    const r = detectHallucinationSignals(text);
    expect(r.signals.map((s) => s.type)).toContain("fabricated_addresses");
  });

  it("does NOT exempt a previously-allowlisted base like 0x60200000", () => {
    // Even an address that exactly matches a former allowlist entry must
    // now be evaluated by the trailing-zero rule. `0x60200000` has 5
    // trailing zeros, so it counts as round.
    const text = `Bases: 0x60200000, 0x60300000, 0x60400000, 0x60500000.`;
    const r = detectHallucinationSignals(text);
    expect(r.signals.map((s) => s.type)).toContain("fabricated_addresses");
  });

  it("still spares legit ASan dumps via the structural-anchor guard", () => {
    // A legit dump with a `SUMMARY: AddressSanitizer` line trips
    // `hasRealCrashIndicators` regardless of how round any quoted base
    // looks, so the round-address rule must NOT fire.
    const text = `==12345==ERROR: AddressSanitizer: heap-buffer-overflow on address 0x000060400000
READ of size 4 at 0x000060400000 thread T0
    #0 0x55c1aa11 in foo_parse src/parse.c:120
    #1 0x55c1aa22 in main src/main.c:42
SUMMARY: AddressSanitizer: heap-buffer-overflow src/parse.c:120 in foo_parse`;
    const r = detectHallucinationSignals(text);
    expect(r.signals.map((s) => s.type)).not.toContain("fabricated_addresses");
  });

  it("still spares legit non-round addresses (T1-AVRI-cve-2025-0725-curl)", () => {
    // Pin the cohort guarantee: tightening the threshold from ≥5 to ≥3
    // must not regress the canonical legit fixture.
    const r = detectHallucinationSignals(
      findFixture("T1-AVRI-cve-2025-0725-curl").text,
    );
    expect(r.signals.map((s) => s.type)).not.toContain("fabricated_addresses");
  });
});

describe("Task #304: impossible_http_response signal", () => {
  // Helper: assert the signal fires with at least the expected number of
  // markers. Each test exercises one predicate in isolation so a future
  // regression points directly at the broken predicate.
  const expectFires = (text: string, minMarkers = 1) => {
    const r = detectHallucinationSignals(text);
    const sig = r.signals.find((s) => s.type === "impossible_http_response");
    expect(sig, "impossible_http_response signal should fire").toBeDefined();
    // Description format: "... — marker_a, marker_b, ..."
    const markersInDesc = sig!.description.split("—")[1]?.split(",").length ?? 0;
    expect(markersInDesc).toBeGreaterThanOrEqual(minMarkers);
    expect(sig!.weight).toBeGreaterThanOrEqual(minMarkers * 8);
    return sig!;
  };

  describe("predicate 1: reason-phrase mismatch", () => {
    it("flags '200 Not Found'", () => {
      const text = [
        "Server confirmed the bypass:",
        "```http",
        "HTTP/1.1 200 Not Found",
        "Content-Type: application/json",
        "",
        '{"admin":true}',
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("flags '404 OK'", () => {
      const text = [
        "```http",
        "HTTP/1.1 404 OK",
        "Content-Type: text/plain",
        "",
        "ok",
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("does not flag the canonical reason phrase", () => {
      const text = [
        "```http",
        "HTTP/1.1 200 OK",
        "Content-Type: text/plain",
        "Content-Length: 5",
        "",
        "hello",
        "```",
      ].join("\n");
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).not.toContain("impossible_http_response");
    });

    it("accepts both 'Found' and 'Moved Temporarily' for 302", () => {
      for (const phrase of ["Found", "Moved Temporarily"]) {
        const text = [
          "```http",
          `HTTP/1.1 302 ${phrase}`,
          "Location: /next",
          "",
          "```",
        ].join("\n");
        const r = detectHallucinationSignals(text);
        expect(r.signals.map((s) => s.type)).not.toContain("impossible_http_response");
      }
    });
  });

  describe("predicate 2: no-body status with body", () => {
    it("flags 204 followed by a body", () => {
      const text = [
        "```http",
        "HTTP/1.1 204 No Content",
        "Content-Type: application/json",
        "",
        '{"leak":"all rows"}',
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("flags 304 followed by a body", () => {
      const text = [
        "```http",
        "HTTP/1.1 304 Not Modified",
        "ETag: \"abc\"",
        "",
        "<html>cached payload returned anyway</html>",
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("flags 1xx followed by a body", () => {
      const text = [
        "```http",
        "HTTP/1.1 100 Continue",
        "",
        "{\"premature_payload\":\"yes\"}",
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("does NOT flag 204 with an empty body (the legit shape)", () => {
      const text = [
        "```http",
        "HTTP/1.1 204 No Content",
        "Server: nginx",
        "",
        "```",
      ].join("\n");
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).not.toContain("impossible_http_response");
    });
  });

  describe("predicate 3: Content-Length disagreement", () => {
    it("flags Content-Length: 0 with body present", () => {
      const text = [
        "```http",
        "HTTP/1.1 200 OK",
        "Content-Type: application/json",
        "Content-Length: 0",
        "",
        '{"injection_succeeded":true,"rows":50000}',
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("flags large declared length with empty body", () => {
      const text = [
        "```http",
        "HTTP/1.1 200 OK",
        "Content-Type: text/html",
        "Content-Length: 2048",
        "",
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("does NOT flag a body whose length matches Content-Length", () => {
      // "hello world" is 11 bytes — well under the >50 absolute floor
      // and within 50% of the declared 11.
      const text = [
        "```http",
        "HTTP/1.1 200 OK",
        "Content-Type: text/plain",
        "Content-Length: 11",
        "",
        "hello world",
        "```",
      ].join("\n");
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).not.toContain("impossible_http_response");
    });
  });

  describe("predicate 4: header in wrong direction", () => {
    it("flags a response carrying a Cookie header", () => {
      const text = [
        "```http",
        "HTTP/1.1 200 OK",
        "Cookie: sid=abc123",
        "",
        "{}",
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("flags a request carrying a Set-Cookie header", () => {
      const text = [
        "```http",
        "POST /login HTTP/1.1",
        "Host: target.test",
        "Set-Cookie: stolen=yes",
        "",
        "user=admin",
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("flags a response carrying a Referer header", () => {
      const text = [
        "```http",
        "HTTP/1.1 200 OK",
        "Referer: https://attacker.example",
        "",
        "{}",
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("does NOT flag Server / Host (permitted in either direction enough to skip)", () => {
      // Host on a response is unusual but not impossible (some buggy
      // proxies emit it). Server on a request is unusual but allowed.
      // Both must stay out of the impossibility list to avoid FPs on
      // odd-but-real captures.
      const text = [
        "```http",
        "HTTP/1.1 200 OK",
        "Host: api.target.test",
        "Server: nginx/1.21",
        "",
        "ok",
        "```",
      ].join("\n");
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).not.toContain("impossible_http_response");
    });
  });

  describe("predicate 5: HEAD/CONNECT response with body", () => {
    it("flags a HEAD request followed by a response with a body", () => {
      const text = [
        "```http",
        "HEAD /admin HTTP/1.1",
        "Host: app.test",
        "",
        "HTTP/1.1 200 OK",
        "Content-Type: text/html",
        "",
        "<html>full admin panel returned for HEAD</html>",
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("flags a CONNECT request followed by a response with a body", () => {
      const text = [
        "```http",
        "CONNECT proxy.target.test:443 HTTP/1.1",
        "Host: proxy.target.test:443",
        "",
        "HTTP/1.1 200 OK",
        "Content-Type: text/plain",
        "",
        "tunnel established and here's the secret payload too",
        "```",
      ].join("\n");
      expectFires(text);
    });

    it("does NOT flag a HEAD request followed by a 200 with no body", () => {
      // Mirrors the T2-03 fixture shape — HEAD + headers-only response.
      const text = [
        "```http",
        "HEAD /file HTTP/1.1",
        "Host: app.test",
        "",
        "HTTP/1.1 200 OK",
        "Server: nginx",
        "X-Powered-By: Express",
        "",
        "```",
      ].join("\n");
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).not.toContain("impossible_http_response");
    });
  });

  describe("scoping: only fenced code blocks are inspected", () => {
    it("ignores HTTP-shaped prose outside any fence", () => {
      // Even a clear "200 Not Found" in narrative prose must not
      // trigger the signal — narrative summaries of HTTP behaviour
      // are common in real reports.
      const text = [
        "The server returned HTTP/1.1 200 Not Found",
        "with a Set-Cookie request header. We confirmed via curl.",
      ].join("\n");
      const r = detectHallucinationSignals(text);
      expect(r.signals.map((s) => s.type)).not.toContain("impossible_http_response");
    });

    it("composes when a single fence carries multiple impossibilities", () => {
      // Two markers → weight ≥ 16, which on its own clears the
      // moderate-tier composite-override floor (totalWeight ≥ 12).
      const text = [
        "```http",
        "HTTP/1.1 204 Not Found",
        "Content-Length: 0",
        "Cookie: sid=stolen",
        "",
        '{"impossible":"in every direction"}',
        "```",
      ].join("\n");
      const sig = expectFires(text, 2);
      expect(sig.weight).toBeGreaterThanOrEqual(16);
    });
  });

  describe("legit-cohort silence guard", () => {
    // The canonical legit/curl/HackerOne fixtures must remain at
    // zero impossible_http_response weight. T1-01 has a Content-
    // Length: 32 line outside any fence; T2-03 has a fenced HEAD +
    // 200 OK with no body. Neither should ever fire this signal.
    for (const id of [
      "T1-01-uaf-libfoo",
      "T1-AVRI-firefox-uaf",
      "T1-AVRI-cve-2025-0725-curl",
      "T2-03-info-disclosure-headers",
    ]) {
      it(`${id} does not fire impossible_http_response`, () => {
        const r = detectHallucinationSignals(findFixture(id).text);
        expect(r.signals.map((s) => s.type)).not.toContain(
          "impossible_http_response",
        );
      });
    }
  });
});
