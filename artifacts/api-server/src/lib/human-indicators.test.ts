import { describe, it, expect } from "vitest";
import { detectHumanIndicators } from "./human-indicators.js";

describe("detectHumanIndicators", () => {
  it("detects contractions as human signal", () => {
    const text = "I don't think this is right. It won't work because the input isn't validated. There aren't any checks on the boundary. The server doesn't enforce the limit correctly.";
    const result = detectHumanIndicators(text);
    const types = result.indicators.map(i => i.type);
    expect(types).toContain("human_contractions");
    expect(result.totalReduction).toBeLessThan(0);
  });

  it("detects informal abbreviations", () => {
    const text = "Found this issue while testing tbh. The endpoint iirc was /api/users. Basically fwiw the auth is broken and anyone can access admin routes.";
    const result = detectHumanIndicators(text);
    const types = result.indicators.map(i => i.type);
    expect(types).toContain("human_informal_language");
  });

  it("detects commit/PR references", () => {
    const text = "This was introduced in commit a1b2c3d4e5f6g and partially fixed in PR #42. The regression appeared after merge request #15 was applied to the main branch.";
    const result = detectHumanIndicators(text);
    const types = result.indicators.map(i => i.type);
    expect(types).toContain("human_commit_refs");
  });

  it("detects patched version references", () => {
    const text = "This vulnerability was fixed in version 2.3.1 but the fix was incomplete. The issue was properly patched in v2.4.0 with additional boundary checks added to the input parser.";
    const result = detectHumanIndicators(text);
    const types = result.indicators.map(i => i.type);
    expect(types).toContain("human_patched_version");
  });

  it("detects named researcher attribution", () => {
    const text = "This issue was reported by Alice Johnson who discovered the flaw during a routine code audit. The vulnerability affects the core authentication module and requires immediate attention.";
    const result = detectHumanIndicators(text);
    const types = result.indicators.map(i => i.type);
    expect(types).toContain("human_named_researcher");
  });

  it("detects lack of AI pleasantries", () => {
    const text = "Buffer overflow in libpng 1.6.39. The png_read_row function does not bounds-check the row_info->rowbytes field against the allocated buffer size. When processing a malformed IHDR chunk with width greater than two to the power of thirty, the multiplication overflows and a small buffer gets allocated. Subsequent row reads write past the buffer end. Crash is trivial to trigger by feeding the attached PNG to any application linking libpng. Affects all platforms and versions since the initial release of the library. The fix involves adding a check for the maximum possible row size before allocating the buffer. No workaround is available other than upgrading. Proof of concept file is attached below.";
    const result = detectHumanIndicators(text);
    const types = result.indicators.map(i => i.type);
    expect(types).toContain("human_no_pleasantries");
  });

  it("does NOT flag pleasantries if present", () => {
    const text = "Dear Security Team, I hope this finds you well. I would like to report a vulnerability in your application. Thank you for your time. Best regards, Researcher. " + "x ".repeat(50);
    const result = detectHumanIndicators(text);
    const types = result.indicators.map(i => i.type);
    expect(types).not.toContain("human_no_pleasantries");
  });

  it("applies compound multiplier for multiple indicators", () => {
    const text = "Found this while debugging tbh. Commit a1b2c3d4e5f was the cause. It's a race condition that won't trigger without concurrent requests. Fixed in v3.2.1 but the backport doesn't cover the edge case where the lock isn't released properly. We've been tracking this since the refactor in PR #88 — iirc the original code had a mutex but it was removed for performance reasons. The server can't handle the load under these conditions.";
    const result = detectHumanIndicators(text);
    expect(result.indicators.length).toBeGreaterThanOrEqual(3);
    const baseSum = result.indicators.reduce((s, i) => s + i.weight, 0);
    expect(Math.abs(result.totalReduction)).toBeGreaterThan(Math.abs(baseSum));
  });

  it("returns empty indicators for generic AI-like text", () => {
    const text = "It is important to note that this vulnerability represents a significant security risk. In the realm of cybersecurity, proactive measures must be taken to ensure robust security. The implications of this finding are multifaceted and require a holistic approach to remediation.";
    const result = detectHumanIndicators(text);
    expect(result.indicators.length).toBeLessThanOrEqual(1);
  });

  it("detects terse writing style", () => {
    const text = "Buffer overflow. Stack smash. No ASLR. No canary. Trivial RCE. Heap spray works. Got shell in 3 tries. Patch the bounds check. Test attached. See crash log. Affects v2 and v3. Fix is one-liner. " + "Short line. ".repeat(10);
    const result = detectHumanIndicators(text);
    const types = result.indicators.map(i => i.type);
    expect(types).toContain("human_terse_style");
  });
});
