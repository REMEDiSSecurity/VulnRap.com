import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  revertWouldBeNoop,
  productionScanStalenessDays,
  isProductionScanStale,
  PRODUCTION_SCAN_FRESHNESS_DAYS,
  renderHandwavyEditEntries,
  computeHandwavyActiveListVersion,
  createSingleRemoveDryRunPreviewCache,
  describeRemovePreviewSource,
  formatRemovePreviewScannedAgo,
  summarizeDatasetHistory,
  computeCohortFixtureDelta,
  FIXTURE_VS_DATASET_DELTA_WARN_THRESHOLD,
  sortDatasetSamplesByDistanceFromMean,
  type DatasetSampleRow,
  isValidDriftLookback,
  parseDriftLookback,
  readStoredDriftLookback,
  AVRI_DRIFT_LOOKBACK_STORAGE_KEY,
  describeHandwavyDisabledReason,
} from "./feedback-analytics";
import type {
  HandwavyEditEntry,
  HandwavyPhraseSingleRemoveDryRunResponse,
} from "@workspace/api-client-react";

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

describe("renderHandwavyEditEntries — visible no-op hint (Task #241)", () => {
  // Task #148 disables the per-entry Revert button when the live marker
  // already matches the entry's "from" values, replacing the label with
  // "At this state". The only explanation lived in the button's hover
  // title/aria-label, which is invisible on touch and to screen-reader
  // users who never focus the button. Task #241 adds a visible inline
  // caption so the disabled state is self-explanatory; these tests pin
  // both the visible wording AND the aria-describedby wiring so a future
  // refactor can't silently delete one without the other.

  function renderEntries(args: Parameters<typeof renderHandwavyEditEntries>[0]) {
    return render(<ul>{renderHandwavyEditEntries(args)}</ul>);
  }

  const noopEntry: HandwavyEditEntry = {
    editedAt: "2026-04-22T10:00:00.000Z",
    editedBy: "alice",
    category: { from: "absence", to: "buzzword" },
  };
  const enabledEntry: HandwavyEditEntry = {
    editedAt: "2026-04-23T10:00:00.000Z",
    editedBy: "bob",
    category: { from: "buzzword", to: "absence" },
  };

  it("renders a visible inline hint beneath the disabled Revert row that explains WHY it is greyed out", () => {
    renderEntries({
      editsList: [noopEntry],
      phrase: "we plan to investigate",
      // Live category matches the entry's `from` value, so revert is a no-op.
      currentCategory: "absence",
      currentRationale: undefined,
      editing: null,
      busy: null,
      onRevertClick: () => {},
      mutationsAllowed: true,
    });

    const button = screen.getByTestId("handwavy-revert-edit");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-noop", "true");

    // The hint must be a real visible DOM node — not just a hover title —
    // so reviewers on touch devices can read it without focus or hover.
    const hint = screen.getByTestId("handwavy-revert-noop-hint");
    expect(hint).toBeVisible();
    expect(hint).toHaveTextContent(/already matches/i);
    expect(hint).toHaveTextContent(/nothing to undo/i);
  });

  it("wires the visible hint to the disabled button via aria-describedby so screen-reader focus picks it up", () => {
    // Pick a realistic phrase that contains whitespace and punctuation.
    // aria-describedby is an IDREF list split on whitespace, so a naive id
    // generator that embeds the raw phrase would silently break the screen-
    // reader association. The test pins the whitespace-safe contract.
    const phrase = "we plan to investigate (later)";
    renderEntries({
      editsList: [noopEntry],
      phrase,
      currentCategory: "absence",
      currentRationale: undefined,
      editing: null,
      busy: null,
      onRevertClick: () => {},
      mutationsAllowed: true,
    });

    const button = screen.getByTestId("handwavy-revert-edit");
    const hint = screen.getByTestId("handwavy-revert-noop-hint");
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy, "disabled button must reference the hint by id").toBe(hint.id);
    expect(hint.id).toBeTruthy();
    // The hint id MUST NOT contain whitespace or other characters that would
    // turn aria-describedby into a multi-token IDREF list and silently drop
    // the reference. Restricting to URL-safe ASCII covers HTML5's id rules
    // and matches what the renderer slugifies to.
    expect(hint.id).toMatch(/^[A-Za-z][A-Za-z0-9_:.-]*$/);
    expect(hint.id).not.toMatch(/\s/);
    // And the resulting accessible description on the button (resolved via
    // aria-describedby by jest-dom) must equal the visible caption text — so
    // a screen-reader user who focuses the button hears the same wording a
    // touch user can read.
    expect(button).toHaveAccessibleDescription(/already matches/i);
    expect(button).toHaveAccessibleDescription(/nothing to undo/i);
  });

  it("does NOT render the hint when Revert would actually change something (enabled rows are unchanged)", () => {
    renderEntries({
      editsList: [enabledEntry],
      phrase: "we plan to investigate",
      // Live category is NOT the entry's `from` value, so revert would change
      // things — button must be enabled and the hint must not appear.
      currentCategory: "absence",
      currentRationale: undefined,
      editing: null,
      busy: null,
      onRevertClick: () => {},
      mutationsAllowed: true,
    });

    const button = screen.getByTestId("handwavy-revert-edit");
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("data-noop", "false");
    expect(button).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByTestId("handwavy-revert-noop-hint")).toBeNull();
  });

  it("renders the hint only on the no-op row when a list mixes enabled and disabled entries", () => {
    renderEntries({
      // Renderer reverses the list so the most recent entry appears first.
      // Both entries describe the same field (category) — only the older
      // one's `from` value matches the live category.
      editsList: [noopEntry, enabledEntry],
      phrase: "we plan to investigate",
      currentCategory: "absence",
      currentRationale: undefined,
      editing: null,
      busy: null,
      onRevertClick: () => {},
      mutationsAllowed: true,
    });

    const buttons = screen.getAllByTestId("handwavy-revert-edit");
    expect(buttons).toHaveLength(2);
    // Most recent first (enabledEntry) — enabled, no hint.
    expect(buttons[0]).toBeEnabled();
    expect(buttons[0]).toHaveAttribute("data-noop", "false");
    // Older (noopEntry) — disabled, hint visible.
    expect(buttons[1]).toBeDisabled();
    expect(buttons[1]).toHaveAttribute("data-noop", "true");

    const hints = screen.getAllByTestId("handwavy-revert-noop-hint");
    expect(hints).toHaveLength(1);
    // The single hint must be inside the same <li> as the disabled button.
    const noopRow = buttons[1].closest("li");
    expect(noopRow, "disabled button must live in an <li> row").not.toBeNull();
    expect(within(noopRow!).getByTestId("handwavy-revert-noop-hint")).toBe(hints[0]);
  });
});

