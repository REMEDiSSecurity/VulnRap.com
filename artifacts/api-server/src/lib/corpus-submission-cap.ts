import { logger } from "./logger";

const DEFAULT_CAP = 20;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10_000;

interface VisitorBucket {
  utcDay: string;
  timestamps: number[];
}

const STATE: Map<string, VisitorBucket> = new Map();

function utcDay(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function getConfiguredCap(): number {
  const raw = process.env.CORPUS_SUBMISSION_CAP;
  if (raw !== undefined) {
    const v = Number(raw);
    if (Number.isFinite(v) && Number.isInteger(v) && v >= 1) return v;
  }
  return DEFAULT_CAP;
}

function pruneIfNeeded(): void {
  if (STATE.size <= MAX_ENTRIES) return;
  const entries = Array.from(STATE.entries()).sort(
    (a, b) =>
      (a[1].timestamps[a[1].timestamps.length - 1] ?? 0) -
      (b[1].timestamps[b[1].timestamps.length - 1] ?? 0),
  );
  const drop = entries.slice(0, entries.length - MAX_ENTRIES + 500);
  for (const [k] of drop) STATE.delete(k);
}

export interface CorpusCapResult {
  allowed: boolean;
  submissionCount: number;
  cap: number;
  remaining: number;
  reservedAt: number | null;
}

export function checkCorpusCap(
  visitorHash: string | null | undefined,
): Omit<CorpusCapResult, "reservedAt"> {
  const cap = getConfiguredCap();
  if (!visitorHash)
    return { allowed: true, submissionCount: 0, cap, remaining: cap };

  const day = utcDay();
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const existing = STATE.get(visitorHash);
  let timestamps: number[];
  if (!existing || existing.utcDay !== day) {
    timestamps = [];
  } else {
    timestamps = existing.timestamps.filter((t) => t >= cutoff);
  }

  const remaining = Math.max(0, cap - timestamps.length);
  return {
    allowed: timestamps.length < cap,
    submissionCount: timestamps.length,
    cap,
    remaining,
  };
}

export function recordCorpusSubmission(
  visitorHash: string | null | undefined,
): CorpusCapResult {
  const cap = getConfiguredCap();
  if (!visitorHash)
    return { allowed: true, submissionCount: 0, cap, remaining: cap, reservedAt: null };

  const day = utcDay();
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const existing = STATE.get(visitorHash);
  let timestamps: number[];
  if (!existing || existing.utcDay !== day) {
    timestamps = [];
  } else {
    timestamps = existing.timestamps.filter((t) => t >= cutoff);
  }

  if (timestamps.length >= cap) {
    logger.warn(
      { visitorHash: visitorHash.slice(0, 8), count: timestamps.length, cap },
      "[corpus-cap] visitor exceeded corpus submission cap",
    );
    return {
      allowed: false,
      submissionCount: timestamps.length,
      cap,
      remaining: 0,
      reservedAt: null,
    };
  }

  timestamps.push(now);
  STATE.set(visitorHash, { utcDay: day, timestamps });
  pruneIfNeeded();

  const remaining = Math.max(0, cap - timestamps.length);
  return {
    allowed: true,
    submissionCount: timestamps.length,
    cap,
    remaining,
    reservedAt: now,
  };
}

export function releaseCorpusSubmission(
  visitorHash: string | null | undefined,
  reservedAt: number,
): void {
  if (!visitorHash) return;
  const bucket = STATE.get(visitorHash);
  if (!bucket) return;
  const idx = bucket.timestamps.indexOf(reservedAt);
  if (idx !== -1) {
    bucket.timestamps.splice(idx, 1);
    logger.info(
      { visitorHash: visitorHash.slice(0, 8) },
      "[corpus-cap] released reserved slot (submission failed)",
    );
  }
}

export function __resetCorpusCapForTests(): void {
  STATE.clear();
}
