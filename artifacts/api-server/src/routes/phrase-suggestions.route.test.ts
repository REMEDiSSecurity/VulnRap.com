// Task #634 — route-level integration test for the user-suggested phrase
// pipeline. Mounts the public + reviewer routes on an isolated express
// app with `@workspace/db` mocked the same way the cohort route tests do
// — a per-test FIFO of pre-built rows that the drizzle select / insert /
// update chain pops on `await`. This pins down the JSON wiring (status
// codes, body shape, validation, dedupe, daily-cap, reviewer auth)
// without standing up a real Postgres.
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

const TEST_TOKEN = "phrase-suggestions-test-token";

type SelectResult = unknown[];
const selectQueue: SelectResult[] = [];
const insertReturningQueue: unknown[][] = [];
const updateReturningQueue: unknown[][] = [];
const insertedValuesLog: unknown[] = [];
const updatedSetLog: unknown[] = [];

function makeChain(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  const passthrough = (): Record<string, unknown> => chain;
  chain.from = passthrough;
  chain.where = passthrough;
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
      select: () => {
        const rows = selectQueue.length > 0 ? selectQueue.shift()! : [];
        return makeChain(rows);
      },
      insert: () => ({
        values: (v: unknown) => {
          insertedValuesLog.push(v);
          return {
            returning: () =>
              Promise.resolve(
                insertReturningQueue.length > 0
                  ? insertReturningQueue.shift()!
                  : [{ id: 1 }],
              ),
          };
        },
      }),
      update: () => ({
        set: (updates: unknown) => {
          updatedSetLog.push(updates);
          return {
            where: () => ({
              returning: () =>
                Promise.resolve(
                  updateReturningQueue.length > 0
                    ? updateReturningQueue.shift()!
                    : [],
                ),
            }),
          };
        },
      }),
    },
    phraseSuggestionsTable: schema.phraseSuggestionsTable,
    pool: { end: async () => undefined },
  };
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.VISITOR_HMAC_KEY = "phrase-suggestion-test-key";
  process.env.CALIBRATION_TOKEN = TEST_TOKEN;

  const router = (await import("./phrase-suggestions")).default;
  const app = express();
  app.set("trust proxy", true);
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
  delete process.env.VISITOR_HMAC_KEY;
  delete process.env.CALIBRATION_TOKEN;
});

beforeEach(() => {
  selectQueue.length = 0;
  insertReturningQueue.length = 0;
  updateReturningQueue.length = 0;
  insertedValuesLog.length = 0;
  updatedSetLog.length = 0;
});

interface HttpResponse<T> {
  status: number;
  body: T;
}

