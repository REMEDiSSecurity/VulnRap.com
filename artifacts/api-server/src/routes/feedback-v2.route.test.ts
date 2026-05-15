// Task #1328 — Route-level tests for POST /api/feedback/v2 ingest +
// the admin review surface. Uses the same mocked-DB chain pattern as
// feedback.holdout.route.test.ts so we can drive precise row-set
// scenarios without a real Postgres.
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

const INGEST_TOKEN = "remedis-ingest-token";
const CAL_TOKEN = "cal-reviewer-token";

const insertValues: unknown[] = [];
const updateSetCalls: unknown[] = [];
const selectQueue: unknown[][] = [];
let nextInsertId = 100;

function makeSelectChain(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const passthrough = (): Record<string, unknown> => chain;
  chain.from = passthrough;
  chain.innerJoin = passthrough;
  chain.where = passthrough;
  chain.orderBy = passthrough;
  chain.limit = passthrough;
  chain.groupBy = passthrough;
  chain.for = passthrough;
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

function makeDb(): Record<string, unknown> {
  return {
    select: () => {
      const rows = selectQueue.length > 0 ? selectQueue.shift()! : [];
      return makeSelectChain(rows);
    },
    insert: () => ({
      values: (v: unknown) => {
        insertValues.push(v);
        return {
          returning: async () => [{ id: nextInsertId++ }],
        };
      },
    }),
    update: () => ({
      set: (v: unknown) => {
        updateSetCalls.push(v);
        return {
          where: () => ({
            returning: async () => [{ id: 1 }],
          }),
        };
      },
    }),
    transaction: async (
      fn: (tx: ReturnType<typeof makeDb>) => Promise<unknown>,
    ) => fn(makeDb()),
    execute: vi.fn(async () => ({ rows: [] })),
  };
}

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  return {
    db: makeDb(),
    corpusUnreviewedTable: schema.corpusUnreviewedTable,
    corpusLabelledTable: schema.corpusLabelledTable,
    pool: { end: async () => undefined },
  };
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.REMEDIS_FEEDBACK_TOKEN = INGEST_TOKEN;
  process.env.CALIBRATION_TOKEN = CAL_TOKEN;
  const router = (await import("./feedback-v2")).default;
  const app = express();
  app.use(express.json());
  app.use(router);
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
  insertValues.length = 0;
  updateSetCalls.length = 0;
  selectQueue.length = 0;
  nextInsertId = 100;
});

interface HttpResponse<T> {
  status: number;
  body: T;
}

