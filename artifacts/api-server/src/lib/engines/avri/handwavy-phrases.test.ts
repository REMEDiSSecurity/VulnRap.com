import os from "node:os";
import path from "node:path";
import { promises as fs, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Pin the loader to an isolated tmp file BEFORE importing the loader so the
// real shipped data/handwavy-phrases.json is never mutated by these tests.
let TMP_DIR: string;
let TMP_FILE: string;
let getHandwavyPhrases: typeof import("./handwavy-phrases").getHandwavyPhrases;
let getHandwavyPhraseHistory: typeof import("./handwavy-phrases").getHandwavyPhraseHistory;
let addHandwavyPhrase: typeof import("./handwavy-phrases").addHandwavyPhrase;
let removeHandwavyPhrase: typeof import("./handwavy-phrases").removeHandwavyPhrase;
let removeHandwavyPhrasesBatch: typeof import("./handwavy-phrases").removeHandwavyPhrasesBatch;
let reinstateHandwavyPhrase: typeof import("./handwavy-phrases").reinstateHandwavyPhrase;
let reinstateHandwavyPhrasesBatch: typeof import("./handwavy-phrases").reinstateHandwavyPhrasesBatch;
let editHandwavyPhrase: typeof import("./handwavy-phrases").editHandwavyPhrase;
let undoHandwavyPhrase: typeof import("./handwavy-phrases").undoHandwavyPhrase;
let undoHandwavyPhrasesBatch: typeof import("./handwavy-phrases").undoHandwavyPhrasesBatch;
let revertHandwavyPhraseEdit: typeof import("./handwavy-phrases").revertHandwavyPhraseEdit;
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
  removeHandwavyPhrasesBatch = mod.removeHandwavyPhrasesBatch;
  reinstateHandwavyPhrase = mod.reinstateHandwavyPhrase;
  reinstateHandwavyPhrasesBatch = mod.reinstateHandwavyPhrasesBatch;
  editHandwavyPhrase = mod.editHandwavyPhrase;
  undoHandwavyPhrase = mod.undoHandwavyPhrase;
  undoHandwavyPhrasesBatch = mod.undoHandwavyPhrasesBatch;
  revertHandwavyPhraseEdit = mod.revertHandwavyPhraseEdit;
  __resetHandwavyPhrasesForTests = mod.__resetHandwavyPhrasesForTests;
  __restoreHandwavyPhraseDefaultsForTests =
    mod.__restoreHandwavyPhraseDefaultsForTests;
});