function request<T>(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const data =
      body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        headers: {
          ...(data
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(data.length),
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
            const parsed = text.length > 0 ? JSON.parse(text) : {};
            resolve({ status: res.statusCode ?? 0, body: parsed as T });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("POST /public/phrase-suggestions — input validation", () => {
  it("rejects too-short text with 400", async () => {
    const res = await request<{ error: string }>(
      "POST",
      "/public/phrase-suggestions",
      {
        text: "ok",
        category: "handwavy",
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least/i);
  });

  it("rejects too-long text with 400", async () => {
    const res = await request<{ error: string }>(
      "POST",
      "/public/phrase-suggestions",
      {
        text: "x".repeat(241),
        category: "handwavy",
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most/i);
  });

  it("rejects an invalid category with 400", async () => {
    const res = await request<{ error: string }>(
      "POST",
      "/public/phrase-suggestions",
      {
        text: "this is a vague hand-wavy phrase",
        category: "nonsense",
      },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/category/i);
  });
});

describe("POST /public/phrase-suggestions — happy path + dedupe + daily cap", () => {
  it("accepts a valid submission, normalizes the text, and persists it as pending with an HMAC'd IP", async () => {
    selectQueue.push([{ count: 0 }]); // daily-count check
    selectQueue.push([]); // duplicate check
    insertReturningQueue.push([{ id: 42 }]);

    const res = await request<{ ok: boolean; duplicate: boolean; id: number }>(
      "POST",
      "/public/phrase-suggestions",
      {
        text: "  could  potentially   allow attackers  ",
        category: "handwavy",
        context: "saw it twice",
      },
    );

    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.id).toBe(42);

    expect(insertedValuesLog).toHaveLength(1);
    const inserted = insertedValuesLog[0] as Record<string, unknown>;
    expect(inserted.text).toBe("could potentially allow attackers");
    expect(inserted.category).toBe("handwavy");
    expect(inserted.context).toBe("saw it twice");
    expect(inserted.status).toBe("pending");
    expect(typeof inserted.ipHmac).toBe("string");
    expect((inserted.ipHmac as string).length).toBeGreaterThan(20);
  });

  it("returns duplicate=true and does NOT insert when the same IP recently submitted the same text", async () => {
    selectQueue.push([{ count: 1 }]); // daily-count check (under cap)
    selectQueue.push([{ id: 7 }]); // duplicate check finds a hit

    const res = await request<{ ok: boolean; duplicate: boolean; id?: number }>(
      "POST",
      "/public/phrase-suggestions",
      { text: "leverages cutting-edge synergy", category: "handwavy" },
    );

    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBeUndefined();
    expect(insertedValuesLog).toHaveLength(0);
  });

  it("returns 429 with the dailyLimit + retryAfterHours payload when the per-IP cap is reached", async () => {
    selectQueue.push([{ count: 5 }]); // already at the cap

    const res = await request<{
      error: string;
      dailyLimit: number;
      retryAfterHours: number;
    }>("POST", "/public/phrase-suggestions", {
      text: "another distinct hand-wavy phrase",
      category: "handwavy",
    });

    expect(res.status).toBe(429);
    expect(res.body.dailyLimit).toBe(5);
    expect(res.body.retryAfterHours).toBe(24);
    expect(insertedValuesLog).toHaveLength(0);
  });
});

describe("GET /feedback/calibration/phrase-suggestions — reviewer auth", () => {
  it("requires the calibration token", async () => {
    const res = await request(
      "GET",
      "/feedback/calibration/phrase-suggestions",
    );
    expect(res.status).toBe(401);
  });

  it("returns the queue with createdAt serialized to ISO when the token is correct", async () => {
    const created = new Date("2026-04-22T10:00:00.000Z");
    selectQueue.push([
      {
        id: 1,
        text: "first",
        category: "handwavy",
        context: null,
        status: "pending",
        createdAt: created,
      },
      {
        id: 2,
        text: "second",
        category: "ai-self-disclosure",
        context: "where I saw it",
        status: "pending",
        createdAt: created,
      },
    ]);

    const res = await request<{
      suggestions: Array<{
        id: number;
        text: string;
        category: string;
        context: string | null;
        status: string;
        createdAt: string;
      }>;
      total: number;
      status: string;
    }>("GET", "/feedback/calibration/phrase-suggestions", undefined, {
      "X-Calibration-Token": TEST_TOKEN,
    });

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.status).toBe("pending");
    expect(res.body.suggestions[0]).toEqual({
      id: 1,
      text: "first",
      category: "handwavy",
      context: null,
      status: "pending",
      createdAt: "2026-04-22T10:00:00.000Z",
    });
    expect(res.body.suggestions[1].context).toBe("where I saw it");
  });

  it("rejects unknown status filters with 400", async () => {
    const res = await request<{ error: string }>(
      "GET",
      "/feedback/calibration/phrase-suggestions?status=spammy",
      undefined,
      { "X-Calibration-Token": TEST_TOKEN },
    );
    expect(res.status).toBe(400);
  });
});

describe("PATCH /feedback/calibration/phrase-suggestions/:id", () => {
  it("requires the calibration token", async () => {
    const res = await request(
      "PATCH",
      "/feedback/calibration/phrase-suggestions/1",
      {
        status: "approved",
      },
    );
    expect(res.status).toBe(401);
  });

  it("flips a queued suggestion to approved and echoes the new status", async () => {
    updateReturningQueue.push([
      {
        id: 5,
        text: "phrase to approve",
        category: "handwavy",
        status: "approved",
      },
    ]);

    const res = await request<{ ok: boolean; id: number; status: string }>(
      "PATCH",
      "/feedback/calibration/phrase-suggestions/5",
      { status: "approved" },
      { "X-Calibration-Token": TEST_TOKEN },
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.id).toBe(5);
    expect(res.body.status).toBe("approved");
    expect(updatedSetLog).toEqual([{ status: "approved" }]);
  });

  it("flips a queued suggestion to rejected", async () => {
    updateReturningQueue.push([
      {
        id: 9,
        text: "phrase to reject",
        category: "handwavy",
        status: "rejected",
      },
    ]);
    const res = await request<{ status: string }>(
      "PATCH",
      "/feedback/calibration/phrase-suggestions/9",
      { status: "rejected" },
      { "X-Calibration-Token": TEST_TOKEN },
    );
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
  });

  it("rejects invalid status values with 400 and never touches the DB", async () => {
    const res = await request<{ error: string }>(
      "PATCH",
      "/feedback/calibration/phrase-suggestions/1",
      { status: "spammy" },
      { "X-Calibration-Token": TEST_TOKEN },
    );
    expect(res.status).toBe(400);
    expect(updatedSetLog).toHaveLength(0);
  });

  it("returns 404 when the suggestion id does not exist", async () => {
    updateReturningQueue.push([]); // empty -> not found
    const res = await request<{ error: string }>(
      "PATCH",
      "/feedback/calibration/phrase-suggestions/99999",
      { status: "approved" },
      { "X-Calibration-Token": TEST_TOKEN },
    );
    expect(res.status).toBe(404);
  });

  it("rejects non-positive ids with 400", async () => {
    const res = await request<{ error: string }>(
      "PATCH",
      "/feedback/calibration/phrase-suggestions/0",
      { status: "approved" },
      { "X-Calibration-Token": TEST_TOKEN },
    );
    expect(res.status).toBe(400);
  });
});
