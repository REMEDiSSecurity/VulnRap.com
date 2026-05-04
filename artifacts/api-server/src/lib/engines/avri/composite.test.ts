// Composite-layer override regression coverage for the AVRI overrides that
// key off `e2.detail.contradictions` and `e2.detail.absencePenalty`.
//
// Task #394 collapsed the engine's internal AVRI record into the shared
// `AvriEngine2Block` shape and updated `composite.ts` to read those
// canonical field names. The AVRI engine itself has thorough tests, but
// the composite override branches —
//   * `AVRI_FAMILY_CONTRADICTION` (fires when
//     `e2.detail.contradictions.length >= 1` for a non-FLAT family)
//   * `AVRI_FLAT_SLOP_HAIRCUT` (fires when `family.id === "FLAT"` and
//     `-e2.detail.absencePenalty >= 18`)
// — were not exercised end-to-end. A future rename of either field on
// `AvriEngine2Block` would silently turn both branches into no-ops on
// the persisted JSON path.
//
// These tests pin the override behavior to crafted inputs so a rename
// that loses the wiring shows up as a red test instead of a silently
// disabled override.
import { describe, expect, it } from "vitest";
import { runAvriComposite } from "./composite";
import { runEngine2Avri } from "./engine2-avri";
import { runEngine3Avri } from "./engine3-avri";
import { extractSignals } from "../extractors";
import { classifyReport } from "./classify";

// A small INJECTION report with concrete payload + endpoint so the
// classifier routes it to INJECTION (non-FLAT) and Engine 2 doesn't
// crater on absence penalties. The prose deliberately includes the
// contradiction phrase `addresssanitizer` (a MEMORY_CORRUPTION marker)
// to trip the family-contradiction override.
const INJECTION_WITH_CONTRADICTION = `
# SQL Injection in /api/v1/login

CWE-89. The endpoint POST /api/v1/login concatenates the email parameter
straight into a SQL string:

\`\`\`python
query = "SELECT * FROM users WHERE email = '" + email + "' AND active = 1"
cursor.execute(query)
\`\`\`

Repro:
POST /api/v1/login
Content-Type: application/x-www-form-urlencoded

email=admin' OR 1=1-- &password=x

The application returns the first row, granting auth bypass. Note: while
debugging I also ran this under addresssanitizer to look for memory
issues, but the bug is purely a SQL injection.
`;

const INJECTION_CLEAN = `
# SQL Injection in /api/v1/login

CWE-89. The endpoint POST /api/v1/login concatenates the email parameter
straight into a SQL string:

\`\`\`python
query = "SELECT * FROM users WHERE email = '" + email + "' AND active = 1"
cursor.execute(query)
\`\`\`

Repro:
POST /api/v1/login
Content-Type: application/x-www-form-urlencoded

email=admin' OR 1=1-- &password=x

The application returns the first row, granting auth bypass.
`;

// Three FLAT-handwavy phrases × 6 = 18 → FLAT slop haircut threshold.
const FLAT_SLOP_THREE_PHRASES = `
# Possible issue in the deployment

I do not have a runnable reproducer for this finding. The structural
vulnerability follows from the design as observed in production. I have
not enumerated every endpoint but the pattern is consistent.

There is no concrete payload here; this is a design-level concern.
`;

// Two FLAT-handwavy phrases × 6 = 12 → below the 18 haircut threshold,
// so AVRI_FLAT_SLOP_HAIRCUT must NOT fire.
const FLAT_SLOP_TWO_PHRASES = `
# Possible issue in the deployment

I do not have a runnable reproducer for this finding. I have not
enumerated every endpoint but the pattern is consistent.
`;

function familyOf(text: string, claimedCwes?: string[]): string {
  return classifyReport(text, claimedCwes).family.id;
}

