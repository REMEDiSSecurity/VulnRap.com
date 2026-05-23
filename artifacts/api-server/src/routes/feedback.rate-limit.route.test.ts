// Task #1342 — Pen-test finding #4 (May 23 2026). Regression test for the
// per-IP feedback flood limiter. Without this, the rate-limit middleware
// can silently regress (max bumped, window changed, middleware dropped
// from the chain, etc.) and re-open the automated-flood vector the
// pen-test demonstrated. We mock the PoW challenge to always pass so we
// exercise the limiter — not the PoW — in isolation, and mock the DB so
// successful submissions return 201 without touching Postgres.
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

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  return {
    db: {
      transaction: async (
        fn: (tx: {
          insert: () => {
            values: () => { returning: () => Promise<{ id: number }[]> };
          };
          execute: () => Promise<{ rows: never[] }>;
        }) => Promise<unknown>,
      ) =>
        fn({
          insert: () => ({
            values: () => ({
              returning: async () => [{ id: 1 }],
            }),
          }),
          execute: async () => ({ rows: [] }),
        }),
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }),
      execute: vi.fn(async () => ({ rows: [] })),
    },
    reportsTable: schema.reportsTable,
    userFeedbackTable: schema.userFeedbackTable,
    pool: { end: async () => undefined },
  };
});

// Bypass the proof-of-work so we exercise the rate limiter in isolation.
// The real PoW path is covered by feedback-v2 / challenge unit tests.
vi.mock("../lib/challenge", () => ({
  generateChallenge: () => ({
    challengeId: "test",
    nonce: "test",
    difficulty: 1,
  }),
  verifyChallenge: () => ({ valid: true }),
}));

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
  // No per-test rate-limit reset hook is exposed by express-rate-limit
  // when using its default in-memory store, so the suite must run as a
  // single contiguous burst. Vitest runs `it` blocks in declaration
  // order within a describe, which is what we rely on here.
});

async function postFeedback(): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const res = await fetch(`${baseUrl}/feedback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: "test",
      challengeSolution: "test",
      reportId: 1,
      rating: 5,
      helpful: true,
      comment: "ok",
    }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

describe("POST /feedback — per-IP flood limiter (pen-test #4)", () => {
  it("accepts the first 3 rapid submissions then 429s the rest (acceptance: 5 rapid → later ones blocked)", async () => {
    // Task plan acceptance: "Submitting 5 feedbacks back-to-back from
    // one IP now returns 429 on the later ones." With the burst cap at
    // 3 / 15 min, the 1st-3rd succeed (201) and the 4th + 5th return
    // 429 with the limiter's JSON error envelope. This is the exact
    // pen-test PoC scenario and it must never silently regress.
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const { status } = await postFeedback();
      results.push(status);
    }
    expect(results.slice(0, 3)).toEqual([201, 201, 201]);
    expect(results[3]).toBe(429);
    expect(results[4]).toBe(429);

    const limited = await postFeedback();
    expect(limited.status).toBe(429);
    expect(typeof limited.body.error).toBe("string");
    expect((limited.body.error as string).toLowerCase()).toContain(
      "too many",
    );
  });
});
