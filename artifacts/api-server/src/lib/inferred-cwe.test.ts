// Unit tests for the soft-citation inferred-CWE extractor used by the
// reports feed mapper (Task #423). Mirrors the precedence the triage
// report panel already applies in `results.tsx` so the feed badge and
// the per-report badge agree on every row.

import { describe, it, expect } from "vitest";
import { deriveInferredCwe } from "./inferred-cwe";

describe("deriveInferredCwe", () => {
  it("returns null/null for empty / missing blobs", () => {
    expect(deriveInferredCwe(null)).toEqual({
      inferredCwe: null,
      inferredCweName: null,
    });
    expect(deriveInferredCwe(undefined)).toEqual({
      inferredCwe: null,
      inferredCweName: null,
    });
    expect(deriveInferredCwe({})).toEqual({
      inferredCwe: null,
      inferredCweName: null,
    });
    expect(deriveInferredCwe({ engines: [] })).toEqual({
      inferredCwe: null,
      inferredCweName: null,
    });
  });

  it("extracts inferredCwe from signalBreakdown.avri.softCitation (AVRI engine)", () => {
    const blob = {
      engines: [
        {
          engine: "CWE Coherence Checker",
          signalBreakdown: {
            avri: {
              family: "WEB_CLIENT",
              softCitation: { name: "XSS", inferredCwe: "CWE-79" },
            },
          },
        },
      ],
    };
    expect(deriveInferredCwe(blob)).toEqual({
      inferredCwe: "CWE-79",
      inferredCweName: "XSS",
    });
  });

  it("extracts inferredCwe from legacy signalBreakdown.softCitation when AVRI block is absent", () => {
    const blob = {
      engines: [
        {
          engine: "CWE Coherence Checker",
          signalBreakdown: {
            softCitation: { name: "Open Redirect", inferredCwe: "CWE-601" },
          },
        },
      ],
    };
    expect(deriveInferredCwe(blob)).toEqual({
      inferredCwe: "CWE-601",
      inferredCweName: "Open Redirect",
    });
  });

  it("prefers the AVRI block over the legacy block when both are present (matches results.tsx precedence)", () => {
    const blob = {
      engines: [
        {
          engine: "CWE Coherence Checker",
          signalBreakdown: {
            // Both shapes coexist briefly on rows that ran through both
            // pipelines. The triage panel prefers the AVRI block; the
            // feed badge has to agree or the two views disagree.
            softCitation: { name: "Legacy", inferredCwe: "CWE-000" },
            avri: {
              softCitation: { name: "XSS", inferredCwe: "CWE-79" },
            },
          },
        },
      ],
    };
    expect(deriveInferredCwe(blob)).toEqual({
      inferredCwe: "CWE-79",
      inferredCweName: "XSS",
    });
  });

  it("returns null when the engine fired but no soft citation was set (e.g. explicit CWE was claimed)", () => {
    const blob = {
      engines: [
        {
          engine: "CWE Coherence Checker",
          signalBreakdown: {
            avri: { family: "INJECTION", softCitation: null },
          },
        },
      ],
    };
    expect(deriveInferredCwe(blob)).toEqual({
      inferredCwe: null,
      inferredCweName: null,
    });
  });

  it("walks all engines and picks the first one with a soft citation", () => {
    const blob = {
      engines: [
        {
          engine: "Technical Substance Analyzer",
          signalBreakdown: {
            avri: { rawHttp: { isFake: false } },
          },
        },
        {
          engine: "CWE Coherence Checker",
          signalBreakdown: {
            avri: {
              softCitation: { name: "SQLi", inferredCwe: "CWE-89" },
            },
          },
        },
      ],
    };
    expect(deriveInferredCwe(blob)).toEqual({
      inferredCwe: "CWE-89",
      inferredCweName: "SQLi",
    });
  });

  it("treats empty-string inferredCwe as missing (defensive — engines never emit empty strings, but the JSONB type is open)", () => {
    const blob = {
      engines: [
        {
          engine: "CWE Coherence Checker",
          signalBreakdown: {
            avri: { softCitation: { name: "", inferredCwe: "" } },
          },
        },
      ],
    };
    expect(deriveInferredCwe(blob)).toEqual({
      inferredCwe: null,
      inferredCweName: null,
    });
  });

  it("returns inferredCwe with a null name when the soft-citation name is missing", () => {
    const blob = {
      engines: [
        {
          engine: "CWE Coherence Checker",
          signalBreakdown: {
            avri: { softCitation: { inferredCwe: "CWE-352" } },
          },
        },
      ],
    };
    expect(deriveInferredCwe(blob)).toEqual({
      inferredCwe: "CWE-352",
      inferredCweName: null,
    });
  });
});
