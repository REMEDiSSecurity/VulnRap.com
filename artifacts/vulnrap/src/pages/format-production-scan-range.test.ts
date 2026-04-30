import { describe, it, expect } from "vitest";
import { formatProductionScanRange } from "./feedback-analytics";

const localLabel = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

// Build an ISO timestamp anchored to the local calendar day. Using the
// `new Date(y, m, d, h, ...)` constructor pins the result to local time, so
// two ISO strings produced this way for the same local Y/M/D are guaranteed
// to render the same `toLocaleDateString` label regardless of the test
// runner's timezone — which is exactly what `formatProductionScanRange`
// keys off when collapsing to the "on <date>" branch.
const localIso = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): string => new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();

describe("formatProductionScanRange (Task #124 — production scan window helper)", () => {
  it("collapses to 'on <date>' when oldest and newest fall on the same local calendar day", () => {
    // 09:15 and 16:42 local time — far enough from local midnight that they
    // can't accidentally straddle it, and built via the local-time
    // constructor so the assertion holds in any timezone.
    const oldest = localIso(2026, 4, 22, 9, 15);
    const newest = localIso(2026, 4, 22, 16, 42);
    const label = localLabel(oldest);
    expect(label).toBe(localLabel(newest));
    expect(formatProductionScanRange(oldest, newest)).toBe(`on ${label}`);
  });

  it("collapses to 'on <date>' when both endpoints share the exact same timestamp (single-row sample)", () => {
    const ts = localIso(2026, 4, 22, 12, 0);
    expect(formatProductionScanRange(ts, ts)).toBe(`on ${localLabel(ts)}`);
  });

  it("renders 'from <date> to <date>' when the endpoints land on different calendar days", () => {
    const oldest = localIso(2026, 4, 20, 12, 0);
    const newest = localIso(2026, 4, 22, 12, 0);
    const oldestLabel = localLabel(oldest);
    const newestLabel = localLabel(newest);
    expect(oldestLabel).not.toBe(newestLabel);
    expect(formatProductionScanRange(oldest, newest)).toBe(
      `from ${oldestLabel} to ${newestLabel}`,
    );
  });

  it("returns null when either endpoint is missing or unparseable", () => {
    const valid = localIso(2026, 4, 22, 12, 0);
    expect(formatProductionScanRange(null, valid)).toBeNull();
    expect(formatProductionScanRange(valid, null)).toBeNull();
    expect(formatProductionScanRange(undefined, undefined)).toBeNull();
    expect(formatProductionScanRange("not-a-date", valid)).toBeNull();
    expect(formatProductionScanRange(valid, "also-not-a-date")).toBeNull();
  });
});
