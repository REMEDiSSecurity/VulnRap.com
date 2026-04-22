// In-memory same-day submission velocity tracker.
// Keyed by the daily-rotating visitor hash that the reports route already
// computes. No DB writes, no persistent submitter tracking — the underlying
// hash rotates at UTC midnight (HMAC over (ip,user-agent,utc-day,VISITOR_HMAC_KEY))
// so this map is naturally bounded and resets every day.

interface VisitorWindow {
  utcDay: string;
  count: number;
  lastSeenMs: number;
}

const STATE: Map<string, VisitorWindow> = new Map();
const MAX_ENTRIES = 5000;

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function pruneIfNeeded(): void {
  if (STATE.size <= MAX_ENTRIES) return;
  // Drop oldest by lastSeenMs. Cheap O(n) — runs only when oversized.
  const entries = Array.from(STATE.entries()).sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
  const drop = entries.slice(0, entries.length - MAX_ENTRIES + 200);
  for (const [k] of drop) STATE.delete(k);
}

export interface VelocityResult {
  submissionCount: number;
  penalty: number;
  utcDay: string;
}

/**
 * Record a new submission for the given (already-rotating, anonymous) visitor
 * hash and return how many submissions that hash has produced today, plus the
 * penalty (0..-15) that should be applied to the AVRI composite.
 *
 * Penalty schedule (Part 6, Sprint 11 spec, capped at -15):
 *   1 → 0       (first submission of the day, neutral)
 *   2 → -3
 *   3 → -7
 *   4 → -11
 *   5+ → -15
 */
export function recordAndScore(visitorHash: string | null | undefined): VelocityResult {
  const day = utcDay();
  if (!visitorHash) return { submissionCount: 0, penalty: 0, utcDay: day };
  const existing = STATE.get(visitorHash);
  let count: number;
  if (!existing || existing.utcDay !== day) {
    count = 1;
  } else {
    count = existing.count + 1;
  }
  STATE.set(visitorHash, { utcDay: day, count, lastSeenMs: Date.now() });
  pruneIfNeeded();
  let penalty = 0;
  if (count >= 5) penalty = -15;
  else if (count === 4) penalty = -11;
  else if (count === 3) penalty = -7;
  else if (count === 2) penalty = -3;
  return { submissionCount: count, penalty, utcDay: day };
}

/** Inspect (without recording) the current count for diagnostics or tests. */
export function peek(visitorHash: string | null | undefined): VelocityResult {
  const day = utcDay();
  if (!visitorHash) return { submissionCount: 0, penalty: 0, utcDay: day };
  const existing = STATE.get(visitorHash);
  if (!existing || existing.utcDay !== day) return { submissionCount: 0, penalty: 0, utcDay: day };
  const count = existing.count;
  let penalty = 0;
  if (count >= 5) penalty = -15;
  else if (count === 4) penalty = -11;
  else if (count === 3) penalty = -7;
  else if (count === 2) penalty = -3;
  return { submissionCount: count, penalty, utcDay: day };
}

/** Test-only reset. */
export function __resetVelocityForTests(): void {
  STATE.clear();
}
