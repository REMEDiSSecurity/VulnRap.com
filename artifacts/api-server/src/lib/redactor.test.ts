import { describe, it, expect } from "vitest";
import { redactReport } from "./redactor.js";

describe("redactReport", () => {
  it("redacts email addresses", () => {
    const { redactedText, summary } = redactReport("Contact admin@company.com for details");
    expect(redactedText).toContain("[REDACTED_EMAIL]");
    expect(redactedText).not.toContain("admin@company.com");
    expect(summary.categories.email).toBe(1);
  });

  it("redacts IPv4 addresses", () => {
    const { redactedText } = redactReport("Server at 192.168.1.100 is vulnerable");
    expect(redactedText).toContain("[REDACTED_IP]");
    expect(redactedText).not.toContain("192.168.1.100");
  });

  it("redacts API keys", () => {
    const { redactedText } = redactReport('api_key: "sk_live_abcdef1234567890abcdef"');
    expect(redactedText).toContain("[REDACTED_API_KEY]");
  });

  it("redacts Bearer tokens", () => {
    const { redactedText } = redactReport("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijk");
    expect(redactedText).toContain("[REDACTED_TOKEN]");
  });

  it("redacts JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789";
    const { redactedText } = redactReport(`Token: ${jwt}`);
    expect(redactedText).toContain("[REDACTED_JWT]");
  });

  it("redacts AWS keys", () => {
    const { redactedText } = redactReport("Access key: AKIAIOSFODNN7EXAMPLE");
    expect(redactedText).toContain("[REDACTED_AWS_KEY]");
  });

  it("redacts private keys", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----";
    const { redactedText } = redactReport(key);
    expect(redactedText).toContain("[REDACTED_PRIVATE_KEY]");
  });

  it("redacts passwords", () => {
    const { redactedText } = redactReport('password: "supersecret123"');
    expect(redactedText).toContain("[REDACTED_PASSWORD]");
  });

  it("redacts connection strings", () => {
    const { redactedText } = redactReport("Database: postgres://user:pass@db.internal.local:5432/prod");
    expect(redactedText).toContain("[REDACTED_CONNECTION_STRING]");
  });

  it("redacts internal IPs in URLs", () => {
    const { redactedText } = redactReport("Admin panel at http://192.168.1.50:8080/admin");
    expect(redactedText).toContain("[REDACTED_IP]");
    expect(redactedText).not.toContain("192.168.1.50");
  });

  it("redacts internal hostnames", () => {
    const { redactedText } = redactReport("Connected to db1.acme.internal for data");
    expect(redactedText).toContain("[REDACTED_HOSTNAME]");
  });

  it("redacts SSNs", () => {
    const { redactedText } = redactReport("SSN found: 123-45-6789");
    expect(redactedText).toContain("[REDACTED_SSN]");
  });

  it("counts total redactions correctly", () => {
    const { summary } = redactReport("Email admin@test.com, password: secret123, key: AKIAIOSFODNN7EXAMPLE");
    expect(summary.totalRedactions).toBeGreaterThanOrEqual(3);
  });

  it("preserves non-sensitive text", () => {
    const text = "This is a normal vulnerability description with no sensitive data.";
    const { redactedText, summary } = redactReport(text);
    expect(redactedText).toBe(text);
    expect(summary.totalRedactions).toBe(0);
  });
});
