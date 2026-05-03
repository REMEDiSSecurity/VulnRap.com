import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  within,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setCalibrationToken } from "@workspace/api-client-react";
import { resetCalibrationCooldown } from "@/lib/calibration-cooldown";
import { resetCalibrationTokenRejection } from "@/lib/calibration-token-rejection";
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
  DatasetCohortDriftSection,
  DatasetCohortFixtureDeltaSparkline,
  DatasetHistoryMeanSparkline,
  DatasetRotationDensityBar,
  FIXTURE_VS_DATASET_DELTA_WARN_THRESHOLD,
  COHORT_DELTA_WARN_THRESHOLD_OPTIONS,
  COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY,
  isValidCohortDeltaWarnThreshold,
  parseCohortDeltaWarnThreshold,
  readStoredCohortDeltaWarnThreshold,
  sortDatasetSamplesByDistanceFromMean,
  type DatasetSampleRow,
  buildSampleReportLinkResolver,
  type SampleReportLinkCandidate,
  isValidDriftLookback,
  parseDriftLookback,
  readStoredDriftLookback,
  AVRI_DRIFT_LOOKBACK_STORAGE_KEY,
  describeHandwavyDisabledReason,
  BulkRemovalImpactBlock,
  HandwavyPhrasesAdmin,
} from "./feedback-analytics";
import type {
  HandwavyEditEntry,
  HandwavyPhraseSingleRemoveDryRunResponse,
  HandwavyPhraseBatchRemoveDryRunImpact,
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
      expect(revertWouldBeNoop(entry, "hedging", "original reason")).toBe(
        false,
      );
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
    const oneDayAndAHalfAgo = new Date(
      NOW.getTime() - (1 * 24 + 12) * 60 * 60 * 1000,
    ).toISOString();
    expect(productionScanStalenessDays(oneDayAndAHalfAgo, NOW)).toBe(1);
    const justUnderOneDay = new Date(
      NOW.getTime() - (24 * 60 * 60 * 1000 - 1),
    ).toISOString();
    expect(productionScanStalenessDays(justUnderOneDay, NOW)).toBe(0);
  });

  it("treats a sample exactly at the threshold as fresh and one day past as stale", () => {
    // The default threshold is "older than N days" so equality should be fresh.
    const exactlyAtThreshold = new Date(
      NOW.getTime() - PRODUCTION_SCAN_FRESHNESS_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(productionScanStalenessDays(exactlyAtThreshold, NOW)).toBe(
      PRODUCTION_SCAN_FRESHNESS_DAYS,
    );
    expect(isProductionScanStale(exactlyAtThreshold, NOW)).toBe(false);

    const onePastThreshold = new Date(
      NOW.getTime() -
        (PRODUCTION_SCAN_FRESHNESS_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(productionScanStalenessDays(onePastThreshold, NOW)).toBe(
      PRODUCTION_SCAN_FRESHNESS_DAYS + 1,
    );
    expect(isProductionScanStale(onePastThreshold, NOW)).toBe(true);
  });

  it("respects an overridden threshold so callers can probe arbitrary windows", () => {
    const fiveDaysAgo = new Date(
      NOW.getTime() - 5 * 24 * 60 * 60 * 1000,
    ).toISOString();
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

describe("BulkRemovalImpactBlock — production-sample staleness notice (Task #414)", () => {
  // Pins the bulk-removal block's render of the amber stale notice
  // (mirrors the add-time PreviewMatchBlock notice from Task #219).

  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  function makeImpact(
    overrides: Partial<HandwavyPhraseBatchRemoveDryRunImpact> = {},
  ): HandwavyPhraseBatchRemoveDryRunImpact {
    return {
      total: 0,
      byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 0, t4Hallucinated: 0 },
      validDetectionsLost: 0,
      falsePositivesDropped: 0,
      corpusSize: 100,
      sampleMatches: [],
      warning: null,
      oldestCreatedAt: null,
      newestCreatedAt: null,
      archiveTotal: null,
      ...overrides,
    };
  }

  it("renders the amber stale notice with the threshold + day count when the production sample is older than the freshness window", () => {
    const newest = new Date(
      Date.now() - (PRODUCTION_SCAN_FRESHNESS_DAYS + 16) * MS_PER_DAY,
    ).toISOString();
    const oldest = new Date(
      Date.now() - (PRODUCTION_SCAN_FRESHNESS_DAYS + 30) * MS_PER_DAY,
    ).toISOString();

    render(
      <BulkRemovalImpactBlock
        kind="production"
        title="Production reports"
        subtitle="recent N"
        emptyHint="No flagged reports impacted"
        impact={makeImpact({
          oldestCreatedAt: oldest,
          newestCreatedAt: newest,
        })}
      />,
    );

    const notice = screen.getByTestId("handwavy-bulk-preview-production-stale");
    expect(notice).toHaveTextContent(
      `${PRODUCTION_SCAN_FRESHNESS_DAYS}-day freshness window`,
    );
    expect(notice).toHaveTextContent(/Production sample is \d+ days old/);
    const days = Number(notice.getAttribute("data-stale-days"));
    expect(Number.isFinite(days)).toBe(true);
    expect(days).toBeGreaterThan(PRODUCTION_SCAN_FRESHNESS_DAYS);
  });

  it("does NOT render the stale notice when the production sample is fresh (within the freshness window)", () => {
    const newest = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
    const oldest = new Date(Date.now() - 2 * MS_PER_DAY).toISOString();

    render(
      <BulkRemovalImpactBlock
        kind="production"
        title="Production reports"
        subtitle="recent N"
        emptyHint="No flagged reports impacted"
        impact={makeImpact({
          oldestCreatedAt: oldest,
          newestCreatedAt: newest,
        })}
      />,
    );

    expect(
      screen.queryByTestId("handwavy-bulk-preview-production-stale"),
    ).toBeNull();
    // Scan-range subtitle still renders so the absence of the notice
    // reflects a fresh-check, not dropped timestamps.
    expect(
      screen.getByTestId("handwavy-bulk-preview-production-range"),
    ).toBeInTheDocument();
  });

  it("never renders the stale notice on the curated block, even when the curated impact carries timestamps", () => {
    const oldNewest = new Date(
      Date.now() - (PRODUCTION_SCAN_FRESHNESS_DAYS + 60) * MS_PER_DAY,
    ).toISOString();

    render(
      <BulkRemovalImpactBlock
        kind="curated"
        title="Curated fixtures"
        subtitle="benchmark"
        emptyHint="No fixture impact"
        impact={makeImpact({
          oldestCreatedAt: oldNewest,
          newestCreatedAt: oldNewest,
        })}
      />,
    );

    expect(
      screen.queryByTestId("handwavy-bulk-preview-curated-stale"),
    ).toBeNull();
    expect(
      screen.queryByTestId("handwavy-bulk-preview-production-stale"),
    ).toBeNull();
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

  function renderEntries(
    args: Parameters<typeof renderHandwavyEditEntries>[0],
  ) {
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
    expect(describedBy, "disabled button must reference the hint by id").toBe(
      hint.id,
    );
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
    expect(within(noopRow!).getByTestId("handwavy-revert-noop-hint")).toBe(
      hints[0],
    );
  });
});

describe("renderHandwavyEditEntries — rename block (Task #357)", () => {
  // Task #357 surfaces rename entries (recorded as `phrase: { from, to }` on
  // the per-marker edit log) in the audit panel alongside the existing
  // category/rationale diffs. These tests pin the visible wording, the test
  // hooks the E2E spec latches onto, and the "no tracked changes" fallback
  // so future refactors can't silently drop the rename block.

  function renderEntries(
    args: Parameters<typeof renderHandwavyEditEntries>[0],
  ) {
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

describe("renderHandwavyEditEntries — rename-only Revert hint (Task #506)", () => {
  // Task #506 — the per-edit Revert button only restores category and
  // rationale (the server's `revertHandwavyPhraseEdit` ignores the
  // `phrase` field), so a rename-only entry will always look like a
  // no-op to `revertWouldBeNoop`. Pre-Task #506 those rows showed the
  // generic "Already at this state — nothing to revert" wording, which
  // is misleading: there IS something to undo (the rename) — just not
  // through this button. The new wording must point reviewers at the
  // inline phrase edit field for renaming back instead.
  function renderEntries(
    args: Parameters<typeof renderHandwavyEditEntries>[0],
  ) {
    return render(<ul>{renderHandwavyEditEntries(args)}</ul>);
  }

  const renameOnlyEntry: HandwavyEditEntry = {
    editedAt: "2026-04-25T10:00:00.000Z",
    editedBy: "alice@team.com",
    phrase: { from: "we plan to look", to: "we plan to investigate" },
  };

  it("shows a rename-specific hint that points at the inline phrase edit field, not the generic 'already matches prior values' wording", () => {
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

    const button = screen.getByTestId("handwavy-revert-edit");
    // The button is still disabled (the server-side revert can't undo
    // renames), but the surrounding messaging must explain WHY in a way
    // that doesn't lie to the reviewer.
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-noop", "true");

    const hint = screen.getByTestId("handwavy-revert-noop-hint");
    expect(hint).toBeVisible();
    // The rename-only branch is tagged so future selectors / E2E specs
    // can target the two no-op kinds independently without scraping
    // user-visible copy.
    expect(hint).toHaveAttribute("data-noop-kind", "rename-only");
    // Visible copy must mention renames AND the inline phrase edit
    // field — the whole point is to redirect the reviewer at the right
    // affordance.
    expect(hint).toHaveTextContent(/rename/i);
    expect(hint).toHaveTextContent(/inline phrase edit field/i);
    // And it must NOT show the misleading "already matches prior
    // values" / "nothing to undo" wording, which falsely implies the
    // rename can't be reversed.
    expect(hint).not.toHaveTextContent(/already matches/i);
    expect(hint).not.toHaveTextContent(/nothing to undo/i);

    // The accessible description (resolved via aria-describedby) must
    // match the visible caption so screen-reader users get the same
    // redirection a sighted touch user reads.
    expect(button).toHaveAccessibleDescription(/rename/i);
    expect(button).toHaveAccessibleDescription(/inline phrase edit field/i);
  });

  it("keeps the existing 'already matches prior values' wording for category/rationale-only no-op entries", () => {
    // Pinning the negative side of the split: a category-only edit
    // whose `from` value already matches the live marker is a TRUE
    // no-op (there's nothing the server could do, and the inline
    // phrase edit field isn't relevant). The wording for that branch
    // must NOT regress to the rename-specific copy.
    const categoryOnlyNoopEntry: HandwavyEditEntry = {
      editedAt: "2026-04-22T10:00:00.000Z",
      editedBy: "carol@team.com",
      category: { from: "absence", to: "buzzword" },
    };
    renderEntries({
      editsList: [categoryOnlyNoopEntry],
      phrase: "we plan to investigate",
      currentCategory: "absence",
      currentRationale: undefined,
      editing: null,
      busy: null,
      onRevertClick: () => {},
      mutationsAllowed: true,
    });

    const hint = screen.getByTestId("handwavy-revert-noop-hint");
    expect(hint).toHaveAttribute("data-noop-kind", "values-match");
    expect(hint).toHaveTextContent(/already matches/i);
    expect(hint).toHaveTextContent(/nothing to undo/i);
    expect(hint).not.toHaveTextContent(/inline phrase edit field/i);
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
    const a = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "bravo" },
    ]);
    const b = computeHandwavyActiveListVersion([
      { phrase: "bravo" },
      { phrase: "alpha" },
    ]);
    expect(a).toBe(b);
  });

  it("returns a different version when a phrase is added, removed, or replaced", () => {
    const base = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "bravo" },
    ]);
    const added = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "bravo" },
      { phrase: "charlie" },
    ]);
    const removed = computeHandwavyActiveListVersion([{ phrase: "alpha" }]);
    const replaced = computeHandwavyActiveListVersion([
      { phrase: "alpha" },
      { phrase: "delta" },
    ]);
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
    const pair = computeHandwavyActiveListVersion([
      { phrase: "" },
      { phrase: "foo" },
    ]);
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
    expect(formatRemovePreviewScannedAgo(FAKE_NOW - 4_000, FAKE_NOW)).toBe(
      "just now",
    );
    // Boundary: 5s crosses over to integer-seconds.
    expect(formatRemovePreviewScannedAgo(FAKE_NOW - 5_000, FAKE_NOW)).toBe(
      "5s ago",
    );
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
    expect(
      summarizeDatasetHistory({ totalSnapshots: 0, cohorts: [] }).isEmpty,
    ).toBe(true);
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
    expect(summary.tiers.map((t) => t.tier)).toEqual([
      "T1_LEGIT",
      "T2_BORDERLINE",
      "T3_SLOP",
    ]);
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
    const t1 = summary.tiers.find((t) => t.tier === "T1_LEGIT")!;
    // Snapshot count keeps all rows (so the chip says "3 pts") but only
    // the one row with a finite mean is plotted.
    expect(t1.snapshotCount).toBe(3);
    expect(t1.points.map((p) => p.value)).toEqual([16.2]);
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
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 16,
              gap: 10,
            },
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 17,
              gap: 11,
            },
          ],
        },
        {
          tier: "T2_BORDERLINE",
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T2_BORDERLINE",
              label: "borderline",
              count: 25,
              compositeMean: 22,
              gap: 10,
            },
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T2_BORDERLINE",
              label: "borderline",
              count: 25,
              compositeMean: 21,
              gap: 11,
            },
          ],
        },
        {
          tier: "T3_SLOP",
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T3_SLOP",
              label: "ai_slop",
              count: 25,
              compositeMean: 26,
              gap: 10,
            },
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T3_SLOP",
              label: "ai_slop",
              count: 25,
              compositeMean: 28,
              gap: 11,
            },
          ],
        },
      ],
    });
    expect(summary.gapPoints.map((p) => `${p.timestamp}:${p.value}`)).toEqual([
      "2026-04-22T00:00:00.000Z:10",
      "2026-04-23T00:00:00.000Z:11",
    ]);
    expect(summary.latestGap).toBe(11);
  });

  // Task #362 — per-tier dataset-vs-fixture delta series powering the
  // new sparkline inside each Curated Dataset Cohort Means tile.
  it("computes a per-tier deltaPoints series (datasetMean − fixtureMean) chronologically", () => {
    const summary = summarizeDatasetHistory({
      totalSnapshots: 4,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            // Run 1: dataset 78.3, fixtures 82.1 → Δ −3.8 (rounded to 1dp)
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 78.3,
              fixtureMean: 82.1,
              gap: 24,
            },
            // Run 2: dataset 80.0, fixtures 79.5 → Δ +0.5
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 80.0,
              fixtureMean: 79.5,
              gap: 25,
            },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find((t) => t.tier === "T1_LEGIT")!;
    expect(t1.deltaPoints.map((p) => p.value)).toEqual([-3.8, 0.5]);
    expect(t1.deltaPoints.map((p) => p.timestamp)).toEqual([
      "2026-04-22T00:00:00.000Z",
      "2026-04-23T00:00:00.000Z",
    ]);
    expect(t1.latestDelta).toBe(0.5);
  });

  it("skips delta points when either side is missing or non-finite (legacy/empty rows)", () => {
    const summary = summarizeDatasetHistory({
      totalSnapshots: 4,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            // Legacy row predating fixtureMean — fixtureMean undefined.
            {
              timestamp: "2026-04-20T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 75,
              gap: 22,
            },
            // Run with explicit null fixtureMean (e.g. T4 absent in summary).
            {
              timestamp: "2026-04-21T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 76,
              fixtureMean: null,
              gap: 22,
            },
            // Empty cohort that run — compositeMean null filters it out
            // before fixtureMean is even consulted.
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 0,
              compositeMean: null,
              fixtureMean: 80,
              gap: null,
            },
            // NaN fixture mean is treated as missing.
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 77,
              fixtureMean: Number.NaN,
              gap: 22,
            },
            // Valid pair — only this row produces a delta point.
            {
              timestamp: "2026-04-24T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 78,
              fixtureMean: 80,
              gap: 22,
            },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find((t) => t.tier === "T1_LEGIT")!;
    expect(t1.deltaPoints.map((p) => p.value)).toEqual([-2]);
    expect(t1.latestDelta).toBe(-2);
    // Mean snapshot count still reflects every row so the "N pts" chip
    // doesn't lie about the underlying history size.
    expect(t1.snapshotCount).toBe(5);
  });

  it("returns empty deltaPoints (and null latestDelta) for tiers with no fixture-mean coverage", () => {
    const summary = summarizeDatasetHistory({
      totalSnapshots: 1,
      cohorts: [
        {
          tier: "T2_BORDERLINE",
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T2_BORDERLINE",
              label: "borderline",
              count: 25,
              compositeMean: 60,
              gap: 18,
            },
          ],
        },
      ],
    });
    const t2 = summary.tiers.find((t) => t.tier === "T2_BORDERLINE")!;
    expect(t2.deltaPoints).toEqual([]);
    expect(t2.latestDelta).toBeNull();
    // A tier we have no rows for at all also reports no delta points
    // rather than blowing up.
    const t3 = summary.tiers.find((t) => t.tier === "T3_SLOP")!;
    expect(t3.deltaPoints).toEqual([]);
    expect(t3.latestDelta).toBeNull();
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
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T3_SLOP",
              label: "ai_slop",
              count: 25,
              compositeMean: 28,
              gap: 11,
            },
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T3_SLOP",
              label: "ai_slop",
              count: 25,
              compositeMean: 26,
              gap: 10,
            },
          ],
        },
      ],
    });
    expect(summary.gapPoints.map((p) => p.value)).toEqual([10, 11]);
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
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 70,
              gap: 18,
              sampleDateKey: "2026-04-22",
            },
            // Same slice → no rotation between #1 and #2.
            {
              timestamp: "2026-04-22T12:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 71,
              gap: 18,
              sampleDateKey: "2026-04-22",
            },
            // Slice flipped → rotation between #2 and #3.
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 72,
              gap: 19,
              sampleDateKey: "2026-04-23",
            },
            // Slice flipped again → rotation between #3 and #4.
            {
              timestamp: "2026-04-24T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 73,
              gap: 20,
              sampleDateKey: "2026-04-24",
            },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find((t) => t.tier === "T1_LEGIT")!;
    expect(t1.points.map((p) => p.sampleDateKey)).toEqual([
      "2026-04-22",
      "2026-04-22",
      "2026-04-23",
      "2026-04-24",
    ]);
    expect(t1.rotationCount).toBe(2);
    expect(t1.latestSampleDateKey).toBe("2026-04-24");
    expect(summary.latestSampleDateKey).toBe("2026-04-24");
    // Threaded onto the gap series too, so the gap sparkline can mark rotations.
    expect(summary.gapPoints.map((p) => p.sampleDateKey)).toEqual([
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
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 70,
              gap: 18,
            },
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 71,
              gap: 18,
              sampleDateKey: "2026-04-23",
            },
            {
              timestamp: "2026-04-23T12:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 72,
              gap: 18,
              sampleDateKey: "2026-04-23",
            },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find((t) => t.tier === "T1_LEGIT")!;
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
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 70,
              gap: 18,
            },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find((t) => t.tier === "T1_LEGIT")!;
    expect(t1.latestSampleDateKey).toBeNull();
    expect(t1.rotationCount).toBe(0);
    expect(summary.latestSampleDateKey).toBeNull();
  });

  it("threads the per-snapshot `aggregated` flag onto plotted points and counts the agg/raw split per tier and on the gap series (Task #380)", () => {
    // Mixed history — older rows are daily roll-ups (aggregated:true)
    // and the most recent row is raw per-run resolution. The summary
    // should preserve `aggregated` on each plotted point AND surface
    // the rolled-up vs raw counts so the UI can render the dashed
    // prefix and the "X agg + Y raw" chip without re-counting.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 3,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            {
              timestamp: "2026-04-20T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 71.0,
              gap: 19.0,
              aggregated: true,
            },
            {
              timestamp: "2026-04-21T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 71.4,
              gap: 18.6,
              aggregated: true,
            },
            {
              timestamp: "2026-04-22T12:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 72.1,
              gap: 18.0,
            },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find((t) => t.tier === "T1_LEGIT")!;
    // Per-point flag survives so the sparkline can split coords on it.
    expect(t1.points.map((p) => p.aggregated)).toEqual([true, true, undefined]);
    // The summary chip's counts come straight from the series so the UI
    // doesn't have to re-walk the points array on every render.
    expect(t1.aggregatedCount).toBe(2);
    expect(t1.rawCount).toBe(1);
    // Gap dedupe path threads the same flag onto the deduped points so
    // the T1−T3 gap sparkline can split-stroke the same way.
    expect(summary.gapPoints.map((p) => p.aggregated)).toEqual([
      true,
      true,
      undefined,
    ]);
    expect(summary.gapAggregatedCount).toBe(2);
    expect(summary.gapRawCount).toBe(1);
  });

  it("reports zero aggregated counts on a pure-raw history so the legend stays hidden (Task #380)", () => {
    // No `aggregated` flag anywhere — the dashboard should not promise
    // a dashed-prefix legend when there's nothing to point at.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 2,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 70,
              gap: 18,
            },
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 70.5,
              gap: 17.8,
            },
          ],
        },
      ],
    });
    const t1 = summary.tiers.find((t) => t.tier === "T1_LEGIT")!;
    expect(t1.aggregatedCount).toBe(0);
    expect(t1.rawCount).toBe(2);
    expect(summary.gapAggregatedCount).toBe(0);
    expect(summary.gapRawCount).toBe(2);
  });

  // Task #510 — per-UTC-day rotation-density bucket on the gap series so
  // the new visual under the per-tier sparklines can show whether a
  // week had a denser rotation cadence than another at a glance.
  it("buckets slice rotations by the UTC day they landed on and fills 0-rotation days inside the trend window (Task #510)", () => {
    // Two rotations across a 4-day window: one lands on 2026-04-23,
    // one on 2026-04-25. The intervening 2026-04-24 (no rotation) and
    // the leading 2026-04-22 (the first day, anchor) should both
    // appear with count: 0 so the bar stays comparable week-over-week
    // instead of being squashed onto the days that happened to flip.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 5,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 70,
              gap: 18,
              sampleDateKey: "2026-04-22",
            },
            {
              timestamp: "2026-04-22T12:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 71,
              gap: 18,
              sampleDateKey: "2026-04-22",
            },
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 72,
              gap: 19,
              sampleDateKey: "2026-04-23",
            },
            {
              timestamp: "2026-04-24T06:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 72.5,
              gap: 19.2,
              sampleDateKey: "2026-04-23",
            },
            {
              timestamp: "2026-04-25T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 73,
              gap: 20,
              sampleDateKey: "2026-04-25",
            },
          ],
        },
      ],
    });
    expect(summary.rotationsByDay).toEqual([
      { date: "2026-04-22", count: 0 },
      { date: "2026-04-23", count: 1 },
      { date: "2026-04-24", count: 0 },
      { date: "2026-04-25", count: 1 },
    ]);
  });

  it("counts multiple rotations on the same UTC day separately (Task #510)", () => {
    // Pathological-but-possible: two runs in the same UTC day each
    // observe a different sampleDateKey (e.g. an operator backfilled
    // a slice mid-day). Both rotations should fall into the same
    // bucket and sum, so the bar's height honestly reflects density.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 3,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            {
              timestamp: "2026-04-22T01:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 70,
              gap: 18,
              sampleDateKey: "2026-04-22",
            },
            {
              timestamp: "2026-04-22T05:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 71,
              gap: 18,
              sampleDateKey: "2026-04-23",
            },
            {
              timestamp: "2026-04-22T11:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 72,
              gap: 18,
              sampleDateKey: "2026-04-22",
            },
          ],
        },
      ],
    });
    expect(summary.rotationsByDay).toEqual([{ date: "2026-04-22", count: 2 }]);
  });

  it("returns an empty rotation-density series when no slice keys are present (legacy history) (Task #510)", () => {
    // Pure-legacy history: no rotations are observable, so the visual
    // shouldn't render at all. Mirrors the per-tier `rotationCount`
    // staying at 0 in the same scenario.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 2,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 70,
              gap: 18,
            },
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 71,
              gap: 18,
            },
          ],
        },
      ],
    });
    expect(summary.rotationsByDay).toEqual([]);
  });

  it("returns an empty rotation-density series on a single-snapshot history (no rotation observable) (Task #510)", () => {
    // One gap point can't produce an adjacent pair, so there's nothing
    // to bucket. The visual is hidden by the renderer in this case.
    const summary = summarizeDatasetHistory({
      totalSnapshots: 1,
      cohorts: [
        {
          tier: "T1_LEGIT",
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier: "T1_LEGIT",
              label: "human_authentic",
              count: 25,
              compositeMean: 70,
              gap: 18,
              sampleDateKey: "2026-04-22",
            },
          ],
        },
      ],
    });
    expect(summary.rotationsByDay).toEqual([]);
  });

  it("returns an empty rotation-density series on the dataset-not-mounted empty state (Task #510)", () => {
    // Mirrors the rest of the card — the bar must not render in the
    // empty state. `summary.isEmpty` is the gate the renderer uses;
    // `rotationsByDay` is empty for free here because there are no
    // gap points to walk.
    const summary = summarizeDatasetHistory({ totalSnapshots: 0, cohorts: [] });
    expect(summary.isEmpty).toBe(true);
    expect(summary.rotationsByDay).toEqual([]);
  });
});

