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
let reinstateHandwavyPhrase: typeof import("./handwavy-phrases").reinstateHandwavyPhrase;
let editHandwavyPhrase: typeof import("./handwavy-phrases").editHandwavyPhrase;
let undoHandwavyPhrase: typeof import("./handwavy-phrases").undoHandwavyPhrase;
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
  reinstateHandwavyPhrase = mod.reinstateHandwavyPhrase;
  editHandwavyPhrase = mod.editHandwavyPhrase;
  undoHandwavyPhrase = mod.undoHandwavyPhrase;
  revertHandwavyPhraseEdit = mod.revertHandwavyPhraseEdit;
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
      const active = getHandwavyPhrases().find((m) => m.phrase === "reinstatable phrase");
      expect(active?.category).toBe("buzzword");
      expect(active?.addedBy).toBe("carol@team.com");
      expect(active?.rationale).toMatch(/three weekly drills/);

      // History row is flagged so the same row can't be reinstated twice.
      const history = getHandwavyPhraseHistory();
      const row = history.find(
        (h) => h.phrase === "reinstatable phrase" && h.removedAt === "2026-04-15T10:00:00.000Z",
      );
      expect(row?.reinstated).toBe(true);
      expect(row?.reinstatedBy).toBe("carol@team.com");

      // The flag survives a cache reset (i.e. it was actually persisted).
      __resetHandwavyPhrasesForTests();
      const reloaded = getHandwavyPhraseHistory();
      const reloadedRow = reloaded.find(
        (h) => h.phrase === "reinstatable phrase" && h.removedAt === "2026-04-15T10:00:00.000Z",
      );
      expect(reloadedRow?.reinstated).toBe(true);
    });

    it("returns history-not-found when no matching history entry exists", () => {
      const result = reinstateHandwavyPhrase("never removed phrase", "2026-01-01T00:00:00.000Z");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("history-not-found");
      }
    });

    it("refuses to reinstate the same history row twice", () => {
      addHandwavyPhrase("double reinstate phrase", "absence", {
        now: "2026-04-10T08:00:00.000Z",
      });
      removeHandwavyPhrase("double reinstate phrase", { now: "2026-04-12T10:00:00.000Z" });
      const first = reinstateHandwavyPhrase(
        "double reinstate phrase",
        "2026-04-12T10:00:00.000Z",
        { now: "2026-04-13T11:00:00.000Z" },
      );
      expect(first.ok).toBe(true);
      // Now remove it again — that creates a NEW history row.
      removeHandwavyPhrase("double reinstate phrase", { now: "2026-04-14T12:00:00.000Z" });
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
      addHandwavyPhrase("collision phrase", "hedging", { now: "2026-04-10T00:00:00.000Z" });
      removeHandwavyPhrase("collision phrase", { now: "2026-04-12T00:00:00.000Z" });
      // Someone manually re-adds the phrase before the reinstate fires.
      addHandwavyPhrase("collision phrase", "absence", { now: "2026-04-13T00:00:00.000Z" });
      const result = reinstateHandwavyPhrase("collision phrase", "2026-04-12T00:00:00.000Z");
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
      expect(result.editEntry?.category).toEqual({ from: "absence", to: "buzzword" });
      expect(result.editEntry?.rationale).toBeUndefined();

      // Original add metadata is preserved.
      expect(result.marker.addedBy).toBe("alice@team.com");
      expect(result.marker.addedAt).toBe("2026-04-20T08:00:00.000Z");
      expect(result.marker.category).toBe("buzzword");
      expect(result.marker.rationale).toBe("original rationale here");
      expect(result.marker.edits).toHaveLength(1);

      // Survives a cache reset (i.e. it actually persisted).
      __resetHandwavyPhrasesForTests();
      const reloaded = getHandwavyPhrases().find((m) => m.phrase === "editable phrase one");
      expect(reloaded?.category).toBe("buzzword");
      expect(reloaded?.edits?.[0].category).toEqual({ from: "absence", to: "buzzword" });
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
      expect(result.editEntry?.rationale).toEqual({ from: "first take", to: "fixed typo and clarified" });
      expect(result.editEntry?.category).toBeUndefined();
      expect(result.marker.rationale).toBe("fixed typo and clarified");
    });

    it("clears the rationale when an empty string is supplied", () => {
      addHandwavyPhrase("editable phrase three", "absence", { rationale: "old reason" });
      const result = editHandwavyPhrase("editable phrase three", { rationale: "" });
      expect(result.edited).toBe(true);
      expect(result.editEntry?.rationale).toEqual({ from: "old reason", to: "" });
      expect(result.marker.rationale).toBeUndefined();
    });

    it("returns edited=false and writes nothing when supplied updates match the existing values", () => {
      addHandwavyPhrase("editable phrase four", "hedging", { rationale: "stable rationale" });
      const result = editHandwavyPhrase("editable phrase four", {
        category: "hedging",
        rationale: "stable rationale",
      });
      expect(result.edited).toBe(false);
      expect(result.editEntry).toBeUndefined();
      const marker = getHandwavyPhrases().find((m) => m.phrase === "editable phrase four");
      expect(marker?.edits ?? []).toHaveLength(0);
    });

    it("appends multiple edits chronologically", () => {
      addHandwavyPhrase("editable phrase five", "absence");
      editHandwavyPhrase("editable phrase five", { category: "hedging" }, { now: "2026-04-22T10:00:00.000Z" });
      editHandwavyPhrase(
        "editable phrase five",
        { rationale: "added a reason later" },
        { now: "2026-04-22T11:00:00.000Z" },
      );
      const marker = getHandwavyPhrases().find((m) => m.phrase === "editable phrase five");
      expect(marker?.edits).toHaveLength(2);
      expect(marker?.edits?.[0].editedAt).toBe("2026-04-22T10:00:00.000Z");
      expect(marker?.edits?.[1].editedAt).toBe("2026-04-22T11:00:00.000Z");
      expect(marker?.edits?.[1].rationale?.to).toBe("added a reason later");
    });

    it("preserves the edit history on remove so reinstating still has it", () => {
      addHandwavyPhrase("editable phrase six", "absence", { reviewer: "alice@team.com" });
      editHandwavyPhrase("editable phrase six", { category: "buzzword" }, { reviewer: "bob@team.com" });
      const removed = removeHandwavyPhrase("editable phrase six", { reviewer: "carol@team.com" });
      expect(removed.removed).toBe(true);
      expect(removed.historyEntry?.edits).toHaveLength(1);
      expect(removed.historyEntry?.edits?.[0].editedBy).toBe("bob@team.com");
    });

    it("throws when the phrase is not in the active list", () => {
      expect(() =>
        editHandwavyPhrase("phrase that was never added", { category: "absence" }),
      ).toThrow(/not found/i);
    });

    it("rejects too-short rationales on edit (mirrors add validation)", () => {
      addHandwavyPhrase("editable phrase seven");
      expect(() => editHandwavyPhrase("editable phrase seven", { rationale: "ab" })).toThrow(/Rationale/);
    });

    it("caps the per-marker edit log at 50 entries, pruning the oldest", () => {
      addHandwavyPhrase("editable phrase eight", "absence", { now: "2026-04-01T00:00:00.000Z" });
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
      const marker = getHandwavyPhrases().find((m) => m.phrase === "editable phrase eight");
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
      expect(getHandwavyPhrases().some((m) => m.phrase === "undo me phrase")).toBe(false);
      // History row is flagged AND survives a cache reset.
      __resetHandwavyPhrasesForTests();
      const reloaded = getHandwavyPhraseHistory();
      const row = reloaded.find(
        (h) => h.phrase === "undo me phrase" && h.removedAt === "2026-04-22T12:01:30.000Z",
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
      expect(getHandwavyPhrases().some((m) => m.phrase === "stale undo phrase")).toBe(true);
      // No history row was added.
      expect(getHandwavyPhraseHistory().some((h) => h.phrase === "stale undo phrase")).toBe(false);
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
      const result = undoHandwavyPhrase("never added phrase", "2026-04-22T12:00:00.000Z");
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
      const result = undoHandwavyPhrase(curated.phrase, "2026-04-22T12:00:00.000Z");
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
      const after = getHandwavyPhrases().find((m) => m.phrase === "revertable phrase two");
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
      expect(result.marker.edits?.[1].rationale).toEqual({ from: "", to: "first take" });
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
      addHandwavyPhrase("revertable phrase four", "absence", { now: "2026-04-20T08:00:00.000Z" });
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
      addHandwavyPhrase("revertable phrase six", "absence", { now: "2026-04-20T08:00:00.000Z" });
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
