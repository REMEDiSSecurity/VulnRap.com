// Task #645 — End-to-end tests for the reviewer audit log:
//   1. The middleware persists a row for every reviewer mutation, with
//      secret-shaped keys redacted out of the body.
//   2. GET /api/audit-log requires the strict reviewer auth gate.
//   3. Filters (actor / method / endpoint substring / from-to range) and
//      pagination work, and `revertHint` is stitched onto known-revertible
//      endpoints.
//
// The DB is mocked at the @workspace/db boundary so the test can run
// hermetically (no Postgres needed). The mock keeps an in-memory array of
// audit rows and reproduces enough of drizzle's chainable builder for the
// route's filtered SELECT + COUNT.

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

interface FakeAuditRow {
  id: number;
  actor: string;
  method: string;
  endpoint: string;
  requestPayload: unknown;
  queryParams: unknown;
  responseStatus: number;
  ip: string | null;
  createdAt: Date;
}

const auditRows: FakeAuditRow[] = [];
const filterFns: Array<(r: FakeAuditRow) => boolean> = [];
let nextId = 1;

vi.mock("@workspace/db", () => {
  // The route only ever operates on auditLogTable, but the calibration router
  // (mounted to drive a mutation through the middleware) imports
  // reportsTable. Keep the latter a structural stub.
  const auditLogTable = { __name: "audit_log" };
  const reportsTable = {
    id: "id",
    vulnrapCompositeLabel: "label",
    contentText: "content",
    createdAt: "createdAt",
  };

  type FilterPredicate = (r: FakeAuditRow) => boolean;
  type FilterToken =
    | { kind: "predicate"; fn: FilterPredicate }
    | { kind: "and"; parts: FilterPredicate[] };

  function tokenToPredicate(
    token: FilterToken | undefined | null,
  ): FilterPredicate {
    if (!token) return () => true;
    if (token.kind === "predicate") return token.fn;
    return (r) => token.parts.every((p) => p(r));
  }

  function makeSelectBuilder(isCount: boolean) {
    let predicate: FilterPredicate = () => true;
    let limitN: number | null = null;
    let offsetN = 0;
    const builder = {
      from() {
        return builder;
      },
      where(token: FilterToken | undefined) {
        predicate = tokenToPredicate(token ?? null);
        return builder;
      },
      orderBy() {
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      offset(n: number) {
        offsetN = n;
        return builder;
      },
      then<T>(onF: (rows: unknown[]) => T) {
        const matching = auditRows
          .filter(predicate)
          .sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id,
          );
        if (isCount) {
          return Promise.resolve([{ count: matching.length }]).then(onF);
        }
        const sliced = matching.slice(
          offsetN,
          limitN != null ? offsetN + limitN : undefined,
        );
        return Promise.resolve(sliced).then(onF);
      },
    };
    return builder;
  }

  const db = {
    select(shape?: Record<string, unknown>) {
      const isCount = !!shape && "count" in shape;
      return makeSelectBuilder(isCount);
    },
    insert(_table: unknown) {
      return {
        async values(row: Omit<FakeAuditRow, "id">) {
          auditRows.push({ ...row, id: nextId++ });
        },
      };
    },
  };

  // drizzle-orm helpers: return tagged predicates the fake builder can
  // collapse back into JS filters.
  const eq = (col: { __field: string }, val: unknown) => ({
    kind: "predicate" as const,
    fn: (r: FakeAuditRow) =>
      (r as unknown as Record<string, unknown>)[col.__field] === val,
  });
  const ilike = (col: { __field: string }, pattern: string) => {
    const needle = pattern.replace(/^%|%$/g, "").toLowerCase();
    return {
      kind: "predicate" as const,
      fn: (r: FakeAuditRow) =>
        String((r as unknown as Record<string, unknown>)[col.__field] ?? "")
          .toLowerCase()
          .includes(needle),
    };
  };
  const gte = (col: { __field: string }, val: Date) => ({
    kind: "predicate" as const,
    fn: (r: FakeAuditRow) =>
      (
        (r as unknown as Record<string, unknown>)[col.__field] as Date
      ).getTime() >= val.getTime(),
  });
  const lte = (col: { __field: string }, val: Date) => ({
    kind: "predicate" as const,
    fn: (r: FakeAuditRow) =>
      (
        (r as unknown as Record<string, unknown>)[col.__field] as Date
      ).getTime() <= val.getTime(),
  });
  const and = (...preds: Array<{ fn: FilterPredicate }>) => ({
    kind: "and" as const,
    parts: preds.map((p) => p.fn),
  });
  const desc = (_x: unknown) => _x;
  const sql = (strings: TemplateStringsArray) => strings.join("");

  // Replace auditLogTable with column descriptors so the predicates above
  // can reach the field names.
  Object.assign(auditLogTable, {
    id: { __field: "id" },
    actor: { __field: "actor" },
    method: { __field: "method" },
    endpoint: { __field: "endpoint" },
    responseStatus: { __field: "responseStatus" },
    createdAt: { __field: "createdAt" },
    ip: { __field: "ip" },
    requestPayload: { __field: "requestPayload" },
    queryParams: { __field: "queryParams" },
  });

  return {
    db,
    auditLogTable,
    reportsTable,
    eq,
    ilike,
    gte,
    lte,
    and,
    desc,
    sql,
  };
});

