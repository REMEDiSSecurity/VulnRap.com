import { describe, expect, it } from "vitest";
import { buildAvriRubricMarkdown } from "@workspace/avri-rubric";

// Task 190: snapshot tests for the shared AVRI Family Rubric markdown
// formatter. These pin the output bit-for-bit so future schema additions
// (new gold-signal field, new behavioural penalty, FLAT category addition)
// have to land here too — preventing the diagnostics-panel JSON/TXT export
// and the /reports/:id/triage-report endpoint from silently drifting again.

describe("buildAvriRubricMarkdown", () => {
  it("returns no lines when neither composite nor engine2 block is present", () => {
    expect(buildAvriRubricMarkdown({ composite: null, engine2: null })).toEqual(
      [],
    );
  });

  it("renders a minimal composite-only block (e.g. reconstructed reports)", () => {
    const lines = buildAvriRubricMarkdown({
      composite: {
        family: "TYPE_CONFUSION",
        familyName: "Type Confusion",
        classification: { confidence: "HIGH", reason: "CWE-843 cited" },
        goldHitCount: 2,
      },
      engine2: null,
    });
    expect(lines).toMatchInlineSnapshot(`
      [
        "## AVRI Family Rubric",
        "",
        "- **Family**: Type Confusion",
        "- **Classification confidence**: HIGH",
        "- **Classification reason**: CWE-843 cited",
        "- **Gold signals**: 2",
        "",
      ]
    `);
  });

  it("renders the full rubric with FLAT-grouped absence penalties, contradictions, stripped trace, fake raw HTTP, and composite overrides", () => {
    const lines = buildAvriRubricMarkdown({
      composite: {
        family: "MEMORY_CORRUPTION",
        familyName: "Memory Corruption",
        classification: {
          confidence: "MEDIUM",
          reason: "ASan stack trace + heap-overflow keywords",
        },
        goldHitCount: 2,
        velocityPenalty: -5,
        templatePenalty: -3,
        rawCompositeBeforeBehavioralPenalties: 62,
      },
      engine2: {
        family: "MEMORY_CORRUPTION",
        familyName: "Memory Corruption",
        goldHitCount: 2,
        goldTotalCount: 3,
        goldHits: [
          { id: "asan_trace", description: "ASan trace present", points: 15 },
          { id: "heap_keyword", description: "Heap keyword cited", points: 10 },
        ],
        goldMisses: [
          { id: "minimal_repro", description: "Minimal reproducer", points: 12 },
        ],
        absencePenalty: -25,
        absencePenalties: [
          {
            id: "no_repro",
            description: '"I have not reproduced this"',
            points: 10,
            flatHandwavyCategory: "absence",
          },
          {
            id: "may_appears",
            description: '"may allow"',
            points: 5,
            flatHandwavyCategory: "hedging",
          },
          {
            id: "buzz_zero_trust",
            description: '"zero-trust posture"',
            points: 5,
            flatHandwavyCategory: "buzzword",
          },
          {
            id: "legacy_no_category",
            description: "Legacy uncategorised marker",
            points: 5,
          },
        ],
        contradictions: ["XSS payload in a buffer-overflow report"],
        crashTrace: {
          framesAnalyzed: 8,
          goodFrames: 1,
          placeholderFrames: 7,
          isStripped: true,
          reason: "7 of 8 frames are placeholders",
          revokedGoldHits: [{ id: "asan_trace", points: 15 }],
          penalty: -15,
        },
        rawHttp: {
          requestsAnalyzed: 1,
          totalHeaders: 4,
          placeholderHeaders: 3,
          crlfPresent: false,
          teClConflicts: 0,
          teClBroken: 0,
          isFake: true,
          reason: "headers are placeholders, no CRLF separators",
          revokedGoldHits: [
            { id: "te_cl_conflict", points: 12 },
          ],
          penalty: -12,
        },
      },
      overridesApplied: [
        "AVRI_NO_GOLD_SIGNALS_TYPE_CONFUSION applied at composite step",
        "UNRELATED_OVERRIDE_RULE",
      ],
    });
    expect(lines).toMatchInlineSnapshot(`
      [
        "## AVRI Family Rubric",
        "",
        "- **Family**: Memory Corruption",
        "- **Classification confidence**: MEDIUM",
        "- **Classification reason**: ASan stack trace + heap-overflow keywords",
        "- **Gold signals**: 2/3",
        "- **Gold signals found**:",
        "  - +15 ASan trace present (asan_trace)",
        "  - +10 Heap keyword cited (heap_keyword)",
        "- **Expected signals missing**:",
        "  - −12 Minimal reproducer (minimal_repro)",
        "- **Absence penalties applied** (haircut -25):",
        "  - Self-admitted absence of evidence (1 phrase, −10 raw):",
        "    - −10 "I have not reproduced this" (no_repro)",
        "  - Generic hedging ("may / appears") (1 phrase, −5 raw):",
        "    - −5 "may allow" (may_appears)",
        "  - Buzzword-soup framings (1 phrase, −5 raw):",
        "    - −5 "zero-trust posture" (buzz_zero_trust)",
        "  - −5 Legacy uncategorised marker (legacy_no_category)",
        "- **Contradiction phrases**: "XSS payload in a buffer-overflow report"",
        "- **Stripped crash trace** (penalty -15): 7 of 8 frames are placeholders — frames 8, good 1, placeholder 7",
        "  - Trace gold signals revoked: asan_trace (−15)",
        "- **Fake raw HTTP request** (penalty -12): headers are placeholders, no CRLF separators — requests 1, headers 1/4 good, placeholder 3, CRLF no, TE/CL conflicts 0 (broken 0)",
        "  - Smuggling gold signals revoked: te_cl_conflict (−12)",
        "- **Composite overrides**:",
        "  - No gold signals for family — \`AVRI_NO_GOLD_SIGNALS_TYPE_CONFUSION applied at composite step\`",
        "  - Submission-velocity penalty applied: -5",
        "  - Template-fingerprint penalty applied: -3",
        "- Composite before behavioural penalties: 62",
        "",
      ]
    `);
  });

  it("falls back to family id and computed gold total when familyName/totalCount are absent", () => {
    const lines = buildAvriRubricMarkdown({
      composite: null,
      engine2: {
        family: "RACE_CONCURRENCY",
        goldHits: [{ id: "tsan", description: "TSan trace", points: 10 }],
        goldMisses: [
          { id: "interleaving", description: "Interleaving sketch", points: 5 },
        ],
      },
    });
    expect(lines).toContain("- **Family**: RACE_CONCURRENCY");
    // computed goldTotal = hits + misses = 2 (no goldTotalCount on engine2)
    expect(lines).toContain("- **Gold signals**: 0/2");
  });

  it("labels stripped traces by family (race / crash / tool)", () => {
    const traceBase = {
      framesAnalyzed: 4,
      goodFrames: 0,
      placeholderFrames: 4,
      isStripped: true,
      reason: null,
      revokedGoldHits: [],
      penalty: -10,
    };
    const memLines = buildAvriRubricMarkdown({
      composite: { family: "MEMORY_CORRUPTION" },
      engine2: { crashTrace: { ...traceBase } },
    });
    const raceLines = buildAvriRubricMarkdown({
      composite: { family: "RACE_CONCURRENCY" },
      engine2: { crashTrace: { ...traceBase } },
    });
    const toolLines = buildAvriRubricMarkdown({
      composite: { family: "ENDPOINT_INJECTION" },
      engine2: { crashTrace: { ...traceBase } },
    });
    expect(memLines.some((l) => l.includes("Stripped crash trace"))).toBe(true);
    expect(raceLines.some((l) => l.includes("Stripped race trace"))).toBe(true);
    expect(toolLines.some((l) => l.includes("Stripped tool trace"))).toBe(true);
  });

  it("only emits the Composite overrides block when there is something to show", () => {
    const lines = buildAvriRubricMarkdown({
      composite: { family: "GENERIC", goldHitCount: 1 },
      engine2: null,
      overridesApplied: ["UNRELATED_OVERRIDE_RULE"],
    });
    expect(lines.some((l) => l.startsWith("- **Composite overrides**"))).toBe(
      false,
    );
  });
});