describe("renderHandwavyEditEntries — rename block (Task #357)", () => {
  // Task #357 surfaces rename entries (recorded as `phrase: { from, to }` on
  // the per-marker edit log) in the audit panel alongside the existing
  // category/rationale diffs. These tests pin the visible wording, the test
  // hooks the E2E spec latches onto, and the "no tracked changes" fallback
  // so future refactors can't silently drop the rename block.

  function renderEntries(args: Parameters<typeof renderHandwavyEditEntries>[0]) {
    return render(<ul>{renderHandwavyEditEntries(args)}</ul>);
  }

  const renameOnlyEntry: HandwavyEditEntry = {
    editedAt: "2026-04-25T10:00:00.000Z",
    editedBy: "alice@team.com",
    phrase: { from: "we plan to look", to: "we plan to investigate" },
  };

  const combinedRenameEntry: HandwavyEditEntry = {
    editedAt: "2026-04-26T10:00:00.000Z",
    editedBy: "bob@team.com",
    phrase: { from: "we plan to investigate", to: "we plan to dig in" },
    category: { from: "absence", to: "hedging" },
  };

  it("renders the previous phrase text and the renamer in the in-row affordance", () => {
    renderEntries({
      editsList: [renameOnlyEntry],
      phrase: "we plan to investigate",
      currentCategory: "absence",
      currentRationale: undefined,
      editing: null,
      busy: null,
      onRevertClick: () => {},
      mutationsAllowed: true,
    });

    const block = screen.getByTestId("handwavy-edit-rename");
    expect(block).toBeVisible();
    // The "from" value (the previous phrase text) MUST be visible so a
    // reviewer can answer "what was this called before?" without opening
    // the JSON.
    expect(block).toHaveTextContent("we plan to look");
    expect(block).toHaveTextContent("we plan to investigate");
    expect(block).toHaveTextContent(/renamed/i);
    // The renamer is surfaced via the existing per-row "By <editedBy>"
    // header that the renderer already builds for every entry, so the
    // audit answer "who renamed it?" is visible right next to the rename
    // block without the renderer having to duplicate the field.
    const row = block.closest("li");
    expect(row, "rename block must live in an <li> row").not.toBeNull();
    expect(within(row!).getByText("alice@team.com")).toBeVisible();
  });

  it("uses the history-panel test id when showHistoryTestIds is set so the full-history view selector works", () => {
    // The single-edit <details> uses `handwavy-edit-rename`; the full
    // chronological history panel uses `handwavy-edit-history-rename`.
    // Both must surface the rename block, but with their own selectors so
    // E2E specs can target the expanded view without ambiguity.
    renderEntries({
      editsList: [renameOnlyEntry],
      phrase: "we plan to investigate",
      currentCategory: "absence",
      currentRationale: undefined,
      editing: null,
      busy: null,
      onRevertClick: () => {},
      mutationsAllowed: true,
      showHistoryTestIds: true,
    });

    expect(screen.queryByTestId("handwavy-edit-rename")).toBeNull();
    expect(screen.getByTestId("handwavy-edit-history-rename")).toBeVisible();
  });

  it("renders the rename block alongside other change kinds when an entry recorded both a rename and a category change", () => {
    renderEntries({
      editsList: [combinedRenameEntry],
      phrase: "we plan to dig in",
      currentCategory: "hedging",
      currentRationale: undefined,
      editing: null,
      busy: null,
      onRevertClick: () => {},
      mutationsAllowed: true,
    });

    // Both blocks must be present so the reviewer sees the full audit
    // story for that single edit (renames don't hide category diffs and
    // vice versa).
    expect(screen.getByTestId("handwavy-edit-rename")).toBeVisible();
    expect(screen.getByTestId("handwavy-edit-category")).toBeVisible();
  });

  it("does NOT render the rename block when only category or rationale changed (the audit log omits `phrase` for those edits)", () => {
    const noRenameEntry: HandwavyEditEntry = {
      editedAt: "2026-04-22T10:00:00.000Z",
      editedBy: "carol@team.com",
      category: { from: "absence", to: "buzzword" },
    };
    renderEntries({
      editsList: [noRenameEntry],
      phrase: "we plan to investigate",
      currentCategory: "buzzword",
      currentRationale: undefined,
      editing: null,
      busy: null,
      onRevertClick: () => {},
      mutationsAllowed: true,
    });

    expect(screen.queryByTestId("handwavy-edit-rename")).toBeNull();
    expect(screen.queryByTestId("handwavy-edit-history-rename")).toBeNull();
  });

  it("treats a rename-only entry as a tracked change so the 'No tracked field changes recorded' fallback is suppressed in the history view", () => {
    // Pre-Task #357 a rename-only entry would have rendered the
    // "No tracked field changes recorded" fallback (since the renderer
    // only knew about category and rationale). The new fallback must
    // also account for `entry.phrase` so a real rename never shows up
    // as an empty audit row.
    renderEntries({
      editsList: [renameOnlyEntry],
      phrase: "we plan to investigate",
      currentCategory: "absence",
      currentRationale: undefined,
      editing: null,
      busy: null,
      onRevertClick: () => {},
      mutationsAllowed: true,
      showHistoryTestIds: true,
    });

    expect(
      screen.queryByText(/No tracked field changes recorded\./),
    ).toBeNull();
  });
});

