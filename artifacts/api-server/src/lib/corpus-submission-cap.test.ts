import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  checkCorpusCap,
  recordCorpusSubmission,
  releaseCorpusSubmission,
  __resetCorpusCapForTests,
} from "./corpus-submission-cap";

beforeEach(() => {
  __resetCorpusCapForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("corpus-submission-cap", () => {
  it("allows submissions under the default cap", () => {
    const hash = "test-visitor-hash-abc";
    for (let i = 0; i < 19; i++) {
      const r = recordCorpusSubmission(hash);
      expect(r.allowed).toBe(true);
      expect(r.submissionCount).toBe(i + 1);
    }
  });

  it("blocks submissions at the default cap (20)", () => {
    const hash = "test-visitor-hash-def";
    for (let i = 0; i < 20; i++) {
      recordCorpusSubmission(hash);
    }
    const r = recordCorpusSubmission(hash);
    expect(r.allowed).toBe(false);
    expect(r.submissionCount).toBe(20);
    expect(r.remaining).toBe(0);
  });

  it("respects CORPUS_SUBMISSION_CAP env var", () => {
    vi.stubEnv("CORPUS_SUBMISSION_CAP", "3");
    const hash = "test-visitor-env";
    for (let i = 0; i < 3; i++) {
      const r = recordCorpusSubmission(hash);
      expect(r.allowed).toBe(true);
    }
    const r = recordCorpusSubmission(hash);
    expect(r.allowed).toBe(false);
    expect(r.cap).toBe(3);
  });

  it("allows unlimited submissions for null visitor hash", () => {
    for (let i = 0; i < 50; i++) {
      const r = recordCorpusSubmission(null);
      expect(r.allowed).toBe(true);
    }
  });

  it("tracks different visitors independently", () => {
    vi.stubEnv("CORPUS_SUBMISSION_CAP", "2");
    recordCorpusSubmission("visitor-a");
    recordCorpusSubmission("visitor-a");

    const rA = recordCorpusSubmission("visitor-a");
    expect(rA.allowed).toBe(false);

    const rB = recordCorpusSubmission("visitor-b");
    expect(rB.allowed).toBe(true);
  });

  it("releaseCorpusSubmission frees a reserved slot", () => {
    vi.stubEnv("CORPUS_SUBMISSION_CAP", "2");
    const hash = "release-test";
    const r1 = recordCorpusSubmission(hash);
    expect(r1.allowed).toBe(true);
    expect(r1.reservedAt).not.toBeNull();

    const r2 = recordCorpusSubmission(hash);
    expect(r2.allowed).toBe(true);

    const r3 = recordCorpusSubmission(hash);
    expect(r3.allowed).toBe(false);

    releaseCorpusSubmission(hash, r1.reservedAt!);

    const r4 = recordCorpusSubmission(hash);
    expect(r4.allowed).toBe(true);
    expect(r4.submissionCount).toBe(2);
  });

  it("concurrent reservations are atomic (no TOCTOU)", () => {
    vi.stubEnv("CORPUS_SUBMISSION_CAP", "3");
    const hash = "concurrent-test";
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(recordCorpusSubmission(hash));
    }
    const allowed = results.filter((r) => r.allowed);
    const blocked = results.filter((r) => !r.allowed);
    expect(allowed).toHaveLength(3);
    expect(blocked).toHaveLength(2);
  });

  it("checkCorpusCap does not increment the counter", () => {
    vi.stubEnv("CORPUS_SUBMISSION_CAP", "2");
    const hash = "check-only";
    recordCorpusSubmission(hash);

    const peek = checkCorpusCap(hash);
    expect(peek.allowed).toBe(true);
    expect(peek.submissionCount).toBe(1);
    expect(peek.remaining).toBe(1);

    const peek2 = checkCorpusCap(hash);
    expect(peek2.submissionCount).toBe(1);
  });
});
