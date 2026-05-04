process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { AddressInfo } from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../../lib/db/drizzle");

let pgliteInstance: PGlite;
let pgliteDb: ReturnType<typeof drizzle>;

const mockRecomputeFn = vi.fn();

vi.mock("../lib/score-fusion", async () => {
  const actual =
    await vi.importActual<Record<string, unknown>>("../lib/score-fusion");
  return {
    ...actual,
    recomputeSlopScoreWithoutLlm: (...args: unknown[]) =>
      mockRecomputeFn(...args),
  };
});

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );

  return {
    ...schema,
    get db() {
      return pgliteDb;
    },
    pool: { end: async () => undefined },
  };
});

async function applyMigrations(client: PGlite): Promise<void> {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await client.exec(stmt);
    }
  }
}

const TOKEN = "score-stability-route-test-token";

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  pgliteInstance = new PGlite();
  await applyMigrations(pgliteInstance);

  const schema = await import("@workspace/db/schema");
  pgliteDb = drizzle(pgliteInstance, { schema: schema as Record<string, unknown> });

  process.env.CALIBRATION_TOKEN = TOKEN;
  process.env.SCORE_STABILITY_CODE_VERSION = "test-v1";

  const calibrationRouter = (await import("./calibration")).default;

  const app = express();
  app.use(express.json());
  app.use(calibrationRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pgliteInstance.close();
  delete process.env.CALIBRATION_TOKEN;
  delete process.env.SCORE_STABILITY_CODE_VERSION;
});

beforeEach(async () => {
  await pgliteInstance.exec('DELETE FROM "report_rescore_log"');
  await pgliteInstance.exec('DELETE FROM "reports"');
  await pgliteInstance.exec("ALTER SEQUENCE reports_id_seq RESTART WITH 1");
  await pgliteInstance.exec(
    "ALTER SEQUENCE report_rescore_log_id_seq RESTART WITH 1",
  );
  mockRecomputeFn.mockReset();
});

async function seedReport(overrides: {
  slopScore?: number;
  slopTier?: string;
  breakdown?: Record<string, unknown> | null;
  evidence?: unknown[] | null;
  redactedText?: string | null;
  contentText?: string | null;
  createdAt?: Date;
}): Promise<{ id: number }> {
  const result = await pgliteInstance.query<{ id: number }>(
    `INSERT INTO reports (
      content_hash, simhash, minhash_signature, file_size,
      slop_score, slop_tier, breakdown, evidence,
      redacted_text, content_text, created_at
    ) VALUES (
      $1, $2, $3::jsonb, $4,
      $5, $6, $7::jsonb, $8::jsonb,
      $9, $10, $11
    ) RETURNING id`,
    [
      `hash-${Date.now()}-${Math.random()}`,
      "0",
      "[]",
      0,
      overrides.slopScore ?? 50,
      overrides.slopTier ?? "Questionable",
      overrides.breakdown !== undefined
        ? overrides.breakdown === null
          ? null
          : JSON.stringify(overrides.breakdown)
        : JSON.stringify({ linguistic: 0, factual: 0, template: 0 }),
      overrides.evidence !== undefined
        ? overrides.evidence === null
          ? null
          : JSON.stringify(overrides.evidence)
        : "[]",
      overrides.redactedText ?? null,
      overrides.contentText ?? null,
      overrides.createdAt ?? new Date(),
    ],
  );
  return { id: result.rows[0].id };
}

interface HttpResponse<T> {
  status: number;
  body: T;
}

function request<T>(
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(data) as T });
          } catch {
            resolve({ status: res.statusCode!, body: data as unknown as T });
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /feedback/calibration/score-stability", () => {
  it("returns 401 without a valid calibration token", async () => {
    const res = await request("GET", "/feedback/calibration/score-stability");
    expect(res.status).toBe(401);
  });

  it("returns the expected summary shape with empty data", async () => {
    const res = await request<Record<string, unknown>>(
      "GET",
      "/feedback/calibration/score-stability",
      { "x-calibration-token": TOKEN },
    );
    expect(res.status).toBe(200);
    const body = res.body;
    expect(body).toHaveProperty("generatedAt");
    expect(body).toHaveProperty("lookbackDays", 7);
    expect(body).toHaveProperty("alertThreshold");
    expect(body).toHaveProperty("daily");
    expect(body).toHaveProperty("totals");
    expect(Array.isArray(body.daily)).toBe(true);

    const totals = body.totals as Record<string, unknown>;
    expect(totals).toHaveProperty("total", 0);
    expect(totals).toHaveProperty("flips", 0);
    expect(totals).toHaveProperty("flipRate", 0);
    expect(totals).toHaveProperty("legitToSlop");
    expect(totals).toHaveProperty("slopToLegit");
    expect(totals).toHaveProperty("tightened");
    expect(totals).toHaveProperty("loosened");
    expect(totals).toHaveProperty("lateral");
  });

  it("seeds the 7-day daily array even when no rescore rows exist", async () => {
    const res = await request<Record<string, unknown>>(
      "GET",
      "/feedback/calibration/score-stability",
      { "x-calibration-token": TOKEN },
    );
    expect(res.status).toBe(200);
    const daily = res.body.daily as Array<Record<string, unknown>>;
    expect(daily.length).toBe(7);
    for (const d of daily) {
      expect(d).toHaveProperty("date");
      expect(d).toHaveProperty("total", 0);
      expect(d).toHaveProperty("flips", 0);
      expect(d).toHaveProperty("flipRate", 0);
    }
  });
});

