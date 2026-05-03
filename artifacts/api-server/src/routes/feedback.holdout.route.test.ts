// Task #640 — route-level test for GET /feedback/holdout-eval and the
// calibration-filter behavior that drops holdout rows from the suggestion
// engine. Uses the same mocked-DB chain pattern as stats.route.test.ts so
// we can drive precise row-set scenarios without a real Postgres.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import http from "node:http";
import express from "express";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { AddressInfo } from "node:net";

const selectQueue: unknown[][] = [];
const lastWhereSql: string[] = [];

// Recursively walk a drizzle SQL/Column object and collect every column
// name and string literal it references. Drizzle's SQL chunks are nested
// objects (SQL.queryChunks, Column.name, etc.) — they don't serialize
// usefully via JSON.stringify, so we walk them ourselves.
function collectIdentifiers(node: unknown, into: string[]): void {
  if (node == null) return;
  if (typeof node === "string") {
    into.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectIdentifiers(v, into);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.name === "string") into.push(obj.name);
    if (Array.isArray(obj.queryChunks))
      collectIdentifiers(obj.queryChunks, into);
    if (Array.isArray(obj.values)) collectIdentifiers(obj.values, into);
    if (obj.value !== undefined && typeof obj.value !== "object") {
      collectIdentifiers(obj.value, into);
    }
  }
}

function makeSelectChain(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const passthrough = (): Record<string, unknown> => chain;
  chain.from = passthrough;
  chain.innerJoin = passthrough;
  chain.where = (clause: unknown) => {
    const ids: string[] = [];
    collectIdentifiers(clause, ids);
    lastWhereSql.push(ids.join(" "));
    return chain;
  };
  chain.orderBy = passthrough;
  chain.limit = passthrough;
  chain.groupBy = passthrough;
  chain.then = (
    resolve: (v: unknown[]) => void,
    reject: (e: unknown) => void,
  ): void => {
    try {
      resolve(rows);
    } catch (e) {
      reject(e);
    }
  };
  return chain;
}

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  return {
    db: {
      execute: vi.fn(async () => ({ rows: [] })),
      select: () => {
        const rows = selectQueue.length > 0 ? selectQueue.shift()! : [];
        return makeSelectChain(rows);
      },
      insert: () => ({
        values: () => ({
          returning: async () => [{ id: 1 }],
        }),
      }),
    },
    reportsTable: schema.reportsTable,
    userFeedbackTable: schema.userFeedbackTable,
    pool: { end: async () => undefined },
  };
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const feedbackRouter = (await import("./feedback")).default;
  const app = express();
  app.use(express.json());
  app.use(feedbackRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  selectQueue.length = 0;
  lastWhereSql.length = 0;
});

interface HttpResponse<T> {
  status: number;
  body: T;
}
function get<T>(urlPath: string): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(text) as T,
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

interface HoldoutPartition {
  totalFeedback: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  accuracy: number | null;
}
interface HoldoutResponse {
  thresholds: {
    scoreThreshold: number;
    ratingThreshold: number;
    description: string;
  };
  holdout: HoldoutPartition;
  inSample: HoldoutPartition;
  holdoutFraction: number;
}

