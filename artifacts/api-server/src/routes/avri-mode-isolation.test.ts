import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeWithEnginesTraced } from "../lib/engines/index";

describe("AVRI forceAvri option does not leak through process.env", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.VULNRAP_USE_AVRI;
    delete process.env.VULNRAP_USE_AVRI;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.VULNRAP_USE_AVRI;
    else process.env.VULNRAP_USE_AVRI = originalEnv;
  });

  const sampleText = `# Stored XSS in profile bio
The bio field on /profile reflects user input without escaping. PoC:
\`\`\`
<script>alert(1)</script>
\`\`\`
Tested on Chrome 122. Fix: HTML-escape on render.`;

  it("forceAvri=true/false does not mutate process.env.VULNRAP_USE_AVRI", () => {
    expect(process.env.VULNRAP_USE_AVRI).toBeUndefined();
    analyzeWithEnginesTraced(sampleText, { forceAvri: true });
    expect(process.env.VULNRAP_USE_AVRI).toBeUndefined();
    analyzeWithEnginesTraced(sampleText, { forceAvri: false });
    expect(process.env.VULNRAP_USE_AVRI).toBeUndefined();
  });

  it("forceAvri produces deterministic, isolated results across repeated calls", () => {
    const onA = analyzeWithEnginesTraced(sampleText, { forceAvri: true }).composite.overallScore;
    const offA = analyzeWithEnginesTraced(sampleText, { forceAvri: false }).composite.overallScore;
    const onB = analyzeWithEnginesTraced(sampleText, { forceAvri: true }).composite.overallScore;
    const offB = analyzeWithEnginesTraced(sampleText, { forceAvri: false }).composite.overallScore;
    expect(onA).toBe(onB);
    expect(offA).toBe(offB);
  });

  it("forceAvri overrides the env flag without persisting the override", () => {
    process.env.VULNRAP_USE_AVRI = "false";
    const forcedOn = analyzeWithEnginesTraced(sampleText, { forceAvri: true }).composite.overallScore;
    expect(process.env.VULNRAP_USE_AVRI).toBe("false");
    const defaultRun = analyzeWithEnginesTraced(sampleText).composite.overallScore;
    const forcedOnAgain = analyzeWithEnginesTraced(sampleText, { forceAvri: true }).composite.overallScore;
    expect(forcedOnAgain).toBe(forcedOn);
    // env flag still says off, so default-mode score should equal forceAvri=false score
    const forcedOff = analyzeWithEnginesTraced(sampleText, { forceAvri: false }).composite.overallScore;
    expect(defaultRun).toBe(forcedOff);
  });
});