describe("DatasetRotationDensityBar (Task #510 — per-UTC-day rotation density underneath the cohort drift sparklines)", () => {
  it("renders nothing when the bucket array is empty so the legacy / empty-state branch stays clean", () => {
    const { container } = render(<DatasetRotationDensityBar buckets={[]} />);
    expect(container.querySelector("svg")).toBeNull();
    expect(
      container.querySelector(
        "[data-testid='dataset-cohort-drift-rotation-density']",
      ),
    ).toBeNull();
  });

  it("renders one bar per UTC day with a hover-friendly count and a summary aria-label", () => {
    render(
      <DatasetRotationDensityBar
        buckets={[
          { date: "2026-04-22", count: 0 },
          { date: "2026-04-23", count: 2 },
          { date: "2026-04-24", count: 1 },
        ]}
      />,
    );
    const svg = screen.getByTestId("dataset-cohort-drift-rotation-density");
    // One <rect> per bucket, regardless of whether the day rotated.
    const rects = svg.querySelectorAll("rect");
    expect(rects.length).toBe(3);
    // Days with rotations carry the bar test id and expose their count
    // via data-* and a native SVG <title> so hover surfaces it.
    const filledBars = svg.querySelectorAll(
      "[data-testid='dataset-cohort-drift-rotation-density-bar']",
    );
    expect(filledBars.length).toBe(2);
    const filledByDate = new Map<string, Element>();
    for (const bar of Array.from(filledBars)) {
      filledByDate.set(bar.getAttribute("data-date")!, bar);
    }
    expect(filledByDate.get("2026-04-23")?.getAttribute("data-count")).toBe(
      "2",
    );
    expect(filledByDate.get("2026-04-24")?.getAttribute("data-count")).toBe(
      "1",
    );
    expect(
      filledByDate.get("2026-04-23")?.querySelector("title")?.textContent,
    ).toBe("2026-04-23 UTC: 2 slice rotations");
    expect(
      filledByDate.get("2026-04-24")?.querySelector("title")?.textContent,
    ).toBe("2026-04-24 UTC: 1 slice rotation");
    // Days with zero rotations get the empty-day marker so the time
    // axis stays continuous but the bar reads as background.
    const emptyDays = svg.querySelectorAll(
      "[data-testid='dataset-cohort-drift-rotation-density-empty-day']",
    );
    expect(emptyDays.length).toBe(1);
    expect(emptyDays[0]!.getAttribute("data-date")).toBe("2026-04-22");
    expect(emptyDays[0]!.getAttribute("data-count")).toBe("0");
    expect(emptyDays[0]!.querySelector("title")?.textContent).toBe(
      "2026-04-22 UTC: 0 slice rotations",
    );
    // Top-level aria-label / <title> reports the totals so screen-
    // reader users get the same context as hover users.
    expect(svg.getAttribute("aria-label")).toBe(
      "3 slice rotations across 3 UTC days (2026-04-22 → 2026-04-24)",
    );
  });

  it("renders a bar that's visibly taller for higher-count days (height scales with count)", () => {
    render(
      <DatasetRotationDensityBar
        buckets={[
          { date: "2026-04-22", count: 1 },
          { date: "2026-04-23", count: 4 },
        ]}
      />,
    );
    const svg = screen.getByTestId("dataset-cohort-drift-rotation-density");
    const bars = Array.from(
      svg.querySelectorAll(
        "[data-testid='dataset-cohort-drift-rotation-density-bar']",
      ),
    );
    const byDate = new Map(
      bars.map((b) => [b.getAttribute("data-date")!, b] as const),
    );
    const shortH = Number(byDate.get("2026-04-22")!.getAttribute("height"));
    const tallH = Number(byDate.get("2026-04-23")!.getAttribute("height"));
    expect(Number.isFinite(shortH)).toBe(true);
    expect(Number.isFinite(tallH)).toBe(true);
    expect(tallH).toBeGreaterThan(shortH);
  });
});