function request<T>(
  method: string,
  urlPath: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${urlPath}`);
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: {
          ...(payload
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload).toString(),
              }
            : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: res.statusCode ?? 0,
              body: text ? (JSON.parse(text) as T) : (null as T),
            });
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const VALID_PAYLOAD = {
  schema_version: "remedis.feedback.v2",
  verdict: "confirm",
  report_id: "rr-042-some-bug",
  report_features: {
    positive: ["file_path_line", "named_cwe"],
    negative: ["templated_opening"],
  },
  agreement: {
    authenticity_match: true,
    realness_in_band: true,
    severity_match: false,
    in_scope_match: true,
    duplicate_match: true,
  },
  explanations: {
    severity: {
      expected: "high",
      vulnrap_said: "medium",
      should_have_weighted: ["cvss_vector"],
      guidance: "CVSS score band mismatch",
    },
  },
  signals_vulnrap_should_have_weighted: {
    severity_band: ["cvss_vector"],
  },
  model_improvement_suggestions: ["Add a hard CVSS-band check"],
  calibration_note: "Calibration off by -0.1",
  ground_truth: { is_real: true, severity: "high" },
};

describe("POST /api/feedback/v2 — Task #1328", () => {
  it("rejects requests without the REMEDiS token", async () => {
    const res = await request("POST", "/feedback/v2", VALID_PAYLOAD);
    expect(res.status).toBe(401);
  });

  it("rejects requests carrying a wrong bearer token", async () => {
    const res = await request("POST", "/feedback/v2", VALID_PAYLOAD, {
      authorization: "Bearer not-the-right-token",
    });
    expect(res.status).toBe(401);
  });

  it("accepts a valid payload with the bearer token and persists it", async () => {
    const res = await request<{ feedback_id: number; submission_id: string }>(
      "POST",
      "/feedback/v2",
      VALID_PAYLOAD,
      { authorization: `Bearer ${INGEST_TOKEN}` },
    );
    expect(res.status).toBe(201);
    expect(res.body.feedback_id).toBe(100);
    expect(res.body.submission_id).toBe("rr-042-some-bug");
    expect(insertValues).toHaveLength(1);
    const inserted = insertValues[0] as Record<string, unknown>;
    expect(inserted.submissionId).toBe("rr-042-some-bug");
    expect(inserted.schemaVersion).toBe("remedis.feedback.v2");
    expect(inserted.verdict).toBe("confirm");
  });

  it("accepts the dedicated X-Remedis-Token header as well", async () => {
    const res = await request("POST", "/feedback/v2", VALID_PAYLOAD, {
      "x-remedis-token": INGEST_TOKEN,
    });
    expect(res.status).toBe(201);
  });

  it("rejects payloads with the wrong schema_version", async () => {
    const bad = { ...VALID_PAYLOAD, schema_version: "remedis.feedback.v1" };
    const res = await request<{ error: string; issues: unknown[] }>(
      "POST",
      "/feedback/v2",
      bad,
      { authorization: `Bearer ${INGEST_TOKEN}` },
    );
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(insertValues).toHaveLength(0);
  });

  it("rejects payloads missing required fields", async () => {
    const bad = { ...VALID_PAYLOAD } as Record<string, unknown>;
    delete bad.agreement;
    const res = await request("POST", "/feedback/v2", bad, {
      authorization: `Bearer ${INGEST_TOKEN}`,
    });
    expect(res.status).toBe(400);
    expect(insertValues).toHaveLength(0);
  });

  it("rejects unknown verdicts", async () => {
    const bad = { ...VALID_PAYLOAD, verdict: "wat" };
    const res = await request("POST", "/feedback/v2", bad, {
      authorization: `Bearer ${INGEST_TOKEN}`,
    });
    expect(res.status).toBe(400);
  });
});

describe("Admin endpoints — Task #1328", () => {
  it("GET /api/feedback/v2/pending rejects without the reviewer token", async () => {
    const res = await request("GET", "/feedback/v2/pending", undefined);
    expect(res.status).toBe(401);
  });

  it("GET /api/feedback/v2/pending returns rows with the reviewer token", async () => {
    selectQueue.push([
      {
        id: 1,
        submissionId: "rr-1",
        schemaVersion: "remedis.feedback.v2",
        verdict: "confirm",
        receivedAt: new Date().toISOString(),
        status: "pending",
        decidedAt: null,
        decidedBy: null,
        decisionReason: null,
      },
    ]);
    const res = await request<{ rows: unknown[] }>(
      "GET",
      "/feedback/v2/pending",
      undefined,
      { "x-calibration-token": CAL_TOKEN },
    );
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
  });

  it("POST /api/feedback/v2/:id/reject requires a reason", async () => {
    const res = await request(
      "POST",
      "/feedback/v2/5/reject",
      {},
      { "x-calibration-token": CAL_TOKEN },
    );
    expect(res.status).toBe(400);
  });

  it("POST /api/feedback/v2/:id/reject succeeds with a reason and stamps reviewer", async () => {
    const res = await request<{ status: string }>(
      "POST",
      "/feedback/v2/5/reject",
      { reason: "ground truth says not slop" },
      {
        "x-calibration-token": CAL_TOKEN,
        "x-reviewer-id": "alice",
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(updateSetCalls).toHaveLength(1);
    const set = updateSetCalls[0] as Record<string, unknown>;
    expect(set.status).toBe("rejected");
    expect(set.decidedBy).toBe("alice");
    expect(set.decisionReason).toBe("ground truth says not slop");
  });

  it("POST /api/feedback/v2/:id/promote requires a reason", async () => {
    const res = await request(
      "POST",
      "/feedback/v2/5/promote",
      {},
      { "x-calibration-token": CAL_TOKEN },
    );
    expect(res.status).toBe(400);
  });

  it("POST /api/feedback/v2/:id/defer requires a reason", async () => {
    const res = await request(
      "POST",
      "/feedback/v2/5/defer",
      { reason: "" },
      { "x-calibration-token": CAL_TOKEN },
    );
    expect(res.status).toBe(400);
  });
});