describe("computeHandwavyActiveListVersion (Task #246 — invalidation key for the per-row dry-run preview cache)", () => {
  it("returns a stable string for the empty list so callers don't have to special-case undefined", () => {
    expect(computeHandwavyActiveListVersion([])).toBe("0:");
  });

  it("returns the same version when only the iteration order of the SAME phrase set changes", () => {
    // The cache uses this string to decide whether a previously-fetched
    // dry-run can be served. A reorder (e.g. the sort-by-thrash toggle)
    // doesn't change what removing any given phrase would un-flag, so it
    // MUST NOT bust the cache.
    const a = computeHandwavyActiveListVersion([{ phrase: "alpha" }, { phrase: "bravo" }]);
    const b = computeHandwavyActiveListVersion([{ phrase: "bravo" }, { phrase: "alpha" }]);
    expect(a).toBe(b);
  });

  it("returns a different version when a phrase is added, removed, or replaced", () => {
    const base = computeHandwavyActiveListVersion([{ phrase: "alpha" }, { phrase: "bravo" }]);
    const added = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "bravo" },
      { phrase: "charlie" },
    ]);
    const removed = computeHandwavyActiveListVersion([{ phrase: "alpha" }]);
    const replaced = computeHandwavyActiveListVersion([{ phrase: "alpha" }, { phrase: "delta" }]);
    expect(added).not.toBe(base);
    expect(removed).not.toBe(base);
    expect(replaced).not.toBe(base);
    // And these three "changed" versions are all distinct from each other
    // — defense against a length-only or first-element-only hash that
    // would let an edit slip through unnoticed.
    expect(new Set([base, added, removed, replaced]).size).toBe(4);
  });

  it("does not collide between a single phrase containing a digit prefix and a multi-element list with the same suffix", () => {
    // The version string starts with a length prefix specifically so a
    // phrase like "2:foo" can't accidentally match a 2-element list whose
    // joined form happens to equal "foo".
    const single = computeHandwavyActiveListVersion([{ phrase: "2:foo" }]);
    const pair = computeHandwavyActiveListVersion([{ phrase: "" }, { phrase: "foo" }]);
    expect(single).not.toBe(pair);
  });
});