describe("DatasetCohortFixtureDeltaSparkline (Task #362 — per-tier dataset-vs-fixture drift sparkline)", () => {
  it("renders the empty-history hint when no points are supplied", () => {
    render(
      <DatasetCohortFixtureDeltaSparkline points={[]} isDivergent={false} />,
    );
    expect(
      screen.getByTestId("dataset-cohort-fixture-delta-sparkline-empty"),
    ).toHaveTextContent(/no delta history/i);
  });

  it("renders the single-snapshot hint with a signed delta when only one point is supplied", () => {
    render(
      <DatasetCohortFixtureDeltaSparkline
        points={[{ timestamp: "2026-04-22T00:00:00.000Z", value: -3.8 }]}
        isDivergent={false}
      />,
    );
    expect(
      screen.getByTestId("dataset-cohort-fixture-delta-sparkline-single"),
    ).toHaveTextContent(/1 snapshot · Δ-3\.8/);
  });

  it("draws the sparkline svg with the warn band, polyline, and current point when 2+ points are supplied", () => {
    render(
      <DatasetCohortFixtureDeltaSparkline
        points={[
          { timestamp: "2026-04-22T00:00:00.000Z", value: -3.8 },
          { timestamp: "2026-04-23T00:00:00.000Z", value: -1.2 },
          { timestamp: "2026-04-24T00:00:00.000Z", value: 0.5 },
        ]}
        isDivergent={false}
      />,
    );
    const svg = screen.getByTestId("dataset-cohort-fixture-delta-sparkline");
    // Tooltip exposes the first→last summary so screen-reader users
    // and hover users get the same actionable info.
    expect(svg).toHaveAttribute(
      "aria-label",
      expect.stringContaining("3 snapshots: Δ-3.8 → Δ+0.5"),
    );
    expect(svg).toHaveAttribute(
      "aria-label",
      expect.stringContaining("warn band ±5"),
    );
    // Warn band rect + zero baseline + polyline + current-point circle
    // all need to be present so the visual contract from the task spec
    // ("shades the band around 0 and highlights the current point") is
    // covered by a structural assertion.
    expect(svg.querySelector("rect")).not.toBeNull();
    expect(svg.querySelectorAll("line").length).toBeGreaterThanOrEqual(1);
    const polyline = svg.querySelector("polyline");
    expect(polyline).not.toBeNull();
    // Polyline should have one coordinate pair per supplied point.
    expect(polyline!.getAttribute("points")!.trim().split(/\s+/).length).toBe(
      3,
    );
    expect(svg.querySelector("circle")).not.toBeNull();
  });

  it("colours the current point with the divergent treatment when the tile is in warn state", () => {
    const { rerender } = render(
      <DatasetCohortFixtureDeltaSparkline
        points={[
          { timestamp: "2026-04-22T00:00:00.000Z", value: 1 },
          { timestamp: "2026-04-23T00:00:00.000Z", value: 6.5 },
        ]}
        isDivergent={true}
      />,
    );
    const divergentSvg = screen.getByTestId(
      "dataset-cohort-fixture-delta-sparkline",
    );
    const divergentFill = divergentSvg
      .querySelector("circle")!
      .getAttribute("fill");
    rerender(
      <DatasetCohortFixtureDeltaSparkline
        points={[
          { timestamp: "2026-04-22T00:00:00.000Z", value: 1 },
          { timestamp: "2026-04-23T00:00:00.000Z", value: 2 },
        ]}
        isDivergent={false}
      />,
    );
    const calmFill = screen
      .getByTestId("dataset-cohort-fixture-delta-sparkline")
      .querySelector("circle")!
      .getAttribute("fill");
    // The actual colour values are an implementation detail; what
    // matters is that the divergent and calm states render different
    // fills so the sparkline tracks the same warn treatment as the
    // tile's numeric Δ line above it.
    expect(divergentFill).not.toBe(calmFill);
    expect(divergentFill).toBeTruthy();
  });

  it("splits the polyline into a dashed aggregated prefix and a solid raw suffix sharing the boundary point (Task #380)", () => {
    // 4 points: first two are daily roll-ups, last two are raw. The
    // aggregated segment must cover indices 0..2 and the raw segment
    // 2..3 so the boundary point is shared (line stays continuous).
    render(
      <DatasetCohortFixtureDeltaSparkline
        points={[
          {
            timestamp: "2026-04-20T00:00:00.000Z",
            value: -3.0,
            aggregated: true,
          },
          {
            timestamp: "2026-04-21T00:00:00.000Z",
            value: -2.5,
            aggregated: true,
          },
          { timestamp: "2026-04-22T00:00:00.000Z", value: -1.0 },
          { timestamp: "2026-04-23T00:00:00.000Z", value: 0.5 },
        ]}
        isDivergent={false}
      />,
    );
    const svg = screen.getByTestId("dataset-cohort-fixture-delta-sparkline");
    const aggSeg = svg.querySelector(
      "[data-testid='dataset-cohort-fixture-delta-aggregated-segment']",
    );
    const rawSeg = svg.querySelector(
      "[data-testid='dataset-cohort-fixture-delta-raw-segment']",
    );
    expect(aggSeg).not.toBeNull();
    expect(rawSeg).not.toBeNull();
    // Aggregated prefix is dashed at reduced opacity so reviewers can
    // tell rolled-up history from raw points at a glance.
    expect(aggSeg!.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(rawSeg!.getAttribute("stroke-dasharray")).toBeNull();
    // Boundary point (index 2) is shared between the two segments so
    // the polyline stays continuous.
    const aggCoords = aggSeg!.getAttribute("points")!.trim().split(/\s+/);
    const rawCoords = rawSeg!.getAttribute("points")!.trim().split(/\s+/);
    expect(aggCoords.length).toBe(3);
    expect(rawCoords.length).toBe(2);
    expect(aggCoords[2]).toBe(rawCoords[0]);
    // Tooltip surfaces the same X agg + Y raw breakdown the per-tier
    // chip uses so screen-reader and hover users get the same context.
    expect(svg.getAttribute("aria-label")).toContain(
      "2 daily aggregates + 2 raw",
    );
  });

  it("renders only the solid suffix (no dashed prefix) on a pure-raw history (Task #380)", () => {
    render(
      <DatasetCohortFixtureDeltaSparkline
        points={[
          { timestamp: "2026-04-22T00:00:00.000Z", value: -1.0 },
          { timestamp: "2026-04-23T00:00:00.000Z", value: 0.5 },
        ]}
        isDivergent={false}
      />,
    );
    const svg = screen.getByTestId("dataset-cohort-fixture-delta-sparkline");
    expect(
      svg.querySelector(
        "[data-testid='dataset-cohort-fixture-delta-aggregated-segment']",
      ),
    ).toBeNull();
    expect(
      svg.querySelector(
        "[data-testid='dataset-cohort-fixture-delta-raw-segment']",
      ),
    ).not.toBeNull();
    // Aria-label should not promise a roll-up split when there isn't one.
    expect(svg.getAttribute("aria-label")).not.toContain("daily aggregate");
  });
});

describe("DatasetCohortDriftSection (Task #515 — surface the dataset-vs-fixture trend on the standalone Drift panel)", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      // The /config endpoint feeds the rollup-window editor at the top
      // of the panel; we don't care about it for this assertion, so
      // 404 it (the panel tolerates that path silently).
      if (url.includes("/api/test/dataset-history/config")) {
        return jsonResponse({ error: "not found" }, 404);
      }
      if (url.includes("/api/test/dataset-history")) {
        // Two snapshots per tier with finite fixtureMean so each tier
        // produces a 2-point deltaPoints series and the
        // `DatasetCohortFixtureDeltaSparkline` falls into the polyline
        // branch (rather than the empty/single-snapshot fallback).
        const mkCohort = (
          tier: string,
          a: { dataset: number; fixture: number; gap: number },
          b: { dataset: number; fixture: number; gap: number },
        ) => ({
          tier,
          snapshots: [
            {
              timestamp: "2026-04-22T00:00:00.000Z",
              tier,
              label: tier,
              count: 25,
              compositeMean: a.dataset,
              fixtureMean: a.fixture,
              gap: a.gap,
            },
            {
              timestamp: "2026-04-23T00:00:00.000Z",
              tier,
              label: tier,
              count: 25,
              compositeMean: b.dataset,
              fixtureMean: b.fixture,
              gap: b.gap,
            },
          ],
        });
        return jsonResponse({
          totalSnapshots: 6,
          cohorts: [
            // T1: latest Δ = +1.0 → calm caption.
            mkCohort(
              "T1_LEGIT",
              { dataset: 70, fixture: 71, gap: 50 },
              { dataset: 72, fixture: 71, gap: 52 },
            ),
            // T2: latest Δ = -2.0 → still calm.
            mkCohort(
              "T2_BORDERLINE",
              { dataset: 50, fixture: 51, gap: 0 },
              { dataset: 49, fixture: 51, gap: 0 },
            ),
            // T3: latest Δ = +8.0 (|Δ| > warn threshold of 5) →
            // divergent caption + matching sparkline treatment.
            mkCohort(
              "T3_SLOP",
              { dataset: 22, fixture: 20, gap: 50 },
              { dataset: 28, fixture: 20, gap: 44 },
            ),
          ],
        });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function renderSection() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/feedback-analytics"]}>
          <DatasetCohortDriftSection />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("renders the per-tier dataset-vs-fixture sparkline + signed Δ caption inside every drift tile", async () => {
    renderSection();

    // Wait for the panel to swap from the loading skeleton to its
    // populated tile grid before asserting on the new sparkline.
    await screen.findByTestId("dataset-cohort-drift-tier-T1_LEGIT");

    for (const tier of ["T1_LEGIT", "T2_BORDERLINE", "T3_SLOP"]) {
      const tile = screen.getByTestId(`dataset-cohort-drift-tier-${tier}`);
      // The new "fixture Δ" trend wraps the reused
      // DatasetCohortFixtureDeltaSparkline — assert both the tile-
      // scoped wrapper and the underlying sparkline render.
      const trend = within(tile).getByTestId(
        `dataset-cohort-drift-fixture-delta-trend-${tier}`,
      );
      expect(
        trend.querySelector(
          "[data-testid='dataset-cohort-fixture-delta-sparkline']",
        ),
      ).not.toBeNull();
      // The signed-Δ caption beside the sparkline mirrors the means
      // panel's `Δ+x.x` format so the two cards read consistently.
      expect(
        within(tile).getByTestId(
          `dataset-cohort-drift-fixture-delta-latest-${tier}`,
        ),
      ).toBeInTheDocument();
    }

    // T1's most recent dataset−fixture is 72−71 = +1.0 (calm).
    expect(
      screen.getByTestId("dataset-cohort-drift-fixture-delta-latest-T1_LEGIT"),
    ).toHaveTextContent("Δ+1.0");
    // T2's is 49−51 = -2.0 (still inside the ±5 warn band).
    expect(
      screen.getByTestId(
        "dataset-cohort-drift-fixture-delta-latest-T2_BORDERLINE",
      ),
    ).toHaveTextContent("Δ-2.0");
    // T3's is 28−20 = +8.0 — past the warn threshold so the caption
    // flips to the divergent treatment that matches the means tile.
    const t3Caption = screen.getByTestId(
      "dataset-cohort-drift-fixture-delta-latest-T3_SLOP",
    );
    expect(t3Caption).toHaveTextContent("Δ+8.0");
    expect(t3Caption.className).toContain("text-orange-400");
  });
});

describe("DatasetHistoryMeanSparkline (Task #380 — split-stroke for daily roll-up vs raw points)", () => {
  it("splits the polyline into a dashed aggregated prefix and a solid raw suffix sharing the boundary point", () => {
    // 3 daily roll-ups followed by 2 raw per-run snapshots — same shape
    // we expect when the compactor has rewritten history older than the
    // configured rollup window. The aggregated polyline must include
    // the boundary index so the line stays continuous when joined to
    // the raw suffix.
    const { container } = render(
      <DatasetHistoryMeanSparkline
        points={[
          {
            timestamp: "2026-04-18T00:00:00.000Z",
            value: 70.1,
            aggregated: true,
          },
          {
            timestamp: "2026-04-19T00:00:00.000Z",
            value: 71.0,
            aggregated: true,
          },
          {
            timestamp: "2026-04-20T00:00:00.000Z",
            value: 71.4,
            aggregated: true,
          },
          { timestamp: "2026-04-21T00:00:00.000Z", value: 72.0 },
          { timestamp: "2026-04-22T00:00:00.000Z", value: 72.3 },
        ]}
      />,
    );
    const svg = container.querySelector("svg")!;
    const aggSeg = svg.querySelector(
      "[data-testid='dataset-cohort-drift-aggregated-segment']",
    );
    const rawSeg = svg.querySelector(
      "[data-testid='dataset-cohort-drift-raw-segment']",
    );
    expect(aggSeg).not.toBeNull();
    expect(rawSeg).not.toBeNull();
    // Dashed prefix must be visually distinct from the solid suffix.
    expect(aggSeg!.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(rawSeg!.getAttribute("stroke-dasharray")).toBeNull();
    // Boundary point (the last aggregated point at index 2) is shared.
    const aggCoords = aggSeg!.getAttribute("points")!.trim().split(/\s+/);
    const rawCoords = rawSeg!.getAttribute("points")!.trim().split(/\s+/);
    expect(aggCoords.length).toBe(4);
    expect(rawCoords.length).toBe(2);
    expect(aggCoords[3]).toBe(rawCoords[0]);
    // Tooltip / aria-label exposes the breakdown so screen-reader users
    // get the same context as hover users.
    expect(svg.getAttribute("aria-label")).toContain(
      "3 daily aggregates + 2 raw",
    );
  });

  it("renders only the solid suffix on a pure-raw history (no dashed prefix)", () => {
    const { container } = render(
      <DatasetHistoryMeanSparkline
        points={[
          { timestamp: "2026-04-22T00:00:00.000Z", value: 70.0 },
          { timestamp: "2026-04-23T00:00:00.000Z", value: 70.5 },
          { timestamp: "2026-04-24T00:00:00.000Z", value: 71.0 },
        ]}
      />,
    );
    const svg = container.querySelector("svg")!;
    expect(
      svg.querySelector(
        "[data-testid='dataset-cohort-drift-aggregated-segment']",
      ),
    ).toBeNull();
    expect(
      svg.querySelector("[data-testid='dataset-cohort-drift-raw-segment']"),
    ).not.toBeNull();
    expect(svg.getAttribute("aria-label")).not.toContain("daily aggregate");
  });

  it("renders only the dashed prefix on a pure-aggregated history (no solid suffix)", () => {
    // Edge case: every snapshot is daily-rolled (older than the rollup
    // window). The line should be entirely dashed and the tooltip
    // should still report the agg/raw split so the chip and the
    // sparkline tell the same story.
    const { container } = render(
      <DatasetHistoryMeanSparkline
        points={[
          {
            timestamp: "2026-04-18T00:00:00.000Z",
            value: 69.8,
            aggregated: true,
          },
          {
            timestamp: "2026-04-19T00:00:00.000Z",
            value: 70.4,
            aggregated: true,
          },
          {
            timestamp: "2026-04-20T00:00:00.000Z",
            value: 70.9,
            aggregated: true,
          },
        ]}
      />,
    );
    const svg = container.querySelector("svg")!;
    const aggSeg = svg.querySelector(
      "[data-testid='dataset-cohort-drift-aggregated-segment']",
    );
    expect(aggSeg).not.toBeNull();
    expect(aggSeg!.getAttribute("stroke-dasharray")).toBeTruthy();
    expect(
      svg.querySelector("[data-testid='dataset-cohort-drift-raw-segment']"),
    ).toBeNull();
    expect(svg.getAttribute("aria-label")).toContain(
      "3 daily aggregates + 0 raw",
    );
  });

  it("annotates the single-snapshot fallback as '1 daily aggregate' when the only point is rolled up", () => {
    // The fallback branch (points.length === 1) shouldn't mislead
    // reviewers into thinking the lone point is raw resolution.
    const { container } = render(
      <DatasetHistoryMeanSparkline
        points={[
          {
            timestamp: "2026-04-22T00:00:00.000Z",
            value: 70.0,
            aggregated: true,
          },
        ]}
      />,
    );
    expect(container.textContent).toMatch(/1 daily aggregate · 70\.0/);
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
    expect(computeCohortFixtureDelta(null, 70)).toEqual({
      delta: null,
      isDivergent: false,
    });
    // Synthetic summary didn't include this tier (e.g. T2 missing).
    expect(computeCohortFixtureDelta(70, null)).toEqual({
      delta: null,
      isDivergent: false,
    });
    // Both missing — same: silent.
    expect(computeCohortFixtureDelta(null, null)).toEqual({
      delta: null,
      isDivergent: false,
    });
  });

  it("supports an explicit warn threshold override for callers that need a tighter band", () => {
    // A 3pt delta should be flagged once the threshold is tightened to 2pt.
    expect(computeCohortFixtureDelta(73, 70, 2).isDivergent).toBe(true);
    // A 5pt delta should be ignored once the threshold is widened to 10pt,
    // confirming the override travels through both the magnitude and the
    // boundary-strictness logic.
    expect(computeCohortFixtureDelta(75, 70, 10).isDivergent).toBe(false);
  });

  it("flips divergence as the reviewer-tunable threshold sweeps over the delta (Task #363)", () => {
    // A fixed +6pt delta crosses the recalibration-tight 3pt and 5pt
    // boundaries but sits under the steady-state 8pt and 10pt ones — exactly
    // the use case the in-card chooser exists for.
    const dataset = 76;
    const fixture = 70;
    expect(computeCohortFixtureDelta(dataset, fixture, 3).isDivergent).toBe(
      true,
    );
    expect(computeCohortFixtureDelta(dataset, fixture, 5).isDivergent).toBe(
      true,
    );
    expect(computeCohortFixtureDelta(dataset, fixture, 8).isDivergent).toBe(
      false,
    );
    expect(computeCohortFixtureDelta(dataset, fixture, 10).isDivergent).toBe(
      false,
    );
    // The signed delta itself never depends on the threshold.
    for (const t of [3, 5, 8, 10]) {
      expect(computeCohortFixtureDelta(dataset, fixture, t).delta).toBe(6);
    }
  });
});

describe("Cohort delta warn threshold persistence helpers (Task #363 — reviewer-tunable warn band)", () => {
  describe("COHORT_DELTA_WARN_THRESHOLD_OPTIONS", () => {
    it("exposes the four supported sensitivities and includes the legacy 5pt default", () => {
      // Lock the option set so any future change is a deliberate choice the
      // reviewers see in code review (the values map to ⅕ … ⅔ of the dataset
      // T1−T3 gap target of ≥15pt, which is the granularity reviewers care
      // about — see the comment in feedback-analytics.tsx).
      expect([...COHORT_DELTA_WARN_THRESHOLD_OPTIONS]).toEqual([3, 5, 8, 10]);
      // The pre-Task-#363 hard-coded threshold must remain a valid option so
      // the panel keeps its original behaviour for reviewers who never touch
      // the chooser.
      expect(COHORT_DELTA_WARN_THRESHOLD_OPTIONS).toContain(
        FIXTURE_VS_DATASET_DELTA_WARN_THRESHOLD,
      );
    });
  });

  describe("isValidCohortDeltaWarnThreshold", () => {
    it("accepts each of the four supported numeric options", () => {
      expect(isValidCohortDeltaWarnThreshold(3)).toBe(true);
      expect(isValidCohortDeltaWarnThreshold(5)).toBe(true);
      expect(isValidCohortDeltaWarnThreshold(8)).toBe(true);
      expect(isValidCohortDeltaWarnThreshold(10)).toBe(true);
    });

    it("rejects neighbouring numbers, fractions, and NaN so a Number(...) parse can't sneak through", () => {
      expect(isValidCohortDeltaWarnThreshold(0)).toBe(false);
      expect(isValidCohortDeltaWarnThreshold(4)).toBe(false);
      expect(isValidCohortDeltaWarnThreshold(6)).toBe(false);
      expect(isValidCohortDeltaWarnThreshold(11)).toBe(false);
      expect(isValidCohortDeltaWarnThreshold(99)).toBe(false);
      expect(isValidCohortDeltaWarnThreshold(-5)).toBe(false);
      // Fractions that round to an option are still rejected — exact equality.
      expect(isValidCohortDeltaWarnThreshold(5.5)).toBe(false);
      expect(isValidCohortDeltaWarnThreshold(Number.NaN)).toBe(false);
    });
  });

  describe("parseCohortDeltaWarnThreshold", () => {
    it("accepts the supported options expressed as decimal strings", () => {
      expect(parseCohortDeltaWarnThreshold("3")).toBe(3);
      expect(parseCohortDeltaWarnThreshold("5")).toBe(5);
      expect(parseCohortDeltaWarnThreshold("8")).toBe(8);
      expect(parseCohortDeltaWarnThreshold("10")).toBe(10);
    });

    it("treats null, undefined and the empty string as 'no value' (returns null)", () => {
      // The empty-string case matters: useSearchParams returns "" for
      // `?cohortDeltaWarn=` and we must NOT coerce that into 0.
      expect(parseCohortDeltaWarnThreshold(null)).toBeNull();
      expect(parseCohortDeltaWarnThreshold(undefined)).toBeNull();
      expect(parseCohortDeltaWarnThreshold("")).toBeNull();
    });

    it("rejects malformed and out-of-range strings so the panel falls back to the default", () => {
      expect(parseCohortDeltaWarnThreshold("abc")).toBeNull();
      expect(parseCohortDeltaWarnThreshold("0")).toBeNull();
      expect(parseCohortDeltaWarnThreshold("4")).toBeNull();
      expect(parseCohortDeltaWarnThreshold("99")).toBeNull();
      expect(parseCohortDeltaWarnThreshold("5.5")).toBeNull();
      expect(parseCohortDeltaWarnThreshold("-5")).toBeNull();
      expect(parseCohortDeltaWarnThreshold(" ")).toBeNull();
    });
  });

  describe("readStoredCohortDeltaWarnThreshold", () => {
    function clearStorage() {
      window.localStorage.removeItem(COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY);
    }

    it("returns null when nothing has been stored yet", () => {
      clearStorage();
      expect(readStoredCohortDeltaWarnThreshold()).toBeNull();
    });

    it("round-trips each supported option through localStorage", () => {
      // Persistence is the whole point of Task #363's URL+storage pattern —
      // pin a write/read cycle for every option, not just one, so a future
      // option-set tweak surfaces here instead of as a silent persistence
      // regression in production.
      for (const opt of COHORT_DELTA_WARN_THRESHOLD_OPTIONS) {
        clearStorage();
        window.localStorage.setItem(
          COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY,
          String(opt),
        );
        expect(readStoredCohortDeltaWarnThreshold()).toBe(opt);
      }
      clearStorage();
    });

    it("returns null for a stale/garbage stored value so the panel can fall back to the default", () => {
      // Simulates a build that previously wrote a value the current code no
      // longer accepts (e.g. someone hand-edited storage, or an old version
      // stored "abc"). The reader must go through parseCohortDeltaWarnThreshold
      // so a stale entry can't crash or skew the panel.
      clearStorage();
      window.localStorage.setItem(
        COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY,
        "abc",
      );
      expect(readStoredCohortDeltaWarnThreshold()).toBeNull();

      window.localStorage.setItem(
        COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY,
        "99",
      );
      expect(readStoredCohortDeltaWarnThreshold()).toBeNull();

      window.localStorage.setItem(COHORT_DELTA_WARN_THRESHOLD_STORAGE_KEY, "");
      expect(readStoredCohortDeltaWarnThreshold()).toBeNull();

      clearStorage();
    });
  });
});

describe("sortDatasetSamplesByDistanceFromMean (Task #255 — surface cohort outliers first)", () => {
  const make = (id: string, composite: number): DatasetSampleRow => ({
    id,
    label: "human_authentic",
    tier: "T1_LEGIT",
    composite,
    e1: null,
    e2: null,
    e3: null,
    triage: "MANUAL_REVIEW",
  });

  it("sorts rows by absolute distance from the cohort mean, descending", () => {
    const rows = [make("a", 80), make("b", 50), make("c", 90), make("d", 75)];
    const sorted = sortDatasetSamplesByDistanceFromMean(rows, 75);
    // |50-75|=25, |90-75|=15, |80-75|=5, |75-75|=0 → b, c, a, d
    expect(sorted.map((r) => r.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("breaks ties on equal distances by report id so the order is stable", () => {
    // Both 70 and 80 are 5 away from 75; tie-break should put "x" before "y".
    const rows = [make("y", 70), make("x", 80), make("z", 75)];
    const sorted = sortDatasetSamplesByDistanceFromMean(rows, 75);
    expect(sorted.map((r) => r.id)).toEqual(["x", "y", "z"]);
  });

  it("does not mutate the input array", () => {
    const rows = [make("a", 80), make("b", 50)];
    const snapshot = rows.map((r) => r.id);
    sortDatasetSamplesByDistanceFromMean(rows, 75);
    expect(rows.map((r) => r.id)).toEqual(snapshot);
  });

  it("returns rows in upstream order when the cohort mean is null (empty cohort)", () => {
    // Without a mean to anchor distance, falling back to the original
    // order is preferable to picking an arbitrary one.
    const rows = [make("c", 90), make("a", 80), make("b", 50)];
    const sorted = sortDatasetSamplesByDistanceFromMean(rows, null);
    expect(sorted.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("handles an empty input without throwing", () => {
    expect(sortDatasetSamplesByDistanceFromMean([], 75)).toEqual([]);
    expect(sortDatasetSamplesByDistanceFromMean([], null)).toEqual([]);
  });
});

describe("buildSampleReportLinkResolver (Task #371 — link sample ids to /verify/<id> when they're in the live feed)", () => {
  const make = (id: number, reportCode: string): SampleReportLinkCandidate => ({
    id,
    reportCode,
  });

  it("resolves a sample id matching a live report's stringified numeric id to /verify/<id>", () => {
    const resolve = buildSampleReportLinkResolver([
      make(42, "VR-002A"),
      make(7, "VR-0007"),
    ]);
    expect(resolve("42")).toBe("/verify/42");
    expect(resolve("7")).toBe("/verify/7");
  });

  it("resolves a sample id matching a live report's reportCode to that report's /verify/<id>", () => {
    // Curated dataset ids occasionally land as the public report code rather
    // than the raw numeric id; both should hop to the same detail route.
    const resolve = buildSampleReportLinkResolver([make(42, "VR-002A")]);
    expect(resolve("VR-002A")).toBe("/verify/42");
  });

  it("returns null for sample ids that aren't in the snapshot so the caller can fall back to plain text", () => {
    const resolve = buildSampleReportLinkResolver([make(42, "VR-002A")]);
    expect(resolve("999")).toBeNull();
    expect(resolve("VR-FFFF")).toBeNull();
    expect(resolve("curated-h1-12345")).toBeNull();
  });

  it("returns null when the snapshot is empty, undefined, or null so the column stays plain text without a feed", () => {
    expect(buildSampleReportLinkResolver([])("42")).toBeNull();
    expect(buildSampleReportLinkResolver(undefined)("42")).toBeNull();
    expect(buildSampleReportLinkResolver(null)("42")).toBeNull();
  });

  it("returns null for an empty-string sample id rather than producing /verify/", () => {
    // Defensive: an empty id from a malformed sample row must not generate a
    // link to the bare /verify/ route, which would render the not-found page.
    const resolve = buildSampleReportLinkResolver([make(42, "VR-002A")]);
    expect(resolve("")).toBeNull();
  });

  it("ignores feed entries with non-positive or non-integer ids so they can't seed a broken link", () => {
    const resolve = buildSampleReportLinkResolver([
      { id: 0, reportCode: "VR-0000" } as SampleReportLinkCandidate,
      { id: -1, reportCode: "VR-NEG" } as SampleReportLinkCandidate,
      { id: 1.5, reportCode: "VR-FRAC" } as SampleReportLinkCandidate,
      make(99, "VR-0063"),
    ]);
    expect(resolve("0")).toBeNull();
    expect(resolve("VR-0000")).toBeNull();
    expect(resolve("VR-NEG")).toBeNull();
    expect(resolve("VR-FRAC")).toBeNull();
    expect(resolve("99")).toBe("/verify/99");
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

// =====================================================================
// Task #452 — calibration UI render-level coverage of the
// `productionScanLimit` wire field on the per-row Trash and the
// rename-edit preview paths.
//
// Both call sites in HandwavyPhrasesAdmin (handleSaveEdit's rename branch
// at the top of the file, and requestRemoveWithImpactPreview that backs
// the per-row Trash button) issue a `removeHandwavyPhrase` DELETE with
// `dryRun: true`. The reviewer-tunable production-scan window is spread
// into the body ONLY when it's been changed away from the
// CALIBRATION_PRODUCTION_SCAN_LIMIT_DEFAULT (2000), preserving the legacy
// "omit when default" wire shape so existing back-end consumers see no
// behavior change for un-tuned reviewers.
//
// Backend tests already pin the request schema; what was missing was a
// UI assertion that the React layer actually attaches (or omits) the
// field correctly. This block renders the real HandwavyPhrasesAdmin
// against a fetch mock that captures the DELETE body and asserts both
// arms of the conditional spread.
// =====================================================================

describe("HandwavyPhrasesAdmin — productionScanLimit attached on remove dry-run (Task #452)", () => {
  const ACTIVE_PHRASE = "vague handwavy phrase";
  const RENAMED_PHRASE = "tuned renamed phrase";
  const TUNED_LIMIT = 500;
  const DEFAULT_LIMIT = 2000;

  // localStorage keys read at HandwavyPhrasesAdmin mount; clear them so
  // each test starts from a known default of "2000" / no reviewer.
  const REVIEWER_KEY = "vulnrap.handwavy.reviewer";
  const PRODUCTION_SCAN_LIMIT_KEY = "vulnrap.calibration.productionScanLimit";
  const LEGACY_PRODUCTION_SCAN_LIMIT_KEY =
    "vulnrap.handwavy.productionScanLimit";

  type CapturedRequest = {
    method: string;
    url: string;
    body: Record<string, unknown> | null;
  };

  const HIGH_IMPACT_DRY_RUN: HandwavyPhraseSingleRemoveDryRunResponse = {
    dryRun: true,
    batch: false,
    wouldRemove: 1,
    notFound: 0,
    duplicateInBatch: 0,
    phrase: ACTIVE_PHRASE,
    raw: ACTIVE_PHRASE,
    removed: false,
    total: 1,
    projectedTotal: 0,
    results: [{ raw: ACTIVE_PHRASE, phrase: ACTIVE_PHRASE, removed: true }],
    dryRunImpact: {
      corpus: {
        total: 4,
        byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 3, t4Hallucinated: 1 },
        // Non-zero so the preview panel opens (and the live DELETE branch
        // is NOT taken). The point of the test is to assert the dry-run
        // body, not what happens after it.
        validDetectionsLost: 4,
        falsePositivesDropped: 0,
        corpusSize: 50,
        sampleMatches: [],
        warning: "would un-flag 4 valid detections",
        oldestCreatedAt: null,
        newestCreatedAt: null,
        archiveTotal: null,
      } satisfies HandwavyPhraseBatchRemoveDryRunImpact,
      production: null,
      productionError: null,
      productionLimit: TUNED_LIMIT,
    },
    phrases: [
      {
        phrase: ACTIVE_PHRASE,
        category: "hedging",
        addedBy: "tester@example.com",
        addedAt: "2026-04-01T10:00:00.000Z",
        rationale: "test fixture",
      },
    ],
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function installFetchMock(): {
    spy: ReturnType<typeof vi.spyOn>;
    captured: CapturedRequest[];
  } {
    const captured: CapturedRequest[] = [];
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();

      // Capture every DELETE on the handwavy-phrases collection so the
      // test can assert the body shape that the per-row Trash and the
      // rename-edit preview pushed onto the wire.
      if (
        method === "DELETE" &&
        url.includes("/api/feedback/calibration/handwavy-phrases") &&
        !url.includes("/handwavy-phrases/")
      ) {
        let parsed: Record<string, unknown> | null = null;
        if (typeof init?.body === "string") {
          try {
            parsed = JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
        }
        captured.push({ method, url, body: parsed });
        return jsonResponse(HIGH_IMPACT_DRY_RUN);
      }

      if (url.includes("/api/feedback/calibration/auth-status")) {
        return jsonResponse({
          serverRequiresToken: false,
          tokenPresented: false,
          tokenValid: false,
          mutationsAllowed: true,
        });
      }

      if (
        url.includes(
          "/api/feedback/calibration/handwavy-phrases/removal-batches",
        )
      ) {
        return jsonResponse({ batches: [], total: 0, hasMore: false });
      }

      if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
        // Single active phrase so the per-row Trash + Edit affordances
        // render. No history, no edits — keeps the row in the simple
        // "no thrash, no rename badges" branch so the click goes
        // straight through requestRemove → requestRemoveWithImpactPreview
        // (cycles.length === 0 < 2 skips the thrash gate).
        return jsonResponse({
          phrases: [
            {
              phrase: ACTIVE_PHRASE,
              category: "hedging",
              addedBy: "tester@example.com",
              addedAt: "2026-04-01T10:00:00.000Z",
              rationale: "test fixture",
            },
          ],
          history: [],
        });
      }

      // Anything else gets a benign 200 so a missed mock doesn't blow
      // up the render with an unhandled rejection.
      return jsonResponse({});
    });
    return { spy, captured };
  }

  function renderAdmin() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/feedback-analytics"]}>
          <HandwavyPhrasesAdmin mutationsAllowed={true} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    // Per-test isolation — every test must see the documented defaults
    // (no reviewer, no persisted production-scan limit, no leftover
    // calibration cooldown / rejected-token state from a sibling test).
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(REVIEWER_KEY);
      window.localStorage.removeItem(PRODUCTION_SCAN_LIMIT_KEY);
      window.localStorage.removeItem(LEGACY_PRODUCTION_SCAN_LIMIT_KEY);
    }
    setCalibrationToken(null);
    resetCalibrationCooldown();
    resetCalibrationTokenRejection();
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    fetchMock.spy.mockRestore();
    setCalibrationToken(null);
    resetCalibrationCooldown();
    resetCalibrationTokenRejection();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(REVIEWER_KEY);
      window.localStorage.removeItem(PRODUCTION_SCAN_LIMIT_KEY);
      window.localStorage.removeItem(LEGACY_PRODUCTION_SCAN_LIMIT_KEY);
    }
  });

  it("attaches the tuned productionScanLimit to the per-row Trash dry-run when the reviewer changed it away from the default", async () => {
    renderAdmin();

    // Wait for the active list to land so the Trash button is rendered.
    const trashButton = await screen.findByTestId(
      "handwavy-remove",
      {},
      { timeout: 5_000 },
    );

    // Tune the shared production-scan window away from the default.
    const limitInput = screen.getByTestId(
      "handwavy-production-scan-limit",
    ) as HTMLInputElement;
    fireEvent.change(limitInput, { target: { value: String(TUNED_LIMIT) } });
    expect(limitInput.value).toBe(String(TUNED_LIMIT));

    fireEvent.click(trashButton);

    // The DELETE dry-run is async; wait for the captured-request log
    // to pick up the call.
    await waitFor(() => {
      expect(
        fetchMock.captured.some(
          (r) => r.method === "DELETE" && r.body?.dryRun === true,
        ),
      ).toBe(true);
    });

    const removeRequest = fetchMock.captured.find(
      (r) => r.method === "DELETE" && r.body?.dryRun === true,
    );
    expect(removeRequest).toBeDefined();
    expect(removeRequest?.body).toMatchObject({
      phrase: ACTIVE_PHRASE,
      dryRun: true,
      productionScanLimit: TUNED_LIMIT,
    });
  });

  it("attaches the tuned productionScanLimit to the rename-edit preview dry-run", async () => {
    renderAdmin();

    // Wait for the row to render.
    const editButton = await screen.findByTestId(
      "handwavy-edit",
      {},
      { timeout: 5_000 },
    );

    // Tune the shared production-scan window away from the default
    // BEFORE entering edit mode (the input gets disabled while the
    // single-phrase preview is open, but it's enabled here).
    const limitInput = screen.getByTestId(
      "handwavy-production-scan-limit",
    ) as HTMLInputElement;
    fireEvent.change(limitInput, { target: { value: String(TUNED_LIMIT) } });
    expect(limitInput.value).toBe(String(TUNED_LIMIT));

    // Enter edit mode and rewrite the phrase to a different normalized
    // form so handleSaveEdit takes the rename branch (which is the
    // path that issues the DELETE dry-run).
    fireEvent.click(editButton);
    const phraseInput = (await screen.findByTestId(
      "handwavy-edit-phrase",
    )) as HTMLInputElement;
    fireEvent.change(phraseInput, { target: { value: RENAMED_PHRASE } });
    expect(phraseInput.value).toBe(RENAMED_PHRASE);

    const saveButton = screen.getByTestId("handwavy-edit-save");
    await act(async () => {
      fireEvent.click(saveButton);
    });

    await waitFor(() => {
      expect(
        fetchMock.captured.some(
          (r) => r.method === "DELETE" && r.body?.dryRun === true,
        ),
      ).toBe(true);
    });

    const renameRequest = fetchMock.captured.find(
      (r) => r.method === "DELETE" && r.body?.dryRun === true,
    );
    expect(renameRequest).toBeDefined();
    // The rename preview always sends the ORIGINAL phrase as the
    // dry-run target — that's the marker the server has to look up
    // before deciding whether the rename would un-flag detections.
    expect(renameRequest?.body).toMatchObject({
      phrase: ACTIVE_PHRASE,
      dryRun: true,
      productionScanLimit: TUNED_LIMIT,
    });
  });

  it("OMITS productionScanLimit from the dry-run body when the reviewer leaves the input at the default 2000", async () => {
    renderAdmin();

    const trashButton = await screen.findByTestId(
      "handwavy-remove",
      {},
      { timeout: 5_000 },
    );

    // Sanity-check that the rendered input is at the documented default
    // — this is the regression we're guarding against. If a future
    // refactor changed the default, the conditional spread would no
    // longer match and the legacy "omit when default" wire shape
    // would silently break.
    const limitInput = screen.getByTestId(
      "handwavy-production-scan-limit",
    ) as HTMLInputElement;
    expect(limitInput.value).toBe(String(DEFAULT_LIMIT));

    fireEvent.click(trashButton);

    await waitFor(() => {
      expect(
        fetchMock.captured.some(
          (r) => r.method === "DELETE" && r.body?.dryRun === true,
        ),
      ).toBe(true);
    });

    const removeRequest = fetchMock.captured.find(
      (r) => r.method === "DELETE" && r.body?.dryRun === true,
    );
    expect(removeRequest).toBeDefined();
    expect(removeRequest?.body).toMatchObject({
      phrase: ACTIVE_PHRASE,
      dryRun: true,
    });
    // Critical assertion: the field must NOT be present when the
    // reviewer hasn't tuned the window. Object-key check (not just
    // value === undefined) so an explicit `productionScanLimit:
    // undefined` would still fail.
    expect(removeRequest?.body).not.toHaveProperty("productionScanLimit");
  });
});

// =====================================================================
// Task #494 — regression test for the per-row Trash preview's "Re-scan"
// affordance. Task #349 added a cached-vs-fresh badge to the open
// preview but offered no way to ask for ground-truth numbers without
// dismissing the panel; Task #494 adds an inline Re-scan button next
// to the cached badge that re-fires the same DELETE dry-run and flips
// the badge back to "Fresh scan" on completion.
//
// To reach a cached preview without leaving the page we Trash the same
// phrase twice in a row: the first click populates the per-row dry-run
// cache and opens the panel with `source: "fresh"`; backing out and
// re-clicking the Trash short-circuits to the cached entry and re-
// opens the panel with `source: "cached"`. Pressing the Re-scan
// button must then issue another DELETE dry-run and flip the badge
// back to "Fresh scan" — the regression we're guarding against is a
// silent revert to the "back-out and re-Trash from another row" hack.
// =====================================================================

describe("HandwavyPhrasesAdmin — Re-scan from cached preview (Task #494)", () => {
  const ACTIVE_PHRASE = "vague handwavy phrase";

  const REVIEWER_KEY = "vulnrap.handwavy.reviewer";
  const PRODUCTION_SCAN_LIMIT_KEY = "vulnrap.calibration.productionScanLimit";
  const LEGACY_PRODUCTION_SCAN_LIMIT_KEY =
    "vulnrap.handwavy.productionScanLimit";

  type CapturedRequest = {
    method: string;
    url: string;
    body: Record<string, unknown> | null;
  };

  const HIGH_IMPACT_DRY_RUN: HandwavyPhraseSingleRemoveDryRunResponse = {
    dryRun: true,
    batch: false,
    wouldRemove: 1,
    notFound: 0,
    duplicateInBatch: 0,
    phrase: ACTIVE_PHRASE,
    raw: ACTIVE_PHRASE,
    removed: false,
    total: 1,
    projectedTotal: 0,
    results: [{ raw: ACTIVE_PHRASE, phrase: ACTIVE_PHRASE, removed: true }],
    dryRunImpact: {
      corpus: {
        total: 4,
        byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 3, t4Hallucinated: 1 },
        // Non-zero so the preview panel actually opens (zero-impact
        // dry-runs short-circuit straight to the live DELETE and never
        // reach the panel we're testing).
        validDetectionsLost: 4,
        falsePositivesDropped: 0,
        corpusSize: 50,
        sampleMatches: [],
        warning: "would un-flag 4 valid detections",
        oldestCreatedAt: null,
        newestCreatedAt: null,
        archiveTotal: null,
      } satisfies HandwavyPhraseBatchRemoveDryRunImpact,
      production: null,
      productionError: null,
      // Default production-scan window — the actual value is irrelevant
      // for this test (we never read it back), but the wire schema
      // requires a number, not null.
      productionLimit: 2000,
    },
    phrases: [
      {
        phrase: ACTIVE_PHRASE,
        category: "hedging",
        addedBy: "tester@example.com",
        addedAt: "2026-04-01T10:00:00.000Z",
        rationale: "test fixture",
      },
    ],
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function installFetchMock(): {
    spy: ReturnType<typeof vi.spyOn>;
    captured: CapturedRequest[];
  } {
    const captured: CapturedRequest[] = [];
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (
        method === "DELETE" &&
        url.includes("/api/feedback/calibration/handwavy-phrases") &&
        !url.includes("/handwavy-phrases/")
      ) {
        let parsed: Record<string, unknown> | null = null;
        if (typeof init?.body === "string") {
          try {
            parsed = JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
        }
        captured.push({ method, url, body: parsed });
        return jsonResponse(HIGH_IMPACT_DRY_RUN);
      }

      if (url.includes("/api/feedback/calibration/auth-status")) {
        return jsonResponse({
          serverRequiresToken: false,
          tokenPresented: false,
          tokenValid: false,
          mutationsAllowed: true,
        });
      }

      if (
        url.includes(
          "/api/feedback/calibration/handwavy-phrases/removal-batches",
        )
      ) {
        return jsonResponse({ batches: [], total: 0, hasMore: false });
      }

      if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
        return jsonResponse({
          phrases: [
            {
              phrase: ACTIVE_PHRASE,
              category: "hedging",
              addedBy: "tester@example.com",
              addedAt: "2026-04-01T10:00:00.000Z",
              rationale: "test fixture",
            },
          ],
          history: [],
        });
      }

      return jsonResponse({});
    });
    return { spy, captured };
  }

  function renderAdmin() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/feedback-analytics"]}>
          <HandwavyPhrasesAdmin mutationsAllowed={true} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(REVIEWER_KEY);
      window.localStorage.removeItem(PRODUCTION_SCAN_LIMIT_KEY);
      window.localStorage.removeItem(LEGACY_PRODUCTION_SCAN_LIMIT_KEY);
    }
    setCalibrationToken(null);
    resetCalibrationCooldown();
    resetCalibrationTokenRejection();
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    fetchMock.spy.mockRestore();
    setCalibrationToken(null);
    resetCalibrationCooldown();
    resetCalibrationTokenRejection();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(REVIEWER_KEY);
      window.localStorage.removeItem(PRODUCTION_SCAN_LIMIT_KEY);
      window.localStorage.removeItem(LEGACY_PRODUCTION_SCAN_LIMIT_KEY);
    }
  });

  function countRemoveDryRunRequests(): number {
    return fetchMock.captured.filter(
      (r) => r.method === "DELETE" && r.body?.dryRun === true,
    ).length;
  }

  it("flips a cached preview back to 'Fresh scan' when the reviewer clicks Re-scan, without dismissing the panel", async () => {
    renderAdmin();

    // Step 1 — first Trash click populates the per-row cache and opens
    // the panel with `source: "fresh"` (one DELETE dry-run on the wire).
    const trashButton = await screen.findByTestId(
      "handwavy-remove",
      {},
      { timeout: 5_000 },
    );
    fireEvent.click(trashButton);

    const panel = await screen.findByTestId(
      "handwavy-remove-preview",
      {},
      { timeout: 5_000 },
    );
    await waitFor(() => {
      expect(
        within(panel).getByTestId("handwavy-remove-preview-source"),
      ).toHaveAttribute("data-source", "fresh");
    });
    await waitFor(() => {
      expect(countRemoveDryRunRequests()).toBe(1);
    });
    // Fresh preview must NOT render a Re-scan button — there's nothing
    // to refresh from the reviewer's perspective when the numbers are
    // already ground truth.
    expect(
      within(panel).queryByTestId("handwavy-remove-preview-rescan"),
    ).not.toBeInTheDocument();

    // Step 2 — back out and re-click Trash. The active list is
    // unchanged so the cached entry is reused and the panel re-opens
    // with `source: "cached"`. No second DELETE dry-run on the wire.
    fireEvent.click(
      within(panel).getByTestId("handwavy-remove-preview-cancel"),
    );
    await waitFor(() => {
      expect(
        screen.queryByTestId("handwavy-remove-preview"),
      ).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("handwavy-remove"));
    const cachedPanel = await screen.findByTestId(
      "handwavy-remove-preview",
      {},
      { timeout: 5_000 },
    );
    await waitFor(() => {
      expect(
        within(cachedPanel).getByTestId("handwavy-remove-preview-source"),
      ).toHaveAttribute("data-source", "cached");
    });
    expect(countRemoveDryRunRequests()).toBe(1);

    // Step 3 — the Re-scan button is rendered next to the cached
    // badge. Capture the cached badge's `data-scanned-at` so we can
    // assert it advances after the re-scan lands.
    const rescanButton = within(cachedPanel).getByTestId(
      "handwavy-remove-preview-rescan",
    );
    expect(rescanButton).toBeVisible();
    const cachedScannedAt = Number(
      within(cachedPanel)
        .getByTestId("handwavy-remove-preview-source")
        .getAttribute("data-scanned-at"),
    );
    expect(Number.isFinite(cachedScannedAt)).toBe(true);

    // Step 4 — click Re-scan. Fires a fresh DELETE dry-run and the
    // panel re-renders with the badge flipped back to "Fresh scan",
    // the Re-scan button itself unmounts, and the cached `scannedAt`
    // anchor advances (or stays equal — the fake timer resolution
    // means we only assert non-decreasing).
    await act(async () => {
      fireEvent.click(rescanButton);
    });

    await waitFor(() => {
      expect(countRemoveDryRunRequests()).toBe(2);
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("handwavy-remove-preview-source"),
      ).toHaveAttribute("data-source", "fresh");
    });
    expect(
      screen.queryByTestId("handwavy-remove-preview-rescan"),
    ).not.toBeInTheDocument();
    const freshScannedAt = Number(
      screen
        .getByTestId("handwavy-remove-preview-source")
        .getAttribute("data-scanned-at"),
    );
    expect(freshScannedAt).toBeGreaterThanOrEqual(cachedScannedAt);

    // The panel itself must still be open — the whole point of the
    // affordance is that the reviewer never had to back out.
    expect(screen.getByTestId("handwavy-remove-preview")).toBeInTheDocument();

    // The Re-scan dry-run must carry the same shape as the original
    // Trash dry-run (same phrase, dryRun: true). The default scan
    // window is omitted on the wire (Task #452 contract).
    const rescanRequest = fetchMock.captured.filter(
      (r) => r.method === "DELETE" && r.body?.dryRun === true,
    )[1];
    expect(rescanRequest).toBeDefined();
    expect(rescanRequest?.body).toMatchObject({
      phrase: ACTIVE_PHRASE,
      dryRun: true,
    });
    expect(rescanRequest?.body).not.toHaveProperty("productionScanLimit");
  });
});

// =====================================================================
// Task #492 — render-level coverage of the rename impact preview's
// fresh-vs-cached badge. Mirrors the per-row Trash preview's badge
// (Task #349) so a reviewer who renames the same phrase twice in a
// row can tell whether the second click reused the prior scan or
// paid for a fresh corpus + production-archive round-trip.
//
// The test mounts the real `HandwavyPhrasesAdmin`, opens the rename
// preview once (asserts the badge reads "Fresh scan" and the panel
// is mounted with `data-source="fresh"`), backs out, re-clicks Save
// on the same rename (asserts the badge reads "Reused scan · just
// now" with `data-source="cached"`), and finally verifies that only
// ONE DELETE dry-run hit the wire across both clicks — proving the
// cache reuse the badge is advertising actually short-circuited the
// fetch.
//
// The pure-helper branching of `describeRemovePreviewSource` itself
// (label / tone for both arms, "Ns ago" rounding, sub-5s collapse,
// negative-skew handling) is already pinned by the Task #349 unit
// tests above; this block specifically pins the rename panel's
// wiring of the helper so a future refactor that drops the
// `source`/`scannedAt` plumbing on `editPreview` (or stops reading
// from the shared dry-run cache) can't land silently.
// =====================================================================

describe("HandwavyPhrasesAdmin — rename impact preview fresh-vs-cached badge (Task #492)", () => {
  const ACTIVE_PHRASE = "vague handwavy phrase";
  const RENAMED_PHRASE = "tuned renamed phrase";

  const REVIEWER_KEY = "vulnrap.handwavy.reviewer";
  const PRODUCTION_SCAN_LIMIT_KEY = "vulnrap.calibration.productionScanLimit";
  const LEGACY_PRODUCTION_SCAN_LIMIT_KEY =
    "vulnrap.handwavy.productionScanLimit";

  type CapturedRequest = {
    method: string;
    url: string;
    body: Record<string, unknown> | null;
  };

  const HIGH_IMPACT_DRY_RUN: HandwavyPhraseSingleRemoveDryRunResponse = {
    dryRun: true,
    batch: false,
    wouldRemove: 1,
    notFound: 0,
    duplicateInBatch: 0,
    phrase: ACTIVE_PHRASE,
    raw: ACTIVE_PHRASE,
    removed: false,
    total: 1,
    projectedTotal: 0,
    results: [{ raw: ACTIVE_PHRASE, phrase: ACTIVE_PHRASE, removed: true }],
    dryRunImpact: {
      corpus: {
        total: 4,
        byTier: { t1Legit: 0, t2Borderline: 0, t3Slop: 3, t4Hallucinated: 1 },
        // Non-zero so the rename preview panel opens (the zero-impact
        // branch would silently PATCH and never render the badge).
        validDetectionsLost: 4,
        falsePositivesDropped: 0,
        corpusSize: 50,
        sampleMatches: [],
        warning: "would un-flag 4 valid detections",
        oldestCreatedAt: null,
        newestCreatedAt: null,
        archiveTotal: null,
      } satisfies HandwavyPhraseBatchRemoveDryRunImpact,
      production: null,
      productionError: null,
      productionLimit: 2000,
    },
    phrases: [
      {
        phrase: ACTIVE_PHRASE,
        category: "hedging",
        addedBy: "tester@example.com",
        addedAt: "2026-04-01T10:00:00.000Z",
        rationale: "test fixture",
      },
    ],
  };

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function installFetchMock(): {
    spy: ReturnType<typeof vi.spyOn>;
    captured: CapturedRequest[];
  } {
    const captured: CapturedRequest[] = [];
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (
        method === "DELETE" &&
        url.includes("/api/feedback/calibration/handwavy-phrases") &&
        !url.includes("/handwavy-phrases/")
      ) {
        let parsed: Record<string, unknown> | null = null;
        if (typeof init?.body === "string") {
          try {
            parsed = JSON.parse(init.body) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
        }
        captured.push({ method, url, body: parsed });
        return jsonResponse(HIGH_IMPACT_DRY_RUN);
      }

      if (url.includes("/api/feedback/calibration/auth-status")) {
        return jsonResponse({
          serverRequiresToken: false,
          tokenPresented: false,
          tokenValid: false,
          mutationsAllowed: true,
        });
      }

      if (
        url.includes(
          "/api/feedback/calibration/handwavy-phrases/removal-batches",
        )
      ) {
        return jsonResponse({ batches: [], total: 0, hasMore: false });
      }

      if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
        return jsonResponse({
          phrases: [
            {
              phrase: ACTIVE_PHRASE,
              category: "hedging",
              addedBy: "tester@example.com",
              addedAt: "2026-04-01T10:00:00.000Z",
              rationale: "test fixture",
            },
          ],
          history: [],
        });
      }

      return jsonResponse({});
    });
    return { spy, captured };
  }

  function renderAdmin() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/feedback-analytics"]}>
          <HandwavyPhrasesAdmin mutationsAllowed={true} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(REVIEWER_KEY);
      window.localStorage.removeItem(PRODUCTION_SCAN_LIMIT_KEY);
      window.localStorage.removeItem(LEGACY_PRODUCTION_SCAN_LIMIT_KEY);
    }
    setCalibrationToken(null);
    resetCalibrationCooldown();
    resetCalibrationTokenRejection();
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    fetchMock.spy.mockRestore();
    setCalibrationToken(null);
    resetCalibrationCooldown();
    resetCalibrationTokenRejection();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(REVIEWER_KEY);
      window.localStorage.removeItem(PRODUCTION_SCAN_LIMIT_KEY);
      window.localStorage.removeItem(LEGACY_PRODUCTION_SCAN_LIMIT_KEY);
    }
  });

  // Helper that walks Edit → rewrite phrase → Save and waits for the
  // rename impact preview panel (and its source badge) to mount.
  async function openRenamePreview(): Promise<HTMLElement> {
    const editButton = await screen.findByTestId(
      "handwavy-edit",
      {},
      { timeout: 5_000 },
    );
    fireEvent.click(editButton);
    const phraseInput = (await screen.findByTestId(
      "handwavy-edit-phrase",
    )) as HTMLInputElement;
    fireEvent.change(phraseInput, { target: { value: RENAMED_PHRASE } });
    const saveButton = screen.getByTestId("handwavy-edit-save");
    await act(async () => {
      fireEvent.click(saveButton);
    });
    return await screen.findByTestId(
      "handwavy-edit-preview-source",
      {},
      { timeout: 5_000 },
    );
  }

  it("renders 'Fresh scan' on the first rename Save and 'Reused scan · just now' on a back-out + re-Save", async () => {
    renderAdmin();

    // First Save → fresh fetch → "Fresh scan" badge with data-source="fresh".
    const freshBadge = await openRenamePreview();
    expect(freshBadge).toHaveAttribute("data-source", "fresh");
    expect(freshBadge).toHaveTextContent("Fresh scan");

    // Capture the fetch count after the first preview lands so we can
    // prove the second click did NOT issue a second DELETE dry-run.
    const dryRunsAfterFirst = fetchMock.captured.filter(
      (r) => r.method === "DELETE" && r.body?.dryRun === true,
    ).length;
    expect(dryRunsAfterFirst).toBe(1);

    // Back out of the rename preview so the panel unmounts.
    fireEvent.click(screen.getByTestId("handwavy-edit-preview-cancel"));
    await waitFor(() =>
      expect(screen.queryByTestId("handwavy-edit-preview")).toBeNull(),
    );

    // Re-Save the same rename. The Edit row stays open after Back out
    // (cancelEditPreview only clears `editPreview`, not `editing`),
    // so the phrase input still carries the renamed value and a
    // single Save click re-enters the rename branch.
    const saveButtonAgain = screen.getByTestId("handwavy-edit-save");
    await act(async () => {
      fireEvent.click(saveButtonAgain);
    });

    const cachedBadge = await screen.findByTestId(
      "handwavy-edit-preview-source",
      {},
      { timeout: 5_000 },
    );
    // Cache hit on the same phrase + production-scan limit + active-
    // list version → the badge flips to "cached" with the same
    // sub-5s "just now" copy the helper renders for fresh writes.
    expect(cachedBadge).toHaveAttribute("data-source", "cached");
    expect(cachedBadge).toHaveTextContent("Reused scan · just now");

    // Critical: the cache short-circuit prevented a second DELETE
    // dry-run from hitting the wire. Without this, the badge would
    // be cosmetic — the panel would say "cached" while the network
    // tab still showed a redundant scan.
    const dryRunsAfterSecond = fetchMock.captured.filter(
      (r) => r.method === "DELETE" && r.body?.dryRun === true,
    ).length;
    expect(dryRunsAfterSecond).toBe(1);
  });
});