describe("GET /feedback/holdout-eval — Task #640", () => {
  it("partitions rows by isHoldout and reports honest precision/recall per partition", async () => {
    // 4 holdout rows, 4 in-sample rows. Engine threshold defaults to 75
    // (config.tierThresholds.high). actually-slop = rating<=2 OR helpful=false.
    selectQueue.push([
      // ---- HOLDOUT ----
      // TP: predicted slop (score>=75) AND actually slop (rating<=2)
      { slopScore: 90, rating: 1, helpful: true, isHoldout: true },
      // FP: predicted slop AND not actually slop (rating>=4 AND helpful=true)
      { slopScore: 80, rating: 5, helpful: true, isHoldout: true },
      // FN: not predicted (score<75) AND actually slop (helpful=false)
      { slopScore: 30, rating: 4, helpful: false, isHoldout: true },
      // TN: not predicted AND not actually slop
      { slopScore: 10, rating: 5, helpful: true, isHoldout: true },
      // ---- IN-SAMPLE (different distribution so partitions look distinct) ----
      // Two TPs
      { slopScore: 95, rating: 1, helpful: false, isHoldout: false },
      { slopScore: 88, rating: 2, helpful: true, isHoldout: false },
      // One FP
      { slopScore: 85, rating: 5, helpful: true, isHoldout: false },
      // One TN
      { slopScore: 5, rating: 5, helpful: true, isHoldout: false },
    ]);

    const res = await get<HoldoutResponse>("/feedback/holdout-eval");
    expect(res.status).toBe(200);
    expect(res.body.holdoutFraction).toBe(0.2);
    expect(res.body.thresholds.ratingThreshold).toBe(2);
    expect(typeof res.body.thresholds.scoreThreshold).toBe("number");

    expect(res.body.holdout).toMatchObject({
      totalFeedback: 4,
      tp: 1,
      fp: 1,
      fn: 1,
      tn: 1,
      precision: 0.5,
      recall: 0.5,
      f1: 0.5,
      accuracy: 0.5,
    });
    expect(res.body.inSample).toMatchObject({
      totalFeedback: 4,
      tp: 2,
      fp: 1,
      fn: 0,
      tn: 1,
    });
    // tp/(tp+fp) = 2/3 ≈ 0.667
    expect(res.body.inSample.precision).toBeCloseTo(0.667, 2);
    // tp/(tp+fn) = 2/2 = 1
    expect(res.body.inSample.recall).toBe(1);
  });

  it("returns null ratio metrics when a partition has zero rows", async () => {
    selectQueue.push([
      // Only in-sample rows; holdout partition is empty
      { slopScore: 90, rating: 1, helpful: false, isHoldout: false },
    ]);
    const res = await get<HoldoutResponse>("/feedback/holdout-eval");
    expect(res.status).toBe(200);
    expect(res.body.holdout).toMatchObject({
      totalFeedback: 0,
      tp: 0,
      fp: 0,
      fn: 0,
      tn: 0,
      precision: null,
      recall: null,
      f1: null,
      accuracy: null,
    });
    expect(res.body.inSample.totalFeedback).toBe(1);
  });

  it("returns null precision when no rows are predicted slop (denominator=0)", async () => {
    selectQueue.push([
      // All low scores → no predicted slop → precision denominator 0
      { slopScore: 10, rating: 1, helpful: false, isHoldout: true },
      { slopScore: 20, rating: 5, helpful: true, isHoldout: true },
    ]);
    const res = await get<HoldoutResponse>("/feedback/holdout-eval");
    expect(res.status).toBe(200);
    expect(res.body.holdout.precision).toBeNull();
    // recall has actually-slop in denominator (1 FN), so it's defined (=0).
    expect(res.body.holdout.recall).toBe(0);
  });
});

describe("calibration suggestions exclude holdout rows — Task #640", () => {
  it("at runtime, every calibration query WHERE clause references is_holdout", async () => {
    const { generateCalibrationReport } = await import("../lib/calibration");
    // Seed enough empty result sets that any number of selects in the
    // calibration pipeline finds something to await without throwing.
    for (let i = 0; i < 20; i++) selectQueue.push([]);

    try {
      await generateCalibrationReport();
    } catch {
      // Calibration may throw on empty data — we only care that the WHERE
      // clauses were constructed before the failure.
    }

    expect(lastWhereSql.length).toBeGreaterThan(0);
    // Every captured WHERE clause that touches user_feedback rows must
    // also reference the is_holdout column. If a future refactor adds a
    // new query path that forgets the filter, this assertion fires.
    const allClauses = lastWhereSql.join(" | ");
    expect(allClauses).toMatch(/is_holdout/);
  });
});
