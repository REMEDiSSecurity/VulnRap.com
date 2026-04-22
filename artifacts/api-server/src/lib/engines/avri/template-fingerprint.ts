// Structural template fingerprinting (in-memory LRU).
// We hash the *structure* of the report — lower-cased section headers and
// paragraph length buckets — rather than the prose, so cosmetic edits don't
// break the match. When the same template fingerprint is seen N+ times within
// the rolling window, we apply a -20 campaign penalty to the AVRI composite.

import { createHash } from "crypto";

const MAX_ENTRIES = 4000;
const CAMPAIGN_THRESHOLD = 3; // ≥3 hits within the LRU window triggers the penalty.
const PENALTY_POINTS = -20;
const STATE: Map<string, { count: number; firstSeenMs: number; lastSeenMs: number }> = new Map();

function bucketLength(words: number): string {
  if (words < 30) return "xs";
  if (words < 80) return "s";
  if (words < 160) return "m";
  if (words < 320) return "l";
  return "xl";
}

/**
 * Build a structural fingerprint from a report.
 *
 * Components (joined with `|`, then sha256-hashed):
 *   - lowered, trimmed section headers (`#`/`##`/`###`) preserved in order
 *   - paragraph word-count buckets in order
 *   - boolean flags: hasCodeBlock, hasNumberedSteps, hasBulletList
 *
 * Two reports with the same skeleton but different surface words will produce
 * the same fingerprint; reports with different headings/paragraph shape will
 * produce different fingerprints.
 */
export function structuralFingerprint(text: string): string {
  const lines = text.split(/\r?\n/);
  const headers: string[] = [];
  const paragraphs: string[][] = [];
  let buf: string[] = [];
  let hasNumberedSteps = false;
  let hasBulletList = false;
  let hasCodeBlock = false;
  let inFence = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      hasCodeBlock = true;
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) {
      if (buf.length > 0) { paragraphs.push(buf); buf = []; }
      continue;
    }
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      if (buf.length > 0) { paragraphs.push(buf); buf = []; }
      headers.push(headerMatch[2].toLowerCase().replace(/[^a-z0-9 ]/g, "").trim());
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) hasNumberedSteps = true;
    if (/^\s*[-*+]\s+/.test(line)) hasBulletList = true;
    buf.push(line);
  }
  if (buf.length > 0) paragraphs.push(buf);

  const headerSig = headers.join(">");
  const paraSig = paragraphs
    .map((p) => bucketLength(p.join(" ").split(/\s+/).filter(Boolean).length))
    .join(",");
  const flagSig = `${hasCodeBlock ? "c" : ""}${hasNumberedSteps ? "n" : ""}${hasBulletList ? "b" : ""}`;

  const composite = `H:${headerSig}|P:${paraSig}|F:${flagSig}`;
  return createHash("sha256").update(composite).digest("hex").slice(0, 32);
}

export interface FingerprintResult {
  fingerprint: string;
  count: number;
  penalty: number;
}

function pruneIfNeeded(): void {
  if (STATE.size <= MAX_ENTRIES) return;
  const entries = Array.from(STATE.entries()).sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
  const drop = entries.slice(0, entries.length - MAX_ENTRIES + 200);
  for (const [k] of drop) STATE.delete(k);
}

/**
 * Record a sighting of `text`'s structural fingerprint and return how many
 * times the same skeleton has been seen plus the penalty to apply.
 */
export function recordAndScore(text: string): FingerprintResult {
  const fp = structuralFingerprint(text);
  const existing = STATE.get(fp);
  const now = Date.now();
  const count = (existing?.count ?? 0) + 1;
  STATE.set(fp, {
    count,
    firstSeenMs: existing?.firstSeenMs ?? now,
    lastSeenMs: now,
  });
  pruneIfNeeded();
  const penalty = count >= CAMPAIGN_THRESHOLD ? PENALTY_POINTS : 0;
  return { fingerprint: fp, count, penalty };
}

export function peek(text: string): FingerprintResult {
  const fp = structuralFingerprint(text);
  const existing = STATE.get(fp);
  const count = existing?.count ?? 0;
  const penalty = count >= CAMPAIGN_THRESHOLD ? PENALTY_POINTS : 0;
  return { fingerprint: fp, count, penalty };
}

export function __resetFingerprintsForTests(): void {
  STATE.clear();
}
