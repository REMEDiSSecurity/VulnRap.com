import { describe, it, expect } from "vitest";
import { detectVulnClass, generateReproGuidance } from "./triage-assistant.js";

describe("detectVulnClass", () => {
  it("detects SQL injection", () => {
    const text = "SQL injection vulnerability found. The query SELECT * FROM users WHERE id = '$input' allows UNION-based injection. SQLi is confirmed via sqlmap.";
    const result = detectVulnClass(text);
    expect(result.vulnClass).toBe("sqli");
    expect(result.label).toContain("SQL");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("detects XSS", () => {
    const text = "Reflected cross-site scripting in the search parameter. Injecting <script>alert(1)</script> causes JavaScript execution in the victim's browser context.";
    const result = detectVulnClass(text);
    expect(result.vulnClass).toBe("xss");
  });

  it("detects buffer overflow", () => {
    const text = "Stack-based buffer overflow in the image parser. Sending a malformed JPEG header causes a heap buffer overflow, leading to arbitrary code execution via memory corruption.";
    const result = detectVulnClass(text);
    expect(result.vulnClass).toBe("buffer_overflow");
  });

  it("detects authentication bypass", () => {
    const text = "Authentication bypass vulnerability. An attacker can bypass login by manipulating the session token. The authorization check is missing on the admin endpoint, allowing unauthorized access.";
    const result = detectVulnClass(text);
    expect(result.vulnClass).toBe("auth_bypass");
  });

  it("returns unknown for unclassifiable text", () => {
    const text = "The application has a performance issue when processing large files.";
    const result = detectVulnClass(text);
    expect(result.vulnClass).toBe("unknown");
    expect(result.confidence).toBe(0);
  });
});

describe("generateReproGuidance", () => {
  it("generates guidance for SQL injection", () => {
    const text = "SQL injection vulnerability found in the login form. The query is vulnerable to UNION-based injection via the username parameter. SQLi allows full database access.";
    const result = generateReproGuidance(text);
    expect(result).not.toBeNull();
    expect(result!.vulnClass).toContain("SQL");
    expect(result!.steps.length).toBeGreaterThan(0);
    expect(result!.tools.length).toBeGreaterThan(0);
  });

  it("returns null for unclassifiable reports", () => {
    const text = "The application is slow when many users are logged in.";
    const result = generateReproGuidance(text);
    expect(result).toBeNull();
  });

  it("includes environment and tools", () => {
    const text = "Reflected XSS in the search parameter. Cross-site scripting payload executes in the browser. Script injection via the q parameter.";
    const result = generateReproGuidance(text);
    expect(result).not.toBeNull();
    expect(result!.environment.length).toBeGreaterThan(0);
    expect(result!.tools.length).toBeGreaterThan(0);
  });
});
