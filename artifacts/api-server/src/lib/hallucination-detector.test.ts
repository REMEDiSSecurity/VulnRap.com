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