vi.mock("../lib/engines/avri/handwavy-phrases", () => ({
  getHandwavyPhraseHistory: () => [],
}));

// drizzle-orm itself is also imported by the route for its sql tag and
// predicate helpers — re-export the same shims.
vi.mock("drizzle-orm", async () => {
  const dbMock = await import("@workspace/db");
  return {
    eq: (dbMock as unknown as Record<string, unknown>).eq,
    ilike: (dbMock as unknown as Record<string, unknown>).ilike,
    gte: (dbMock as unknown as Record<string, unknown>).gte,
    lte: (dbMock as unknown as Record<string, unknown>).lte,
    and: (dbMock as unknown as Record<string, unknown>).and,
    desc: (dbMock as unknown as Record<string, unknown>).desc,
    sql: (dbMock as unknown as Record<string, unknown>).sql,
    isNotNull: () => ({ kind: "predicate", fn: () => true }),
  };
});

const TOKEN = "audit-log-test-token";
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.CALIBRATION_TOKEN = TOKEN;
  const { auditLogMutationMiddleware, writeAuditLogEntry } =
    await import("../middlewares/audit-log-middleware");
  const auditLogRouter = (await import("./audit-log")).default;

  const app = express();
  app.use(express.json());
  // Mount the middleware against a tiny synthetic mutation surface so we
  // can verify it persists rows + redacts secrets without hauling in the
  // full calibration router (which would need a phrases-file fixture).
  const reviewerOnly = express.Router();
  reviewerOnly.use(auditLogMutationMiddleware);
  reviewerOnly.post("/feedback/calibration/handwavy-phrases", (req, res) => {
    void req.body;
    res.status(201).json({ ok: true });
  });
  reviewerOnly.delete("/feedback/calibration/handwavy-phrases", (_req, res) => {
    res.status(200).json({ ok: true });
  });
  reviewerOnly.post("/feedback/calibration/echo-fail", (_req, res) => {
    res.status(400).json({ error: "bad" });
  });
  app.use("/api", reviewerOnly);
  app.use("/api", auditLogRouter);

  // Seed a few rows that the GET filter tests can lean on. Using the
  // exported writer keeps the row shape identical to the middleware path.
  await writeAuditLogEntry({
    actor: "alice",
    method: "POST",
    endpoint: "/api/feedback/calibration/handwavy-phrases",
    requestPayload: { phrase: "seed alice", reviewer: "alice" },
    queryParams: null,
    responseStatus: 201,
    ip: "127.0.0.1",
    createdAt: new Date("2026-01-01T10:00:00Z"),
  });
  await writeAuditLogEntry({
    actor: "bob",
    method: "DELETE",
    endpoint: "/api/feedback/calibration/handwavy-phrases",
    requestPayload: { phrase: "seed bob" },
    queryParams: null,
    responseStatus: 200,
    ip: "127.0.0.1",
    createdAt: new Date("2026-02-01T10:00:00Z"),
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.CALIBRATION_TOKEN;
});

beforeEach(() => {
  // Keep only the two seeded rows between tests so order/filter assertions
  // stay deterministic regardless of run order.
  auditRows.length = 2;
  nextId = 3;
});

