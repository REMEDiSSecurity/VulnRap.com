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
  summarizeDatasetHistory,
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
});