describe("createSingleRemoveDryRunPreviewCache (Task #246 — cache hit + invalidation)", () => {
  // The cache is generic over the response type; using a minimal stand-in
  // here keeps the test focused on the cache's hit/miss + invalidation
  // contract without coupling it to the full DryRunResponse shape.
  type StubResp = Pick<HandwavyPhraseSingleRemoveDryRunResponse, "phrase">;
  const stubFor = (phrase: string): StubResp => ({ phrase });

  const VERSION_A = "2:alpha\u0001bravo";
  const VERSION_B = "3:alpha\u0001bravo\u0001charlie";

  it("returns the stored response on a cache hit when phrase + scan-limit + version all match", () => {
    const cache = createSingleRemoveDryRunPreviewCache<StubResp>();
    const response = stubFor("alpha");
    cache.set("alpha", 50, VERSION_A, response);
    // Same key triple -> same reference back out (no clone, no fetch).
    expect(cache.get("alpha", 50, VERSION_A)).toBe(response);
    expect(cache.size()).toBe(1);
  });

  it("returns undefined when the active-list version has changed since the entry was stored", () => {
    // This is the core invalidation contract: any add / remove /
    // reinstate / edit bumps the version, and a cached preview from the
    // OLD list MUST NOT be served against the NEW list.
    const cache = createSingleRemoveDryRunPreviewCache<StubResp>();
    cache.set("alpha", 50, VERSION_A, stubFor("alpha"));
    expect(cache.get("alpha", 50, VERSION_B)).toBeUndefined();
    // The stale entry is still occupying a slot — that's fine, a fresh
    // `set` will overwrite it on the next miss-then-fetch round-trip.
    expect(cache.size()).toBe(1);
  });

  it("treats a different production-scan limit as a different cache slot", () => {
    // The dry-run response embeds production matches scored against up to
    // N reports. A reviewer who tunes N gets a materially different
    // response and must NOT be served the previous limit's cached result.
    const cache = createSingleRemoveDryRunPreviewCache<StubResp>();
    const at50 = stubFor("alpha");
    cache.set("alpha", 50, VERSION_A, at50);
    expect(cache.get("alpha", 100, VERSION_A)).toBeUndefined();
    expect(cache.get("alpha", 50, VERSION_A)).toBe(at50);
  });

  it("treats a different phrase as a different cache slot (no cross-phrase pollution)", () => {
    const cache = createSingleRemoveDryRunPreviewCache<StubResp>();
    cache.set("alpha", 50, VERSION_A, stubFor("alpha"));
    expect(cache.get("bravo", 50, VERSION_A)).toBeUndefined();
  });

  it("invalidate() drops every entry so a refresh() can defensively clear the cache before the new list lands", () => {
    const cache = createSingleRemoveDryRunPreviewCache<StubResp>();
    cache.set("alpha", 50, VERSION_A, stubFor("alpha"));
    cache.set("bravo", 50, VERSION_A, stubFor("bravo"));
    expect(cache.size()).toBe(2);
    cache.invalidate();
    expect(cache.size()).toBe(0);
    expect(cache.get("alpha", 50, VERSION_A)).toBeUndefined();
    expect(cache.get("bravo", 50, VERSION_A)).toBeUndefined();
  });

  it("a re-set after a version bump replaces the stale entry instead of stacking another slot", () => {
    // Simulates: Trash phrase X (set v1) → reviewer adds a new phrase
    // (version bumps to v2) → reviewer Trashes X again (miss, then fresh
    // set against v2). The cache should end up with exactly one entry
    // for X, tagged at v2.
    const cache = createSingleRemoveDryRunPreviewCache<StubResp>();
    cache.set("alpha", 50, VERSION_A, stubFor("alpha-v1"));
    cache.set("alpha", 50, VERSION_B, stubFor("alpha-v2"));
    expect(cache.size()).toBe(1);
    expect(cache.get("alpha", 50, VERSION_A)).toBeUndefined();
    expect(cache.get("alpha", 50, VERSION_B)?.phrase).toBe("alpha-v2");
  });

  it("getEntry returns the response paired with the write-time scannedAt", () => {
    let clock = 1_700_000_000_000;
    const cache = createSingleRemoveDryRunPreviewCache<StubResp>({
      now: () => clock,
    });
    const response = stubFor("alpha");
    cache.set("alpha", 50, VERSION_A, response);
    const entry = cache.getEntry("alpha", 50, VERSION_A);
    expect(entry?.response).toBe(response);
    expect(entry?.scannedAt).toBe(1_700_000_000_000);
    // A later set against the same key advances the stored timestamp.
    clock = 1_700_000_005_000;
    cache.set("alpha", 50, VERSION_A, response);
    expect(cache.getEntry("alpha", 50, VERSION_A)?.scannedAt).toBe(
      1_700_000_005_000,
    );
  });

  it("getEntry honors the same version + missing-key invalidation as get", () => {
    const cache = createSingleRemoveDryRunPreviewCache<StubResp>({
      now: () => 1_700_000_000_000,
    });
    cache.set("alpha", 50, VERSION_A, stubFor("alpha"));
    expect(cache.getEntry("alpha", 50, VERSION_B)).toBeUndefined();
    expect(cache.getEntry("bravo", 50, VERSION_A)).toBeUndefined();
    cache.invalidate();
    expect(cache.getEntry("alpha", 50, VERSION_A)).toBeUndefined();
  });
});

describe("describeRemovePreviewSource (Task #349 — fresh vs. cached badge branching)", () => {
  const FAKE_NOW = 1_700_000_000_000;

  it("renders 'Fresh scan' (and ignores the scan timestamp) on the fresh branch", () => {
    const result = describeRemovePreviewSource(
      "fresh",
      FAKE_NOW - 30_000,
      FAKE_NOW,
    );
    expect(result.label).toBe("Fresh scan");
    expect(result.tone).toBe("fresh");
  });

  it("renders 'Reused scan · Ns ago' on the cached branch", () => {
    const result = describeRemovePreviewSource(
      "cached",
      FAKE_NOW - 14_000,
      FAKE_NOW,
    );
    expect(result.label).toBe("Reused scan · 14s ago");
    expect(result.tone).toBe("cached");
  });

  it("escalates the cached badge through s → m → h as the scan ages", () => {
    expect(
      describeRemovePreviewSource("cached", FAKE_NOW - 90_000, FAKE_NOW).label,
    ).toBe("Reused scan · 2m ago");
    expect(
      describeRemovePreviewSource("cached", FAKE_NOW - 3_600_000, FAKE_NOW)
        .label,
    ).toBe("Reused scan · 1h ago");
  });

  it("collapses sub-5s diffs to 'just now' so a back-to-back re-Trash doesn't flicker", () => {
    expect(
      describeRemovePreviewSource("cached", FAKE_NOW - 100, FAKE_NOW).label,
    ).toBe("Reused scan · just now");
    expect(
      formatRemovePreviewScannedAgo(FAKE_NOW - 4_000, FAKE_NOW),
    ).toBe("just now");
    // Boundary: 5s crosses over to integer-seconds.
    expect(
      formatRemovePreviewScannedAgo(FAKE_NOW - 5_000, FAKE_NOW),
    ).toBe("5s ago");
  });

  it("collapses negative diffs (clock skew) to 'just now' instead of '-3s ago'", () => {
    const result = describeRemovePreviewSource(
      "cached",
      FAKE_NOW + 3_000,
      FAKE_NOW,
    );
    expect(result.label).toBe("Reused scan · just now");
  });
});

