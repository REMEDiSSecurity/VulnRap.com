import { describe, it, expect } from "vitest";
import { buildEvidenceCsv } from "./results";

// Task #606: pin the evidence CSV export shape so reviewers can sort and
// filter impossibility tells in a spreadsheet without re-parsing the
// joined description sentence. The CSV must include both the existing
// description column AND a new `markers` column that lists the structured
// impossibility tell IDs (so existing consumers reading just `description`
// keep working — the `markers` cell is purely additive at the end of each
// row).

describe("buildEvidenceCsv", () => {
  it("emits the documented type,description,weight,matched,markers header row even with no evidence", () => {
    expect(buildEvidenceCsv([])).toBe(
      "type,description,weight,matched,markers",
    );
  });

  it("serialises an impossible_http_response row with both the joined description sentence AND the structured marker IDs", () => {
    // This is the exact shape the hallucination detector emits for the
    // impossible_http_response signal — joined description sentence
    // (human-readable), plus the flat `markers` array of impossibility
    // tell IDs (machine-readable). Reviewers want both in the export so
    // they can keep human-readable triage notes AND pivot the structured
    // marker IDs in a spreadsheet.
    const csv = buildEvidenceCsv([
      {
        type: "impossible_http_response",
        description:
          "HTTP excerpt is internally inconsistent — content_length_zero_but_body_present, status_204_must_have_no_body",
        weight: 16,
        matched: null,
        markers: [
          "content_length_zero_but_body_present",
          "status_204_must_have_no_body",
        ],
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    // Header row stays stable; consumers depending on it keep working.
    expect(lines[0]).toBe("type,description,weight,matched,markers");
    // Description column (existing consumers) still carries the joined
    // sentence verbatim — quoted because it contains a comma.
    expect(lines[1]).toContain(
      '"HTTP excerpt is internally inconsistent — content_length_zero_but_body_present, status_204_must_have_no_body"',
    );
    // markers column (new) carries the comma-joined structured IDs so a
    // reviewer can split/pivot them without regex-parsing description.
    expect(lines[1]).toContain(
      '"content_length_zero_but_body_present, status_204_must_have_no_body"',
    );
    // Full row, in column order: type, description, weight, matched, markers.
    expect(lines[1]).toBe(
      "impossible_http_response," +
        '"HTTP excerpt is internally inconsistent — content_length_zero_but_body_present, status_204_must_have_no_body",' +
        "16,," +
        '"content_length_zero_but_body_present, status_204_must_have_no_body"',
    );
  });

  it("flattens structured context.markers[].id into the same markers column (structural_fabrication shape)", () => {
    // hallucination_structural_fabrication uses the structured
    // `context.markers[]` payload (each entry is `{ id, description }`)
    // rather than the flat `markers` array. Both shapes must land in the
    // same `markers` cell so a reviewer's spreadsheet pivot works
    // regardless of which detector fired.
    const csv = buildEvidenceCsv([
      {
        type: "hallucination_structural_fabrication",
        description:
          "Crash trace has 2 structural fabrication markers — round_function_offset, sequential_frame_addresses",
        weight: 16,
        matched: null,
        context: {
          markers: [
            { id: "round_function_offset" },
            { id: "sequential_frame_addresses" },
          ],
        },
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toContain(
      '"round_function_offset, sequential_frame_addresses"',
    );
  });

  it("leaves the markers cell empty for evidence rows that have no impossibility tells (purely additive)", () => {
    const csv = buildEvidenceCsv([
      {
        type: "ai_phrase_pattern",
        description: "matched 'as an AI language model'",
        weight: 5,
        matched: "as an AI language model",
      },
    ]);
    const lines = csv.split("\r\n");
    // Row ends with a trailing empty cell for `markers`, so the existing
    // 4-column shape (type/description/weight/matched) is preserved
    // verbatim.
    expect(lines[1]).toBe(
      "ai_phrase_pattern,matched 'as an AI language model',5,as an AI language model,",
    );
    expect(csv).not.toContain("undefined");
  });

  it("RFC-4180 escapes embedded quotes, commas, and newlines in any cell", () => {
    const csv = buildEvidenceCsv([
      {
        type: "fabricated_evidence",
        description: 'has, comma and "quoted" word\nplus newline',
        weight: 10,
        matched: "with, comma",
        markers: ["marker_a", "marker_b"],
      },
    ]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe(
      "fabricated_evidence," +
        '"has, comma and ""quoted"" word\nplus newline",' +
        "10," +
        '"with, comma",' +
        '"marker_a, marker_b"',
    );
  });
});
