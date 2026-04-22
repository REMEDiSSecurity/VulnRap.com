import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Pin the loader to an isolated tmp file BEFORE importing the loader so the
// real shipped data/handwavy-phrases.json is never mutated by these tests.
let TMP_DIR: string;
let TMP_FILE: string;
let getHandwavyPhrases: typeof import("./handwavy-phrases").getHandwavyPhrases;
let getHandwavyPhraseHistory: typeof import("./handwavy-phrases").getHandwavyPhraseHistory;
let addHandwavyPhrase: typeof import("./handwavy-phrases").addHandwavyPhrase;
let removeHandwavyPhrase: typeof import("./handwavy-phrases").removeHandwavyPhrase;
let __resetHandwavyPhrasesForTests: typeof import("./handwavy-phrases").__resetHandwavyPhrasesForTests;
let __restoreHandwavyPhraseDefaultsForTests: typeof import("./handwavy-phrases").__restoreHandwavyPhraseDefaultsForTests;

beforeAll(async () => {
  TMP_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "handwavy-loader-"));
  TMP_FILE = path.join(TMP_DIR, "handwavy-phrases.json");
  process.env.HANDWAVY_PHRASES_PATH = TMP_FILE;
  const mod = await import("./handwavy-phrases");
  getHandwavyPhrases = mod.getHandwavyPhrases;
  getHandwavyPhraseHistory = mod.getHandwavyPhraseHistory;
  addHandwavyPhrase = mod.addHandwavyPhrase;
  removeHandwavyPhrase = mod.removeHandwavyPhrase;
  __resetHandwavyPhrasesForTests = mod.__resetHandwavyPhrasesForTests;
  __restoreHandwavyPhraseDefaultsForTests = mod.__restoreHandwavyPhraseDefaultsForTests;
});