describe("summarizeDatasetHistory (Task #263 — render dataset cohort drift sparklines)", () => {
  it("flags an empty response so the dashboard can render the 'dataset not mounted' placeholder", () => {
    expect(summarizeDatasetHistory(null).isEmpty).toBe(true);
    expect(summarizeDatasetHistory(undefined).isEmpty).toBe(true);
    expect(summarizeDatasetHistory({ totalSnapshots: 0, cohorts: [] }).isEmpty).toBe(true);
    // totalSnapshots could be stale/missing — fall back to per-cohort length.
    expect(
      summarizeDatasetHistory({
        totalSnapshots: 0,
        cohorts: [{ tier: "T1_LEGIT", snapshots: [] }],
      }).isEmpty,
    ).toBe(true);
  });

  it("returns one tier series per known tier in T1 → T2 → T3 order even when the response is partial", () => {
    // Only T1 + T3 present in the response — T2 should still be a placeholder
    // entry so the rendered grid stays in a stable order.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 2,
      cohorts: [
        {
          tier: "T3_SLOP",
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T3_SLOP",
              label: "ai_slop",
              count: 25,
              compositeMean: 28.4,
              gap: 12.5,
            },
          ],
        },
        {
          tier: "T1_LEGIT",
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 15.9,
              gap: 12.5,
            },
          ],
        },
      ],
    });
    expect(summary.isEmpty).toBe(false);
    expect(summary.tiers.map(t => t.tier)).toEqual(["T1_LEGIT", "T2_BORDERLINE", "T3_SLOP"]);
    expect(summary.tiers[0]!.latest).toBe(15.9);
    expect(summary.tiers[1]!.latest).toBeNull();
    expect(summary.tiers[1]!.points).toEqual([]);
    expect(summary.tiers[2]!.latest).toBe(28.4);
  });

  it("filters null and non-finite composite means out of the plottable points", () => {
    const summary = summarizeDatasetHistory({
      totalSnapshots: 3,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 0,
              compositeMean: null,
              gap: null,
            },
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 16.2,
              gap: 11.0,
            },
            {
              timestamp: "2026-04-24T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: Number.NaN,
              gap: null,
            },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find(t => t.tier === "T1_LEGIT")!;
    // Snapshot count keeps all rows (so the chip says "3 pts") but only
    // the one row with a finite mean is plotted.
    expect(t1.snapshotCount).toBe(3);
    expect(t1.points.map(p => p.value)).toEqual([16.2]);
    expect(t1.latest).toBe(16.2);
  });

  it("dedupes the gap series across cohort rows so the gap sparkline shows one point per run", () => {
    // The api-server repeats `gap` on every cohort row of a single run.
    // Without deduping, a 2-run history would render 6 gap points (3 per
    // run) instead of 2.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 6,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            { timestamp: "2026-04-22T00:00:00.000Z", tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 16, gap: 10 },
            { timestamp: "2026-04-23T00:00:00.000Z", tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 17, gap: 11 },
          ],
        },
        {
          tier: "T2_BORDERLINE",
          snapshots: [
            { timestamp: "2026-04-22T00:00:00.000Z", tier: "T2_BORDERLINE", label: "borderline", count: 25, compositeMean: 22, gap: 10 },
            { timestamp: "2026-04-23T00:00:00.000Z", tier: "T2_BORDERLINE", label: "borderline", count: 25, compositeMean: 21, gap: 11 },
          ],
        },
        {
          tier: "T3_SLOP",
          snapshots: [
            { timestamp: "2026-04-22T00:00:00.000Z", tier: "T3_SLOP", label: "ai_slop", count: 25, compositeMean: 26, gap: 10 },
            { timestamp: "2026-04-23T00:00:00.000Z", tier: "T3_SLOP", label: "ai_slop", count: 25, compositeMean: 28, gap: 11 },
          ],
        },
      ],
    });
    expect(summary.gapPoints.map(p => `${p.timestamp}:${p.value}`)).toEqual([
      "2026-04-22T00:00:00.000Z:10",
      "2026-04-23T00:00:00.000Z:11",
    ]);
    expect(summary.latestGap).toBe(11);
  });

  it("sorts the deduped gap series chronologically even when cohorts are received out of order", () => {
    // Defensive: the API sorts cohorts alphabetically (T1, T2, T3) but if
    // a future change ever returned snapshots in a different order, the
    // gap sparkline still needs left-to-right time ordering.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 2,
      cohorts: [
        {
          tier: "T3_SLOP",
          snapshots: [
            { timestamp: "2026-04-23T00:00:00.000Z", tier: "T3_SLOP", label: "ai_slop", count: 25, compositeMean: 28, gap: 11 },
            { timestamp: "2026-04-22T00:00:00.000Z", tier: "T3_SLOP", label: "ai_slop", count: 25, compositeMean: 26, gap: 10 },
          ],
        },
      ],
    });
    expect(summary.gapPoints.map(p => p.value)).toEqual([10, 11]);
    expect(summary.latestGap).toBe(11);
  });

  // Task #358 — `sampleDateKey` annotations on the trend so reviewers can
  // tell daily-slice rotations apart from real cohort drift.
  it("threads sampleDateKey onto plottable points and counts adjacent rotations per tier", () => {
    const summary = summarizeDatasetHistory({
      totalSnapshots: 4,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            { timestamp: "2026-04-22T00:00:00.000Z", tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 70, gap: 18, sampleDateKey: "2026-04-22" },
            // Same slice → no rotation between #1 and #2.
            { timestamp: "2026-04-22T12:00:00.000Z", tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 71, gap: 18, sampleDateKey: "2026-04-22" },
            // Slice flipped → rotation between #2 and #3.
            { timestamp: "2026-04-23T00:00:00.000Z", tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 72, gap: 19, sampleDateKey: "2026-04-23" },
            // Slice flipped again → rotation between #3 and #4.
            { timestamp: "2026-04-24T00:00:00.000Z", tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 73, gap: 20, sampleDateKey: "2026-04-24" },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find(t => t.tier === "T1_LEGIT")!;
    expect(t1.points.map(p => p.sampleDateKey)).toEqual([
      "2026-04-22",
      "2026-04-22",
      "2026-04-23",
      "2026-04-24",
    ]);
    expect(t1.rotationCount).toBe(2);
    expect(t1.latestSampleDateKey).toBe("2026-04-24");
    expect(summary.latestSampleDateKey).toBe("2026-04-24");
    // Threaded onto the gap series too, so the gap sparkline can mark rotations.
    expect(summary.gapPoints.map(p => p.sampleDateKey)).toEqual([
      "2026-04-22",
      "2026-04-22",
      "2026-04-23",
      "2026-04-24",
    ]);
  });

  it("does not count a rotation across a gap where one side lacks a slice key (legacy rows)", () => {
    // Pre-Task-#358 history won't have the field — we mustn't ghost-mark
    // a rotation purely because the data showed up partway through the
    // trend. Rotation detection only fires when both sides actually
    // disagree on a real key.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 3,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            { timestamp: "2026-04-22T00:00:00.000Z", tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 70, gap: 18 },
            { timestamp: "2026-04-23T00:00:00.000Z", tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 71, gap: 18, sampleDateKey: "2026-04-23" },
            { timestamp: "2026-04-23T12:00:00.000Z", tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 72, gap: 18, sampleDateKey: "2026-04-23" },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find(t => t.tier === "T1_LEGIT")!;
    expect(t1.rotationCount).toBe(0);
    expect(t1.latestSampleDateKey).toBe("2026-04-23");
    expect(summary.latestSampleDateKey).toBe("2026-04-23");
  });

  it("falls back to a null latest slice key when no snapshot carried one", () => {
    // Pure-legacy history: the summary reports no slice annotations so
    // the dashboard's "latest slice" badge stays hidden.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 1,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            { timestamp: "2026-04-22T00:00:00.000Z", tier: "T1_LEGIT", label: "human_authentic", count: 25, compositeMean: 70, gap: 18 },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find(t => t.tier === "T1_LEGIT")!;
    expect(t1.latestSampleDateKey).toBeNull();
    expect(t1.rotationCount).toBe(0);
    expect(summary.latestSampleDateKey).toBeNull();
  });
});