afterAll(async () => {
  try {
    await fs.rm(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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
    const hedging = phrases.find(
      (m) => m.phrase === "appears to be susceptible",
    );
    expect(hedging?.category).toBe("hedging");
  });

  it("normalizes new phrases (lowercase + collapsed whitespace) and defaults to absence category", () => {
    const result = addHandwavyPhrase("  Reviewer-Added\nPhrase  ");
    expect(result.added).toBe(true);
    expect(result.phrase).toBe("reviewer-added phrase");
    expect(result.category).toBe("absence");
    expect(getHandwavyPhrases().map((m) => m.phrase)).toContain(
      "reviewer-added phrase",
    );
  });

  it("accepts an explicit category", () => {
    const result = addHandwavyPhrase("hand-wavy hedging marker", "hedging");
    expect(result.added).toBe(true);
    expect(result.category).toBe("hedging");
    const m = getHandwavyPhrases().find(
      (x) => x.phrase === "hand-wavy hedging marker",
    );
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
    expect(getHandwavyPhrases().map((m) => m.phrase)).toContain(
      "ephemeral marker phrase",
    );
    const removed = removeHandwavyPhrase("ephemeral marker phrase");
    expect(removed.removed).toBe(true);
    __resetHandwavyPhrasesForTests();
    expect(getHandwavyPhrases().map((m) => m.phrase)).not.toContain(
      "ephemeral marker phrase",
    );
  });

  it("returns removed=false when phrase is absent", () => {
    const result = removeHandwavyPhrase("never added this one");
    expect(result.removed).toBe(false);
  });

  // --- Task #112: audit trail ---

  it("records the reviewer, timestamp, and rationale on add", () => {
    const result = addHandwavyPhrase("novel buzzword soup phrase", "buzzword", {
      reviewer: "alice@team.com",
      rationale: "Caught three duplicate report submissions last week.",
      now: "2026-04-22T12:00:00.000Z",
    });
    expect(result.added).toBe(true);
    expect(result.marker.addedBy).toBe("alice@team.com");
    expect(result.marker.addedAt).toBe("2026-04-22T12:00:00.000Z");
    expect(result.marker.rationale).toMatch(/duplicate report submissions/);

    __resetHandwavyPhrasesForTests();
    const reloaded = getHandwavyPhrases().find(
      (m) => m.phrase === "novel buzzword soup phrase",
    );
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
    expect(removed.historyEntry?.rationale).toMatch(
      /noisy on internal triage drills/,
    );

    const history = getHandwavyPhraseHistory();
    expect(
      history.some(
        (h) =>
          h.phrase === "temp removed phrase" && h.removedBy === "bob@team.com",
      ),
    ).toBe(true);

    __resetHandwavyPhrasesForTests();
    const reloadedHistory = getHandwavyPhraseHistory();
    expect(
      reloadedHistory.some((h) => h.phrase === "temp removed phrase"),
    ).toBe(true);
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

  // --- Task #121: reinstate from history ---

  describe("reinstateHandwavyPhrase", () => {
    it("re-adds the phrase with original category and rationale, recording the current reviewer as addedBy", () => {
      addHandwavyPhrase("reinstatable phrase", "buzzword", {
        reviewer: "alice@team.com",
        rationale: "Caught it in three weekly drills.",
        now: "2026-04-10T08:00:00.000Z",
      });
      const removed = removeHandwavyPhrase("reinstatable phrase", {
        reviewer: "bob@team.com",
        now: "2026-04-15T10:00:00.000Z",
      });
      expect(removed.removed).toBe(true);

      const result = reinstateHandwavyPhrase(
        "reinstatable phrase",
        "2026-04-15T10:00:00.000Z",
        { reviewer: "carol@team.com", now: "2026-04-22T14:00:00.000Z" },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.category).toBe("buzzword");
      expect(result.marker.addedBy).toBe("carol@team.com");
      expect(result.marker.addedAt).toBe("2026-04-22T14:00:00.000Z");
      expect(result.marker.rationale).toMatch(/three weekly drills/);
      expect(result.historyEntry.reinstated).toBe(true);
      expect(result.historyEntry.reinstatedBy).toBe("carol@team.com");
      expect(result.historyEntry.reinstatedAt).toBe("2026-04-22T14:00:00.000Z");

      // Active list now contains the phrase, with the reinstator's name.
      const active = getHandwavyPhrases().find(
        (m) => m.phrase === "reinstatable phrase",
      );
      expect(active?.category).toBe("buzzword");
      expect(active?.addedBy).toBe("carol@team.com");
      expect(active?.rationale).toMatch(/three weekly drills/);

      // History row is flagged so the same row can't be reinstated twice.
      const history = getHandwavyPhraseHistory();
      const row = history.find(
        (h) =>
          h.phrase === "reinstatable phrase" &&
          h.removedAt === "2026-04-15T10:00:00.000Z",
      );
      expect(row?.reinstated).toBe(true);
      expect(row?.reinstatedBy).toBe("carol@team.com");

      // The flag survives a cache reset (i.e. it was actually persisted).
      __resetHandwavyPhrasesForTests();
      const reloaded = getHandwavyPhraseHistory();
      const reloadedRow = reloaded.find(
        (h) =>
          h.phrase === "reinstatable phrase" &&
          h.removedAt === "2026-04-15T10:00:00.000Z",
      );
      expect(reloadedRow?.reinstated).toBe(true);
    });

    it("returns history-not-found when no matching history entry exists", () => {
      const result = reinstateHandwavyPhrase(
        "never removed phrase",
        "2026-01-01T00:00:00.000Z",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("history-not-found");
      }
    });

    it("refuses to reinstate the same history row twice", () => {
      addHandwavyPhrase("double reinstate phrase", "absence", {
        now: "2026-04-10T08:00:00.000Z",
      });
      removeHandwavyPhrase("double reinstate phrase", {
        now: "2026-04-12T10:00:00.000Z",
      });
      const first = reinstateHandwavyPhrase(
        "double reinstate phrase",
        "2026-04-12T10:00:00.000Z",
        { now: "2026-04-13T11:00:00.000Z" },
      );
      expect(first.ok).toBe(true);
      // Now remove it again — that creates a NEW history row.
      removeHandwavyPhrase("double reinstate phrase", {
        now: "2026-04-14T12:00:00.000Z",
      });
      // Trying to reinstate the OLD (already-reinstated) row must fail.
      const second = reinstateHandwavyPhrase(
        "double reinstate phrase",
        "2026-04-12T10:00:00.000Z",
      );
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.reason).toBe("already-reinstated");
      }
      // But the NEW row can be reinstated independently.
      const third = reinstateHandwavyPhrase(
        "double reinstate phrase",
        "2026-04-14T12:00:00.000Z",
        { now: "2026-04-15T09:00:00.000Z" },
      );
      expect(third.ok).toBe(true);
    });

    it("refuses to reinstate when the phrase is already on the active list (manual re-add)", () => {
      addHandwavyPhrase("collision phrase", "hedging", {
        now: "2026-04-10T00:00:00.000Z",
      });
      removeHandwavyPhrase("collision phrase", {
        now: "2026-04-12T00:00:00.000Z",
      });
      // Someone manually re-adds the phrase before the reinstate fires.
      addHandwavyPhrase("collision phrase", "absence", {
        now: "2026-04-13T00:00:00.000Z",
      });
      const result = reinstateHandwavyPhrase(
        "collision phrase",
        "2026-04-12T00:00:00.000Z",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("already-active");
      }
    });
  });

  // --- Task #120: in-place edits ---

  describe("editHandwavyPhrase", () => {
    it("updates the category and records an edit entry with reviewer + before/after", () => {
      addHandwavyPhrase("editable phrase one", "absence", {
        reviewer: "alice@team.com",
        rationale: "original rationale here",
        now: "2026-04-20T08:00:00.000Z",
      });
      const result = editHandwavyPhrase(
        "editable phrase one",
        { category: "buzzword" },
        { reviewer: "bob@team.com", now: "2026-04-22T13:00:00.000Z" },
      );
      expect(result.edited).toBe(true);
      expect(result.editEntry?.editedBy).toBe("bob@team.com");
      expect(result.editEntry?.editedAt).toBe("2026-04-22T13:00:00.000Z");
      expect(result.editEntry?.category).toEqual({
        from: "absence",
        to: "buzzword",
      });
      expect(result.editEntry?.rationale).toBeUndefined();

      // Original add metadata is preserved.
      expect(result.marker.addedBy).toBe("alice@team.com");
      expect(result.marker.addedAt).toBe("2026-04-20T08:00:00.000Z");
      expect(result.marker.category).toBe("buzzword");
      expect(result.marker.rationale).toBe("original rationale here");
      expect(result.marker.edits).toHaveLength(1);

      // Survives a cache reset (i.e. it actually persisted).
      __resetHandwavyPhrasesForTests();
      const reloaded = getHandwavyPhrases().find(
        (m) => m.phrase === "editable phrase one",
      );
      expect(reloaded?.category).toBe("buzzword");
      expect(reloaded?.edits?.[0].category).toEqual({
        from: "absence",
        to: "buzzword",
      });
      expect(reloaded?.edits?.[0].editedBy).toBe("bob@team.com");
    });

    it("updates the rationale and records the before/after text", () => {
      addHandwavyPhrase("editable phrase two", "hedging", {
        rationale: "first take",
        now: "2026-04-20T08:00:00.000Z",
      });
      const result = editHandwavyPhrase(
        "editable phrase two",
        { rationale: "fixed typo and clarified" },
        { now: "2026-04-22T14:00:00.000Z" },
      );
      expect(result.edited).toBe(true);
      expect(result.editEntry?.rationale).toEqual({
        from: "first take",
        to: "fixed typo and clarified",
      });
      expect(result.editEntry?.category).toBeUndefined();
      expect(result.marker.rationale).toBe("fixed typo and clarified");
    });

    it("clears the rationale when an empty string is supplied", () => {
      addHandwavyPhrase("editable phrase three", "absence", {
        rationale: "old reason",
      });
      const result = editHandwavyPhrase("editable phrase three", {
        rationale: "",
      });
      expect(result.edited).toBe(true);
      expect(result.editEntry?.rationale).toEqual({
        from: "old reason",
        to: "",
      });
      expect(result.marker.rationale).toBeUndefined();
    });

    it("returns edited=false and writes nothing when supplied updates match the existing values", () => {
      addHandwavyPhrase("editable phrase four", "hedging", {
        rationale: "stable rationale",
      });
      const result = editHandwavyPhrase("editable phrase four", {
        category: "hedging",
        rationale: "stable rationale",
      });
      expect(result.edited).toBe(false);
      expect(result.editEntry).toBeUndefined();
      const marker = getHandwavyPhrases().find(
        (m) => m.phrase === "editable phrase four",
      );
      expect(marker?.edits ?? []).toHaveLength(0);
    });

    it("appends multiple edits chronologically", () => {
      addHandwavyPhrase("editable phrase five", "absence");
      editHandwavyPhrase(
        "editable phrase five",
        { category: "hedging" },
        { now: "2026-04-22T10:00:00.000Z" },
      );
      editHandwavyPhrase(
        "editable phrase five",
        { rationale: "added a reason later" },
        { now: "2026-04-22T11:00:00.000Z" },
      );
      const marker = getHandwavyPhrases().find(
        (m) => m.phrase === "editable phrase five",
      );
      expect(marker?.edits).toHaveLength(2);
      expect(marker?.edits?.[0].editedAt).toBe("2026-04-22T10:00:00.000Z");
      expect(marker?.edits?.[1].editedAt).toBe("2026-04-22T11:00:00.000Z");
      expect(marker?.edits?.[1].rationale?.to).toBe("added a reason later");
    });

    it("preserves the edit history on remove so reinstating still has it", () => {
      addHandwavyPhrase("editable phrase six", "absence", {
        reviewer: "alice@team.com",
      });
      editHandwavyPhrase(
        "editable phrase six",
        { category: "buzzword" },
        { reviewer: "bob@team.com" },
      );
      const removed = removeHandwavyPhrase("editable phrase six", {
        reviewer: "carol@team.com",
      });
      expect(removed.removed).toBe(true);
      expect(removed.historyEntry?.edits).toHaveLength(1);
      expect(removed.historyEntry?.edits?.[0].editedBy).toBe("bob@team.com");
    });

    it("throws when the phrase is not in the active list", () => {
      expect(() =>
        editHandwavyPhrase("phrase that was never added", {
          category: "absence",
        }),
      ).toThrow(/not found/i);
    });

    it("rejects too-short rationales on edit (mirrors add validation)", () => {
      addHandwavyPhrase("editable phrase seven");
      expect(() =>
        editHandwavyPhrase("editable phrase seven", { rationale: "ab" }),
      ).toThrow(/Rationale/);
    });

    // Task #247 — rename support on the same edit endpoint.
    it("renames the marker in place and records a phrase before/after audit entry", () => {
      addHandwavyPhrase("rename source", "hedging", {
        reviewer: "alice@team.com",
        rationale: "Original wording.",
        now: "2026-04-22T08:00:00.000Z",
      });
      const result = editHandwavyPhrase(
        "rename source",
        { newPhrase: "rename TARGET" },
        { reviewer: "bob@team.com", now: "2026-04-22T09:00:00.000Z" },
      );
      expect(result.edited).toBe(true);
      // The result should refer to the marker's NEW identity so callers
      // can keep referencing it after a rename.
      expect(result.phrase).toBe("rename target");
      expect(result.marker.phrase).toBe("rename target");
      // addedBy / addedAt / rationale are preserved across the rename.
      expect(result.marker.addedBy).toBe("alice@team.com");
      expect(result.marker.addedAt).toBe("2026-04-22T08:00:00.000Z");
      expect(result.marker.rationale).toBe("Original wording.");
      // Audit entry records the rename as a from/to pair.
      expect(result.editEntry?.phrase).toEqual({
        from: "rename source",
        to: "rename target",
      });
      // Active list reflects the new identity; old phrase is gone.
      const phrases = getHandwavyPhrases().map((m) => m.phrase);
      expect(phrases).toContain("rename target");
      expect(phrases).not.toContain("rename source");
    });

    it("treats a newPhrase that normalizes to the existing phrase as a rename no-op", () => {
      addHandwavyPhrase("noop rename phrase", "hedging");
      // A no-op rename with no other updates is a no-op overall and
      // should NOT append an audit entry.
      const result = editHandwavyPhrase("noop rename phrase", {
        newPhrase: "  Noop   Rename  Phrase  ",
      });
      expect(result.edited).toBe(false);
      const marker = getHandwavyPhrases().find(
        (m) => m.phrase === "noop rename phrase",
      );
      expect(marker?.edits ?? []).toHaveLength(0);
    });

    it("applies concurrent category edits even when the rename is a no-op", () => {
      addHandwavyPhrase("noop rename two", "hedging");
      const result = editHandwavyPhrase(
        "noop rename two",
        { newPhrase: "noop rename two", category: "buzzword" },
        { reviewer: "carol@team.com" },
      );
      expect(result.edited).toBe(true);
      // Category change recorded but no rename audit field.
      expect(result.editEntry?.category).toEqual({
        from: "hedging",
        to: "buzzword",
      });
      expect(result.editEntry?.phrase).toBeUndefined();
      expect(result.marker.phrase).toBe("noop rename two");
      expect(result.marker.category).toBe("buzzword");
    });

    it("rejects a rename whose normalized form collides with another active phrase", () => {
      addHandwavyPhrase("collision source phrase", "hedging");
      addHandwavyPhrase("collision target phrase", "buzzword");
      expect(() =>
        editHandwavyPhrase("collision source phrase", {
          newPhrase: "Collision Target Phrase",
        }),
      ).toThrow(/already uses that normalized form/i);
      // Active list is unchanged on the failed rename.
      const phrases = getHandwavyPhrases().map((m) => m.phrase);
      expect(phrases).toContain("collision source phrase");
      expect(phrases).toContain("collision target phrase");
    });

    it("rejects too-short and too-long rename targets like the add path", () => {
      addHandwavyPhrase("rename validation phrase", "hedging");
      expect(() =>
        editHandwavyPhrase("rename validation phrase", { newPhrase: "ab" }),
      ).toThrow(/Phrase must be at least 3 characters/);
      expect(() =>
        editHandwavyPhrase("rename validation phrase", {
          newPhrase: "x".repeat(201),
        }),
      ).toThrow(/Phrase must be at most 200 characters/);
    });

    it("caps the per-marker edit log at 50 entries, pruning the oldest", () => {
      addHandwavyPhrase("editable phrase eight", "absence", {
        now: "2026-04-01T00:00:00.000Z",
      });
      // Apply 60 alternating-category edits so each one is a real change.
      for (let i = 0; i < 60; i += 1) {
        const category = i % 2 === 0 ? "hedging" : "absence";
        const ts = `2026-05-${String((i % 28) + 1).padStart(2, "0")}T00:${String(i % 60).padStart(2, "0")}:00.000Z`;
        editHandwavyPhrase(
          "editable phrase eight",
          { category },
          { reviewer: `reviewer-${i}@team.com`, now: ts },
        );
      }
      const marker = getHandwavyPhrases().find(
        (m) => m.phrase === "editable phrase eight",
      );
      expect(marker?.edits).toHaveLength(50);
      // The first ten entries should have been pruned, so the oldest remaining
      // edit is the 11th one we wrote (index 10 → reviewer-10).
      expect(marker?.edits?.[0].editedBy).toBe("reviewer-10@team.com");
      expect(marker?.edits?.[49].editedBy).toBe("reviewer-59@team.com");
    });
  });

  // --- Task #130: undo a brand-new add ---

  describe("undoHandwavyPhrase", () => {
    it("removes the marker and tags the resulting history row undone:true", () => {
      addHandwavyPhrase("undo me phrase", "buzzword", {
        reviewer: "alice@team.com",
        rationale: "Initial whim, not vetted.",
        now: "2026-04-22T12:00:00.000Z",
      });
      const result = undoHandwavyPhrase(
        "undo me phrase",
        "2026-04-22T12:00:00.000Z",
        { reviewer: "alice@team.com", now: "2026-04-22T12:01:30.000Z" },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.historyEntry.undone).toBe(true);
      expect(result.historyEntry.undoneBy).toBe("alice@team.com");
      expect(result.historyEntry.removedBy).toBe("alice@team.com");
      expect(result.historyEntry.removedAt).toBe("2026-04-22T12:01:30.000Z");
      expect(result.historyEntry.addedAt).toBe("2026-04-22T12:00:00.000Z");
      expect(result.historyEntry.rationale).toMatch(/Initial whim/);

      // Phrase is gone from the active list.
      expect(
        getHandwavyPhrases().some((m) => m.phrase === "undo me phrase"),
      ).toBe(false);
      // History row is flagged AND survives a cache reset.
      __resetHandwavyPhrasesForTests();
      const reloaded = getHandwavyPhraseHistory();
      const row = reloaded.find(
        (h) =>
          h.phrase === "undo me phrase" &&
          h.removedAt === "2026-04-22T12:01:30.000Z",
      );
      expect(row?.undone).toBe(true);
      expect(row?.undoneBy).toBe("alice@team.com");
    });

    it("returns window-expired when more than UNDO_WINDOW_MS has elapsed", () => {
      addHandwavyPhrase("stale undo phrase", "absence", {
        now: "2026-04-22T12:00:00.000Z",
      });
      const result = undoHandwavyPhrase(
        "stale undo phrase",
        "2026-04-22T12:00:00.000Z",
        // 6 minutes later — outside the default 5 minute window.
        { now: "2026-04-22T12:06:00.000Z" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("window-expired");
      }
      // Active list is unchanged.
      expect(
        getHandwavyPhrases().some((m) => m.phrase === "stale undo phrase"),
      ).toBe(true);
      // No history row was added.
      expect(
        getHandwavyPhraseHistory().some(
          (h) => h.phrase === "stale undo phrase",
        ),
      ).toBe(false);
    });

    it("returns addedAt-mismatch when the addedAt does not match the live marker", () => {
      addHandwavyPhrase("mismatched undo phrase", "absence", {
        now: "2026-04-22T12:00:00.000Z",
      });
      const result = undoHandwavyPhrase(
        "mismatched undo phrase",
        "2020-01-01T00:00:00.000Z",
        { now: "2026-04-22T12:01:00.000Z" },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("addedAt-mismatch");
      }
    });

    it("returns not-found when the phrase is not on the active list", () => {
      const result = undoHandwavyPhrase(
        "never added phrase",
        "2026-04-22T12:00:00.000Z",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("not-found");
      }
    });

    it("refuses to undo a curated default (no addedAt)", () => {
      // Curated defaults seeded by __restoreHandwavyPhraseDefaultsForTests
      // have no addedAt — they were never added by a reviewer in the first
      // place, so the undo path must reject with no-addedAt.
      const curated = getHandwavyPhrases().find((m) => !m.addedAt);
      expect(curated).toBeDefined();
      if (!curated) return;
      const result = undoHandwavyPhrase(
        curated.phrase,
        "2026-04-22T12:00:00.000Z",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("no-addedAt");
      }
    });

    it("respects a custom windowMs option", () => {
      addHandwavyPhrase("custom-window undo phrase", "absence", {
        now: "2026-04-22T12:00:00.000Z",
      });
      // 30s after add, but with windowMs = 10s → expired.
      const expired = undoHandwavyPhrase(
        "custom-window undo phrase",
        "2026-04-22T12:00:00.000Z",
        { now: "2026-04-22T12:00:30.000Z", windowMs: 10_000 },
      );
      expect(expired.ok).toBe(false);
      if (!expired.ok) expect(expired.reason).toBe("window-expired");
      // 30s with windowMs = 60s → succeeds.
      const ok = undoHandwavyPhrase(
        "custom-window undo phrase",
        "2026-04-22T12:00:00.000Z",
        { now: "2026-04-22T12:00:30.000Z", windowMs: 60_000 },
      );
      expect(ok.ok).toBe(true);
    });
  });

  // --- Task #233: bulk-undo wrapper ---
  describe("undoHandwavyPhrasesBatch", () => {
    it("emits one undone:true history row per successfully-undone phrase (no batch-merge that hides per-phrase provenance)", () => {
      addHandwavyPhrase("batch-undo phrase one", "buzzword", {
        reviewer: "alice@team.com",
        now: "2026-04-22T12:00:00.000Z",
      });
      addHandwavyPhrase("batch-undo phrase two", "absence", {
        reviewer: "alice@team.com",
        now: "2026-04-22T12:00:01.000Z",
      });
      addHandwavyPhrase("batch-undo phrase three", "hedging", {
        reviewer: "alice@team.com",
        now: "2026-04-22T12:00:02.000Z",
      });

      const result = undoHandwavyPhrasesBatch(
        [
          {
            phrase: "batch-undo phrase one",
            addedAt: "2026-04-22T12:00:00.000Z",
          },
          {
            phrase: "batch-undo phrase two",
            addedAt: "2026-04-22T12:00:01.000Z",
          },
          {
            phrase: "batch-undo phrase three",
            addedAt: "2026-04-22T12:00:02.000Z",
          },
        ],
        { reviewer: "alice@team.com", now: "2026-04-22T12:01:00.000Z" },
      );

      expect(result.undone).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.results).toHaveLength(3);
      for (const entry of result.results) {
        expect(entry.undone).toBe(true);
        expect(entry.historyEntry?.undone).toBe(true);
        expect(entry.historyEntry?.undoneBy).toBe("alice@team.com");
      }

      // All three phrases are off the active list.
      const active = getHandwavyPhrases().map((m) => m.phrase);
      expect(active).not.toContain("batch-undo phrase one");
      expect(active).not.toContain("batch-undo phrase two");
      expect(active).not.toContain("batch-undo phrase three");

      // The audit log has THREE distinct undone:true rows — one per
      // phrase. The contract is explicit: no batch-merge row that
      // collapses provenance.
      const undoneRows = getHandwavyPhraseHistory().filter(
        (h) =>
          h.undone === true &&
          (h.phrase === "batch-undo phrase one" ||
            h.phrase === "batch-undo phrase two" ||
            h.phrase === "batch-undo phrase three"),
      );
      expect(undoneRows).toHaveLength(3);
      const undoneByPhrase = new Set(undoneRows.map((r) => r.phrase));
      expect(undoneByPhrase.size).toBe(3);

      // The rows survive a cache reset — they were persisted, not just
      // mutated in memory.
      __resetHandwavyPhrasesForTests();
      const reloaded = getHandwavyPhraseHistory().filter(
        (h) =>
          h.undone === true &&
          (h.phrase === "batch-undo phrase one" ||
            h.phrase === "batch-undo phrase two" ||
            h.phrase === "batch-undo phrase three"),
      );
      expect(reloaded).toHaveLength(3);
    });

    it("reports per-entry skip reasons (window-expired, addedAt-mismatch, not-found, no-addedAt) without aborting the rest", () => {
      // One in-window phrase that should succeed.
      addHandwavyPhrase("mixed-batch fresh", "absence", {
        now: "2026-04-22T12:00:00.000Z",
      });
      // One phrase whose window will be elapsed at undo time.
      addHandwavyPhrase("mixed-batch stale", "absence", {
        now: "2026-04-22T11:54:00.000Z",
      });
      // One phrase live but with a mismatched addedAt in the request.
      addHandwavyPhrase("mixed-batch mismatch", "absence", {
        now: "2026-04-22T12:00:00.000Z",
      });
      // Curated default for the no-addedAt case.
      const curated = getHandwavyPhrases().find((m) => !m.addedAt);
      expect(curated).toBeDefined();
      if (!curated) return;

      const result = undoHandwavyPhrasesBatch(
        [
          { phrase: "mixed-batch fresh", addedAt: "2026-04-22T12:00:00.000Z" },
          { phrase: "mixed-batch stale", addedAt: "2026-04-22T11:54:00.000Z" },
          {
            phrase: "mixed-batch mismatch",
            addedAt: "2020-01-01T00:00:00.000Z",
          },
          { phrase: "never-added phrase", addedAt: "2026-04-22T12:00:00.000Z" },
          { phrase: curated.phrase, addedAt: "2026-04-22T12:00:00.000Z" },
        ],
        { now: "2026-04-22T12:00:30.000Z" },
      );

      expect(result.undone).toBe(1);
      expect(result.skipped).toBe(4);
      const reasonByPhrase = new Map<string, string | undefined>();
      for (const r of result.results) reasonByPhrase.set(r.phrase, r.reason);
      expect(reasonByPhrase.get("mixed-batch fresh")).toBeUndefined();
      expect(reasonByPhrase.get("mixed-batch stale")).toBe("window-expired");
      expect(reasonByPhrase.get("mixed-batch mismatch")).toBe(
        "addedAt-mismatch",
      );
      expect(reasonByPhrase.get("never-added phrase")).toBe("not-found");
      expect(reasonByPhrase.get(curated.phrase)).toBe("no-addedAt");

      // The fresh entry IS gone from the active list; the stale and
      // mismatch entries are still there.
      const active = getHandwavyPhrases().map((m) => m.phrase);
      expect(active).not.toContain("mixed-batch fresh");
      expect(active).toContain("mixed-batch stale");
      expect(active).toContain("mixed-batch mismatch");

      // Only ONE undone:true history row was appended (for the fresh
      // entry); the failures did not pollute the audit log.
      const freshUndone = getHandwavyPhraseHistory().filter(
        (h) => h.phrase === "mixed-batch fresh" && h.undone === true,
      );
      expect(freshUndone).toHaveLength(1);
      const staleHistory = getHandwavyPhraseHistory().filter(
        (h) => h.phrase === "mixed-batch stale",
      );
      expect(staleHistory).toHaveLength(0);
    });

    it("returns total reflecting the post-batch active list size", () => {
      const baseline = getHandwavyPhrases().length;
      addHandwavyPhrase("batch-undo total a", "absence", {
        now: "2026-04-22T12:00:00.000Z",
      });
      addHandwavyPhrase("batch-undo total b", "absence", {
        now: "2026-04-22T12:00:01.000Z",
      });
      expect(getHandwavyPhrases().length).toBe(baseline + 2);

      const result = undoHandwavyPhrasesBatch(
        [
          { phrase: "batch-undo total a", addedAt: "2026-04-22T12:00:00.000Z" },
          { phrase: "batch-undo total b", addedAt: "2026-04-22T12:00:01.000Z" },
        ],
        { now: "2026-04-22T12:01:00.000Z" },
      );
      expect(result.undone).toBe(2);
      expect(result.total).toBe(baseline);
      expect(getHandwavyPhrases().length).toBe(baseline);
    });

    it("handles an empty entries list as a no-op", () => {
      const baseline = getHandwavyPhrases().length;
      const baselineHistory = getHandwavyPhraseHistory().length;
      const result = undoHandwavyPhrasesBatch([]);
      expect(result.undone).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.results).toHaveLength(0);
      expect(result.total).toBe(baseline);
      expect(getHandwavyPhraseHistory()).toHaveLength(baselineHistory);
    });
  });

  // --- Task #132: revert a single edit-history entry ---

  describe("revertHandwavyPhraseEdit", () => {
    it("restores the prior category and appends an inverse edit entry attributed to the reverter", () => {
      addHandwavyPhrase("revertable phrase one", "absence", {
        reviewer: "alice@team.com",
        rationale: "original reason",
        now: "2026-04-20T08:00:00.000Z",
      });
      const edit = editHandwavyPhrase(
        "revertable phrase one",
        { category: "buzzword" },
        { reviewer: "bob@team.com", now: "2026-04-22T13:00:00.000Z" },
      );
      expect(edit.editEntry?.editedAt).toBe("2026-04-22T13:00:00.000Z");

      const result = revertHandwavyPhraseEdit(
        "revertable phrase one",
        "2026-04-22T13:00:00.000Z",
        { reviewer: "carol@team.com", now: "2026-04-22T15:00:00.000Z" },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.edited).toBe(true);
      expect(result.marker.category).toBe("absence");
      // Original add metadata is preserved.
      expect(result.marker.addedBy).toBe("alice@team.com");
      expect(result.marker.rationale).toBe("original reason");
      // The original edit row stays in place, and the revert appears as a
      // fresh inverse entry — append-only audit log.
      expect(result.marker.edits).toHaveLength(2);
      const inverse = result.marker.edits?.[1];
      expect(inverse?.editedBy).toBe("carol@team.com");
      expect(inverse?.editedAt).toBe("2026-04-22T15:00:00.000Z");
      expect(inverse?.category).toEqual({ from: "buzzword", to: "absence" });
      expect(result.revertedEntry.editedAt).toBe("2026-04-22T13:00:00.000Z");
    });

    it("restores rationale, including reverting a 'cleared' edit back to the original text", () => {
      addHandwavyPhrase("revertable phrase two", "hedging", {
        rationale: "first take",
        now: "2026-04-20T08:00:00.000Z",
      });
      // Edit clears the rationale.
      editHandwavyPhrase(
        "revertable phrase two",
        { rationale: "" },
        { now: "2026-04-22T10:00:00.000Z" },
      );
      const after = getHandwavyPhrases().find(
        (m) => m.phrase === "revertable phrase two",
      );
      expect(after?.rationale).toBeUndefined();

      const result = revertHandwavyPhraseEdit(
        "revertable phrase two",
        "2026-04-22T10:00:00.000Z",
        { now: "2026-04-22T12:00:00.000Z" },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.edited).toBe(true);
      expect(result.marker.rationale).toBe("first take");
      expect(result.marker.edits?.[1].rationale).toEqual({
        from: "",
        to: "first take",
      });
    });

    it("only undoes the fields the entry recorded a change to (later edits to OTHER fields stick)", () => {
      addHandwavyPhrase("revertable phrase three", "absence", {
        rationale: "initial reason",
        now: "2026-04-20T08:00:00.000Z",
      });
      const e1 = editHandwavyPhrase(
        "revertable phrase three",
        { category: "hedging" },
        { now: "2026-04-21T10:00:00.000Z" },
      );
      // Subsequent unrelated rationale edit should NOT be undone by reverting e1.
      editHandwavyPhrase(
        "revertable phrase three",
        { rationale: "newer reason" },
        { now: "2026-04-22T10:00:00.000Z" },
      );
      const result = revertHandwavyPhraseEdit(
        "revertable phrase three",
        e1.editEntry!.editedAt,
        { now: "2026-04-22T15:00:00.000Z" },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.marker.category).toBe("absence");
      // The unrelated rationale change is preserved.
      expect(result.marker.rationale).toBe("newer reason");
    });

    it("returns edited=false when the current values already match the edit's before-state", () => {
      addHandwavyPhrase("revertable phrase four", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      const e1 = editHandwavyPhrase(
        "revertable phrase four",
        { category: "hedging" },
        { now: "2026-04-21T10:00:00.000Z" },
      );
      // A later edit happens to put the category back to absence.
      editHandwavyPhrase(
        "revertable phrase four",
        { category: "absence" },
        { now: "2026-04-22T10:00:00.000Z" },
      );
      // Revert e1 — nothing to undo because category is already 'absence'.
      const result = revertHandwavyPhraseEdit(
        "revertable phrase four",
        e1.editEntry!.editedAt,
        { now: "2026-04-22T15:00:00.000Z" },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.edited).toBe(false);
      // No inverse entry was appended (still just the two original edits).
      expect(result.marker.edits).toHaveLength(2);
    });

    it("returns phrase-not-found when the active list has no such phrase", () => {
      const result = revertHandwavyPhraseEdit(
        "phrase that was never added",
        "2026-04-22T13:00:00.000Z",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("phrase-not-found");
      }
    });

    it("returns edit-not-found when no edit on the marker matches editedAt", () => {
      addHandwavyPhrase("revertable phrase five", "absence");
      editHandwavyPhrase(
        "revertable phrase five",
        { category: "hedging" },
        { now: "2026-04-21T10:00:00.000Z" },
      );
      const result = revertHandwavyPhraseEdit(
        "revertable phrase five",
        "2099-01-01T00:00:00.000Z",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("edit-not-found");
      }
    });

    it("can be applied repeatedly — reverting a revert restores the original change", () => {
      addHandwavyPhrase("revertable phrase six", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      const e1 = editHandwavyPhrase(
        "revertable phrase six",
        { category: "buzzword" },
        { now: "2026-04-21T10:00:00.000Z" },
      );
      const r1 = revertHandwavyPhraseEdit(
        "revertable phrase six",
        e1.editEntry!.editedAt,
        { now: "2026-04-22T10:00:00.000Z" },
      );
      expect(r1.ok).toBe(true);
      if (!r1.ok) return;
      // The revert appended a new edit; reverting THAT one should put us
      // back to the original edit's "to" value (buzzword).
      const inverse = r1.marker.edits?.[1];
      expect(inverse?.editedAt).toBe("2026-04-22T10:00:00.000Z");
      const r2 = revertHandwavyPhraseEdit(
        "revertable phrase six",
        inverse!.editedAt,
        { now: "2026-04-22T12:00:00.000Z" },
      );
      expect(r2.ok).toBe(true);
      if (!r2.ok) return;
      expect(r2.marker.category).toBe("buzzword");
    });
  });

  // --- Task #135: batched removal ---

  describe("removeHandwavyPhrasesBatch", () => {
    it("removes every requested phrase in a single pass and writes ONE batch history entry", () => {
      addHandwavyPhrase("batch alpha", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("batch bravo", "hedging", {
        now: "2026-04-20T08:01:00.000Z",
      });
      addHandwavyPhrase("batch charlie", "buzzword", {
        rationale: "noisy across drills",
        now: "2026-04-20T08:02:00.000Z",
      });
      const before = getHandwavyPhraseHistory().length;
      const result = removeHandwavyPhrasesBatch(
        ["batch alpha", "BATCH bravo", " batch charlie "],
        { reviewer: "bob@team.com", now: "2026-04-22T13:00:00.000Z" },
      );
      expect(result.removed).toBe(3);
      expect(result.notFound).toBe(0);
      expect(result.results.every((r) => r.removed)).toBe(true);
      expect(result.historyEntry?.phrases?.map((p) => p.phrase)).toEqual([
        "batch alpha",
        "batch bravo",
        "batch charlie",
      ]);
      expect(result.historyEntry?.removedBy).toBe("bob@team.com");
      expect(result.historyEntry?.removedAt).toBe("2026-04-22T13:00:00.000Z");
      // Inner phrase metadata mirrors what the markers carried.
      const charlieInner = result.historyEntry?.phrases?.find(
        (p) => p.phrase === "batch charlie",
      );
      expect(charlieInner?.category).toBe("buzzword");
      expect(charlieInner?.rationale).toMatch(/noisy across drills/);
      // Active list no longer contains any of them.
      const live = getHandwavyPhrases().map((m) => m.phrase);
      expect(live).not.toContain("batch alpha");
      expect(live).not.toContain("batch bravo");
      expect(live).not.toContain("batch charlie");
      // History grew by exactly one entry, not three.
      const after = getHandwavyPhraseHistory();
      expect(after.length).toBe(before + 1);
      // And it survives a cache reset.
      __resetHandwavyPhrasesForTests();
      const reloaded = getHandwavyPhraseHistory();
      const reloadedBatch = reloaded.find(
        (h) => h.removedAt === "2026-04-22T13:00:00.000Z",
      );
      expect(reloadedBatch?.phrases?.length).toBe(3);
    });

    it("flags duplicates within the same batch and missing phrases without writing them to history", () => {
      addHandwavyPhrase("present in batch", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      const result = removeHandwavyPhrasesBatch(
        ["present in batch", "PRESENT in batch", "never seen"],
        { now: "2026-04-22T13:00:00.000Z" },
      );
      expect(result.removed).toBe(1);
      expect(result.notFound).toBe(1);
      expect(
        result.results.find((r) => r.raw === "PRESENT in batch")?.reason,
      ).toBe("duplicate-in-batch");
      expect(result.results.find((r) => r.raw === "never seen")?.reason).toBe(
        "not-found",
      );
      expect(result.historyEntry?.phrases?.map((p) => p.phrase)).toEqual([
        "present in batch",
      ]);
    });

    it("returns no historyEntry when nothing was removed", () => {
      const before = getHandwavyPhraseHistory().length;
      const result = removeHandwavyPhrasesBatch([
        "never added a",
        "never added b",
      ]);
      expect(result.removed).toBe(0);
      expect(result.notFound).toBe(2);
      expect(result.historyEntry).toBeUndefined();
      expect(getHandwavyPhraseHistory().length).toBe(before);
    });

    it("supports per-phrase reinstate from a batch entry, flipping the aggregate flag once all are back", () => {
      addHandwavyPhrase("batch reinstate one", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("batch reinstate two", "hedging", {
        now: "2026-04-20T08:01:00.000Z",
      });
      removeHandwavyPhrasesBatch(
        ["batch reinstate one", "batch reinstate two"],
        {
          reviewer: "bob@team.com",
          now: "2026-04-22T13:00:00.000Z",
        },
      );
      const first = reinstateHandwavyPhrase(
        "batch reinstate one",
        "2026-04-22T13:00:00.000Z",
        { reviewer: "carol@team.com", now: "2026-04-22T14:00:00.000Z" },
      );
      expect(first.ok).toBe(true);
      // Aggregate flag should NOT be true yet — one inner phrase is still down.
      const midHistory = getHandwavyPhraseHistory();
      const midRow = midHistory.find(
        (h) => h.removedAt === "2026-04-22T13:00:00.000Z",
      );
      expect(midRow?.reinstated).not.toBe(true);
      const innerOne = midRow?.phrases?.find(
        (p) => p.phrase === "batch reinstate one",
      );
      const innerTwo = midRow?.phrases?.find(
        (p) => p.phrase === "batch reinstate two",
      );
      expect(innerOne?.reinstated).toBe(true);
      expect(innerOne?.reinstatedBy).toBe("carol@team.com");
      expect(innerTwo?.reinstated).not.toBe(true);
      // Reinstate the second one — aggregate flips true.
      const second = reinstateHandwavyPhrase(
        "batch reinstate two",
        "2026-04-22T13:00:00.000Z",
        { reviewer: "carol@team.com", now: "2026-04-22T14:05:00.000Z" },
      );
      expect(second.ok).toBe(true);
      const finalHistory = getHandwavyPhraseHistory();
      const finalRow = finalHistory.find(
        (h) => h.removedAt === "2026-04-22T13:00:00.000Z",
      );
      expect(finalRow?.reinstated).toBe(true);
      expect(finalRow?.phrases?.every((p) => p.reinstated)).toBe(true);
      // Trying to reinstate one of them again must fail.
      const dupe = reinstateHandwavyPhrase(
        "batch reinstate one",
        "2026-04-22T13:00:00.000Z",
      );
      expect(dupe.ok).toBe(false);
      if (!dupe.ok) expect(dupe.reason).toBe("already-reinstated");
    });
  });

  describe("reinstateHandwavyPhrasesBatch (Task #144)", () => {
    it("reinstates every inner phrase in one call and flips the aggregate flag", () => {
      addHandwavyPhrase("batch all alpha", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("batch all bravo", "hedging", {
        rationale: "noisy",
        now: "2026-04-20T08:01:00.000Z",
      });
      addHandwavyPhrase("batch all charlie", "buzzword", {
        now: "2026-04-20T08:02:00.000Z",
      });
      removeHandwavyPhrasesBatch(
        ["batch all alpha", "batch all bravo", "batch all charlie"],
        { reviewer: "alice@team.com", now: "2026-04-22T13:00:00.000Z" },
      );
      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        reviewer: "carol@team.com",
        now: "2026-04-22T15:00:00.000Z",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reinstated).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.results.every((r) => r.reinstated)).toBe(true);
      expect(result.historyEntry.reinstated).toBe(true);
      expect(result.historyEntry.phrases?.every((p) => p.reinstated)).toBe(
        true,
      );
      expect(
        result.historyEntry.phrases?.every(
          (p) => p.reinstatedBy === "carol@team.com",
        ),
      ).toBe(true);
      const live = getHandwavyPhrases().map((m) => m.phrase);
      expect(live).toContain("batch all alpha");
      expect(live).toContain("batch all bravo");
      expect(live).toContain("batch all charlie");
      // Reviewer + rationale propagate to the new active markers.
      const bravo = getHandwavyPhrases().find(
        (m) => m.phrase === "batch all bravo",
      );
      expect(bravo?.addedBy).toBe("carol@team.com");
      expect(bravo?.rationale).toBe("noisy");
    });

    it("skips inner phrases that were already reinstated or are already active without failing", () => {
      addHandwavyPhrase("batch skip one", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("batch skip two", "absence", {
        now: "2026-04-20T08:01:00.000Z",
      });
      addHandwavyPhrase("batch skip three", "absence", {
        now: "2026-04-20T08:02:00.000Z",
      });
      removeHandwavyPhrasesBatch(
        ["batch skip one", "batch skip two", "batch skip three"],
        { now: "2026-04-22T13:00:00.000Z" },
      );
      // Reinstate one via the per-phrase path first.
      reinstateHandwavyPhrase("batch skip one", "2026-04-22T13:00:00.000Z", {
        now: "2026-04-22T13:30:00.000Z",
      });
      // Manually re-add another (bypassing the reinstate helper).
      addHandwavyPhrase("batch skip two", "absence", {
        now: "2026-04-22T13:45:00.000Z",
      });
      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        reviewer: "carol@team.com",
        now: "2026-04-22T15:00:00.000Z",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reinstated).toBe(1);
      expect(result.skipped).toBe(2);
      const byPhrase = new Map(result.results.map((r) => [r.phrase, r]));
      expect(byPhrase.get("batch skip one")?.reason).toBe("already-reinstated");
      expect(byPhrase.get("batch skip two")?.reason).toBe("already-active");
      expect(byPhrase.get("batch skip three")?.reinstated).toBe(true);
      // The "batch skip two" inner row was bypassed via a manual re-add, so
      // its inner reinstated flag was never flipped. The aggregate flag must
      // therefore stay false even though every phrase is back on the active
      // list.
      const finalRow = getHandwavyPhraseHistory().find(
        (h) => h.removedAt === "2026-04-22T13:00:00.000Z",
      );
      const innerTwo = finalRow?.phrases?.find(
        (p) => p.phrase === "batch skip two",
      );
      expect(innerTwo?.reinstated).not.toBe(true);
      expect(finalRow?.reinstated).not.toBe(true);
    });

    it("returns history-not-found when there's no matching entry", () => {
      const result = reinstateHandwavyPhrasesBatch("2099-01-01T00:00:00.000Z");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("history-not-found");
    });

    it("rejects single-phrase entries with not-a-batch", () => {
      addHandwavyPhrase("single not batch", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      removeHandwavyPhrase("single not batch", {
        now: "2026-04-22T13:00:00.000Z",
      });
      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("not-a-batch");
    });

    // Task #159 — dry-run preview returns the same shape but skips persist.
    it("dryRun: true returns the same per-phrase preview without mutating state or appending history", () => {
      addHandwavyPhrase("dryrun reinstate alpha", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("dryrun reinstate bravo", "hedging", {
        now: "2026-04-20T08:01:00.000Z",
      });
      addHandwavyPhrase("dryrun reinstate charlie", "buzzword", {
        now: "2026-04-20T08:02:00.000Z",
      });
      removeHandwavyPhrasesBatch(
        [
          "dryrun reinstate alpha",
          "dryrun reinstate bravo",
          "dryrun reinstate charlie",
        ],
        { reviewer: "alice@team.com", now: "2026-04-22T13:00:00.000Z" },
      );

      // Snapshot the active list and history BEFORE the dry-run so we can
      // prove the call did not mutate either.
      const beforeActive = getHandwavyPhrases().map((m) => m.phrase);
      const beforeHistory = JSON.parse(
        JSON.stringify(getHandwavyPhraseHistory()),
      );

      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        reviewer: "carol@team.com",
        now: "2026-04-22T15:00:00.000Z",
        dryRun: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Same shape as the mutating call.
      expect(result.reinstated).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.results.every((r) => r.reinstated)).toBe(true);
      // The projected `total` reflects "all three would be back".
      expect(result.total).toBe(beforeActive.length + 3);

      // Active list and history are UNCHANGED on disk + in cache.
      const afterActive = getHandwavyPhrases().map((m) => m.phrase);
      expect(afterActive).toEqual(beforeActive);
      expect(afterActive).not.toContain("dryrun reinstate alpha");
      expect(afterActive).not.toContain("dryrun reinstate bravo");
      expect(afterActive).not.toContain("dryrun reinstate charlie");
      expect(getHandwavyPhraseHistory()).toEqual(beforeHistory);
      const removedRow = getHandwavyPhraseHistory().find(
        (h) => h.removedAt === "2026-04-22T13:00:00.000Z",
      );
      expect(removedRow?.reinstated).not.toBe(true);
      expect(removedRow?.phrases?.every((p) => p.reinstated !== true)).toBe(
        true,
      );

      // A subsequent real call still works and produces the same per-phrase
      // outcomes the dry-run advertised.
      const real = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        reviewer: "carol@team.com",
        now: "2026-04-22T15:00:00.000Z",
      });
      expect(real.ok).toBe(true);
      if (!real.ok) return;
      expect(real.reinstated).toBe(3);
      const live = getHandwavyPhrases().map((m) => m.phrase);
      expect(live).toContain("dryrun reinstate alpha");
      expect(live).toContain("dryrun reinstate bravo");
      expect(live).toContain("dryrun reinstate charlie");
    });

    it("dryRun: true reflects partial-undo skips without persisting them", () => {
      addHandwavyPhrase("dryrun skip one", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("dryrun skip two", "absence", {
        now: "2026-04-20T08:01:00.000Z",
      });
      removeHandwavyPhrasesBatch(["dryrun skip one", "dryrun skip two"], {
        now: "2026-04-22T13:00:00.000Z",
      });
      // Reinstate one ahead of time so the dry-run sees a real skip reason.
      reinstateHandwavyPhrase("dryrun skip one", "2026-04-22T13:00:00.000Z", {
        now: "2026-04-22T13:30:00.000Z",
      });

      const beforeActive = getHandwavyPhrases().map((m) => m.phrase);
      const beforeHistory = JSON.parse(
        JSON.stringify(getHandwavyPhraseHistory()),
      );

      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        dryRun: true,
        now: "2026-04-22T15:00:00.000Z",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reinstated).toBe(1);
      expect(result.skipped).toBe(1);
      const byPhrase = new Map(result.results.map((r) => [r.phrase, r]));
      expect(byPhrase.get("dryrun skip one")?.reason).toBe(
        "already-reinstated",
      );
      expect(byPhrase.get("dryrun skip two")?.reinstated).toBe(true);

      // Active list and history are UNCHANGED.
      expect(getHandwavyPhrases().map((m) => m.phrase)).toEqual(beforeActive);
      expect(getHandwavyPhraseHistory()).toEqual(beforeHistory);
    });

    // Optional `phrases` allow-list (Task #360). Lets the client collapse
    // a partial batch reinstate into a single round-trip. A PROVIDED list
    // — including `[]` — is an explicit allow-list, so an empty array
    // reinstates nothing. Allow-list entries that don't match an inner
    // phrase surface as `not-in-batch` skip results.
    it("phrases allow-list reinstates only the matching subset and omits dropped rows from results", () => {
      addHandwavyPhrase("subset alpha", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("subset bravo", "hedging", {
        now: "2026-04-20T08:01:00.000Z",
      });
      addHandwavyPhrase("subset charlie", "buzzword", {
        now: "2026-04-20T08:02:00.000Z",
      });
      removeHandwavyPhrasesBatch(
        ["subset alpha", "subset bravo", "subset charlie"],
        { reviewer: "alice@team.com", now: "2026-04-22T13:00:00.000Z" },
      );
      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        reviewer: "carol@team.com",
        now: "2026-04-22T15:00:00.000Z",
        // Only two of the three inner phrases — `subset bravo` was the
        // row the reviewer dropped from the confirm panel.
        phrases: ["subset alpha", "subset charlie"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reinstated).toBe(2);
      expect(result.skipped).toBe(0);
      // Per-phrase results should ONLY include the two allow-listed rows;
      // the dropped `subset bravo` is silently omitted from `results`.
      expect(result.results.map((r) => r.phrase).sort()).toEqual([
        "subset alpha",
        "subset charlie",
      ]);
      expect(result.results.every((r) => r.reinstated)).toBe(true);
      // Active list got the two allow-listed phrases back; the dropped one
      // stays on the removal-history list.
      const live = getHandwavyPhrases().map((m) => m.phrase);
      expect(live).toContain("subset alpha");
      expect(live).toContain("subset charlie");
      expect(live).not.toContain("subset bravo");
      // Aggregate `reinstated` flag must stay false because one inner row
      // is still unreinstated.
      const finalRow = getHandwavyPhraseHistory().find(
        (h) => h.removedAt === "2026-04-22T13:00:00.000Z",
      );
      expect(finalRow?.reinstated).not.toBe(true);
      const innerBravo = finalRow?.phrases?.find(
        (p) => p.phrase === "subset bravo",
      );
      expect(innerBravo?.reinstated).not.toBe(true);
      const innerAlpha = finalRow?.phrases?.find(
        (p) => p.phrase === "subset alpha",
      );
      expect(innerAlpha?.reinstated).toBe(true);
    });

    it("phrases allow-list still honors per-row skip reasons (already-reinstated / already-active)", () => {
      addHandwavyPhrase("subset skip one", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("subset skip two", "absence", {
        now: "2026-04-20T08:01:00.000Z",
      });
      addHandwavyPhrase("subset skip three", "absence", {
        now: "2026-04-20T08:02:00.000Z",
      });
      removeHandwavyPhrasesBatch(
        ["subset skip one", "subset skip two", "subset skip three"],
        { now: "2026-04-22T13:00:00.000Z" },
      );
      // Reinstate one ahead of time; manually re-add another.
      reinstateHandwavyPhrase("subset skip one", "2026-04-22T13:00:00.000Z", {
        now: "2026-04-22T13:30:00.000Z",
      });
      addHandwavyPhrase("subset skip two", "absence", {
        now: "2026-04-22T13:45:00.000Z",
      });
      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        // Reviewer left every row checked; the partial state happened
        // between preview and confirm.
        phrases: ["subset skip one", "subset skip two", "subset skip three"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reinstated).toBe(1);
      expect(result.skipped).toBe(2);
      const byPhrase = new Map(result.results.map((r) => [r.phrase, r]));
      expect(byPhrase.get("subset skip one")?.reason).toBe(
        "already-reinstated",
      );
      expect(byPhrase.get("subset skip two")?.reason).toBe("already-active");
      expect(byPhrase.get("subset skip three")?.reinstated).toBe(true);
    });

    it("phrases allow-list reports unknown entries as not-in-batch and omits dropped inner rows", () => {
      addHandwavyPhrase("inbatch alpha", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("inbatch bravo", "hedging", {
        now: "2026-04-20T08:01:00.000Z",
      });
      removeHandwavyPhrasesBatch(["inbatch alpha", "inbatch bravo"], {
        now: "2026-04-22T13:00:00.000Z",
      });
      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        // `unknown phrase` is not part of this batch; `inbatch alpha`
        // is. The dropped inner row `inbatch bravo` must be omitted.
        phrases: ["inbatch alpha", "unknown phrase"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reinstated).toBe(1);
      // `unknown phrase` shows up as a not-in-batch skip result so the
      // caller can render the typo / stale entry; `inbatch bravo` is
      // omitted from results entirely.
      const byPhrase = new Map(result.results.map((r) => [r.phrase, r]));
      expect(byPhrase.get("inbatch alpha")?.reinstated).toBe(true);
      expect(byPhrase.get("unknown phrase")?.reason).toBe("not-in-batch");
      expect(byPhrase.has("inbatch bravo")).toBe(false);
      expect(result.skipped).toBe(1);
    });

    it("phrases allow-list normalizes input (whitespace + casing) before matching", () => {
      addHandwavyPhrase("normalize alpha", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("normalize bravo", "absence", {
        now: "2026-04-20T08:01:00.000Z",
      });
      removeHandwavyPhrasesBatch(["normalize alpha", "normalize bravo"], {
        now: "2026-04-22T13:00:00.000Z",
      });
      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        phrases: ["  Normalize   ALPHA  "],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reinstated).toBe(1);
      expect(result.results.map((r) => r.phrase)).toEqual(["normalize alpha"]);
    });

    it("phrases allow-list with an empty array is a no-op (does not reinstate the whole batch)", () => {
      addHandwavyPhrase("empty allowlist a", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("empty allowlist b", "absence", {
        now: "2026-04-20T08:01:00.000Z",
      });
      removeHandwavyPhrasesBatch(["empty allowlist a", "empty allowlist b"], {
        now: "2026-04-22T13:00:00.000Z",
      });
      const beforeActive = getHandwavyPhrases().map((m) => m.phrase);
      const beforeHistory = JSON.parse(
        JSON.stringify(getHandwavyPhraseHistory()),
      );

      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        phrases: [],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // An explicit empty allow-list reinstates nothing — neither inner
      // phrase comes back to the active list.
      expect(result.reinstated).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.results).toEqual([]);
      // Active list and history are unchanged on disk.
      expect(getHandwavyPhrases().map((m) => m.phrase)).toEqual(beforeActive);
      expect(getHandwavyPhraseHistory()).toEqual(beforeHistory);
    });

    it("phrases allow-list of only blank/whitespace strings is also a no-op", () => {
      addHandwavyPhrase("blank allowlist a", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("blank allowlist b", "absence", {
        now: "2026-04-20T08:01:00.000Z",
      });
      removeHandwavyPhrasesBatch(["blank allowlist a", "blank allowlist b"], {
        now: "2026-04-22T13:00:00.000Z",
      });
      const beforeActive = getHandwavyPhrases().map((m) => m.phrase);

      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        phrases: ["   ", ""],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reinstated).toBe(0);
      expect(result.results).toEqual([]);
      expect(getHandwavyPhrases().map((m) => m.phrase)).toEqual(beforeActive);
    });

    it("phrases allow-list is honored under dryRun without mutating active list or history", () => {
      addHandwavyPhrase("dry subset alpha", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("dry subset bravo", "absence", {
        now: "2026-04-20T08:01:00.000Z",
      });
      removeHandwavyPhrasesBatch(["dry subset alpha", "dry subset bravo"], {
        now: "2026-04-22T13:00:00.000Z",
      });
      const beforeActive = getHandwavyPhrases().map((m) => m.phrase);
      const beforeHistory = JSON.parse(
        JSON.stringify(getHandwavyPhraseHistory()),
      );

      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        dryRun: true,
        phrases: ["dry subset alpha"],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reinstated).toBe(1);
      expect(result.results.map((r) => r.phrase)).toEqual(["dry subset alpha"]);
      // Active list and history are unchanged.
      expect(getHandwavyPhrases().map((m) => m.phrase)).toEqual(beforeActive);
      expect(getHandwavyPhraseHistory()).toEqual(beforeHistory);
    });

    it("dryRun: true is a clean no-op when every inner phrase is already reinstated/active", () => {
      addHandwavyPhrase("dryrun noop one", "absence", {
        now: "2026-04-20T08:00:00.000Z",
      });
      addHandwavyPhrase("dryrun noop two", "absence", {
        now: "2026-04-20T08:01:00.000Z",
      });
      removeHandwavyPhrasesBatch(["dryrun noop one", "dryrun noop two"], {
        now: "2026-04-22T13:00:00.000Z",
      });
      reinstateHandwavyPhrase("dryrun noop one", "2026-04-22T13:00:00.000Z", {
        now: "2026-04-22T13:30:00.000Z",
      });
      reinstateHandwavyPhrase("dryrun noop two", "2026-04-22T13:00:00.000Z", {
        now: "2026-04-22T13:31:00.000Z",
      });
      const beforeHistory = JSON.parse(
        JSON.stringify(getHandwavyPhraseHistory()),
      );

      const result = reinstateHandwavyPhrasesBatch("2026-04-22T13:00:00.000Z", {
        dryRun: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reinstated).toBe(0);
      expect(result.skipped).toBe(2);
      expect(
        result.results.every((r) => r.reason === "already-reinstated"),
      ).toBe(true);
      // History is byte-for-byte unchanged.
      expect(getHandwavyPhraseHistory()).toEqual(beforeHistory);
    });
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

  // Task #1117 — persist() must use atomicWriteJsonFileSync so a crash
  // mid-write leaves no stale .tmp sibling and no corrupt JSON blob.
  it("leaves no .tmp siblings after writing phrases to disk", () => {
    addHandwavyPhrase("tmp-sibling-probe", { reviewer: "tester" });
    const entries = readdirSync(TMP_DIR);
    expect(entries).toEqual(["handwavy-phrases.json"]);
  });
});