afterAll(async () => {
  try { await fs.rm(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("handwavy-phrases loader", () => {
  beforeEach(() => {
    __restoreHandwavyPhraseDefaultsForTests();
  });

  it("loads the curated default list with category metadata", () => {
    const phrases = getHandwavyPhrases();
    expect(phrases.length).toBeGreaterThan(10);
    const buzz = phrases.find((m) => m.phrase === "modern threat landscape");
    expect(buzz?.category).toBe("buzzword");
    const absence = phrases.find((m) => m.phrase === "no runnable proof");
    expect(absence?.category).toBe("absence");
    const hedging = phrases.find((m) => m.phrase === "appears to be susceptible");
    expect(hedging?.category).toBe("hedging");
  });

  it("normalizes new phrases (lowercase + collapsed whitespace) and defaults to absence category", () => {
    const result = addHandwavyPhrase("  Reviewer-Added\nPhrase  ");
    expect(result.added).toBe(true);
    expect(result.phrase).toBe("reviewer-added phrase");
    expect(result.category).toBe("absence");
    expect(getHandwavyPhrases().map((m) => m.phrase)).toContain("reviewer-added phrase");
  });

  it("accepts an explicit category", () => {
    const result = addHandwavyPhrase("hand-wavy hedging marker", "hedging");
    expect(result.added).toBe(true);
    expect(result.category).toBe("hedging");
    const m = getHandwavyPhrases().find((x) => x.phrase === "hand-wavy hedging marker");
    expect(m?.category).toBe("hedging");
  });

  it("is idempotent on duplicate add", () => {
    addHandwavyPhrase("blast radius is total");
    const before = getHandwavyPhrases().length;
    const second = addHandwavyPhrase("blast radius IS total");
    expect(second.added).toBe(false);
    expect(getHandwavyPhrases().length).toBe(before);
  });

  it("rejects too-short phrases", () => {
    expect(() => addHandwavyPhrase("ab")).toThrow(/at least/);
  });

  it("removes user-added phrases and survives a cache reset", () => {
    addHandwavyPhrase("ephemeral marker phrase");
    expect(getHandwavyPhrases().map((m) => m.phrase)).toContain("ephemeral marker phrase");
    const removed = removeHandwavyPhrase("ephemeral marker phrase");
    expect(removed.removed).toBe(true);
    __resetHandwavyPhrasesForTests();
    expect(getHandwavyPhrases().map((m) => m.phrase)).not.toContain("ephemeral marker phrase");
  });

  it("returns removed=false when phrase is absent", () => {
    const result = removeHandwavyPhrase("never added this one");
    expect(result.removed).toBe(false);
  });

  // --- Task #112: audit trail ---

  it("records the reviewer, timestamp, and rationale on add", () => {
    const result = addHandwavyPhrase(
      "novel buzzword soup phrase",
      "buzzword",
      {
        reviewer: "alice@team.com",
        rationale: "Caught three duplicate report submissions last week.",
        now: "2026-04-22T12:00:00.000Z",
      },
    );
    expect(result.added).toBe(true);
    expect(result.marker.addedBy).toBe("alice@team.com");
    expect(result.marker.addedAt).toBe("2026-04-22T12:00:00.000Z");
    expect(result.marker.rationale).toMatch(/duplicate report submissions/);

    __resetHandwavyPhrasesForTests();
    const reloaded = getHandwavyPhrases().find((m) => m.phrase === "novel buzzword soup phrase");
    expect(reloaded?.addedBy).toBe("alice@team.com");
    expect(reloaded?.addedAt).toBe("2026-04-22T12:00:00.000Z");
    expect(reloaded?.rationale).toMatch(/duplicate report submissions/);
  });

  it("appends a history entry on remove and preserves original add metadata", () => {
    addHandwavyPhrase("temp removed phrase", "hedging", {
      reviewer: "alice@team.com",
      rationale: "noisy on internal triage drills",
      now: "2026-04-20T08:00:00.000Z",
    });
    const removed = removeHandwavyPhrase("temp removed phrase", {
      reviewer: "bob@team.com",
      now: "2026-04-22T13:00:00.000Z",
    });
    expect(removed.removed).toBe(true);
    expect(removed.historyEntry).toBeDefined();
    expect(removed.historyEntry?.removedBy).toBe("bob@team.com");
    expect(removed.historyEntry?.removedAt).toBe("2026-04-22T13:00:00.000Z");
    expect(removed.historyEntry?.addedBy).toBe("alice@team.com");
    expect(removed.historyEntry?.rationale).toMatch(/noisy on internal triage drills/);

    const history = getHandwavyPhraseHistory();
    expect(history.some((h) => h.phrase === "temp removed phrase" && h.removedBy === "bob@team.com")).toBe(true);

    __resetHandwavyPhrasesForTests();
    const reloadedHistory = getHandwavyPhraseHistory();
    expect(reloadedHistory.some((h) => h.phrase === "temp removed phrase")).toBe(true);
  });

  it("rejects too-short rationales", () => {
    expect(() =>
      addHandwavyPhrase("another safe phrase", "absence", { rationale: "ab" }),
    ).toThrow(/Rationale/);
  });

  it("caps the in-memory + on-disk history log at the bounded limit", () => {
    // Add and remove a phrase 220 times. Both the persisted file and the
    // in-memory cache should keep at most the most recent 200 entries so the
    // log never grows unboundedly across a long-running process.
    for (let i = 0; i < 220; i++) {
      addHandwavyPhrase(`bounded marker ${i}`);
      removeHandwavyPhrase(`bounded marker ${i}`);
    }
    const live = getHandwavyPhraseHistory();
    expect(live.length).toBeLessThanOrEqual(200);
    expect(live.length).toBe(200);
    // Oldest 20 entries should have been dropped.
    expect(live[0].phrase).toBe("bounded marker 20");
    expect(live[live.length - 1].phrase).toBe("bounded marker 219");
    // And the bound survives a cache reset (i.e. it was actually persisted).
    __resetHandwavyPhrasesForTests();
    const reloaded = getHandwavyPhraseHistory();
    expect(reloaded.length).toBe(200);
    expect(reloaded[0].phrase).toBe("bounded marker 20");
  });

  it("stamps addedAt automatically when no `now` override is supplied", () => {
    const before = Date.now();
    const result = addHandwavyPhrase("auto stamped phrase");
    const after = Date.now();
    expect(result.marker.addedAt).toBeDefined();
    const t = Date.parse(result.marker.addedAt!);
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(after);
  });
});