describe("computeCohortFixtureDelta (Task #256 — surface synthetic-vs-dataset cohort drift)", () => {
  it("computes a signed dataset-minus-fixture delta rounded to 1 decimal", () => {
    // Dataset cohort hotter than the synthetic fixture mean — positive delta.
    const hotter = computeCohortFixtureDelta(78.3, 70.1);
    expect(hotter.delta).toBe(8.2);
    // Dataset cohort cooler than the synthetic fixture mean — negative delta.
    const cooler = computeCohortFixtureDelta(20.0, 28.5);
    expect(cooler.delta).toBe(-8.5);
    // Floating point math gets rounded to the same precision the UI prints.
    const rounded = computeCohortFixtureDelta(78.34, 70.12);
    expect(rounded.delta).toBe(8.2);
  });

  it("flags |delta| above the warn threshold as divergent and leaves smaller deltas alone", () => {
    // Right at the threshold (5.0) is intentionally NOT flagged — only
    // strictly-greater jumps trip the warning to avoid noise on the boundary.
    expect(computeCohortFixtureDelta(75, 70).isDivergent).toBe(false);
    expect(computeCohortFixtureDelta(70, 75).isDivergent).toBe(false);
    // Just past the threshold in either direction is flagged.
    expect(computeCohortFixtureDelta(75.2, 70).isDivergent).toBe(true);
    expect(computeCohortFixtureDelta(70, 75.2).isDivergent).toBe(true);
    // Sanity-check the actual constant the UI surfaces in its hint.
    expect(FIXTURE_VS_DATASET_DELTA_WARN_THRESHOLD).toBe(5);
  });

  it("returns null delta and no divergence flag when either mean is missing", () => {
    // Cohort had no samples — can't compute a delta, so we don't warn.
    expect(computeCohortFixtureDelta(null, 70)).toEqual({ delta: null, isDivergent: false });
    // Synthetic summary didn't include this tier (e.g. T2 missing).
    expect(computeCohortFixtureDelta(70, null)).toEqual({ delta: null, isDivergent: false });
    // Both missing — same: silent.
    expect(computeCohortFixtureDelta(null, null)).toEqual({ delta: null, isDivergent: false });
  });

  it("supports an explicit warn threshold override for callers that need a tighter band", () => {
    // A 3pt delta should be flagged once the threshold is tightened to 2pt.
    expect(computeCohortFixtureDelta(73, 70, 2).isDivergent).toBe(true);
    // A 5pt delta should be ignored once the threshold is widened to 10pt,
    // confirming the override travels through both the magnitude and the
    // boundary-strictness logic.
    expect(computeCohortFixtureDelta(75, 70, 10).isDivergent).toBe(false);
  });
});

