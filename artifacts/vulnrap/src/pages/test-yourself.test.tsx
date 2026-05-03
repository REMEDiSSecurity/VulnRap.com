// Task #633 — Tests for the bring-your-own fixture battery page.
//
// Covers the pure CSV / JSON parsers, the per-row results CSV builder,
// and an end-to-end happy-path render with mocked fetch that uploads a
// CSV file, hits Run, and asserts the metric tiles + rate-limit panel.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TestYourself, {
  parseCsv,
  parseJsonInput,
  buildResultsCsv,
} from "./test-yourself";

describe("parseCsv — RFC-4180-ish", () => {
  it("handles a plain header + body grid", () => {
    const grid = parseCsv("text,label\nfoo,valid\nbar,invalid\n");
    expect(grid).toEqual([
      ["text", "label"],
      ["foo", "valid"],
      ["bar", "invalid"],
    ]);
  });

  it("handles quoted fields with embedded commas, newlines, and escaped quotes", () => {
    const grid = parseCsv(
      `text,label\n"a, b\nc",valid\n"she said ""hi""",invalid\n`,
    );
    expect(grid).toEqual([
      ["text", "label"],
      ["a, b\nc", "valid"],
      ['she said "hi"', "invalid"],
    ]);
  });

  it("skips entirely blank lines", () => {
    const grid = parseCsv("text,label\n\nfoo,valid\n");
    expect(grid).toEqual([
      ["text", "label"],
      ["foo", "valid"],
    ]);
  });
});

describe("parseJsonInput — label normalization", () => {
  it("accepts a standard array-of-objects shape and normalizes labels", () => {
    const r = parseJsonInput(
      JSON.stringify([
        { report_text: "real bug", expected_label: "valid" },
        { report_text: "noise", expected_label: "slop" },
        { text: "alt key", label: "1" },
      ]),
    );
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { text: "real bug", label: "valid" },
      { text: "noise", label: "invalid" },
      { text: "alt key", label: "valid" },
    ]);
  });

  it("rejects non-array root", () => {
    expect(parseJsonInput('{"a": 1}').errors[0]).toMatch(/array/);
  });

  it("collects per-row errors instead of failing the whole upload", () => {
    const r = parseJsonInput(
      JSON.stringify([
        { text: "ok", label: "valid" },
        { text: "", label: "valid" },
        { text: "no label", label: "huh" },
      ]),
    );
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toHaveLength(2);
  });
});

describe("buildResultsCsv", () => {
  it("escapes commas and quotes in the preview column", () => {
    const csv = buildResultsCsv([
      {
        index: 0,
        textPreview: 'has "quotes", and commas',
        expectedLabel: "valid",
        predictedLabel: "invalid",
        compositeScore: 42,
        compositeLabel: "NEEDS REVIEW",
        correct: false,
      },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "index,expected_label,predicted_label,composite_score,composite_label,correct,text_preview",
    );
    expect(lines[1]).toContain('"has ""quotes"", and commas"');
    expect(lines[1]).toContain("NEEDS REVIEW");
  });
});

describe("<TestYourself /> — end-to-end happy path", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(
        JSON.stringify({
          aggregate: {
            total: 2,
            accuracy: 1.0,
            precision: 1.0,
            recall: 1.0,
            f1: 1.0,
            confusionMatrix: {
              truePositive: 1,
              falsePositive: 0,
              trueNegative: 1,
              falseNegative: 0,
            },
          },
          perRow: [
            {
              index: 0,
              textPreview: "real bug",
              expectedLabel: "valid",
              predictedLabel: "valid",
              compositeScore: 72,
              compositeLabel: "PROMISING",
              correct: true,
            },
            {
              index: 1,
              textPreview: "noise",
              expectedLabel: "invalid",
              predictedLabel: "invalid",
              compositeScore: 14,
              compositeLabel: "LIKELY INVALID",
              correct: true,
            },
          ],
          rateLimit: { limit: 10, remaining: 9 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("uploads CSV, runs the battery, and renders metrics + per-row table", async () => {
    render(
      <MemoryRouter>
        <TestYourself />
      </MemoryRouter>,
    );

    const file = new File(
      ["text,label\nreal bug,valid\nnoise,invalid\n"],
      "battery.csv",
      { type: "text/csv" },
    );
    const input = await screen.findByTestId("byo-file-input");
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText(/Parsed/)).toBeInTheDocument());

    const runButton = screen.getByTestId("byo-run");
    fireEvent.click(runButton);

    await waitFor(() =>
      expect(screen.getByTestId("byo-results")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("byo-metric-accuracy")).toHaveTextContent(
      "100.0%",
    );
    expect(screen.getByTestId("byo-metric-precision")).toHaveTextContent(
      "100.0%",
    );
    expect(screen.getByTestId("byo-metric-recall")).toHaveTextContent("100.0%");
    expect(screen.getByTestId("byo-metric-f1")).toHaveTextContent("100.0%");

    expect(screen.getByTestId("byo-row-0")).toBeInTheDocument();
    expect(screen.getByTestId("byo-row-1")).toBeInTheDocument();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain("/api/test-yourself/run");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({ text: "real bug", label: "valid" });
  });

  it("shows a cooldown banner when the server returns 429", async () => {
    fetchSpy.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error:
              "Daily rate limit exceeded (10 runs / day per IP). Try again tomorrow.",
          }),
          { status: 429, headers: { "Content-Type": "application/json" } },
        ),
    );

    render(
      <MemoryRouter>
        <TestYourself />
      </MemoryRouter>,
    );

    const file = new File(["text,label\nfoo,valid\n"], "b.csv", {
      type: "text/csv",
    });
    fireEvent.change(await screen.findByTestId("byo-file-input"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(screen.getByText(/Parsed/)).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("byo-run"));
    const banner = await screen.findByTestId("byo-rate-error");
    expect(banner).toHaveTextContent(/rate limit/i);
  });
});
