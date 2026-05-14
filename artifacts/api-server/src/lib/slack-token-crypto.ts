// Slack hosted-relay bot token encryption.
//
// Every bot token persisted in `slack_tenants.bot_token_ciphertext` is
// sealed with AES-256-GCM. The master key lives in the
// SLACK_RELAY_MASTER_KEY env var (32 random bytes, base64-encoded). A
// `keyVersion` column on each row lets us roll forward to a new master
// key without re-encrypting eagerly: add the new key as V2 in `KEYS`
// below, mark it the active write key, and `openBotToken` will keep
// decrypting V1 rows until they're naturally re-sealed on the next
// write (auto-disable, manual disconnect, etc.).
//
// Why AES-GCM (not libsodium / KMS for v0):
//   - AES-256-GCM ships in Node `node:crypto` — zero new deps, FIPS
//     140-2 validated implementations are universally available.
//   - The master key is held in Replit Secrets, the same trust
//     boundary as VISITOR_HMAC_KEY. A KMS upgrade becomes a swap of
//     the `KEYS` provider with no schema change.
//
// Threat model (see slack-hosted-relay-design.md):
//   - DB exfiltration alone: ciphertext is unusable without the env
//     secret. Authentication tag detects tampering.
//   - Env exfiltration alone: useless without the DB.
//   - Both: total compromise. The mitigation is rotation + audit
//     logging on every decrypt — captured in the relay routes, not
//     here.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const KEY_LEN = 32; // 256 bits
const NONCE_LEN = 12; // GCM standard

/**
 * Sealed token bundle persisted to the DB. Every field is
 * base64-encoded; the auth tag is GCM's 16-byte integrity check.
 */
export interface SealedBotToken {
  ciphertext: string;
  nonce: string;
  tag: string;
  keyVersion: number;
}

/**
 * Lazy-loaded keyring. Reads SLACK_RELAY_MASTER_KEY (and any future
 * SLACK_RELAY_MASTER_KEY_V2 / V3) the first time a seal/open is
 * requested, NOT at module load — so importing this module never
 * throws when the env var is unset (tests, CI typecheck, dev
 * bootstrap). Calls into seal/openBotToken with no configured key
 * throw a descriptive error instead.
 */
let cachedKeys: Record<number, Buffer> | null = null;
let cachedActiveVersion: number | null = null;

function loadKey(envName: string): Buffer | null {
  const raw = (process.env[envName] ?? "").trim();
  if (raw.length === 0) return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${envName} is set but is not valid base64`);
  }
  if (key.length !== KEY_LEN) {
    throw new Error(
      `${envName} must decode to exactly ${KEY_LEN} bytes (AES-256). Got ${key.length}.`,
    );
  }
  return key;
}

function loadKeys(): { keys: Record<number, Buffer>; active: number } {
  if (cachedKeys && cachedActiveVersion !== null) {
    return { keys: cachedKeys, active: cachedActiveVersion };
  }
  const v1 = loadKey("SLACK_RELAY_MASTER_KEY");
  if (!v1) {
    throw new Error(
      "SLACK_RELAY_MASTER_KEY is not set. Generate one with: " +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const keys: Record<number, Buffer> = { 1: v1 };
  const v2 = loadKey("SLACK_RELAY_MASTER_KEY_V2");
  if (v2) keys[2] = v2;
  const v3 = loadKey("SLACK_RELAY_MASTER_KEY_V3");
  if (v3) keys[3] = v3;
  // Active version is the newest configured key. Rotate forward by
  // adding a new env var and bumping nothing — encryption uses the
  // highest key, decryption looks up by row.keyVersion.
  const active = Math.max(...Object.keys(keys).map((k) => Number(k)));
  cachedKeys = keys;
  cachedActiveVersion = active;
  return { keys, active };
}

/**
 * Reset the cached keyring. Test-only — called by the unit tests
 * after mutating process.env to force a re-read.
 */
export function _resetSlackKeyCacheForTests(): void {
  cachedKeys = null;
  cachedActiveVersion = null;
}

export function isSlackTokenCryptoConfigured(): boolean {
  try {
    loadKeys();
    return true;
  } catch {
    return false;
  }
}

/**
 * Seal a Slack bot token (xoxb-…) for at-rest storage.
 * Returns base64-encoded ciphertext + nonce + tag and the key version
 * used. Always seals with the highest configured key version.
 */
export function sealBotToken(plaintext: string): SealedBotToken {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("sealBotToken: plaintext must be a non-empty string");
  }
  const { keys, active } = loadKeys();
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv(ALGO, keys[active], nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
    keyVersion: active,
  };
}

/**
 * Open a previously-sealed Slack bot token. Throws on:
 *   - Unknown keyVersion (master key for that version not configured)
 *   - Tampered ciphertext / nonce / tag (GCM auth failure)
 *
 * The returned plaintext should be used inside a single function
 * scope and never logged, cached, or returned outside the relay.
 */
export function openBotToken(sealed: SealedBotToken): string {
  const { keys } = loadKeys();
  const key = keys[sealed.keyVersion];
  if (!key) {
    throw new Error(
      `openBotToken: no key configured for keyVersion=${sealed.keyVersion}. ` +
        "Set the corresponding SLACK_RELAY_MASTER_KEY[_V<n>] env var.",
    );
  }
  const nonce = Buffer.from(sealed.nonce, "base64");
  const ciphertext = Buffer.from(sealed.ciphertext, "base64");
  const tag = Buffer.from(sealed.tag, "base64");
  if (nonce.length !== NONCE_LEN) {
    throw new Error("openBotToken: nonce length mismatch");
  }
  const decipher = createDecipheriv(ALGO, key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