describe("sortDatasetSamplesByDistanceFromMean (Task #255 — surface cohort outliers first)", () => {
  const make = (id: string, composite: number): DatasetSampleRow => ({
    id, label: "human_authentic", tier: "T1_LEGIT",
    composite, e1: null, e2: null, e3: null, triage: "MANUAL_REVIEW",
  });

  it("sorts rows by absolute distance from the cohort mean, descending", () => {
    const rows = [make("a", 80), make("b", 50), make("c", 90), make("d", 75)];
    const sorted = sortDatasetSamplesByDistanceFromMean(rows, 75);
    // |50-75|=25, |90-75|=15, |80-75|=5, |75-75|=0 → b, c, a, d
    expect(sorted.map(r => r.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("breaks ties on equal distances by report id so the order is stable", () => {
    // Both 70 and 80 are 5 away from 75; tie-break should put "x" before "y".
    const rows = [make("y", 70), make("x", 80), make("z", 75)];
    const sorted = sortDatasetSamplesByDistanceFromMean(rows, 75);
    expect(sorted.map(r => r.id)).toEqual(["x", "y", "z"]);
  });

  it("does not mutate the input array", () => {
    const rows = [make("a", 80), make("b", 50)];
    const snapshot = rows.map(r => r.id);
    sortDatasetSamplesByDistanceFromMean(rows, 75);
    expect(rows.map(r => r.id)).toEqual(snapshot);
  });

  it("returns rows in upstream order when the cohort mean is null (empty cohort)", () => {
    // Without a mean to anchor distance, falling back to the original
    // order is preferable to picking an arbitrary one.
    const rows = [make("c", 90), make("a", 80), make("b", 50)];
    const sorted = sortDatasetSamplesByDistanceFromMean(rows, null);
    expect(sorted.map(r => r.id)).toEqual(["c", "a", "b"]);
  });

  it("handles an empty input without throwing", () => {
    expect(sortDatasetSamplesByDistanceFromMean([], 75)).toEqual([]);
    expect(sortDatasetSamplesByDistanceFromMean([], null)).toEqual([]);
  });
});

describe("AVRI drift lookback persistence helpers (Task #270 — lock the parser/validator contract)", () => {
  describe("isValidDriftLookback", () => {
    it("accepts each of the four supported numeric options", () => {
      expect(isValidDriftLookback(4)).toBe(true);
      expect(isValidDriftLookback(8)).toBe(true);
      expect(isValidDriftLookback(13)).toBe(true);
      expect(isValidDriftLookback(26)).toBe(true);
    });

    it("rejects numbers that aren't on the option list, including neighbouring values", () => {
      expect(isValidDriftLookback(0)).toBe(false);
      expect(isValidDriftLookback(1)).toBe(false);
      expect(isValidDriftLookback(7)).toBe(false);
      expect(isValidDriftLookback(9)).toBe(false);
      expect(isValidDriftLookback(12)).toBe(false);
      expect(isValidDriftLookback(99)).toBe(false);
      expect(isValidDriftLookback(-8)).toBe(false);
    });

    it("rejects non-integer numerics that happen to round to a valid option", () => {
      // 8.5 is not an allowed lookback even though Math.round(8.5) === 9 (and
      // 8 is valid). The validator must use exact equality, not rounding.
      expect(isValidDriftLookback(8.5)).toBe(false);
      expect(isValidDriftLookback(7.999)).toBe(false);
    });

    it("rejects NaN so a Number(...) parse failure can't sneak through", () => {
      expect(isValidDriftLookback(Number.NaN)).toBe(false);
    });
  });

  describe("parseDriftLookback", () => {
    it("accepts the supported options expressed as decimal strings", () => {
      expect(parseDriftLookback("4")).toBe(4);
      expect(parseDriftLookback("8")).toBe(8);
      expect(parseDriftLookback("13")).toBe(13);
      expect(parseDriftLookback("26")).toBe(26);
    });

    it("treats null, undefined and the empty string as 'no value' (returns null)", () => {
      // The empty-string case matters: useSearchParams returns "" for
      // `?driftWeeks=` and we must NOT coerce that into 0.
      expect(parseDriftLookback(null)).toBeNull();
      expect(parseDriftLookback(undefined)).toBeNull();
      expect(parseDriftLookback("")).toBeNull();
    });

    it("rejects malformed and out-of-range strings so the panel falls back to the default", () => {
      expect(parseDriftLookback("abc")).toBeNull();
      expect(parseDriftLookback("0")).toBeNull();
      expect(parseDriftLookback("99")).toBeNull();
      expect(parseDriftLookback("8.5")).toBeNull();
      expect(parseDriftLookback("-8")).toBeNull();
      expect(parseDriftLookback(" ")).toBeNull();
      // " 8 " becomes 8 via Number(...) so it currently parses; lock that
      // behaviour explicitly so any future tightening is a deliberate choice.
      expect(parseDriftLookback(" 8 ")).toBe(8);
    });
  });

  describe("readStoredDriftLookback", () => {
    // happy-dom gives us a real window.localStorage; make sure each test
    // starts from a clean slate so order doesn't matter.
    function clearStorage() {
      window.localStorage.removeItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY);
    }

    it("returns null when nothing has been stored yet", () => {
      clearStorage();
      expect(readStoredDriftLookback()).toBeNull();
    });

    it("returns the stored value when it is one of the supported options", () => {
      clearStorage();
      window.localStorage.setItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY, "26");
      expect(readStoredDriftLookback()).toBe(26);
    });

    it("returns null for a stale/garbage stored value so the panel can fall back to the default", () => {
      // Simulates a build that previously wrote a value the current code no
      // longer accepts (e.g. someone hand-edited storage, or an old version
      // stored "abc"). The reader must go through parseDriftLookback so a
      // stale entry can't crash or skew the panel.
      clearStorage();
      window.localStorage.setItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY, "abc");
      expect(readStoredDriftLookback()).toBeNull();

      window.localStorage.setItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY, "99");
      expect(readStoredDriftLookback()).toBeNull();

      window.localStorage.setItem(AVRI_DRIFT_LOOKBACK_STORAGE_KEY, "");
      expect(readStoredDriftLookback()).toBeNull();

      clearStorage();
    });
  });
});

