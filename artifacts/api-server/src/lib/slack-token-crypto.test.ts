import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  sealBotToken,
  openBotToken,
  isSlackTokenCryptoConfigured,
  _resetSlackKeyCacheForTests,
} from "./slack-token-crypto";

const TEST_KEY_V1 = randomBytes(32).toString("base64");
const TEST_KEY_V2 = randomBytes(32).toString("base64");

describe("slack-token-crypto", () => {
  let originalKey: string | undefined;
  let originalKeyV2: string | undefined;

  beforeEach(() => {
    originalKey = process.env.SLACK_RELAY_MASTER_KEY;
    originalKeyV2 = process.env.SLACK_RELAY_MASTER_KEY_V2;
    delete process.env.SLACK_RELAY_MASTER_KEY;
    delete process.env.SLACK_RELAY_MASTER_KEY_V2;
    _resetSlackKeyCacheForTests();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.SLACK_RELAY_MASTER_KEY;
    else process.env.SLACK_RELAY_MASTER_KEY = originalKey;
    if (originalKeyV2 === undefined)
      delete process.env.SLACK_RELAY_MASTER_KEY_V2;
    else process.env.SLACK_RELAY_MASTER_KEY_V2 = originalKeyV2;
    _resetSlackKeyCacheForTests();
  });

  it("reports unconfigured when SLACK_RELAY_MASTER_KEY is missing", () => {
    expect(isSlackTokenCryptoConfigured()).toBe(false);
  });

  it("throws on seal when the key is missing", () => {
    expect(() => sealBotToken("xoxb-test")).toThrow(/SLACK_RELAY_MASTER_KEY/);
  });

  it("rejects a key that is not 32 bytes after base64 decode", () => {
    process.env.SLACK_RELAY_MASTER_KEY = Buffer.from("too-short").toString(
      "base64",
    );
    _resetSlackKeyCacheForTests();
    expect(() => sealBotToken("xoxb-test")).toThrow(/exactly 32 bytes/);
  });

  it("round-trips a token and tags it with the active key version", () => {
    process.env.SLACK_RELAY_MASTER_KEY = TEST_KEY_V1;
    _resetSlackKeyCacheForTests();
    const plaintext = "xoxb-1234567890-9876543210-AbCdEfGhIjKl";
    const sealed = sealBotToken(plaintext);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).not.toContain(plaintext);
    expect(openBotToken(sealed)).toBe(plaintext);
  });

  it("produces a unique nonce per seal (no nonce reuse)", () => {
    process.env.SLACK_RELAY_MASTER_KEY = TEST_KEY_V1;
    _resetSlackKeyCacheForTests();
    const a = sealBotToken("xoxb-A");
    const b = sealBotToken("xoxb-A");
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it("seals with the highest configured key version", () => {
    process.env.SLACK_RELAY_MASTER_KEY = TEST_KEY_V1;
    process.env.SLACK_RELAY_MASTER_KEY_V2 = TEST_KEY_V2;
    _resetSlackKeyCacheForTests();
    const sealed = sealBotToken("xoxb-rotation-test");
    expect(sealed.keyVersion).toBe(2);
    expect(openBotToken(sealed)).toBe("xoxb-rotation-test");
  });

  it("decrypts older keyVersion rows when the active key has rotated forward", () => {
    process.env.SLACK_RELAY_MASTER_KEY = TEST_KEY_V1;
    _resetSlackKeyCacheForTests();
    const sealedV1 = sealBotToken("xoxb-old");
    expect(sealedV1.keyVersion).toBe(1);

    process.env.SLACK_RELAY_MASTER_KEY_V2 = TEST_KEY_V2;
    _resetSlackKeyCacheForTests();
    expect(openBotToken(sealedV1)).toBe("xoxb-old");
    const sealedV2 = sealBotToken("xoxb-new");
    expect(sealedV2.keyVersion).toBe(2);
    expect(openBotToken(sealedV2)).toBe("xoxb-new");
  });

  it("throws if asked to decrypt with a missing keyVersion", () => {
    process.env.SLACK_RELAY_MASTER_KEY = TEST_KEY_V1;
    _resetSlackKeyCacheForTests();
    const sealed = sealBotToken("xoxb-mystery");
    expect(() =>
      openBotToken({ ...sealed, keyVersion: 99 }),
    ).toThrow(/no key configured/);
  });

  it("detects ciphertext tampering via the GCM auth tag", () => {
    process.env.SLACK_RELAY_MASTER_KEY = TEST_KEY_V1;
    _resetSlackKeyCacheForTests();
    const sealed = sealBotToken("xoxb-integrity");
    // Flip a byte in the ciphertext
    const buf = Buffer.from(sealed.ciphertext, "base64");
    buf[0] = buf[0] ^ 0xff;
    const tampered = { ...sealed, ciphertext: buf.toString("base64") };
    expect(() => openBotToken(tampered)).toThrow();
  });

  it("detects auth tag tampering", () => {
    process.env.SLACK_RELAY_MASTER_KEY = TEST_KEY_V1;
    _resetSlackKeyCacheForTests();
    const sealed = sealBotToken("xoxb-tag");
    const tag = Buffer.from(sealed.tag, "base64");
    tag[0] = tag[0] ^ 0xff;
    expect(() =>
      openBotToken({ ...sealed, tag: tag.toString("base64") }),
    ).toThrow();
  });
});
