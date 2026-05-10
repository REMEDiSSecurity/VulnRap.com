import { describe, it, expect } from "vitest";
import { __TESTING__ } from "./audit-log-middleware";

const { redactPayload, redactStringValue } = __TESTING__;

describe("redactStringValue", () => {
  it("redacts OpenAI-style sk- keys", () => {
    expect(redactStringValue("key=sk-abcdefghijklmnopqrstuvwxyz")).toContain(
      "[REDACTED:secret]",
    );
  });
  it("redacts GitHub PATs", () => {
    expect(redactStringValue("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(
      "[REDACTED:secret]",
    );
  });
  it("redacts AWS access keys", () => {
    expect(redactStringValue("AKIAABCDEFGHIJKLMNOP something")).toContain(
      "[REDACTED:secret]",
    );
  });
  it("redacts JWT-shaped tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactStringValue(`token=${jwt}`)).toContain("[REDACTED:secret]");
  });
  it("redacts Google API keys", () => {
    // Google keys are exactly 35 chars after the "AIza" prefix.
    expect(redactStringValue("AIzaSyA1234567890abcdefghij_klmnopqrstu")).toBe(
      "[REDACTED:secret]",
    );
  });
  it("redacts inline PEM blocks", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nABCDEF\n-----END PRIVATE KEY-----";
    expect(redactStringValue(pem)).toBe("[REDACTED:secret]");
  });
  it("leaves ordinary text alone", () => {
    expect(redactStringValue("the quick brown fox jumps over 99 lazy dogs"))
      .toBe("the quick brown fox jumps over 99 lazy dogs");
  });
});

describe("redactPayload + value patterns", () => {
  it("redacts secret-shaped values nested in innocent-named fields", () => {
    const out = redactPayload({
      reviewer: "alice",
      notes: "leftover key sk-abcdefghijklmnopqrstuvwxyz0123 in the body",
      meta: { description: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(out)).not.toContain("ghp_aaaa");
    expect(JSON.stringify(out)).toContain("[REDACTED:secret]");
    // Non-secret fields untouched.
    expect(out.reviewer).toBe("alice");
  });

  it("still redacts secret-named keys via the existing key regex", () => {
    const out = redactPayload({ token: "anything", apiKey: "x" }) as Record<
      string,
      unknown
    >;
    expect(out.token).toBe("[REDACTED]");
    expect(out.apiKey).toBe("[REDACTED]");
  });
});
