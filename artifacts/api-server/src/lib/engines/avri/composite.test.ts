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
});
