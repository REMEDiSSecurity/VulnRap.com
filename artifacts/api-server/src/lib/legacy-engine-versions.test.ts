import { describe, it, expect } from "vitest";
import {
  inferLegacyEngineVersions,
  LEGACY_AVRI_VERSION,
  LEGACY_BASE_VERSION,
  LEGACY_VULNRAP_VERSION,
} from "./legacy-engine-versions";

describe("inferLegacyEngineVersions", () => {
  it("pins everything to 3.0.0 when the vulnrap blob is absent", () => {
    expect(inferLegacyEngineVersions(null)).toEqual({
      linguistic: LEGACY_BASE_VERSION,
      substance: LEGACY_BASE_VERSION,
      cwe: LEGACY_BASE_VERSION,
      avri: LEGACY_BASE_VERSION,
      fusion: LEGACY_BASE_VERSION,
    });
    expect(inferLegacyEngineVersions(undefined).fusion).toBe(
      LEGACY_BASE_VERSION,
    );
  });

  it("treats an empty blob with no vulnrap shape as pre-VulnRap", () => {
    expect(inferLegacyEngineVersions({}).linguistic).toBe(LEGACY_BASE_VERSION);
  });

  it("pins to 3.5.0 when a vulnrap composite blob is present but AVRI is not", () => {
    const blob = {
      engines: [{ engine: "Linguistic", score: 50 }],
      compositeBreakdown: { weightedSum: 50, totalWeight: 1 },
    };
    const out = inferLegacyEngineVersions(blob);
    expect(out.fusion).toBe(LEGACY_VULNRAP_VERSION);
    expect(out.avri).toBe(LEGACY_VULNRAP_VERSION);
  });

  it("pins to 3.6.0 when the blob carries an AVRI sub-block", () => {
    const blob = {
      engines: [{ engine: "Technical Substance", score: 40 }],
      avri: { family: { id: "INFRASTRUCTURE_MISCONFIG" } },
    };
    expect(inferLegacyEngineVersions(blob).avri).toBe(LEGACY_AVRI_VERSION);
    expect(inferLegacyEngineVersions(blob).linguistic).toBe(
      LEGACY_AVRI_VERSION,
    );
  });

  it("ignores non-object blobs defensively", () => {
    expect(inferLegacyEngineVersions("not-a-blob").fusion).toBe(
      LEGACY_BASE_VERSION,
    );
    expect(inferLegacyEngineVersions(42).fusion).toBe(LEGACY_BASE_VERSION);
  });
});
