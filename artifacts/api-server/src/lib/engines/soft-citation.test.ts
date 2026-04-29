// Sprint 13C (Task #205) — soft-citation regression tests.
//
// A terse legit report ("found a stored xss") names a recognised vulnerability
// class without including the explicit `CWE-79` token. Pre-Task-205 this hit
// the worst-case "vuln type, no CWE" branch (E3 = 38). After Task #205 the
// engine grants a "soft citation" credit (E3 = 60), recovering 22 points for
// experienced researchers using shorthand without rewarding reports that
// don't even name the class.

import { describe, it, expect } from "vitest";
import { runEngine3 } from "./engines";
import { extractSignals, detectSoftCitation, VULN_TYPE_TO_CWE } from "./extractors";
import { runEngine3Avri } from "./avri/engine3-avri";
import { classifyReport } from "./avri/classify";
import { FAMILIES_BY_ID } from "./avri/families";

describe("Sprint 13C: soft-citation lookup", () => {
  it("VULN_TYPE_TO_CWE has an entry for every recognised vuln type", () => {
    // Sanity: every name detectSoftCitation could possibly return must map to
    // a numeric CWE id, otherwise the lookup silently misses.
    const names = ["XSS", "SQLi", "SSRF", "Buffer Overflow", "Use After Free", "Path Traversal", "Auth Bypass", "CSRF", "RCE", "Info Disclosure"];
    for (const n of names) {
      expect(VULN_TYPE_TO_CWE[n], `missing CWE for ${n}`).toMatch(/^\d+$/);
    }
  });

  it("detectSoftCitation returns the inferred CWE for shorthand prose", () => {
    expect(detectSoftCitation("found a stored xss in comments")).toEqual({ name: "XSS", cweId: "79" });
    expect(detectSoftCitation("classic SQLi via the search box")).toEqual({ name: "SQLi", cweId: "89" });
    expect(detectSoftCitation("there is an open SSRF on /fetch")).toEqual({ name: "SSRF", cweId: "918" });
    expect(detectSoftCitation("classic IDOR on /accounts/:id")).toEqual({ name: "Auth Bypass", cweId: "287" });
  });

  it("detectSoftCitation returns null when no recognised name appears", () => {
    expect(detectSoftCitation("just a generic report about software")).toBeNull();
    expect(detectSoftCitation("maybe a clickjacking issue with no x-frame")).toBeNull();
  });
});

describe("Sprint 13C: legacy E3 soft-citation tier", () => {
  it("terse XSS report (no CWE token) lifts to E3 = 60", () => {
    const text = "found a stored xss in the comments section";
    const signals = extractSignals(text);
    expect(signals.claimedCwes).toEqual([]);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(60);
    const softCite = r.triggeredIndicators.find((i) => i.signal === "SOFT_CITATION");
    expect(softCite, "expected SOFT_CITATION indicator").toBeDefined();
    expect(softCite!.value).toMatch(/XSS .* CWE-79/);
    expect(r.signalBreakdown).toMatchObject({
      softCitation: { name: "XSS", inferredCwe: "CWE-79" },
    });
  });

  it("terse SQLi shorthand also lifts to E3 = 60", () => {
    const text = "noticed SQLi on the login form parameter `username`";
    const signals = extractSignals(text);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(60);
  });

  it("explicit CWE citation is unchanged (per-CWE fingerprint scoring still wins)", () => {
    // Same report content but with the CWE token added — should still go
    // through the per-CWE fingerprint path, not the soft-citation path.
    const text = "Reflected XSS (CWE-79) via the q parameter, payload <script>alert(1)</script>";
    const signals = extractSignals(text);
    expect(signals.claimedCwes).toContain("CWE-79");
    const r = runEngine3(signals, text);
    // Per-CWE fingerprint scoring; not the SOFT_CITATION constant.
    expect(r.triggeredIndicators.some((i) => i.signal === "SOFT_CITATION")).toBe(false);
    expect(r.signalBreakdown).toHaveProperty("perCWEScores");
  });

  it("no CWE and no recognised name still defaults to 42", () => {
    const text = "I think the way you handle errors is bad and could be exploited.";
    const signals = extractSignals(text);
    const r = runEngine3(signals, text);
    expect(r.score).toBe(42);
    expect(r.triggeredIndicators.some((i) => i.signal === "SOFT_CITATION")).toBe(false);
    expect(r.triggeredIndicators.some((i) => i.signal === "NO_CWE_CLAIMED")).toBe(true);
  });
});

describe("Sprint 13C: AVRI E3 soft-citation tier", () => {
  it("terse XSS report uses SOFT_CITATION baseRule with baseScore=60", () => {
    const text = "found a stored xss in the comments section";
    const signals = extractSignals(text);
    const classification = classifyReport(text, signals.claimedCwes);
    const family = FAMILIES_BY_ID[classification.family.id];
    const result = runEngine3Avri(signals, text, family, classification);
    const breakdown = result.engine.signalBreakdown as Record<string, unknown>;
    const avri = breakdown.avri as { baseRule: string; baseScore: number; softCitation: { name: string; inferredCwe: string } | null };
    // Soft citation lifts the base from the suppressed 32/38 tier to 60.
    expect(avri.baseRule).toBe("SOFT_CITATION");
    expect(avri.baseScore).toBe(60);
    expect(avri.softCitation).toEqual({ name: "XSS", inferredCwe: "CWE-79" });
    // Blended score may be reduced by orthogonal coherence checks (e.g. lack
    // of browser/payload tooling for WEB_CLIENT). The contract is that the
    // score recovers substantially above the pre-Task-205 ~38 baseline, not
    // that coherence is suppressed.
    expect(result.engine.score).toBeGreaterThan(45);
    expect(result.engine.triggeredIndicators.some((i) => i.signal === "SOFT_CITATION")).toBe(true);
  });

  it("SOFT_CITATION does not fire when an explicit CWE is cited", () => {
    const text = "Reflected XSS (CWE-79) via the q parameter, payload <script>alert(1)</script>";
    const signals = extractSignals(text);
    const classification = classifyReport(text, signals.claimedCwes);
    const family = FAMILIES_BY_ID[classification.family.id];
    const result = runEngine3Avri(signals, text, family, classification);
    const breakdown = result.engine.signalBreakdown as Record<string, unknown>;
    const avri = breakdown.avri as { baseRule: string };
    expect(avri.baseRule).not.toBe("SOFT_CITATION");
    expect(result.engine.triggeredIndicators.some((i) => i.signal === "SOFT_CITATION")).toBe(false);
  });
});
