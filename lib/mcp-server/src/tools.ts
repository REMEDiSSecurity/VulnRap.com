import { z } from "zod";
import {
  GetReportParams,
  GetCohortBaselineQueryParams,
  GetReportFeedQueryParams,
} from "@workspace/api-zod";
import { apiRequest } from "./client.js";

// Each tool wraps a single public VulnRap HTTP endpoint. We deliberately
// keep the input schemas tight (LLM-callable surfaces only) and forward
// validated values through `apiRequest`, which centralises base-URL,
// timeout, and error handling. The output of every tool is the raw JSON
// from the upstream endpoint — surfacing it verbatim lets callers (Claude
// Desktop, Cursor, custom agents) see exactly what the public REST API
// would have returned, so users can read VulnRap's own docs.
//
// All input schemas are exported alongside the handlers so the smoke
// tests can assert input validation without booting an MCP transport,
// and so other code (e.g. a future HTTP-mode bridge) can reuse them.

// ---------------------------------------------------------------------------
// score_report
// ---------------------------------------------------------------------------
// Wraps POST /api/reports/check. Read-only path on the platform side
// (nothing is stored), which matches the "agents call this from a chat"
// expectation. We only expose the LLM-callable shape: free-form text or a
// public URL, plus the two boolean toggles that exist server-side. The
// underlying CheckReportBody schema also accepts a multipart File which
// makes no sense from an MCP context, so we don't surface it.

export const ScoreReportInput = z
  .object({
    text: z
      .string()
      .min(1)
      .optional()
      .describe("The vulnerability report text to score."),
    reportUrl: z
      .string()
      .url()
      .optional()
      .describe(
        "Public HTTPS URL pointing at a plain-text report (GitHub raw, Gist, GitLab, Pastebin, etc.). Mutually exclusive with `text`.",
      ),
    skipLlm: z
      .boolean()
      .optional()
      .describe("Skip the LLM analysis stage and use only local heuristics."),
    skipRedaction: z
      .boolean()
      .optional()
      .describe(
        "Skip server-side redaction. When true the LLM stage is forced off as well (server enforces this).",
      ),
  })
  .refine((v) => Boolean(v.text) || Boolean(v.reportUrl), {
    message: "Provide either `text` or `reportUrl`.",
  });

export type ScoreReportInputType = z.infer<typeof ScoreReportInput>;