describe("describeHandwavyDisabledReason (Task #337 — visible disabled-reason caption)", () => {
  it("returns the missing-token hint first when mutations are blocked", () => {
    expect(
      describeHandwavyDisabledReason({
        mutationsAllowed: false,
        cooldownActive: true,
        cooldownSecondsRemaining: 5,
        rowEditingActive: true,
        bulkBusy: true,
        inFlight: true,
        extraReason: "ignored",
      }),
    ).toBe(
      "Reviewer token is missing or invalid — see the warning banner above the calibration card.",
    );
  });

  it("surfaces an active calibration cooldown ahead of row/bulk/in-flight reasons", () => {
    const out = describeHandwavyDisabledReason({
      mutationsAllowed: true,
      cooldownActive: true,
      cooldownSecondsRemaining: 7,
      rowEditingActive: true,
      bulkBusy: true,
      inFlight: true,
      extraReason: "ignored",
    });
    expect(out).toBe(
      "Calibration cooldown active for 7s — wait for the wrong-token throttle to clear.",
    );
  });

  it("clamps the displayed cooldown seconds to a minimum of 1", () => {
    const out = describeHandwavyDisabledReason({
      mutationsAllowed: true,
      cooldownActive: true,
      cooldownSecondsRemaining: 0,
    });
    expect(out).toBe(
      "Calibration cooldown active for 1s — wait for the wrong-token throttle to clear.",
    );
  });

  it("falls through to the row-editing reason when no higher-priority gate is active", () => {
    expect(
      describeHandwavyDisabledReason({
        mutationsAllowed: true,
        rowEditingActive: true,
        bulkBusy: true,
        inFlight: true,
        extraReason: "ignored",
      }),
    ).toBe("Another row is being edited — save or cancel that edit first.");
  });

  it("reports a bulk-removal preview/in-flight when only bulkBusy is set", () => {
    expect(
      describeHandwavyDisabledReason({
        mutationsAllowed: true,
        bulkBusy: true,
        inFlight: true,
        extraReason: "ignored",
      }),
    ).toBe(
      "A bulk removal preview is open or in flight — finish or cancel it first.",
    );
  });

  it("uses the inFlight branch with a custom label when provided", () => {
    expect(
      describeHandwavyDisabledReason({
        mutationsAllowed: true,
        inFlight: true,
        inFlightLabel: "Removing this phrase — wait for it to finish.",
        extraReason: "ignored",
      }),
    ).toBe("Removing this phrase — wait for it to finish.");
  });

  it("falls back to a generic in-flight wording when no custom label is provided", () => {
    expect(
      describeHandwavyDisabledReason({
        mutationsAllowed: true,
        inFlight: true,
      }),
    ).toBe("Another action is in progress — wait for it to finish.");
  });

  it("returns the call-site extraReason when no other gate matches", () => {
    expect(
      describeHandwavyDisabledReason({
        mutationsAllowed: true,
        extraReason: "Tick the acknowledgment checkbox above to continue.",
      }),
    ).toBe("Tick the acknowledgment checkbox above to continue.");
  });

  it("returns null when nothing is disabling the control", () => {
    expect(
      describeHandwavyDisabledReason({ mutationsAllowed: true }),
    ).toBeNull();
    expect(
      describeHandwavyDisabledReason({
        mutationsAllowed: true,
        cooldownActive: false,
        rowEditingActive: false,
        bulkBusy: false,
        inFlight: false,
        extraReason: null,
      }),
    ).toBeNull();
  });
});