describe("runAvriComposite override wiring (Task #745)", () => {
  describe("AVRI_FAMILY_CONTRADICTION", () => {
    it("fires when e2.detail.contradictions is non-empty for a non-FLAT family", () => {
      // Sanity: the report must classify into a non-FLAT family,
      // otherwise the override branch is gated off.
      expect(familyOf(INJECTION_WITH_CONTRADICTION, ["89"])).toBe("INJECTION");

      // And the engine must actually populate `contradictions` on the
      // shared AvriEngine2Block — this is the field composite reads.
      const signals = extractSignals(INJECTION_WITH_CONTRADICTION, ["89"]);
      const cls = classifyReport(INJECTION_WITH_CONTRADICTION, ["89"]);
      const e2 = runEngine2Avri(
        signals,
        INJECTION_WITH_CONTRADICTION,
        cls.family,
      );
      expect(e2.detail.contradictions.length).toBeGreaterThanOrEqual(1);
      expect(e2.detail.contradictions).toContain("addresssanitizer");

      const result = runAvriComposite(INJECTION_WITH_CONTRADICTION, {
        claimedCwes: ["89"],
      });
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_FAMILY_CONTRADICTION:"),
        ),
        `overrides: ${result.overridesApplied.join(" | ")}`,
      ).toBe(true);
      // The override message must include the offending phrase from
      // `contradictions[0]`, which is what composite interpolates.
      expect(
        result.overridesApplied.find((o) =>
          o.startsWith("AVRI_FAMILY_CONTRADICTION:"),
        ),
      ).toContain("addresssanitizer");
    });

    it("does not fire when contradictions is empty for the same family", () => {
      expect(familyOf(INJECTION_CLEAN, ["89"])).toBe("INJECTION");

      const signals = extractSignals(INJECTION_CLEAN, ["89"]);
      const cls = classifyReport(INJECTION_CLEAN, ["89"]);
      const e2 = runEngine2Avri(signals, INJECTION_CLEAN, cls.family);
      expect(e2.detail.contradictions).toEqual([]);

      const result = runAvriComposite(INJECTION_CLEAN, { claimedCwes: ["89"] });
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_FAMILY_CONTRADICTION:"),
        ),
      ).toBe(false);
    });

    it("does not fire for FLAT family even if contradictions field were populated", () => {
      // FLAT reports always emit `contradictions: []` from Engine 2, but
      // the override is also explicitly gated on `family.id !== "FLAT"`
      // — pin both halves of that gate.
      expect(familyOf(FLAT_SLOP_THREE_PHRASES)).toBe("FLAT");
      const result = runAvriComposite(FLAT_SLOP_THREE_PHRASES);
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_FAMILY_CONTRADICTION:"),
        ),
      ).toBe(false);
    });
  });

  describe("AVRI_FLAT_SLOP_HAIRCUT", () => {
    it("fires when FLAT family accumulates absencePenalty <= -18", () => {
      expect(familyOf(FLAT_SLOP_THREE_PHRASES)).toBe("FLAT");

      // Pin the field name + sign convention composite reads. The
      // haircut magnitude is `-e2.detail.absencePenalty`, so the
      // persisted value must be ≤ -18 for the branch to fire.
      const signals = extractSignals(FLAT_SLOP_THREE_PHRASES);
      const cls = classifyReport(FLAT_SLOP_THREE_PHRASES);
      const e2 = runEngine2Avri(signals, FLAT_SLOP_THREE_PHRASES, cls.family);
      expect(e2.detail.absencePenalty).toBeLessThanOrEqual(-18);

      const result = runAvriComposite(FLAT_SLOP_THREE_PHRASES);
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_FLAT_SLOP_HAIRCUT:"),
        ),
        `overrides: ${result.overridesApplied.join(" | ")}`,
      ).toBe(true);
    });

    it("does not fire when FLAT haircut is below the 18-point threshold", () => {
      expect(familyOf(FLAT_SLOP_TWO_PHRASES)).toBe("FLAT");

      const signals = extractSignals(FLAT_SLOP_TWO_PHRASES);
      const cls = classifyReport(FLAT_SLOP_TWO_PHRASES);
      const e2 = runEngine2Avri(signals, FLAT_SLOP_TWO_PHRASES, cls.family);
      expect(e2.detail.absencePenalty).toBeGreaterThan(-18);

      const result = runAvriComposite(FLAT_SLOP_TWO_PHRASES);
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_FLAT_SLOP_HAIRCUT:"),
        ),
      ).toBe(false);
    });

    it("does not fire for non-FLAT families regardless of absencePenalty magnitude", () => {
      // INJECTION reports with no payload + no endpoint will hit the
      // family's own absence penalties, but the FLAT slop haircut
      // branch is explicitly gated on `family.id === "FLAT"`. Pin it.
      const text = `
# Some injection bug

CWE-89. There is a SQL injection somewhere in the login flow but I
cannot share details. No reproducer available.
`;
      // This text is sparse enough that it may classify FLAT without a
      // claimed CWE; force INJECTION via the CWE claim so the gate
      // condition we want to exercise is the family-id check.
      expect(familyOf(text, ["89"])).toBe("INJECTION");
      const result = runAvriComposite(text, { claimedCwes: ["89"] });
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_FLAT_SLOP_HAIRCUT:"),
        ),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // New coverage added by Task #1122
  // ---------------------------------------------------------------------------

  describe("AVRI_NO_GOLD_SIGNALS", () => {
    // A non-FLAT report that classifies as INJECTION via the `claimedCwes`
    // parameter but whose text body contains no CWE number, no SQL syntax,
    // no payload and no endpoint — nothing that would match any INJECTION
    // gold-signal pattern (including `cwe_correct_class` which fires on
    // "CWE-89" in the text).  Both Engine 2 and Engine 3 must see
    // goldHitCount === 0 so the composite override fires.
    const NO_GOLD_INJECTION = `
# Security finding

There may be a vulnerability present in the application.
I do not have a working reproducer at this time and cannot share further details.
`;

    it("fires when both e2.detail.goldHitCount and e3.detail.goldHitCount are zero for a non-FLAT family", () => {
      expect(familyOf(NO_GOLD_INJECTION, ["89"])).toBe("INJECTION");

      // Pin the two field names composite reads — a rename of either must
      // break this test loudly rather than silently disabling the override.
      const signals = extractSignals(NO_GOLD_INJECTION, ["89"]);
      const cls = classifyReport(NO_GOLD_INJECTION, ["89"]);
      const e2 = runEngine2Avri(signals, NO_GOLD_INJECTION, cls.family);
      const e3 = runEngine3Avri(signals, NO_GOLD_INJECTION, cls.family, cls);
      expect(e2.detail.goldHitCount).toBe(0);
      expect(e3.detail.goldHitCount).toBe(0);

      const result = runAvriComposite(NO_GOLD_INJECTION, {
        claimedCwes: ["89"],
      });
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_NO_GOLD_SIGNALS:"),
        ),
        `overrides: ${result.overridesApplied.join(" | ")}`,
      ).toBe(true);
      // The override message must include the family display name.
      expect(
        result.overridesApplied.find((o) =>
          o.startsWith("AVRI_NO_GOLD_SIGNALS:"),
        ),
      ).toContain("Injection");
    });

    it("does not fire when at least one engine has goldHitCount > 0", () => {
      // INJECTION_CLEAN has concrete SQL payload — Engine 2 or 3 will award
      // at least one gold hit, so the gate `e2.goldHitCount === 0 &&
      // e3.detail.goldHitCount === 0` must fail and the override must not fire.
      expect(familyOf(INJECTION_CLEAN, ["89"])).toBe("INJECTION");

      const signals = extractSignals(INJECTION_CLEAN, ["89"]);
      const cls = classifyReport(INJECTION_CLEAN, ["89"]);
      const e2 = runEngine2Avri(signals, INJECTION_CLEAN, cls.family);
      const e3 = runEngine3Avri(signals, INJECTION_CLEAN, cls.family, cls);
      // At least one engine must see a gold signal for this test to be
      // meaningful — assert it so a future rubric change doesn't make this
      // an accidental duplicate of the positive-case test.
      expect(e2.detail.goldHitCount + e3.detail.goldHitCount).toBeGreaterThan(
        0,
      );

      const result = runAvriComposite(INJECTION_CLEAN, { claimedCwes: ["89"] });
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_NO_GOLD_SIGNALS:"),
        ),
      ).toBe(false);
    });

    it("does not fire for FLAT family even with zero gold hits", () => {
      // The override is explicitly gated on `family.id !== "FLAT"`.
      // FLAT reports always have goldHitCount === 0, but the branch must not fire.
      expect(familyOf(FLAT_SLOP_TWO_PHRASES)).toBe("FLAT");
      const result = runAvriComposite(FLAT_SLOP_TWO_PHRASES);
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_NO_GOLD_SIGNALS:"),
        ),
      ).toBe(false);
    });
  });

  describe("AVRI_VELOCITY", () => {
    it("fires when velocityPenalty is negative and reduces the overall score", () => {
      const penalty = -12;
      const baseline = runAvriComposite(INJECTION_CLEAN, {
        claimedCwes: ["89"],
      });
      const withPenalty = runAvriComposite(INJECTION_CLEAN, {
        claimedCwes: ["89"],
        // Pin the option field name that composite reads.
        velocityPenalty: penalty,
      });

      expect(
        withPenalty.overridesApplied.some((o) =>
          o.startsWith("AVRI_VELOCITY:"),
        ),
        `overrides: ${withPenalty.overridesApplied.join(" | ")}`,
      ).toBe(true);
      // The override message must include the penalty value so future
      // format changes are caught by this assertion.
      expect(
        withPenalty.overridesApplied.find((o) =>
          o.startsWith("AVRI_VELOCITY:"),
        ),
      ).toContain(String(penalty));
      // Score must have dropped by exactly the penalty amount (clamped to 0).
      expect(withPenalty.overallScore).toBe(
        Math.max(0, baseline.overallScore + penalty),
      );
      // Confirm the avri block also records the applied penalty.
      expect(withPenalty.avri.velocityPenalty).toBe(penalty);
    });

    it("does not fire when velocityPenalty is zero or omitted", () => {
      for (const opts of [
        { claimedCwes: ["89"] as string[], velocityPenalty: 0 },
        { claimedCwes: ["89"] as string[] },
      ]) {
        const result = runAvriComposite(INJECTION_CLEAN, opts);
        expect(
          result.overridesApplied.some((o) => o.startsWith("AVRI_VELOCITY:")),
          `overrides with opts ${JSON.stringify(opts)}: ${result.overridesApplied.join(" | ")}`,
        ).toBe(false);
      }
    });

    it("clamps positive velocityPenalty to zero so it cannot inflate the score", () => {
      // The composite applies `Math.min(0, opts.velocityPenalty)`, so a
      // caller that accidentally passes a positive value is silently ignored.
      const result = runAvriComposite(INJECTION_CLEAN, {
        claimedCwes: ["89"],
        velocityPenalty: 5,
      });
      expect(result.avri.velocityPenalty).toBe(0);
      expect(
        result.overridesApplied.some((o) => o.startsWith("AVRI_VELOCITY:")),
      ).toBe(false);
    });
  });

  describe("AVRI_TEMPLATE_CAMPAIGN", () => {
    it("fires when templatePenalty is negative and reduces the overall score", () => {
      const penalty = -8;
      const baseline = runAvriComposite(INJECTION_CLEAN, {
        claimedCwes: ["89"],
      });
      const withPenalty = runAvriComposite(INJECTION_CLEAN, {
        claimedCwes: ["89"],
        // Pin the option field name that composite reads.
        templatePenalty: penalty,
      });

      expect(
        withPenalty.overridesApplied.some((o) =>
          o.startsWith("AVRI_TEMPLATE_CAMPAIGN:"),
        ),
        `overrides: ${withPenalty.overridesApplied.join(" | ")}`,
      ).toBe(true);
      expect(
        withPenalty.overridesApplied.find((o) =>
          o.startsWith("AVRI_TEMPLATE_CAMPAIGN:"),
        ),
      ).toContain(String(penalty));
      expect(withPenalty.overallScore).toBe(
        Math.max(0, baseline.overallScore + penalty),
      );
      expect(withPenalty.avri.templatePenalty).toBe(penalty);
    });

    it("does not fire when templatePenalty is zero or omitted", () => {
      for (const opts of [
        { claimedCwes: ["89"] as string[], templatePenalty: 0 },
        { claimedCwes: ["89"] as string[] },
      ]) {
        const result = runAvriComposite(INJECTION_CLEAN, opts);
        expect(
          result.overridesApplied.some((o) =>
            o.startsWith("AVRI_TEMPLATE_CAMPAIGN:"),
          ),
          `overrides with opts ${JSON.stringify(opts)}: ${result.overridesApplied.join(" | ")}`,
        ).toBe(false);
      }
    });

    it("both velocity and template penalties stack and both overrides appear", () => {
      const vp = -7;
      const tp = -5;
      const baseline = runAvriComposite(INJECTION_CLEAN, {
        claimedCwes: ["89"],
      });
      const result = runAvriComposite(INJECTION_CLEAN, {
        claimedCwes: ["89"],
        velocityPenalty: vp,
        templatePenalty: tp,
      });
      expect(
        result.overridesApplied.some((o) => o.startsWith("AVRI_VELOCITY:")),
      ).toBe(true);
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_TEMPLATE_CAMPAIGN:"),
        ),
      ).toBe(true);
      expect(result.overallScore).toBe(
        Math.max(0, baseline.overallScore + vp + tp),
      );
    });
  });

  describe("AVRI_FABRICATED_PATCH (fabricatedPatchPenalty)", () => {
    // A report that explicitly claims to supply a patch/fix using one of the
    // narrow trigger phrases, but has no real diff hunk and no code block.
    const FABRICATED_PATCH_REPORT = `
# XSS in profile page

CWE-79. The user display name is injected into the DOM without escaping.

Suggested remediation: the suggested patch escapes the output before insertion.
The fix should call encodeURIComponent on the value prior to appending it to
the innerHTML property. I wrote the suggested patch from memory as I no longer
have access to the source tree.
`;

    // A report that triggers the claim phrase but escapes the penalty because
    // it includes a substantive code block (≥2 non-empty lines).
    const PATCH_WITH_CODE_BLOCK = `
# XSS in profile page

CWE-79. Suggested patch below.

\`\`\`javascript
const safe = encodeURIComponent(userInput);
element.textContent = safe;
\`\`\`
`;

    it("fires when the report claims a patch but has no real diff or code block", () => {
      const result = runAvriComposite(FABRICATED_PATCH_REPORT);
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_FABRICATED_PATCH:"),
        ),
        `overrides: ${result.overridesApplied.join(" | ")}`,
      ).toBe(true);
      // The override message must carry the points value so a weight change
      // breaks this assertion rather than silently adjusting the score.
      const msg = result.overridesApplied.find((o) =>
        o.startsWith("AVRI_FABRICATED_PATCH:"),
      );
      expect(msg).toContain("-10");
      // Score must be exactly 10 points below the raw composite (before any
      // behavioral overrides), clamped to 0.  Use the persisted
      // `rawCompositeBeforeBehavioralPenalties` field rather than running a
      // second "clean" fixture so the assertion isn't sensitive to unrelated
      // text differences between two separate inputs.
      const raw = result.avri.rawCompositeBeforeBehavioralPenalties;
      expect(result.overallScore).toBe(Math.max(0, raw - 10));
    });

    it("does not fire when a substantive code block is present", () => {
      // The fabricatedPatchPenalty exempts reports that include ≥2 non-empty
      // lines inside a code fence — this pins that escape hatch.
      const result = runAvriComposite(PATCH_WITH_CODE_BLOCK);
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_FABRICATED_PATCH:"),
        ),
      ).toBe(false);
    });

    it("does not fire when no patch-claim phrase is present", () => {
      const result = runAvriComposite(INJECTION_CLEAN, { claimedCwes: ["89"] });
      expect(
        result.overridesApplied.some((o) =>
          o.startsWith("AVRI_FABRICATED_PATCH:"),
        ),
      ).toBe(false);
    });
  });
});
