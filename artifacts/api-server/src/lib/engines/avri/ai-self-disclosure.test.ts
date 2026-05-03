import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  AI_SELF_DISCLOSURE_PENALTY,
  addAiSelfDisclosurePhrase,
  detectAiSelfDisclosure,
  getAiSelfDisclosurePhrases,
  __resetAiSelfDisclosurePhrasesForTests,
  __restoreAiSelfDisclosureDefaultsForTests,
} from "./ai-self-disclosure";

// Pin the loader to a tmpdir so tests never mutate the shipped JSON
// file. The seed mirrors the curated defaults.
let tmpDir: string;
let phrasesPath: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-self-disclosure-"));
  phrasesPath = path.join(tmpDir, "ai-self-disclosure-phrases.json");
  process.env.AI_SELF_DISCLOSURE_PHRASES_PATH = phrasesPath;
  __resetAiSelfDisclosurePhrasesForTests();
  __restoreAiSelfDisclosureDefaultsForTests();
});

afterAll(async () => {
  delete process.env.AI_SELF_DISCLOSURE_PHRASES_PATH;
  __resetAiSelfDisclosurePhrasesForTests();
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  __restoreAiSelfDisclosureDefaultsForTests();
});

afterEach(() => {
  __resetAiSelfDisclosurePhrasesForTests();
});

describe("detectAiSelfDisclosure", () => {
  it("returns no match for empty / nullish input", () => {
    expect(detectAiSelfDisclosure("")).toEqual({
      detected: false,
      matches: [],
      penalty: 0,
    });
    expect(detectAiSelfDisclosure(null)).toEqual({
      detected: false,
      matches: [],
      penalty: 0,
    });
    expect(detectAiSelfDisclosure(undefined)).toEqual({
      detected: false,
      matches: [],
      penalty: 0,
    });
  });

  it("returns no match for ordinary security prose with no AI mention", () => {
    const text = `# Heap buffer overflow in libfoo
The function bar() reads past the end of the heap buffer when len > 4096.
ASan: heap-buffer-overflow READ size 8.`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(false);
    expect(r.matches).toHaveLength(0);
    expect(r.penalty).toBe(0);
  });

  // Task #300: cover ≥3 distinct phrasings, including the canonical
  // HackerOne #3295650 wording, the most common alternate form, an
  // adjective form, and a named-LLM-by-itself form. Each fires its own
  // detector id so reviewers can tell them apart in the diagnostics
  // panel.
  it("matches the canonical 'prepared using an AI security assistant' wording (HackerOne #3295650)", () => {
    const text = `... This report, including the verification steps and analysis, was prepared using an AI security assistant to ensure comprehensive and reproducible results.`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    expect(r.matches.map((m) => m.id)).toContain("prepared_using_ai");
    expect(r.penalty).toBe(AI_SELF_DISCLOSURE_PENALTY);
  });

  it("matches 'generated with the help of an AI assistant' phrasing", () => {
    const text = `Summary: This writeup was generated with the help of an AI assistant to ensure clarity.`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    expect(r.matches.map((m) => m.id)).toContain("with_ai_help");
    expect(r.penalty).toBe(AI_SELF_DISCLOSURE_PENALTY);
  });

  it("matches the 'AI-generated' / 'AI-assisted' adjective form", () => {
    const text = `This is an AI-generated security advisory based on prior CVE patterns.`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    expect(r.matches.map((m) => m.id)).toContain("ai_generated_adjective");
    expect(r.penalty).toBe(AI_SELF_DISCLOSURE_PENALTY);
  });

  it("matches a named-LLM-assisted phrasing (ChatGPT-assisted)", () => {
    const text = `Note: ChatGPT-assisted analysis. Patch verified by hand.`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    expect(r.matches.map((m) => m.id)).toContain("named_llm_assisted");
    expect(r.penalty).toBe(AI_SELF_DISCLOSURE_PENALTY);
  });

  it("matches across line breaks (whitespace is collapsed before pattern matching)", () => {
    const text = `This report
was   prepared\tusing
an AI security assistant.`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    expect(r.matches.map((m) => m.id)).toContain("prepared_using_ai");
  });

  it("is bounded: a legit report mentioning Claude drafting help gets docked exactly the fixed penalty (not multiplied)", () => {
    // Realistic scenario: a competent reporter who used Claude to draft
    // their summary but provides a full PoC, ASan trace, and patch. The
    // detector should fire once at the bounded penalty so it doesn't
    // crater an otherwise well-evidenced report.
    const text = `# Use-after-free in libfoo cookie parser
Note: I used Claude to draft this summary; full PoC and patch below.

## Reproducer
\`\`\`
printf 'GET / HTTP/1.1\\r\\nCookie: x=\\r\\n\\r\\n' | nc -l 8080 &
./foo http://127.0.0.1:8080/
\`\`\`

ASan trace:
==4711==ERROR: AddressSanitizer: heap-use-after-free READ of size 4
    #0 cookie_get cookie.c:712`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    // Bounded: exactly the fixed penalty, never compounded.
    expect(r.penalty).toBe(AI_SELF_DISCLOSURE_PENALTY);
    // The "I used Claude to draft" wording fires the generated_with_ai
    // detector. Whatever subset of detectors trips, the penalty is the
    // same fixed amount — that's the boundedness guarantee.
    expect(r.matches.length).toBeGreaterThanOrEqual(1);
  });

  it("is bounded across multiple matches: 6 phrasings still yield the same penalty as 1", () => {
    // Hammer the detector with text that fires every pattern at once.
    // The penalty must remain exactly AI_SELF_DISCLOSURE_PENALTY — the
    // detector is explicitly NOT additive across phrases so a slop
    // author can't be punished disproportionately for boilerplate.
    const text = `This report was prepared using an AI security assistant.
The findings were generated by ChatGPT and reviewed with the help of an LLM.
The whole writeup is AI-generated. ChatGPT-assisted summary follows.
This analysis was prepared by an AI tool.`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    expect(r.matches.length).toBeGreaterThanOrEqual(3);
    expect(r.penalty).toBe(AI_SELF_DISCLOSURE_PENALTY);
  });

  it("deduplicates matches by detector id (one entry per pattern even if it appears multiple times)", () => {
    const text = `This is AI-generated.
Another AI-written paragraph here.
Also AI-assisted overall.`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    const ids = r.matches.map((m) => m.id);
    const uniqueIds = new Set(ids);
    expect(ids.length).toBe(uniqueIds.size);
    expect(uniqueIds.has("ai_generated_adjective")).toBe(true);
  });

  it("captures an excerpt of the matched phrase for the diagnostics panel", () => {
    const text = `Note: this report was prepared using an AI security assistant to ensure comprehensive coverage.`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    const m = r.matches.find((x) => x.id === "prepared_using_ai");
    expect(m).toBeDefined();
    expect(m!.excerpt).toContain("prepared using an ai");
    expect(m!.excerpt.length).toBeLessThanOrEqual(160);
  });
});