describe("rescore pass → score-stability endpoint integration", () => {
  it("rescores seeded reports and reflects flips in the summary", async () => {
    const now = new Date();
    const breakdown = { linguistic: 30, factual: 40, template: 20 };

    await seedReport({
      slopScore: 50,
      slopTier: "Questionable",
      breakdown,
      evidence: [],
      redactedText: "This is a test report with some content.",
      createdAt: now,
    });
    await seedReport({
      slopScore: 20,
      slopTier: "Clean",
      breakdown,
      evidence: [],
      redactedText: "Another test report with different content.",
      createdAt: now,
    });
    await seedReport({
      slopScore: 80,
      slopTier: "Slop",
      breakdown,
      evidence: [],
      redactedText: "Third report for testing stability.",
      createdAt: now,
    });

    mockRecomputeFn.mockImplementation(
      (
        _breakdown: unknown,
        _evidence: unknown,
        text: string,
      ) => {
        if (text.includes("Third")) {
          return {
            slopScore: 80,
            slopTier: "Slop",
            confidence: 0.9,
            authenticityScore: 10,
            validityScore: 20,
            quadrant: "STRONG_AI",
            archetype: "FULL_SLOP",
          };
        }
        if (text.includes("Another")) {
          return {
            slopScore: 75,
            slopTier: "Likely Slop",
            confidence: 0.8,
            authenticityScore: 25,
            validityScore: 30,
            quadrant: "WEAK_AI",
            archetype: "TEMPLATE_HEAVY",
          };
        }
        return {
          slopScore: 50,
          slopTier: "Questionable",
          confidence: 0.5,
          authenticityScore: 50,
          validityScore: 50,
          quadrant: "WEAK_HUMAN",
          archetype: "REQUEST_DETAILS",
        };
      },
    );

    const { runScoreStabilityRescorePass } = await import(
      "../lib/score-stability-monitor"
    );
    const result = await runScoreStabilityRescorePass({
      lookbackDays: 7,
      now: () => now,
      codeVersion: "test-v1",
    });

    expect(result.scanned).toBe(3);
    expect(result.logged).toBe(3);
    expect(result.flips).toBe(1);
    expect(result.codeVersion).toBe("test-v1");

    const logRows = await pgliteInstance.query(
      'SELECT * FROM "report_rescore_log"',
    );
    expect(logRows.rows.length).toBe(3);

    const res = await request<Record<string, unknown>>(
      "GET",
      "/feedback/calibration/score-stability",
      { "x-calibration-token": TOKEN },
    );
    expect(res.status).toBe(200);
    const body = res.body;

    const totals = body.totals as Record<string, unknown>;
    expect(totals.total).toBe(3);
    expect(totals.flips).toBe(1);
    expect(totals.legitToSlop).toBe(1);
    expect(totals.slopToLegit).toBe(0);
    expect(typeof totals.flipRate).toBe("number");
    expect(totals.flipRate).toBeCloseTo(1 / 3, 2);

    const daily = body.daily as Array<Record<string, unknown>>;
    expect(daily.length).toBe(7);
    const todayStr = now.toISOString().slice(0, 10);
    const todayBucket = daily.find((d) => d.date === todayStr);
    expect(todayBucket).toBeDefined();
    expect(todayBucket!.total).toBe(3);
    expect(todayBucket!.flips).toBe(1);
  });

  it("skips reports without breakdown or text", async () => {
    await seedReport({
      slopScore: 50,
      slopTier: "Questionable",
      breakdown: null,
      evidence: [],
      redactedText: null,
      contentText: null,
      createdAt: new Date(),
    });

    await seedReport({
      slopScore: 50,
      slopTier: "Questionable",
      breakdown: { linguistic: 30, factual: 40, template: 20 },
      evidence: [],
      redactedText: null,
      contentText: null,
      createdAt: new Date(),
    });

    await seedReport({
      slopScore: 50,
      slopTier: "Questionable",
      breakdown: { linguistic: 30, factual: 40, template: 20 },
      evidence: [],
      redactedText: "Has text so should be rescored.",
      createdAt: new Date(),
    });

    mockRecomputeFn.mockImplementation(() => ({
      slopScore: 50,
      slopTier: "Questionable",
      confidence: 0.5,
      authenticityScore: 50,
      validityScore: 50,
      quadrant: "WEAK_HUMAN",
      archetype: "REQUEST_DETAILS",
    }));

    const { runScoreStabilityRescorePass } = await import(
      "../lib/score-stability-monitor"
    );
    const result = await runScoreStabilityRescorePass({
      lookbackDays: 7,
      codeVersion: "test-v1",
    });

    expect(result.scanned).toBe(2);
    expect(result.skippedNoSignals).toBe(1);
    expect(result.logged).toBe(1);
  });

  it("ON CONFLICT DO NOTHING deduplicates same-day rescores", async () => {
    const now = new Date();
    const breakdown = { linguistic: 30, factual: 40, template: 20 };

    await seedReport({
      slopScore: 50,
      slopTier: "Questionable",
      breakdown,
      evidence: [],
      redactedText: "Test report for dedup check.",
      createdAt: now,
    });

    mockRecomputeFn.mockImplementation(() => ({
      slopScore: 50,
      slopTier: "Questionable",
      confidence: 0.5,
      authenticityScore: 50,
      validityScore: 50,
      quadrant: "WEAK_HUMAN",
      archetype: "REQUEST_DETAILS",
    }));

    const { runScoreStabilityRescorePass } = await import(
      "../lib/score-stability-monitor"
    );

    const first = await runScoreStabilityRescorePass({
      lookbackDays: 7,
      now: () => now,
      codeVersion: "test-v1",
    });
    expect(first.logged).toBe(1);
    expect(first.skippedDuplicate).toBe(0);

    const second = await runScoreStabilityRescorePass({
      lookbackDays: 7,
      now: () => now,
      codeVersion: "test-v1",
    });
    expect(second.scanned).toBe(1);
    expect(second.logged).toBe(0);
    expect(second.skippedDuplicate).toBe(1);

    const logRows = await pgliteInstance.query(
      'SELECT * FROM "report_rescore_log"',
    );
    expect(logRows.rows.length).toBe(1);
  });

  it("day-bucketing groups rescore logs by their scoredAt date", async () => {
    const now = new Date("2026-05-04T12:00:00.000Z");
    const yesterday = new Date("2026-05-03T15:00:00.000Z");

    const r1 = await seedReport({
      slopScore: 50,
      slopTier: "Questionable",
      breakdown: { linguistic: 30, factual: 40, template: 20 },
      evidence: [],
      redactedText: "Report one.",
      createdAt: yesterday,
    });
    const r2 = await seedReport({
      slopScore: 20,
      slopTier: "Clean",
      breakdown: { linguistic: 30, factual: 40, template: 20 },
      evidence: [],
      redactedText: "Report two.",
      createdAt: yesterday,
    });
    const r3 = await seedReport({
      slopScore: 80,
      slopTier: "Slop",
      breakdown: { linguistic: 30, factual: 40, template: 20 },
      evidence: [],
      redactedText: "Report three.",
      createdAt: yesterday,
    });

    await pgliteInstance.query(
      `INSERT INTO report_rescore_log
        (report_id, old_score, new_score, old_tier, new_tier, scored_at, code_version)
       VALUES
        ($1, 50, 50, 'Questionable', 'Questionable', $4, 'test-v1'),
        ($2, 20, 80, 'Clean', 'Slop', $4, 'test-v1'),
        ($3, 80, 20, 'Slop', 'Clean', $5, 'test-v1')`,
      [r1.id, r2.id, r3.id, now, yesterday],
    );

    const { computeScoreStabilitySummary } = await import(
      "../lib/score-stability-monitor"
    );
    const summary = await computeScoreStabilitySummary({
      lookbackDays: 7,
      now: () => now,
    });

    expect(summary.daily.length).toBe(7);

    const todayBucket = summary.daily.find((d) => d.date === "2026-05-04");
    expect(todayBucket).toBeDefined();
    expect(todayBucket!.total).toBe(2);
    expect(todayBucket!.flips).toBe(1);
    expect(todayBucket!.legitToSlop).toBe(1);

    const yesterdayBucket = summary.daily.find((d) => d.date === "2026-05-03");
    expect(yesterdayBucket).toBeDefined();
    expect(yesterdayBucket!.total).toBe(1);
    expect(yesterdayBucket!.flips).toBe(1);
    expect(yesterdayBucket!.slopToLegit).toBe(1);

    expect(summary.totals.total).toBe(3);
    expect(summary.totals.flips).toBe(2);
    expect(summary.totals.legitToSlop).toBe(1);
    expect(summary.totals.slopToLegit).toBe(1);
    expect(summary.totals.flipRate).toBeCloseTo(2 / 3, 2);
  });
});

describe("GET /feedback/calibration/score-stability/scheduler-status", () => {
  it("returns 200 without auth (unauthenticated heartbeat)", async () => {
    const res = await request<Record<string, unknown>>(
      "GET",
      "/feedback/calibration/score-stability/scheduler-status",
    );
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("schedulerStarted");
  });
});
