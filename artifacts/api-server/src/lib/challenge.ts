import { createHash, randomBytes } from "crypto";

// Task #1342 — Bumped from 4 → 6 in response to the May 23 2026 pen-test
// finding #4 (automated feedback flood was practical). 6 leading hex zeros
// means ≥16M expected SHA-256 ops per challenge; on commodity client
// hardware that's ~1–3 seconds, which is invisible to a human submitting
// feedback once but turns the abuse cost into thousands of CPU-seconds
// per attempt. The per-IP limiter on POST /feedback in app.ts is the
// secondary throttle.
const CHALLENGE_DIFFICULTY = 6;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_PREFIX = "vulnrap-pow-";

interface StoredChallenge {
  nonce: string;
  difficulty: number;
  createdAt: number;
  used: boolean;
}

const challengeStore = new Map<string, StoredChallenge>();

setInterval(() => {
  const now = Date.now();
  for (const [id, c] of challengeStore) {
    if (now - c.createdAt > CHALLENGE_TTL_MS * 2) {
      challengeStore.delete(id);
    }
  }
}, 60_000);

export function generateChallenge(): {
  challengeId: string;
  nonce: string;
  difficulty: number;
  prefix: string;
  expiresAt: number;
} {
  const challengeId = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;

  challengeStore.set(challengeId, {
    nonce,
    difficulty: CHALLENGE_DIFFICULTY,
    createdAt: Date.now(),
    used: false,
  });

  return {
    challengeId,
    nonce,
    difficulty: CHALLENGE_DIFFICULTY,
    prefix: CHALLENGE_PREFIX,
    expiresAt,
  };
}

export function verifyChallenge(
  challengeId: string,
  solution: string,
): { valid: boolean; error?: string } {
  const stored = challengeStore.get(challengeId);

  if (!stored) {
    return { valid: false, error: "Challenge not found or expired." };
  }

  if (stored.used) {
    return { valid: false, error: "Challenge already used." };
  }

  if (Date.now() - stored.createdAt > CHALLENGE_TTL_MS) {
    challengeStore.delete(challengeId);
    return { valid: false, error: "Challenge expired." };
  }

  const input = CHALLENGE_PREFIX + stored.nonce + solution;
  const hash = createHash("sha256").update(input).digest("hex");

  const requiredPrefix = "0".repeat(stored.difficulty);
  if (!hash.startsWith(requiredPrefix)) {
    return {
      valid: false,
      error: "Invalid solution — hash does not meet difficulty requirement.",
    };
  }

  stored.used = true;
  setTimeout(() => challengeStore.delete(challengeId), 30_000);

  return { valid: true };
}