// Task #429 — phrase list now lives in JSON and is reviewer-extensible at
// runtime. These tests exercise the loader + addAiSelfDisclosurePhrase so a
// regression in the on-disk format or the bounded-penalty contract surfaces
// here instead of at runtime.
describe("addAiSelfDisclosurePhrase + JSON loader", () => {
  it("loads the curated defaults when the file is empty/missing", () => {
    const phrases = getAiSelfDisclosurePhrases();
    const ids = phrases.map((p) => p.id).sort();
    // The 7 curated defaults must all be present so an unconfigured
    // deployment still detects the canonical phrasings.
    expect(ids).toEqual([
      "ai_generated_adjective",
      "generated_with_ai",
      "named_llm_assisted",
      "prepared_using_ai",
      "this_report_ai",
      "used_llm_to_draft",
      "with_ai_help",
    ]);
  });

  it("falls back to defaults when the JSON file is corrupt", async () => {
    await fs.writeFile(phrasesPath, "{ this is not json", "utf8");
    __resetAiSelfDisclosurePhrasesForTests();
    const phrases = getAiSelfDisclosurePhrases();
    expect(phrases.length).toBeGreaterThanOrEqual(7);
    // Detector still works.
    const r = detectAiSelfDisclosure("This is AI-generated content.");
    expect(r.detected).toBe(true);
  });

  it("appends a new pattern that the detector starts firing on the next call", () => {
    const text =
      "This report was generated by Mistral-7B via internal tooling.";
    // Mistral isn't in the default LLM alternation, so the canonical
    // detectors miss it.
    expect(detectAiSelfDisclosure(text).detected).toBe(false);
    const result = addAiSelfDisclosurePhrase(
      "mistral_generated",
      "\\bgenerated\\s+by\\s+mistral",
      undefined,
      {
        reviewer: "reviewer@example.com",
        rationale: "Spotted in 4 recent slop reports.",
      },
    );
    expect(result.added).toBe(true);
    expect(result.phrase.id).toBe("mistral_generated");
    expect(result.phrase.addedBy).toBe("reviewer@example.com");
    expect(result.phrase.addedAt).toBeDefined();
    // Detector picks up the newly-added pattern on the very next call.
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    expect(r.matches.map((m) => m.id)).toContain("mistral_generated");
    expect(r.penalty).toBe(AI_SELF_DISCLOSURE_PENALTY);
  });

  it("is idempotent on id: re-adding the same id returns added=false and leaves the file untouched", () => {
    const first = addAiSelfDisclosurePhrase(
      "dup_pattern",
      "\\bfoobar\\b",
      undefined,
      {},
    );
    expect(first.added).toBe(true);
    const before = getAiSelfDisclosurePhrases();
    const second = addAiSelfDisclosurePhrase(
      "dup_pattern",
      "\\bsomething-else\\b",
      undefined,
      {},
    );
    expect(second.added).toBe(false);
    // Active list is unchanged (original pattern wins on duplicate id).
    const after = getAiSelfDisclosurePhrases();
    expect(after).toEqual(before);
    const dup = after.find((p) => p.id === "dup_pattern");
    expect(dup?.pattern).toBe("\\bfoobar\\b");
  });

  it("rejects malformed input with field-prefixed errors", () => {
    expect(() =>
      addAiSelfDisclosurePhrase("", "\\bfoo\\b", undefined, {}),
    ).toThrow(/^id /);
    expect(() =>
      addAiSelfDisclosurePhrase(
        "bad id with spaces",
        "\\bfoo\\b",
        undefined,
        {},
      ),
    ).toThrow(/^id /);
    expect(() => addAiSelfDisclosurePhrase("ok_id", "", undefined, {})).toThrow(
      /^pattern /,
    );
    expect(() =>
      addAiSelfDisclosurePhrase("ok_id", "x".repeat(501), undefined, {}),
    ).toThrow(/^pattern /);
    expect(() =>
      addAiSelfDisclosurePhrase("ok_id", "(unbalanced", undefined, {}),
    ).toThrow(/^pattern /);
    expect(() =>
      addAiSelfDisclosurePhrase("ok_id", "\\bfoo\\b", "Z", {}),
    ).toThrow(/^flags /);
    expect(() =>
      addAiSelfDisclosurePhrase("ok_id", "\\bfoo\\b", undefined, {
        rationale: "ab",
      }),
    ).toThrow(/^rationale /);
  });

  it("preserves the bounded-penalty contract after adding extra phrases (Task #429)", () => {
    // Append three extra patterns. Even with 10 patterns total, a report
    // hitting all of them must still get docked exactly once.
    addAiSelfDisclosurePhrase(
      "extra_one",
      "\\bfirst-extra-marker\\b",
      undefined,
      {},
    );
    addAiSelfDisclosurePhrase(
      "extra_two",
      "\\bsecond-extra-marker\\b",
      undefined,
      {},
    );
    addAiSelfDisclosurePhrase(
      "extra_three",
      "\\bthird-extra-marker\\b",
      undefined,
      {},
    );
    const text = `This report was prepared using an AI security assistant.
This is AI-generated. Also ChatGPT-assisted.
first-extra-marker second-extra-marker third-extra-marker.`;
    const r = detectAiSelfDisclosure(text);
    expect(r.detected).toBe(true);
    // Should fire many patterns simultaneously.
    expect(r.matches.length).toBeGreaterThanOrEqual(5);
    // Bounded: still exactly the fixed penalty.
    expect(r.penalty).toBe(AI_SELF_DISCLOSURE_PENALTY);
  });

  it("ignores entries with malformed regex on disk so one bad row can't disable the detector", async () => {
    const fileBody = {
      _meta: { description: "test fixture" },
      phrases: [
        { id: "good_one", pattern: "\\bgood-marker\\b", flags: "i" },
        { id: "bad_one", pattern: "(unclosed", flags: "i" },
        { id: "another_good", pattern: "\\banother-marker\\b" },
      ],
    };
    await fs.writeFile(phrasesPath, JSON.stringify(fileBody, null, 2), "utf8");
    __resetAiSelfDisclosurePhrasesForTests();
    const phrases = getAiSelfDisclosurePhrases();
    const ids = phrases.map((p) => p.id);
    expect(ids).toEqual(["good_one", "another_good"]);
    expect(detectAiSelfDisclosure("hit good-marker here").detected).toBe(true);
    expect(detectAiSelfDisclosure("hit another-marker here").detected).toBe(
      true,
    );
  });
});
