import { describe, it, expect } from "vitest";
import { sanitizeText, sanitizeFileName, detectBinaryContent } from "./sanitize.js";

describe("sanitizeText", () => {
  it("removes script tags", () => {
    const input = 'Hello <script>alert("xss")</script> world';
    const result = sanitizeText(input);
    expect(result).toContain("[removed-script]");
    expect(result).not.toContain("<script>");
  });

  it("removes style tags", () => {
    const input = "Hello <style>body{display:none}</style> world";
    const result = sanitizeText(input);
    expect(result).toContain("[removed-style]");
    expect(result).not.toContain("<style>");
  });

  it("removes event handlers", () => {
    const input = 'Click <div onclick="steal()" /> here';
    const result = sanitizeText(input);
    expect(result).toContain("[removed-event-handler]");
  });

  it("removes javascript: URIs", () => {
    const input = "Visit javascript:alert(1)";
    const result = sanitizeText(input);
    expect(result).toContain("[removed-js-uri]");
  });

  it("removes null bytes and control characters", () => {
    const input = "Clean\x00text\x01here\x07end";
    const result = sanitizeText(input);
    expect(result).not.toContain("\x00");
    expect(result).not.toContain("\x01");
    expect(result).not.toContain("\x07");
    expect(result).toBe("Cleantexthereend");
  });

  it("collapses excessive whitespace", () => {
    const input = "a" + " ".repeat(50) + "b";
    const result = sanitizeText(input);
    expect(result.length).toBeLessThan(input.length);
  });

  it("collapses excessive newlines", () => {
    const input = "a" + "\n".repeat(20) + "b";
    const result = sanitizeText(input);
    const newlineCount = (result.match(/\n/g) || []).length;
    expect(newlineCount).toBeLessThanOrEqual(5);
  });

  it("truncates input exceeding 5MB", () => {
    const input = "x".repeat(6 * 1024 * 1024);
    const result = sanitizeText(input);
    expect(result.length).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it("trims leading/trailing whitespace", () => {
    expect(sanitizeText("  hello  ")).toBe("hello");
  });

  it("preserves normal markdown and code blocks", () => {
    const input = "## Vulnerability\n\n```python\nprint('hello')\n```";
    expect(sanitizeText(input)).toBe(input);
  });
});

describe("sanitizeFileName", () => {
  it("strips dangerous characters", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("etcpasswd");
  });

  it("handles double dots", () => {
    expect(sanitizeFileName("file..txt")).toBe("file.txt");
  });

  it("removes leading dots", () => {
    expect(sanitizeFileName(".hidden")).toBe("hidden");
  });

  it("truncates long filenames to 255 chars", () => {
    const longName = "a".repeat(300) + ".txt";
    expect(sanitizeFileName(longName).length).toBeLessThanOrEqual(255);
  });

  it("preserves valid filenames", () => {
    expect(sanitizeFileName("report-2024.txt")).toBe("report-2024.txt");
  });
});

describe("detectBinaryContent", () => {
  it("detects binary content with many null bytes", () => {
    const binary = Buffer.alloc(100, 0);
    expect(detectBinaryContent(binary)).toBe(true);
  });

  it("returns false for text content", () => {
    const text = Buffer.from("This is a normal text report about a vulnerability.");
    expect(detectBinaryContent(text)).toBe(false);
  });

  it("handles empty buffer", () => {
    expect(detectBinaryContent(Buffer.alloc(0))).toBe(false);
  });
});