// =====================================================================
// Task #460 — regression test for the "About the production scan window"
// reviewer cheat-sheet block that Task #326 added under the shared scan-
// window input (data-testid `handwavy-production-scan-limit-help`).
//
// The block is pure documentation: it has no behavior, no event handlers,
// and no state. Its value is *informational* — it tells the reviewer that
// the input is shared across every production-archive preview, what the
// accepted bounds and default are, and that any pre-#230 legacy
// localStorage value is migrated automatically. Because nothing else in
// the test suite touches it, a future refactor that accidentally deleted
// the block (or stripped one of its bullets) would land silently and
// reviewers would lose the documentation.
//
// This block renders the real `HandwavyPhrasesAdmin` (so the JSX path
// that mounts the help block is exercised end-to-end) and asserts:
//   1. The container with `handwavy-production-scan-limit-help` is in
//      the DOM and visible alongside the input it documents.
//   2. The three documented bullets are each present, by matching on
//      their distinguishing substrings (shared scope, the 100/10000
//      bounds plus 2000 default, and the legacy → calibration key
//      migration). String matches are deliberately loose enough to
//      survive minor copy-edits but tight enough to catch a bullet
//      being silently removed.
// =====================================================================

describe("HandwavyPhrasesAdmin — production-scan-window help block (Task #460 regression for the Task #326 cheat-sheet)", () => {
  const REVIEWER_KEY = "vulnrap.handwavy.reviewer";
  const PRODUCTION_SCAN_LIMIT_KEY = "vulnrap.calibration.productionScanLimit";
  const LEGACY_PRODUCTION_SCAN_LIMIT_KEY =
    "vulnrap.handwavy.productionScanLimit";

  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(REVIEWER_KEY);
      window.localStorage.removeItem(PRODUCTION_SCAN_LIMIT_KEY);
      window.localStorage.removeItem(LEGACY_PRODUCTION_SCAN_LIMIT_KEY);
    }
    setCalibrationToken(null);
    resetCalibrationCooldown();
    resetCalibrationTokenRejection();

    // Minimal fetch mock — the help block is static markup, so we only
    // need the page to mount without unhandled rejections. Every
    // network call returns a benign empty payload.
    fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      if (url.includes("/api/feedback/calibration/auth-status")) {
        return new Response(
          JSON.stringify({
            serverRequiresToken: false,
            tokenPresented: false,
            tokenValid: false,
            mutationsAllowed: true,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (
        url.includes(
          "/api/feedback/calibration/handwavy-phrases/removal-batches",
        )
      ) {
        return new Response(
          JSON.stringify({ batches: [], total: 0, hasMore: false }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
        return new Response(JSON.stringify({ phrases: [], history: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setCalibrationToken(null);
    resetCalibrationCooldown();
    resetCalibrationTokenRejection();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(REVIEWER_KEY);
      window.localStorage.removeItem(PRODUCTION_SCAN_LIMIT_KEY);
      window.localStorage.removeItem(LEGACY_PRODUCTION_SCAN_LIMIT_KEY);
    }
  });

  function renderAdmin() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/feedback-analytics"]}>
          <HandwavyPhrasesAdmin mutationsAllowed={true} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("renders the cheat-sheet block alongside the shared scan-window input", () => {
    renderAdmin();

    // The input the block documents must be present and visible
    // (anchors the block visually and proves we're testing the real
    // form, not a stub).
    const limitInput = screen.getByTestId("handwavy-production-scan-limit");
    expect(limitInput).toBeInTheDocument();
    expect(limitInput).toBeVisible();

    const help = screen.getByTestId("handwavy-production-scan-limit-help");
    expect(help).toBeInTheDocument();
    // Visibility assertion mirrors the task's "asserts the block is
    // visible" requirement — toBeVisible() also catches `hidden`,
    // `display: none`, and zero-opacity regressions that
    // toBeInTheDocument() alone would let through.
    expect(help).toBeVisible();

    // Heading line is what makes the block recognizable to reviewers
    // skimming the form; assert it explicitly so a refactor that kept
    // the container but dropped the title still trips the test.
    expect(
      within(help).getByText(/About the production scan window/i),
    ).toBeInTheDocument();
  });

  it("documents the shared-scope, bounds/default, and legacy-key migration bullets", () => {
    renderAdmin();

    const help = screen.getByTestId("handwavy-production-scan-limit-help");
    const bullets = within(help).getAllByRole("listitem");

    // Three bullets is the contract — the help block exists to convey
    // exactly these three points. Asserting the count guards against a
    // bullet being silently removed (the per-bullet substring matches
    // below would still pass if a fourth bullet were added, but never
    // if one of the three were dropped).
    expect(bullets).toHaveLength(3);

    const bulletTexts = bullets.map((li) => li.textContent ?? "");

    // Bullet 1 — the shared-scope point: one preference reused by every
    // production-archive preview on the page.
    expect(
      bulletTexts.some(
        (t) =>
          /shared/i.test(t) &&
          /add-phrase/i.test(t) &&
          /single-phrase removal/i.test(t) &&
          /bulk-removal/i.test(t),
      ),
    ).toBe(true);

    // Bullet 2 — the 100..10000 bounds with the 2000 default. The
    // numbers come straight from CALIBRATION_PRODUCTION_SCAN_LIMIT_*,
    // so the regex looks for all three literal values appearing
    // together in the same bullet.
    expect(
      bulletTexts.some(
        (t) =>
          /\b100\b/.test(t) &&
          /\b10000\b/.test(t) &&
          /\b2000\b/.test(t) &&
          /default/i.test(t),
      ),
    ).toBe(true);

    // Bullet 3 — the one-time migration from the pre-#230 per-tool
    // localStorage key to the calibration-namespaced one. Both literal
    // key names must appear so the regression catches either name
    // being silently dropped or rewritten.
    expect(
      bulletTexts.some(
        (t) =>
          t.includes("vulnrap.handwavy.productionScanLimit") &&
          t.includes("vulnrap.calibration.productionScanLimit") &&
          /migrat/i.test(t),
      ),
    ).toBe(true);
  });
});

// =====================================================================
// Task #474 — vitest-level coverage of the per-row Undo stack behavior
// originally added by Task #237 / Task #332. The stack-of-undos UX is
// otherwise only covered by artifacts/vulnrap/e2e/handwavy-single-undo
// .spec.ts, which needs a live API server + browser and is skipped in
// inner-loop runs. The four tests below pin:
//   1. SINGLE_UNDO_MAX cap (drops the OLDEST when a 6th remove lands).
//   2. Dedupe-by-phrase on push (a re-Trash on the same phrase
//      replaces the older entry's removedAt instead of stacking a
//      duplicate that would 404 on Undo).
//   3. Undoing a MIDDLE entry leaves only that entry — older AND
//      newer stacked entries stay put.
//   4. The per-entry auto-clear effect — once a phrase reappears on
//      the active list (external reinstate) ONLY its entry leaves;
//      sibling entries for other phrases are untouched.
//
// The mock's request-routing mirrors the existing Task #452 fixture so
// new contributors editing one file see a familiar shape in the other.
// =====================================================================

describe("HandwavyPhrasesAdmin — per-row Undo stack (Task #237 / #332 / #474)", () => {
  const REVIEWER_KEY = "vulnrap.handwavy.reviewer";
  const PRODUCTION_SCAN_LIMIT_KEY = "vulnrap.calibration.productionScanLimit";
  const LEGACY_PRODUCTION_SCAN_LIMIT_KEY =
    "vulnrap.handwavy.productionScanLimit";

  type ActiveMarker = {
    phrase: string;
    category: "absence" | "hedging" | "buzzword";
    addedBy: string;
    addedAt: string;
    rationale: string;
  };

  type Controller = {
    active: Map<string, ActiveMarker>;
    history: Array<Record<string, unknown>>;
    removedAtCounter: number;
    // When false, a live DELETE leaves the active map untouched. The
    // dedupe-by-phrase test uses this to keep the row visible across
    // back-to-back Trash clicks (mirrors the race between a remove
    // and the active-list refetch the dedupe was added to guard).
    autoRemoveOnDelete: boolean;
  };

  let controller: Controller;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function makeMarker(phrase: string): ActiveMarker {
    return {
      phrase,
      category: "hedging",
      addedBy: "tester@example.com",
      addedAt: "2026-04-01T10:00:00.000Z",
      rationale: "test fixture",
    };
  }

  function makeZeroImpactDryRun(
    phrase: string,
  ): HandwavyPhraseSingleRemoveDryRunResponse {
    // Zero-impact dry-run so requestRemoveWithImpactPreview short-
    // circuits straight to the live DELETE — the path that pushes onto
    // the singleUndo stack.
    return {
      dryRun: true,
      batch: false,
      wouldRemove: 1,
      notFound: 0,
      duplicateInBatch: 0,
      phrase,
      raw: phrase,
      removed: false,
      total: controller.active.size,
      projectedTotal: Math.max(0, controller.active.size - 1),
      results: [{ raw: phrase, phrase, removed: true }],
      dryRunImpact: {
        corpus: {
          total: 0,
          byTier: {
            t1Legit: 0,
            t2Borderline: 0,
            t3Slop: 0,
            t4Hallucinated: 0,
          },
          validDetectionsLost: 0,
          falsePositivesDropped: 0,
          corpusSize: 50,
          sampleMatches: [],
          warning: null,
          oldestCreatedAt: null,
          newestCreatedAt: null,
          archiveTotal: null,
        } satisfies HandwavyPhraseBatchRemoveDryRunImpact,
        production: null,
        productionError: null,
        productionLimit: 2000,
      },
      phrases: Array.from(controller.active.values()),
    };
  }

  function nextRemovedAt(): string {
    controller.removedAtCounter += 1;
    const ss = String(controller.removedAtCounter).padStart(2, "0");
    return `2026-05-01T00:00:${ss}.000Z`;
  }

  function installFetchMock(): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(globalThis, "fetch");
    spy.mockImplementation(async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const method = (init?.method ?? "GET").toUpperCase();
      let body: Record<string, unknown> | null = null;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }

      if (url.includes("/api/feedback/calibration/auth-status")) {
        return jsonResponse({
          serverRequiresToken: false,
          tokenPresented: false,
          tokenValid: false,
          mutationsAllowed: true,
        });
      }

      if (
        url.includes(
          "/api/feedback/calibration/handwavy-phrases/removal-batches",
        )
      ) {
        return jsonResponse({ batches: [], total: 0, hasMore: false });
      }

      if (
        url.includes("/api/feedback/calibration/handwavy-phrases/reinstate")
      ) {
        const phrase = String(body?.phrase ?? "");
        const removedAt = String(body?.removedAt ?? "");
        const histIdx = controller.history.findIndex(
          (h) =>
            h.phrase === phrase && h.removedAt === removedAt && !h.reinstated,
        );
        if (histIdx === -1) {
          return jsonResponse({ error: "Not found" }, 404);
        }
        controller.history[histIdx] = {
          ...controller.history[histIdx],
          reinstated: true,
          reinstatedBy: "tester@example.com",
          reinstatedAt: "2026-05-01T00:01:00.000Z",
        };
        controller.active.set(phrase, makeMarker(phrase));
        return jsonResponse(
          {
            reinstated: true,
            phrase,
            category: "hedging",
            total: controller.active.size,
            marker: controller.active.get(phrase),
            historyEntry: controller.history[histIdx],
            phrases: Array.from(controller.active.values()),
            history: [...controller.history],
          },
          201,
        );
      }

      if (url.includes("/api/feedback/calibration/handwavy-phrases")) {
        if (method === "DELETE") {
          const phrase = String(body?.phrase ?? "");
          if (body?.dryRun === true) {
            return jsonResponse(makeZeroImpactDryRun(phrase));
          }
          if (controller.autoRemoveOnDelete) {
            controller.active.delete(phrase);
          }
          const removedAt = nextRemovedAt();
          const historyEntry = {
            phrase,
            category: "hedging",
            addedBy: "tester@example.com",
            addedAt: "2026-04-01T10:00:00.000Z",
            rationale: "test fixture",
            removedBy: "tester@example.com",
            removedAt,
            reinstated: false,
          };
          controller.history.push(historyEntry);
          return jsonResponse({
            removed: true,
            phrase,
            category: "hedging",
            total: controller.active.size,
            historyEntry,
            phrases: Array.from(controller.active.values()),
            history: [...controller.history],
          });
        }
        // GET — return the current active list + history snapshot.
        return jsonResponse({
          phrases: Array.from(controller.active.values()),
          history: [...controller.history],
        });
      }

      // Anything else — benign empty payload so a missed mock doesn't
      // blow up the render with an unhandled rejection.
      return jsonResponse({});
    });
    return spy;
  }

  beforeEach(() => {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(REVIEWER_KEY);
      window.localStorage.removeItem(PRODUCTION_SCAN_LIMIT_KEY);
      window.localStorage.removeItem(LEGACY_PRODUCTION_SCAN_LIMIT_KEY);
    }
    setCalibrationToken(null);
    resetCalibrationCooldown();
    resetCalibrationTokenRejection();
    controller = {
      active: new Map(),
      history: [],
      removedAtCounter: 0,
      autoRemoveOnDelete: true,
    };
    fetchSpy = installFetchMock();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    setCalibrationToken(null);
    resetCalibrationCooldown();
    resetCalibrationTokenRejection();
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(REVIEWER_KEY);
      window.localStorage.removeItem(PRODUCTION_SCAN_LIMIT_KEY);
      window.localStorage.removeItem(LEGACY_PRODUCTION_SCAN_LIMIT_KEY);
    }
  });

  function renderAdmin() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const utils = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/feedback-analytics"]}>
          <HandwavyPhrasesAdmin mutationsAllowed={true} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { ...utils, client };
  }

  async function clickTrashFor(phrase: string): Promise<void> {
    const trashBtn = await screen.findByLabelText(
      `Remove phrase ${phrase}`,
      {},
      { timeout: 5_000 },
    );
    await act(async () => {
      fireEvent.click(trashBtn);
    });
  }

  async function waitForStackCount(
    expected: number,
    timeout = 5_000,
  ): Promise<void> {
    if (expected === 0) {
      await waitFor(
        () => {
          expect(screen.queryByTestId("handwavy-single-undo-stack")).toBeNull();
        },
        { timeout },
      );
      return;
    }
    await waitFor(
      () => {
        const stack = screen.getByTestId("handwavy-single-undo-stack");
        expect(stack.getAttribute("data-count")).toBe(String(expected));
      },
      { timeout },
    );
  }

  it("caps the stack at SINGLE_UNDO_MAX (5) and drops the OLDEST entry when a 6th remove lands", async () => {
    // Six distinct phrases so a sequential Trash on each pushes six
    // independent entries with their own removedAt — the cap must
    // drop the very first one once the 6th lands.
    const phrases = [
      "task474 cap alpha",
      "task474 cap bravo",
      "task474 cap charlie",
      "task474 cap delta",
      "task474 cap echo",
      "task474 cap foxtrot",
    ];
    for (const p of phrases) controller.active.set(p, makeMarker(p));

    renderAdmin();
    await screen.findByLabelText(`Remove phrase ${phrases[0]}`);

    for (let i = 0; i < phrases.length; i++) {
      await clickTrashFor(phrases[i]);
      await waitForStackCount(Math.min(i + 1, 5));
    }

    const stack = screen.getByTestId("handwavy-single-undo-stack");
    expect(stack.getAttribute("data-max")).toBe("5");
    expect(stack.getAttribute("data-count")).toBe("5");

    // The five most-recent phrases must still be in the stack — the
    // very first one (alpha) is the only entry that should have been
    // dropped by the cap.
    const phrasesInStack = within(stack)
      .getAllByTestId("handwavy-single-undo")
      .map((e) => e.getAttribute("data-phrase"));
    expect(phrasesInStack).not.toContain(phrases[0]);
    for (const p of phrases.slice(1)) {
      expect(phrasesInStack).toContain(p);
    }
  });

  it("dedupes the stack by phrase when the same phrase is re-Trashed (older entry's removedAt is replaced, count stays at 1)", async () => {
    // Disable the mock's auto-delete so the active list keeps the row
    // visible after the first DELETE — that's what makes a back-to-
    // back Trash on the same phrase reachable, and is exactly the
    // race the dedupe-by-phrase guard was added for. Without dedupe,
    // a remove → re-remove cycle on the same phrase would leave a
    // stale entry whose removedAt no longer matches a live history
    // row and whose Undo would 404.
    controller.autoRemoveOnDelete = false;
    const phrase = "task474 dedupe phrase";
    controller.active.set(phrase, makeMarker(phrase));

    renderAdmin();
    await screen.findByLabelText(`Remove phrase ${phrase}`);

    await clickTrashFor(phrase);
    await waitForStackCount(1);
    const firstRemovedAt = screen
      .getByTestId("handwavy-single-undo")
      .getAttribute("data-removed-at");
    expect(firstRemovedAt).toBeTruthy();

    // Second click on the same phrase. The row is still rendered
    // because the mock's active list never dropped it, and the
    // dedupe-by-phrase guard inside handleRemove must replace the
    // older entry instead of stacking a second one.
    await clickTrashFor(phrase);
    await waitFor(() => {
      const entry = screen.getByTestId("handwavy-single-undo");
      expect(entry.getAttribute("data-removed-at")).not.toBe(firstRemovedAt);
    });

    const stack = screen.getByTestId("handwavy-single-undo-stack");
    expect(stack.getAttribute("data-count")).toBe("1");
    const entries = within(stack).getAllByTestId("handwavy-single-undo");
    expect(entries).toHaveLength(1);
    expect(entries[0].getAttribute("data-phrase")).toBe(phrase);
  });

  it("undoing a MIDDLE stacked entry rolls back only that entry — older AND newer entries stay put", async () => {
    const phrases = [
      "task474 mid older",
      "task474 mid middle",
      "task474 mid newer",
    ];
    for (const p of phrases) controller.active.set(p, makeMarker(p));

    renderAdmin();
    await screen.findByLabelText(`Remove phrase ${phrases[0]}`);
    for (const p of phrases) {
      await clickTrashFor(p);
    }
    await waitForStackCount(3);

    // Click Undo on the MIDDLE entry. Each banner's Undo button is
    // keyed by phrase via aria-label, so the test can target it
    // unambiguously without depending on render order.
    const stackBefore = screen.getByTestId("handwavy-single-undo-stack");
    const middleEntry = stackBefore.querySelector(
      `[data-phrase="${phrases[1]}"]`,
    );
    expect(middleEntry).not.toBeNull();
    const middleUndoBtn = within(middleEntry as HTMLElement).getByTestId(
      "handwavy-single-undo-button",
    );
    await act(async () => {
      fireEvent.click(middleUndoBtn);
    });

    // Stack drops to 2, and the surviving entries are exactly the
    // older + newer ones the reviewer never undid.
    await waitForStackCount(2);
    const stackAfter = screen.getByTestId("handwavy-single-undo-stack");
    const remaining = within(stackAfter)
      .getAllByTestId("handwavy-single-undo")
      .map((e) => e.getAttribute("data-phrase"));
    expect(remaining).toEqual(expect.arrayContaining([phrases[0], phrases[2]]));
    expect(remaining).not.toContain(phrases[1]);

    // The middle phrase was reinstated server-side too — the row
    // should reappear on the active list once the post-reinstate
    // refresh lands.
    await waitFor(() => {
      expect(
        screen.queryByLabelText(`Remove phrase ${phrases[1]}`),
      ).not.toBeNull();
    });
    // And the OTHER two phrases must still be removed (their Undo
    // buttons were never clicked) — the active list must NOT have
    // brought them back.
    expect(screen.queryByLabelText(`Remove phrase ${phrases[0]}`)).toBeNull();
    expect(screen.queryByLabelText(`Remove phrase ${phrases[2]}`)).toBeNull();
  });

  it("auto-clears ONLY the entry whose phrase reappears on the active list (external reinstate); other entries stay", async () => {
    const phrases = ["task474 auto first", "task474 auto second"];
    for (const p of phrases) controller.active.set(p, makeMarker(p));

    const { client } = renderAdmin();
    await screen.findByLabelText(`Remove phrase ${phrases[0]}`);

    for (const p of phrases) {
      await clickTrashFor(p);
    }
    await waitForStackCount(2);

    // Simulate an external reinstate: the first phrase becomes active
    // again via some other path (the history-panel Reinstate, the
    // CLI in another tab, etc.). The auto-clear effect must drop ONLY
    // the entry for that phrase, leaving the entry for the second
    // phrase intact (its phrase is still removed).
    controller.active.set(phrases[0], makeMarker(phrases[0]));
    await act(async () => {
      await client.invalidateQueries();
    });

    await waitFor(() => {
      const stack = screen.getByTestId("handwavy-single-undo-stack");
      expect(stack.getAttribute("data-count")).toBe("1");
    });

    const stack = screen.getByTestId("handwavy-single-undo-stack");
    const remaining = within(stack)
      .getAllByTestId("handwavy-single-undo")
      .map((e) => e.getAttribute("data-phrase"));
    expect(remaining).toEqual([phrases[1]]);
    expect(remaining).not.toContain(phrases[0]);
  });
});
