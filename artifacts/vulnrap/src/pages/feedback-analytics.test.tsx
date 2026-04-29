import { describe, it, expect } from "vitest";
import {
  revertWouldBeNoop,
  productionScanStalenessDays,
  isProductionScanStale,
  PRODUCTION_SCAN_FRESHNESS_DAYS,
} from "./feedback-analytics";
import type { HandwavyEditEntry } from "@workspace/api-client-react";

describe("revertWouldBeNoop (Task #148 — disable Revert when it would be a no-op)", () => {
  it("treats an entry with no tracked field changes as a no-op", () => {
    const entry: HandwavyEditEntry = { editedAt: "2026-04-22T10:00:00.000Z" };
    expect(revertWouldBeNoop(entry, "absence", undefined)).toBe(true);
    expect(revertWouldBeNoop(entry, "buzzword", "anything")).toBe(true);
  });

  describe("category-only edits", () => {
    const entry: HandwavyEditEntry = {
      editedAt: "2026-04-22T10:00:00.000Z",
      category: { from: "absence", to: "buzzword" },
    };

    it("is a no-op when current category already equals the entry's 'from' value", () => {
      expect(revertWouldBeNoop(entry, "absence", undefined)).toBe(true);
      expect(revertWouldBeNoop(entry, "absence", "stale rationale")).toBe(true);
    });

    it("is NOT a no-op when current category still equals the entry's 'to' value", () => {
      expect(revertWouldBeNoop(entry, "buzzword", undefined)).toBe(false);
    });

    it("is NOT a no-op when current category is some unrelated third value", () => {
      expect(revertWouldBeNoop(entry, "hedging", undefined)).toBe(false);
    });
  });

  describe("rationale-only edits", () => {
    it("is a no-op when current rationale already equals the entry's 'from' string", () => {
      const entry: HandwavyEditEntry = {
        editedAt: "2026-04-22T10:00:00.000Z",
        rationale: { from: "first take", to: "second take" },
      };
      expect(revertWouldBeNoop(entry, "absence", "first take")).toBe(true);
    });

    it("treats undefined and empty-string rationale as equivalent (matches the backend's editHandwavyPhrase logic)", () => {
      const clearedEntry: HandwavyEditEntry = {
        editedAt: "2026-04-22T10:00:00.000Z",
        rationale: { from: "", to: "later text" },
      };
      // Current rationale of undefined is the same as "" for revert purposes.
      expect(revertWouldBeNoop(clearedEntry, "absence", undefined)).toBe(true);
      expect(revertWouldBeNoop(clearedEntry, "absence", "")).toBe(true);
    });

    it("is NOT a no-op when current rationale differs from the entry's 'from' value", () => {
      const entry: HandwavyEditEntry = {
        editedAt: "2026-04-22T10:00:00.000Z",
        rationale: { from: "first take", to: "second take" },
      };
      expect(revertWouldBeNoop(entry, "absence", "second take")).toBe(false);
      expect(revertWouldBeNoop(entry, "absence", undefined)).toBe(false);
    });
  });

  describe("entries that recorded both category and rationale changes", () => {
    const entry: HandwavyEditEntry = {
      editedAt: "2026-04-22T10:00:00.000Z",
      category: { from: "absence", to: "hedging" },
      rationale: { from: "original reason", to: "newer reason" },
    };

    it("is a no-op only when BOTH fields already match the entry's 'from' values", () => {
      expect(revertWouldBeNoop(entry, "absence", "original reason")).toBe(true);
    });

    it("is NOT a no-op when only the category matches but the rationale does not", () => {
      expect(revertWouldBeNoop(entry, "absence", "newer reason")).toBe(false);
    });

    it("is NOT a no-op when only the rationale matches but the category does not", () => {
      expect(revertWouldBeNoop(entry, "hedging", "original reason")).toBe(false);
    });

    it("is NOT a no-op when neither field matches", () => {
      expect(revertWouldBeNoop(entry, "buzzword", "newer reason")).toBe(false);
    });
  });
});

describe("productionScanStalenessDays / isProductionScanStale (Task #219 — warn when production sample is older than the freshness window)", () => {
  // A fixed "now" so day-floor arithmetic is deterministic regardless of when
  // the test suite happens to run.
  const NOW = new Date("2026-04-29T12:00:00.000Z");

  it("returns null for missing or unparseable timestamps so callers can render normally", () => {
    expect(productionScanStalenessDays(null, NOW)).toBeNull();
    expect(productionScanStalenessDays(undefined, NOW)).toBeNull();
    expect(productionScanStalenessDays("not-a-date", NOW)).toBeNull();
    expect(isProductionScanStale(null, NOW)).toBe(false);
    expect(isProductionScanStale(undefined, NOW)).toBe(false);
    expect(isProductionScanStale("not-a-date", NOW)).toBe(false);
  });

  it("returns null for future timestamps (clock-skew guard) so a slightly-ahead sample isn't flagged as stale", () => {
    const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    expect(productionScanStalenessDays(future, NOW)).toBeNull();
    expect(isProductionScanStale(future, NOW)).toBe(false);
  });

  it("floors to whole days so the rendered string is stable across same-day re-renders", () => {
    const oneDayAndAHalfAgo = new Date(NOW.getTime() - (1 * 24 + 12) * 60 * 60 * 1000).toISOString();
    expect(productionScanStalenessDays(oneDayAndAHalfAgo, NOW)).toBe(1);
    const justUnderOneDay = new Date(NOW.getTime() - (24 * 60 * 60 * 1000 - 1)).toISOString();
    expect(productionScanStalenessDays(justUnderOneDay, NOW)).toBe(0);
  });

  it("treats a sample exactly at the threshold as fresh and one day past as stale", () => {
    // The default threshold is "older than N days" so equality should be fresh.
    const exactlyAtThreshold = new Date(NOW.getTime() - PRODUCTION_SCAN_FRESHNESS_DAYS * 24 * 60 * 60 * 1000).toISOString();
    expect(productionScanStalenessDays(exactlyAtThreshold, NOW)).toBe(PRODUCTION_SCAN_FRESHNESS_DAYS);
    expect(isProductionScanStale(exactlyAtThreshold, NOW)).toBe(false);

    const onePastThreshold = new Date(NOW.getTime() - (PRODUCTION_SCAN_FRESHNESS_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
    expect(productionScanStalenessDays(onePastThreshold, NOW)).toBe(PRODUCTION_SCAN_FRESHNESS_DAYS + 1);
    expect(isProductionScanStale(onePastThreshold, NOW)).toBe(true);
  });

  it("respects an overridden threshold so callers can probe arbitrary windows", () => {
    const fiveDaysAgo = new Date(NOW.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    expect(isProductionScanStale(fiveDaysAgo, NOW, 7)).toBe(false);
    expect(isProductionScanStale(fiveDaysAgo, NOW, 3)).toBe(true);
  });

  it("exports a sensible default freshness window (positive integer, not too aggressive)", () => {
    // Sanity-check the default so a typo in the constant (negative, zero, or
    // a humongous value) doesn't silently disable the warning everywhere.
    expect(Number.isInteger(PRODUCTION_SCAN_FRESHNESS_DAYS)).toBe(true);
    expect(PRODUCTION_SCAN_FRESHNESS_DAYS).toBeGreaterThan(0);
    expect(PRODUCTION_SCAN_FRESHNESS_DAYS).toBeLessThanOrEqual(90);
  });
});