export async function scoreReport(
  input: ScoreReportInputType,
): Promise<unknown> {
  return apiRequest("/api/reports/check", {
    method: "POST",
    form: {
      rawText: input.text,
      reportUrl: input.reportUrl,
      skipLlm: input.skipLlm ? "true" : undefined,
      skipRedaction: input.skipRedaction ? "true" : undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// lookup_report
// ---------------------------------------------------------------------------
// Wraps GET /api/reports/{id}. Reuses the api-zod GetReportParams schema
// (which `coerce`s id → number), per the task spec asking for input
// validation via api-zod where possible.

export const LookupReportInput = GetReportParams.describe(
  "Numeric id of a previously-submitted report.",
);
export type LookupReportInputType = z.infer<typeof LookupReportInput>;

export async function lookupReport(
  input: LookupReportInputType,
): Promise<unknown> {
  return apiRequest(`/api/reports/${input.id}`);
}

// ---------------------------------------------------------------------------
// query_stats
// ---------------------------------------------------------------------------
// Wraps GET /api/stats. No inputs.

export const QueryStatsInput = z.object({}).describe("No inputs required.");
export type QueryStatsInputType = z.infer<typeof QueryStatsInput>;

export async function queryStats(
  _input: QueryStatsInputType,
): Promise<unknown> {
  return apiRequest("/api/stats");
}

// ---------------------------------------------------------------------------
// query_transparency
// ---------------------------------------------------------------------------
// Wraps GET /api/public/corpus-stats — the redacted, public-safe payload
// the /transparency dashboard reads. Distinct from drift_summary
// (calibration drift) so agents can surface either independently.

export const QueryTransparencyInput = z.object({});
export type QueryTransparencyInputType = z.infer<typeof QueryTransparencyInput>;

export async function queryTransparency(
  _input: QueryTransparencyInputType,
): Promise<unknown> {
  return apiRequest("/api/public/corpus-stats");
}

// ---------------------------------------------------------------------------
// query_gallery
// ---------------------------------------------------------------------------
// Wraps GET /api/reports/feed — the curated/public report feed used by
// the sample-report gallery. Exposes the limit/offset/tier/sort knobs
// from GetReportFeedQueryParams (subset; the schema has more, but these
// are the ones an agent realistically wants to set).

export const QueryGalleryInput = z
  .object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max reports to return (default 10, max 50)."),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Pagination offset (default 0)."),
    sort: z
      .enum(["newest", "oldest", "score_asc", "score_desc"])
      .optional()
      .describe("Sort order (default newest)."),
    tier: z
      .string()
      .optional()
      .describe("Optional triage tier filter, e.g. AUTO_CLOSE or PRIORITIZE."),
  })
  .describe(
    "Optional pagination and filter knobs for the curated report feed.",
  );

export type QueryGalleryInputType = z.infer<typeof QueryGalleryInput>;

export async function queryGallery(
  input: QueryGalleryInputType,
): Promise<unknown> {
  // Reuse api-zod's GetReportFeedQueryParams to apply defaults/coercion
  // before sending — keeps the wire shape consistent with the REST surface.
  const validated = GetReportFeedQueryParams.partial().parse(input);
  return apiRequest("/api/reports/feed", { query: validated });
}

// ---------------------------------------------------------------------------
// get_drift_summary
// ---------------------------------------------------------------------------
// Wraps GET /api/public/drift-summary.

export const GetDriftSummaryInput = z.object({});
export type GetDriftSummaryInputType = z.infer<typeof GetDriftSummaryInput>;

export async function getDriftSummary(
  _input: GetDriftSummaryInputType,
): Promise<unknown> {
  return apiRequest("/api/public/drift-summary");
}

// ---------------------------------------------------------------------------
// query_signal_metrics
// ---------------------------------------------------------------------------
// Wraps GET /api/feedback/holdout-eval — the held-out signal-vs-feedback
// evaluation that powers the per-signal precision/recall views.

export const QuerySignalMetricsInput = z.object({});
export type QuerySignalMetricsInputType = z.infer<
  typeof QuerySignalMetricsInput
>;

export async function querySignalMetrics(
  _input: QuerySignalMetricsInputType,
): Promise<unknown> {
  return apiRequest("/api/feedback/holdout-eval");
}

// ---------------------------------------------------------------------------
// get_cohort_baseline
// ---------------------------------------------------------------------------
// Wraps GET /api/cohort/baseline. The endpoint itself takes only an
// optional `cwe` family filter, but the task asked for `(score)` so we
// also accept a `score` value and synthesise the percentile rank from
// the returned histogram (mirroring how the results page positions its
// marker). Returning both the raw payload and the derived percentile is
// strictly additive — nothing is dropped.

export const GetCohortBaselineInput = z.object({
  score: z
    .number()
    .min(0)
    .max(100)
    .optional()
    .describe(
      "Optional VulnRap composite score (0..100). When supplied the response includes a `percentileRank` derived from the returned 7-day histogram.",
    ),
  cwe: GetCohortBaselineQueryParams.shape.cwe,
});

export type GetCohortBaselineInputType = z.infer<typeof GetCohortBaselineInput>;

interface CohortBaselinePayload {
  bins?: Array<{ min: number; max: number; count: number }>;
  totalReports?: number;
  median?: number | null;
  [k: string]: unknown;
}

// Pure helper exposed for unit tests: percentile rank of `score` against
// a histogram of equal-width bins covering 0..100. Within the matched
// bin we linearly interpolate; below the first bin returns 0 and above
// the last returns 100. Matches the convention used by the cohort
// baseline ribbon on the results page.
export function percentileRankFromBins(
  score: number,
  bins: Array<{ min: number; max: number; count: number }>,
  totalReports: number,
): number {
  if (totalReports <= 0) return 0;
  let below = 0;
  for (const b of bins) {
    if (score >= b.max) {
      below += b.count;
      continue;
    }
    if (score < b.min) break;
    const span = Math.max(1, b.max - b.min);
    const frac = Math.max(0, Math.min(1, (score - b.min) / span));
    below += b.count * frac;
    break;
  }
  const pct = (below / totalReports) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

export async function getCohortBaseline(
  input: GetCohortBaselineInputType,
): Promise<unknown> {
  const payload =
    (await apiRequest<CohortBaselinePayload>("/api/cohort/baseline", {
      query: { cwe: input.cwe ?? undefined },
    })) ?? {};
  if (typeof input.score !== "number") return payload;
  const bins = Array.isArray(payload.bins) ? payload.bins : [];
  const total =
    typeof payload.totalReports === "number"
      ? payload.totalReports
      : bins.reduce((acc, b) => acc + (b.count ?? 0), 0);
  const percentileRank = percentileRankFromBins(input.score, bins, total);
  return { ...payload, queriedScore: input.score, percentileRank };
}

// ---------------------------------------------------------------------------
// test_yourself
// ---------------------------------------------------------------------------
// Wraps GET /api/test/run, the labelled fixture battery endpoint. The
// route is dev-only on the public deployment (returns 404 in
// production); reviewers and self-hosters can still hit it. We accept
// the `withLlm` / `runs` knobs the route understands. BYO-fixture
// upload (`rows`) is intentionally not exposed — the upstream route is
// GET-only and runs a fixed labelled corpus. When the backend grows a
// POST/upload path the schema can add an optional `rows` field then
// without breaking existing agents.

export const TestYourselfInput = z.object({
  withLlm: z
    .boolean()
    .optional()
    .describe(
      "When true, fire the LLM stage for every fixture. Off by default to keep the smoke run cheap.",
    ),
  runs: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Number of independent LLM samples per fixture (1..10, default 3). Only meaningful when withLlm is true.",
    ),
});

export type TestYourselfInputType = z.infer<typeof TestYourselfInput>;

export async function testYourself(
  input: TestYourselfInputType,
): Promise<unknown> {
  return apiRequest("/api/test/run", {
    query: {
      withLlm: input.withLlm ? "1" : undefined,
      runs: input.runs,
    },
  });
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  handler: (input: TInput) => Promise<unknown>;
}

export const TOOLS: ReadonlyArray<ToolDefinition<any>> = [
  {
    name: "score_report",
    description:
      "Score a single vulnerability report through VulnRap's full read-only pipeline. Nothing is stored. Returns the composite score, per-engine breakdown, similarity matches, and LLM feedback.",
    inputSchema: ScoreReportInput,
    handler: scoreReport,
  },
  {
    name: "lookup_report",
    description: "Fetch a previously-submitted report by numeric id.",
    inputSchema: LookupReportInput,
    handler: lookupReport,
  },
  {
    name: "query_stats",
    description:
      "Get aggregate VulnRap platform statistics (total reports, duplicates, mean slop score, today's submissions).",
    inputSchema: QueryStatsInput,
    handler: queryStats,
  },
  {
    name: "query_transparency",
    description:
      "Get the public transparency-dashboard data: corpus composition, slop-tier distribution, calibration provenance.",
    inputSchema: QueryTransparencyInput,
    handler: queryTransparency,
  },
  {
    name: "query_gallery",
    description:
      "List curated/showcased reports from the public sample-report gallery. Optional pagination and tier/sort filters.",
    inputSchema: QueryGalleryInput,
    handler: queryGallery,
  },
  {
    name: "get_drift_summary",
    description:
      "Get the public AVRI calibration drift summary — week-over-week deltas the platform exposes on /transparency.",
    inputSchema: GetDriftSummaryInput,
    handler: getDriftSummary,
  },
  {
    name: "query_signal_metrics",
    description:
      "Get the held-out per-signal precision/recall evaluation that backs VulnRap's calibration claims.",
    inputSchema: QuerySignalMetricsInput,
    handler: querySignalMetrics,
  },
  {
    name: "get_cohort_baseline",
    description:
      "Get the 7-day VulnRap composite-score histogram + median for a cohort. Optionally filter by AVRI CWE family or pass a `score` to also receive its percentile rank.",
    inputSchema: GetCohortBaselineInput,
    handler: getCohortBaseline,
  },
  {
    name: "test_yourself",
    description:
      "Run the labelled fixture battery through the live engine pipeline. Returns per-cohort composite/Engine-2/triage distributions. Dev-only on the public deployment (returns 404 in production).",
    inputSchema: TestYourselfInput,
    handler: testYourself,
  },
];

export function getToolByName(name: string): ToolDefinition<any> | undefined {
  return TOOLS.find((t) => t.name === name);
}
