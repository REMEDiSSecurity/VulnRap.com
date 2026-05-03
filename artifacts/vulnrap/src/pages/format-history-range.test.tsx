import { describe, it, expect } from "vitest";
import {
  formatHistoryRange,
  type ArchetypeHistorySnapshot,
} from "@/lib/archetype-history";

const snap = (
  timestamp: string,
  overrides: Partial<ArchetypeHistorySnapshot> = {},
): ArchetypeHistorySnapshot => ({
  timestamp,
  archetype: "test-archetype",
  count: 1,
  avriOnMean: 0,
  avriOnMax: 0,
  minDistanceToCeiling: 10,
  ceiling: 30,
  ...overrides,
});

const utcLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

describe("formatHistoryRange (Task #98 — calibration history date-range helper)", () => {
  it("returns null for an empty snapshot list", () => {
    expect(formatHistoryRange([])).toBeNull();
  });

  it("renders a single snapshot as one label with a day count of 1", () => {
    const iso = "2026-04-22T15:30:00.000Z";
    const result = formatHistoryRange([snap(iso)]);
    const label = utcLabel(iso);
    expect(result).toEqual({
      startLabel: label,
      endLabel: label,
      days: 1,
      label,
    });
  });

  it("collapses to one label when two snapshots share a UTC calendar day", () => {
    // 00:00 and 23:59 UTC of the same calendar day — the helper should
    // not render an arrow when start and end labels match.
    const result = formatHistoryRange([
      snap("2026-04-22T00:00:00.000Z"),
      snap("2026-04-22T23:59:00.000Z"),
    ]);
    expect(result).not.toBeNull();
    const label = utcLabel("2026-04-22T12:00:00.000Z");
    expect(result!.startLabel).toBe(label);
    expect(result!.endLabel).toBe(label);
    expect(result!.label).toBe(label);
    expect(result!.days).toBe(1);
  });

  it("formats a multi-day range with → and an inclusive day count", () => {
    // Jan 22 → Apr 22 (2026 is not a leap year): 9 + 28 + 31 + 22 = 90
    // exclusive days, plus 1 for inclusive bounds = 91.
    const result = formatHistoryRange([
      snap("2026-01-22T00:00:00.000Z"),
      snap("2026-02-15T12:00:00.000Z"),
      snap("2026-04-22T00:00:00.000Z"),
    ]);
    expect(result).not.toBeNull();
    const start = utcLabel("2026-01-22T00:00:00.000Z");
    const end = utcLabel("2026-04-22T00:00:00.000Z");
    expect(result!.startLabel).toBe(start);
    expect(result!.endLabel).toBe(end);
    expect(result!.label).toBe(`${start} → ${end}`);
    expect(result!.days).toBe(91);
  });

  it("uses UTC calendar dates so sub-day timestamps don't drift the day count", () => {
    // Only ~25h apart but they straddle two distinct UTC calendar days.
    const result = formatHistoryRange([
      snap("2026-04-22T00:00:00.000Z"),
      snap("2026-04-23T01:00:00.000Z"),
    ]);
    expect(result).not.toBeNull();
    expect(result!.days).toBe(2);
    const start = utcLabel("2026-04-22T00:00:00.000Z");
    const end = utcLabel("2026-04-23T01:00:00.000Z");
    expect(result!.label).toBe(`${start} → ${end}`);
  });

  it("returns null when an endpoint timestamp cannot be parsed", () => {
    expect(formatHistoryRange([snap("not a real date")])).toBeNull();
    // First parses fine but the trailing endpoint is garbage — still null,
    // because the helper relies on the last entry to label the end of the range.
    expect(
      formatHistoryRange([
        snap("2026-04-22T00:00:00.000Z"),
        snap("definitely-not-iso"),
      ]),
    ).toBeNull();
  });
});
