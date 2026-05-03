export interface ArchetypeHistorySnapshot {
  timestamp: string;
  archetype: string;
  count: number;
  avriOnMean: number;
  avriOnMax: number;
  minDistanceToCeiling: number;
  ceiling: number;
  // Task #92 — true when the row is a daily roll-up of older snapshots
  // produced by the archetype-history compaction pass.
  aggregated?: boolean;
}

/**
 * Task #98 — derive a human-readable date range and day span from a
 * series of archetype-history snapshots. Returns null when the series
 * is empty so callers can opt out of rendering the chip / appendix.
 *
 * All calendar math uses UTC so that aggregated rows stored at
 * `YYYY-MM-DDT00:00:00.000Z` render as the same day for every viewer,
 * regardless of local timezone. Otherwise reviewers in negative-UTC
 * timezones would see the day label slip backwards by one.
 */
export function formatHistoryRange(snapshots: ArchetypeHistorySnapshot[]): {
  startLabel: string;
  endLabel: string;
  days: number;
  label: string;
} | null {
  if (snapshots.length === 0) return null;
  const first = new Date(snapshots[0]!.timestamp);
  const last = new Date(snapshots[snapshots.length - 1]!.timestamp);
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()))
    return null;
  // Force UTC so the label matches the UTC day key the backend uses
  // when rolling up older snapshots.
  const fmt: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  };
  const startLabel = first.toLocaleDateString(undefined, fmt);
  const endLabel = last.toLocaleDateString(undefined, fmt);
  // Compute an inclusive day span from the UTC calendar dates of the
  // endpoints, not the raw ms delta. This avoids ±1 drift from
  // sub-day timestamps or DST boundaries in the viewer's locale.
  const startDay = Date.UTC(
    first.getUTCFullYear(),
    first.getUTCMonth(),
    first.getUTCDate(),
  );
  const endDay = Date.UTC(
    last.getUTCFullYear(),
    last.getUTCMonth(),
    last.getUTCDate(),
  );
  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.max(1, Math.round((endDay - startDay) / dayMs) + 1);
  const label =
    snapshots.length === 1 || startLabel === endLabel
      ? startLabel
      : `${startLabel} → ${endLabel}`;
  return { startLabel, endLabel, days, label };
}

/**
 * Compute the recent decline in headroom, in composite points. Positive
 * value means the latest snapshot has shrunk vs. the older comparison
 * window (worst-case, most regression-y direction).
 */
export function recentHeadroomDecline(
  snapshots: ArchetypeHistorySnapshot[],
): number {
  if (snapshots.length < 2) return 0;
  // Compare current minDistanceToCeiling to the max observed in the
  // earlier half of the window — picks up the worst regression rather
  // than just the prior snapshot.
  const cur = snapshots[snapshots.length - 1]!.minDistanceToCeiling;
  const earlier = snapshots.slice(
    0,
    Math.max(1, Math.floor(snapshots.length / 2)),
  );
  const prevBest = Math.max(...earlier.map((s) => s.minDistanceToCeiling));
  return Number((prevBest - cur).toFixed(1));
}
