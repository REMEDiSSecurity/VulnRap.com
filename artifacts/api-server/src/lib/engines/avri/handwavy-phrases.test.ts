import { describe, it, expect, beforeEach } from "vitest";
import {
  getHandwavyPhrases,
  addHandwavyPhrase,
  removeHandwavyPhrase,
  __resetHandwavyPhrasesForTests,
  __restoreHandwavyPhraseDefaultsForTests,
} from "./handwavy-phrases";

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
});