interface HttpResponse<T> {
  status: number;
  body: T;
  headers: Record<string, string>;
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
    const baseHeaders: Record<string, string> = data
      ? {
          "content-type": "application/json",
          "content-length": String(data.length),
        }
      : {};
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: { ...baseHeaders, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            /* keep raw */
          }
          resolve({
            status: res.statusCode ?? 0,
            body: parsed as T,
            headers: res.headers as Record<string, string>,
          });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Helper: poll until the audit-log row count grows past `start`. The
// middleware writes asynchronously after `res.end()`, so a synchronous
// assertion right after the response races the insert.
async function waitForAuditRow(start: number, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (auditRows.length > start) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(
    `audit row never landed (start=${start}, current=${auditRows.length})`,
  );
}

describe("audit-log middleware", () => {
  it("persists a row for a successful mutation with reviewer field as actor", async () => {
    const startCount = auditRows.length;
    const res = await request<{ ok: true }>(
      "POST",
      "/api/feedback/calibration/handwavy-phrases",
      { phrase: "new phrase", reviewer: "carol@example.com" },
    );
    expect(res.status).toBe(201);
    await waitForAuditRow(startCount);
    const row = auditRows[auditRows.length - 1];
    expect(row.actor).toBe("carol@example.com");
    expect(row.method).toBe("POST");
    expect(row.endpoint).toBe("/api/feedback/calibration/handwavy-phrases");
    expect(row.responseStatus).toBe(201);
    expect(row.requestPayload).toMatchObject({
      phrase: "new phrase",
      reviewer: "carol@example.com",
    });
  });

  it("redacts secret-shaped keys from the persisted body", async () => {
    const startCount = auditRows.length;
    const res = await request<{ ok: true }>(
      "POST",
      "/api/feedback/calibration/handwavy-phrases",
      {
        phrase: "leaky",
        token: "super-secret-token",
        nested: { apiKey: "abc", password: "p", reviewer: "anon" },
      },
    );
    expect(res.status).toBe(201);
    await waitForAuditRow(startCount);
    const row = auditRows[auditRows.length - 1];
    const payload = row.requestPayload as Record<string, unknown>;
    expect(payload.token).toBe("[REDACTED]");
    const nested = payload.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe("[REDACTED]");
    expect(nested.password).toBe("[REDACTED]");
    // Non-secret keys survive untouched.
    expect(payload.phrase).toBe("leaky");
  });

  it("records the response status for failed mutations", async () => {
    const startCount = auditRows.length;
    const res = await request<{ error: string }>(
      "POST",
      "/api/feedback/calibration/echo-fail",
      { foo: "bar" },
      { "x-reviewer-name": "header-reviewer" },
    );
    expect(res.status).toBe(400);
    await waitForAuditRow(startCount);
    const row = auditRows[auditRows.length - 1];
    expect(row.responseStatus).toBe(400);
    expect(row.actor).toBe("header-reviewer");
  });
});

describe("GET /api/audit-log", () => {
  it("requires the reviewer token (strict)", async () => {
    const res = await request<{ error: string }>("GET", "/api/audit-log");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/calibration auth|reviewer token/i);
  });

  it("returns paginated entries newest-first when authed", async () => {
    const res = await request<{
      total: number;
      limit: number;
      offset: number;
      entries: Array<{
        id: number;
        actor: string;
        method: string;
        endpoint: string;
        revertHint: unknown;
      }>;
    }>("GET", "/api/audit-log", undefined, { "x-calibration-token": TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.entries).toHaveLength(2);
    // Bob (Feb) is newer than Alice (Jan).
    expect(res.body.entries[0].actor).toBe("bob");
    expect(res.body.entries[1].actor).toBe("alice");
  });

  it("filters by actor", async () => {
    const res = await request<{
      total: number;
      entries: Array<{ actor: string }>;
    }>("GET", "/api/audit-log?actor=alice", undefined, {
      "x-calibration-token": TOKEN,
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].actor).toBe("alice");
  });

  it("filters by method (case-insensitive)", async () => {
    const res = await request<{
      total: number;
      entries: Array<{ method: string }>;
    }>("GET", "/api/audit-log?method=delete", undefined, {
      "x-calibration-token": TOKEN,
    });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].method).toBe("DELETE");
  });

  it("filters by endpoint substring and date range", async () => {
    const res = await request<{
      total: number;
      entries: Array<{ actor: string }>;
    }>(
      "GET",
      "/api/audit-log?endpoint=handwavy&from=2026-01-15T00:00:00Z",
      undefined,
      { "x-calibration-token": TOKEN },
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].actor).toBe("bob");
  });

  it("attaches revertHint for known revertible endpoints", async () => {
    const res = await request<{
      entries: Array<{
        method: string;
        revertHint: { method: string; endpoint: string } | null;
      }>;
    }>("GET", "/api/audit-log", undefined, { "x-calibration-token": TOKEN });
    expect(res.status).toBe(200);
    const post = res.body.entries.find((e) => e.method === "POST");
    const del = res.body.entries.find((e) => e.method === "DELETE");
    expect(post?.revertHint?.method).toBe("DELETE");
    expect(del?.revertHint?.method).toBe("POST");
    expect(del?.revertHint?.endpoint).toBe(
      "/api/feedback/calibration/handwavy-phrases/reinstate",
    );
  });
});
