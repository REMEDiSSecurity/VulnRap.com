// In-memory same-day submission velocity tracker.
// Keyed by the daily-rotating visitor hash that the reports route already
// computes. No DB writes, no persistent submitter tracking — the underlying
// hash rotates at UTC midnight (HMAC over (ip,user-agent,utc-day,VISITOR_HMAC_KEY))
// so this map is naturally bounded and resets every day.
//
// Sprint 11 spec, Part 6:
//   >10 submissions within a 60-minute window  → -15
//   average inter-submission gap < 30 seconds  → -10
//   penalties combine, capped at -15 total.

interface VisitorWindow {
  utcDay: string;
  // Recent submission timestamps (ms). Trimmed to the last 60 min on every record.
  timestamps: number[];
}

const STATE: Map<string, VisitorWindow> = new Map();
const MAX_ENTRIES = 5000;
const WINDOW_MS = 60 * 60 * 1000;
const BURST_THRESHOLD = 10;        // >10 in 60 min triggers the window penalty
const BURST_PENALTY = -15;
const TIGHT_GAP_MS = 30_000;       // <30s avg gap triggers the gap penalty
const GAP_PENALTY = -10;
const TOTAL_CAP = -15;             // Combined penalty floor

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function pruneIfNeeded(): void {
  if (STATE.size <= MAX_ENTRIES) return;
  const entries = Array.from(STATE.entries()).sort(
    (a, b) =>
      (a[1].timestamps[a[1].timestamps.length - 1] ?? 0) -
      (b[1].timestamps[b[1].timestamps.length - 1] ?? 0),
  );
  const drop = entries.slice(0, entries.length - MAX_ENTRIES + 200);
  for (const [k] of drop) STATE.delete(k);
}

export interface VelocityResult {
  submissionCount: number; // count within the rolling 60-min window (after this submission)
  penalty: number;         // 0..TOTAL_CAP
  utcDay: string;
  avgGapMs: number | null; // average inter-submission gap within the window, or null when <2
}

function scoreWindow(timestamps: number[]): { penalty: number; avgGapMs: number | null } {
  let penalty = 0;
  if (timestamps.length > BURST_THRESHOLD) penalty += BURST_PENALTY;
  let avgGapMs: number | null = null;
  if (timestamps.length >= 2) {
    let total = 0;
    for (let i = 1; i < timestamps.length; i++) total += timestamps[i] - timestamps[i - 1];
    avgGapMs = total / (timestamps.length - 1);
    if (avgGapMs < TIGHT_GAP_MS && timestamps.length >= 3) penalty += GAP_PENALTY;
  }
  if (penalty < TOTAL_CAP) penalty = TOTAL_CAP;
  return { penalty, avgGapMs };
}

/**
 * Record a new submission for the given (already-rotating, anonymous) visitor
 * hash and return the rolling-window submission count plus the AVRI velocity
 * penalty. See Sprint 11 spec Part 6 for the scoring rules.
 */
export function recordAndScore(visitorHash: string | null | undefined): VelocityResult {
  const day = utcDay();
  const now = Date.now();
  if (!visitorHash) return { submissionCount: 0, penalty: 0, utcDay: day, avgGapMs: null };
  const cutoff = now - WINDOW_MS;
  const existing = STATE.get(visitorHash);
  let timestamps: number[];
  if (!existing || existing.utcDay !== day) {
    timestamps = [now];
  } else {
    timestamps = existing.timestamps.filter((t) => t >= cutoff);
    timestamps.push(now);
  }
  STATE.set(visitorHash, { utcDay: day, timestamps });
  pruneIfNeeded();
  const { penalty, avgGapMs } = scoreWindow(timestamps);
  return { submissionCount: timestamps.length, penalty, utcDay: day, avgGapMs };
}

/** Inspect (without recording) the current rolling-window count for diagnostics or tests. */
export function peek(visitorHash: string | null | undefined): VelocityResult {
  const day = utcDay();
  const now = Date.now();
  if (!visitorHash) return { submissionCount: 0, penalty: 0, utcDay: day, avgGapMs: null };
  const existing = STATE.get(visitorHash);
  if (!existing || existing.utcDay !== day) {
    return { submissionCount: 0, penalty: 0, utcDay: day, avgGapMs: null };
  }
  const cutoff = now - WINDOW_MS;
  const timestamps = existing.timestamps.filter((t) => t >= cutoff);
  const { penalty, avgGapMs } = scoreWindow(timestamps);
  return { submissionCount: timestamps.length, penalty, utcDay: day, avgGapMs };
}

/** Test-only reset. */
export function __resetVelocityForTests(): void {
  STATE.clear();
}
