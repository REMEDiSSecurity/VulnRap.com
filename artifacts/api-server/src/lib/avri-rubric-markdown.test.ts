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
        "  - Gold signals revoked: te_cl_conflict (−12)",
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

  // Task #319 — pin the new "Response Plausibility" sub-section so the
  // printable triage report markdown carries the per-response markers
  // (missing Date/Server, suspiciously clean JSON body, missing
  // incidentals) and the response-class revoked gold signal id(s) the
  // diagnostics panel already shows. Future fabricated-response
  // detector additions land here too.
  it("renders a Response Plausibility sub-section with markers and revoked gold signals when the response side is fake", () => {
    const lines = buildAvriRubricMarkdown({
      composite: { family: "INJECTION", familyName: "Injection" },
      engine2: {
        family: "INJECTION",
        familyName: "Injection",
        rawHttp: {
          requestsAnalyzed: 0,
          totalHeaders: 0,
          placeholderHeaders: 0,
          crlfPresent: false,
          teClConflicts: 0,
          teClBroken: 0,
          isFake: true,
          reason:
            "Raw HTTP response is fabricated (no Date header, suspiciously clean JSON body)",
          revokedGoldHits: [
            { id: "request_response_diff", points: 12 },
          ],
          penalty: -12,
          response: {
            responsesAnalyzed: 1,
            responsesFlagged: 1,
            totalHeaders: 2,
            responsesMissingDate: 1,
            responsesMissingServer: 1,
            responsesWithSuspiciousJsonBody: 1,
            responsesMissingIncidentals: 1,
            isFake: true,
            reason:
              "Raw HTTP response is fabricated (no Date header, suspiciously clean JSON body)",
            revokedGoldHits: [
              { id: "request_response_diff", points: 12 },
            ],
          },
        },
      },
    });
    expect(lines).toMatchInlineSnapshot(`
      [
        "## AVRI Family Rubric",
        "",
        "- **Family**: Injection",
        "- **Fake raw HTTP response** (penalty -12): Raw HTTP response is fabricated (no Date header, suspiciously clean JSON body) — requests 0, headers 0/0 good, placeholder 0, CRLF no, TE/CL conflicts 0 (broken 0)",
        "  - **Response Plausibility** (1/1 response block flagged):",
        "    - Raw HTTP response is fabricated (no Date header, suspiciously clean JSON body)",
        "    - Missing Date header: 1",
        "    - Missing Server header: 1",
        "    - Suspiciously clean JSON body: 1",
        "    - Missing incidental headers: 1",
        "    - Response gold signals revoked: request_response_diff (−12)",
        "  - Gold signals revoked: request_response_diff (−12)",
        "",
      ]
    `);
  });

  it("renders a Response Plausibility sub-section even when the response sub-block omits revokedGoldHits (legacy persisted reports)", () => {
    const lines = buildAvriRubricMarkdown({
      composite: { family: "WEB_CLIENT", familyName: "Web Client" },
      engine2: {
        family: "WEB_CLIENT",
        familyName: "Web Client",
        rawHttp: {
          requestsAnalyzed: 0,
          totalHeaders: 0,
          placeholderHeaders: 0,
          crlfPresent: false,
          teClConflicts: 0,
          teClBroken: 0,
          isFake: true,
          reason: null,
          revokedGoldHits: [],
          penalty: -12,
          response: {
            responsesAnalyzed: 2,
            responsesFlagged: 2,
            totalHeaders: 4,
            responsesMissingDate: 2,
            responsesMissingServer: 2,
            responsesWithSuspiciousJsonBody: 2,
            responsesMissingIncidentals: 2,
            isFake: true,
            reason: null,
            // revokedGoldHits intentionally omitted to simulate a
            // legacy persisted report from before Task #319 shipped.
          },
        },
      },
    });
    expect(lines).toContain("  - **Response Plausibility** (2/2 response blocks flagged):");
    expect(lines).toContain("    - Missing Date header: 2");
    expect(lines).toContain("    - Missing incidental headers: 2");
    // No "Response gold signals revoked" line when the field is absent.
    expect(lines.some((l) => l.includes("Response gold signals revoked"))).toBe(
      false,
    );
  });

  // Task #450 — when the engine persists `rawHttp.signals`, the markdown
  // export emits a `description (id)` sub-bullet per fabrication tell
  // (placeholder headers, broken TE/CL conflict, missing CRLF, fake
  // credential token, placeholder body, prose placeholder payload),
  // mirroring the structural-fabrication marker bullet shape introduced
  // by Task #317. The bullets land at the same indent (2 spaces) as the
  // existing "Gold signals revoked" line so reviewers see the per-signal
  // evidence under the FAKE_RAW_HTTP block in the printable report.
  it("renders per-signal request-side fabrication bullets when rawHttp.signals is populated (Task #450)", () => {
    const lines = buildAvriRubricMarkdown({
      composite: {
        family: "REQUEST_SMUGGLING",
        familyName: "HTTP request smuggling / desync",
      },
      engine2: {
        family: "REQUEST_SMUGGLING",
        familyName: "HTTP request smuggling / desync",
        rawHttp: {
          requestsAnalyzed: 1,
          totalHeaders: 7,
          placeholderHeaders: 4,
          crlfPresent: false,
          teClConflicts: 1,
          teClBroken: 1,
          isFake: true,
          reason:
            "Fabricated raw HTTP request (no CRLFs, placeholder header values)",
          revokedGoldHits: [],
          penalty: -18,
          signals: [
            {
              id: "placeholder_headers",
              description:
                "4 of 7 header values look like placeholders (e.g. `<token>`, `example.com`)",
            },
            {
              id: "broken_te_cl_conflict",
              description:
                "Transfer-Encoding/Content-Length conflict declared in prose but the headers don't actually carry the conflicting values",
            },
            {
              id: "missing_crlf",
              description:
                "Request bytes use LF-only line endings; real raw HTTP uses CRLF",
            },
          ],
        },
      },
    });
    expect(lines).toContain(
      "  - 4 of 7 header values look like placeholders (e.g. `<token>`, `example.com`) (placeholder_headers)",
    );
    expect(lines).toContain(
      "  - Transfer-Encoding/Content-Length conflict declared in prose but the headers don't actually carry the conflicting values (broken_te_cl_conflict)",
    );
    expect(lines).toContain(
      "  - Request bytes use LF-only line endings; real raw HTTP uses CRLF (missing_crlf)",
    );
  });

  // Task #450 — response-side counterpart: per-signal bullets nest one
  // indent deeper (4 spaces) so they live under the "Response
  // Plausibility" sub-section, mirroring the existing per-marker
  // counters and the response gold-signal revocation line shape.
  it("renders per-signal response-side fabrication bullets under Response Plausibility (Task #450)", () => {
    const lines = buildAvriRubricMarkdown({
      composite: { family: "INJECTION", familyName: "Injection" },
      engine2: {
        family: "INJECTION",
        familyName: "Injection",
        rawHttp: {
          requestsAnalyzed: 0,
          totalHeaders: 0,
          placeholderHeaders: 0,
          crlfPresent: false,
          teClConflicts: 0,
          teClBroken: 0,
          isFake: true,
          reason: null,
          revokedGoldHits: [],
          penalty: -12,
          response: {
            responsesAnalyzed: 1,
            responsesFlagged: 1,
            totalHeaders: 2,
            responsesMissingDate: 1,
            responsesMissingServer: 1,
            responsesWithSuspiciousJsonBody: 1,
            responsesMissingIncidentals: 1,
            isFake: true,
            reason: null,
            signals: [
              {
                id: "missing_date_header",
                description:
                  "Response is missing the Date header (real HTTP/1.1 responses always carry one)",
              },
              {
                id: "suspicious_json_body",
                description:
                  "JSON response body reads as a vulnerability narrative with no real-API incidentals",
              },
              {
                id: "missing_incidental_headers",
                description:
                  "Response carries no X-Request-Id / Content-Length / Cache-Control / Set-Cookie",
              },
            ],
          },
        },
      },
    });
    expect(lines).toContain(
      "    - Response is missing the Date header (real HTTP/1.1 responses always carry one) (missing_date_header)",
    );
    expect(lines).toContain(
      "    - JSON response body reads as a vulnerability narrative with no real-API incidentals (suspicious_json_body)",
    );
    expect(lines).toContain(
      "    - Response carries no X-Request-Id / Content-Length / Cache-Control / Set-Cookie (missing_incidental_headers)",
    );
  });

  // Task #450 — legacy persisted reports analyzed before the `signals`
  // field shipped continue to render normally (no per-signal bullets,
  // no crash). The existing inline snapshots above cover this implicitly,
  // but pin it here so a future change to the loop can't accidentally
  // emit blank "  -  ()" rows.
  it("does not emit per-signal bullets when rawHttp.signals is absent (legacy persisted reports) (Task #450)", () => {
    const lines = buildAvriRubricMarkdown({
      composite: {
        family: "REQUEST_SMUGGLING",
        familyName: "HTTP request smuggling / desync",
      },
      engine2: {
        family: "REQUEST_SMUGGLING",
        familyName: "HTTP request smuggling / desync",
        rawHttp: {
          requestsAnalyzed: 1,
          totalHeaders: 4,
          placeholderHeaders: 2,
          crlfPresent: false,
          teClConflicts: 0,
          teClBroken: 0,
          isFake: true,
          reason: "Fabricated raw HTTP request",
          revokedGoldHits: [],
          penalty: -18,
          // signals intentionally omitted to simulate a legacy persisted
          // report from before Task #450 shipped.
        },
      },
    });
    // No bullet of the form "  - <something> (<id>)" should be emitted.
    expect(
      lines.some((l) => /^  - .+\([a-z_]+\)$/.test(l)),
    ).toBe(false);
  });

  it("renders the Sprint 13B-2 / Task #303 structural-fabrication markers when crashTrace.hasStructuralFabrication is true (Task #317)", () => {
    const lines = buildAvriRubricMarkdown({
      composite: { family: "MEMORY_CORRUPTION" },
      engine2: {
        crashTrace: {
          framesAnalyzed: 6,
          goodFrames: 4,
          placeholderFrames: 0,
          isStripped: false,
          reason: null,
          revokedGoldHits: [],
          penalty: 0,
          hasStructuralFabrication: true,
          structuralFabricationPenalty: -12,
          structuralMarkers: [
            {
              id: "round_function_offsets",
              description:
                "3 frames carry round/zero function offsets (0x0, 0x100, 0x1000); real offsets are non-zero and non-round",
            },
            {
              id: "thread_id_inconsistency",
              description:
                "Trace references `thread T0`/`T1` but no `==<pid>==` header is present",
            },
          ],
        },
      },
    });
    // Header line names the family (crash trace for MEMORY_CORRUPTION) and
    // surfaces the out-of-cap penalty.
    expect(lines).toContain(
      "- **Structural fabrication in crash trace** (penalty -12): 2 markers fired",
    );
    // Each marker is rendered as a sub-bullet with its description (which
    // already embeds the offending excerpt) and id in parens.
    expect(lines).toContain(
      "  - 3 frames carry round/zero function offsets (0x0, 0x100, 0x1000); real offsets are non-zero and non-round (round_function_offsets)",
    );
    expect(lines).toContain(
      "  - Trace references `thread T0`/`T1` but no `==<pid>==` header is present (thread_id_inconsistency)",
    );
  });

  it("notes when the structural-fab penalty is subsumed by stripped-trace (Task #317)", () => {
    const lines = buildAvriRubricMarkdown({
      composite: { family: "RACE_CONCURRENCY" },
      engine2: {
        crashTrace: {
          framesAnalyzed: 6,
          goodFrames: 1,
          placeholderFrames: 4,
          isStripped: true,
          reason: "4/6 frames placeholder",
          revokedGoldHits: [],
          penalty: -18,
          // structuralFabricationPenalty 0 means the structural-fab penalty
          // was suppressed because stripped-trace already charged the report.
          hasStructuralFabrication: true,
          structuralFabricationPenalty: 0,
          structuralMarkers: [
            {
              id: "frame_numbering_gaps",
              description: "Frame numbering jumps from #1 to #4",
            },
            {
              id: "round_heap_region_size",
              description:
                'Heap "region size: 0x100" in hex; real ASan emits decimal',
            },
          ],
        },
      },
    });
    // Both blocks render — stripped-trace and structural-fab — and the
    // structural-fab line spells out the subsumed-penalty case so the
    // markdown reader doesn't think two penalties were applied.
    expect(lines).toContain(
      "- **Stripped race trace** (penalty -18): 4/6 frames placeholder — frames 6, good 1, placeholder 4",
    );
    expect(lines).toContain(
      "- **Structural fabrication in race trace** (penalty subsumed by stripped-trace): 2 markers fired",
    );
  });

  // Task #428 — pin the AI self-disclosure rendering used by the
  // diagnostics-panel markdown export AND the printable triage report
  // (`/reports/:id/triage-report`). Both routes call buildAvriRubricMarkdown,
  // so this snapshot keeps them in lock-step on the row layout.
  it("renders the AI self-disclosure block with each matched phrase, detector id, and applied penalty (Task #428)", () => {
    const lines = buildAvriRubricMarkdown({
      composite: { family: "INJECTION", familyName: "Injection" },
      engine2: {
        family: "INJECTION",
        familyName: "Injection",
        aiSelfDisclosure: {
          detected: true,
          penalty: -8,
          matches: [
            {
              id: "ai_assistant_attribution",
              excerpt: "prepared using an AI security assistant",
            },
            {
              id: "ai_generated_disclaimer",
              excerpt: "this report was generated by ChatGPT",
            },
          ],
        },
      },
    });
    expect(lines).toContain(
      "- **AI self-disclosure** (penalty -8): 2 phrases matched",
    );
    expect(lines).toContain(
      '  - "prepared using an AI security assistant" (ai_assistant_attribution)',
    );
    expect(lines).toContain(
      '  - "this report was generated by ChatGPT" (ai_generated_disclaimer)',
    );
  });

  it("singularises the AI self-disclosure header when only one phrase fires (Task #428)", () => {
    const lines = buildAvriRubricMarkdown({
      composite: { family: "INJECTION" },
      engine2: {
        aiSelfDisclosure: {
          detected: true,
          penalty: -5,
          matches: [
            {
              id: "ai_assistant_attribution",
              excerpt: "prepared using an AI security assistant",
            },
          ],
        },
      },
    });
    expect(lines).toContain(
      "- **AI self-disclosure** (penalty -5): 1 phrase matched",
    );
  });

  it("does not render the AI self-disclosure block when detected is false or missing (Task #428)", () => {
    const undetected = buildAvriRubricMarkdown({
      composite: { family: "INJECTION" },
      engine2: {
        aiSelfDisclosure: { detected: false, penalty: 0, matches: [] },
      },
    });
    const missing = buildAvriRubricMarkdown({
      composite: { family: "INJECTION" },
      engine2: { aiSelfDisclosure: null },
    });
    const undefinedField = buildAvriRubricMarkdown({
      composite: { family: "INJECTION" },
      engine2: {},
    });
    for (const lines of [undetected, missing, undefinedField]) {
      expect(lines.some((l) => l.includes("AI self-disclosure"))).toBe(false);
    }
  });

  it("does not render structural-fab block when hasStructuralFabrication is false (Task #317)", () => {
    const lines = buildAvriRubricMarkdown({
      composite: { family: "MEMORY_CORRUPTION" },
      engine2: {
        crashTrace: {
          framesAnalyzed: 6,
          goodFrames: 4,
          placeholderFrames: 0,
          isStripped: false,
          reason: null,
          revokedGoldHits: [],
          penalty: 0,
          hasStructuralFabrication: false,
          structuralMarkers: [],
        },
      },
    });
    expect(
      lines.some((l) => l.includes("Structural fabrication")),
    ).toBe(false);
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

  it("injects the AVRI Family Rubric docs pointer line right after the heading when docsLink is provided", () => {
    const lines = buildAvriRubricMarkdown({
      composite: { family: "TYPE_CONFUSION", familyName: "Type Confusion" },
      engine2: null,
      docsLink: "https://vulnrap.com/changelog#avri-family-rubric",
    });
    expect(lines).toEqual([
      "## AVRI Family Rubric",
      "",
      "_Learn more about the AVRI Family Rubric: https://vulnrap.com/changelog#avri-family-rubric_",
      "",
      "- **Family**: Type Confusion",
      "",
    ]);
  });

  it("omits the AVRI Family Rubric docs pointer line when docsLink is empty/whitespace/undefined", () => {
    const baseInput = {
      composite: { family: "TYPE_CONFUSION", familyName: "Type Confusion" },
      engine2: null,
    };
    for (const docsLink of [undefined, "", "   ", null]) {
      const lines = buildAvriRubricMarkdown({ ...baseInput, docsLink });
      expect(lines.some((l) => l.startsWith("_Learn more about the AVRI"))).toBe(
        false,
      );
    }
  });
});
