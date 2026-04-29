// Task #236 — route-level integration test for the visitor analytics
// endpoints (`GET /stats/visitors`, `POST /stats/visit`).
//
// These two handlers were the source of a regression where a missing
// `page_views` table in development bubbled raw Postgres "undefined_table"
// errors out as 500s, polluting the network panel and server logs on every
// homepage / /stats render. The handlers were patched to detect the
// SQLSTATE 42P01 path (both the raw pg error and the drizzle wrapper that
// hangs the original error off `.cause`) and degrade gracefully:
//
//   - GET  /stats/visitors → 200 with { totalUniqueVisitors: 0, totalVisits: 0 }
//   - POST /stats/visit    → 200 with { recorded: false }
//
// Other DB errors (anything that is NOT 42P01) must still surface as a 500
// so genuine breakage in production is not silently swallowed.
//
// This file mocks `@workspace/db` so we can control what `db.execute`
// returns/throws on a per-test basis without needing a real Postgres
// connection. The `reportsTable` / `userFeedbackTable` re-exports are
// re-exported from the actual schema so the stats router's other handlers
// (which we don't exercise here) still type-check / import successfully.
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ExecuteFn = (...args: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

// Per-test handle: each test installs a fresh implementation before issuing
// requests. Default is "table absent" (42P01) so a test that forgets to
// configure the mock will still match the real-world dev behaviour.
const executeMock = vi.fn() as unknown as ExecuteFn & {
  mockImplementation: (fn: ExecuteFn) => void;
  mockReset: () => void;
};

vi.mock("@workspace/db", async () => {
  const schema = await vi.importActual<Record<string, unknown>>(
    "@workspace/db/schema",
  );
  return {
    db: {
      execute: (...args: unknown[]) =>
        (executeMock as unknown as (...a: unknown[]) => Promise<unknown>)(...args),
      // The other stats handlers (/stats, /stats/recent, /stats/trends, etc.)
      // use db.select(...) chains. We don't exercise them in this test file,
      // but we still need the symbol to exist so the router module imports
      // cleanly.
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
          orderBy: () => ({ limit: () => Promise.resolve([]) }),
          groupBy: () => ({ orderBy: () => Promise.resolve([]) }),
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
  // Pin a stable HMAC key so the visit handler's hash derivation is
  // deterministic and doesn't emit the "ephemeral key" warning during the
  // test run.
  process.env.VISITOR_HMAC_KEY = "stats-route-test-hmac-key";

  const statsRouter = (await import("./stats")).default;
  const app = express();
  app.use(express.json());
  app.use(statsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.VISITOR_HMAC_KEY;
});

beforeEach(() => {
  (executeMock as unknown as { mockReset: () => void }).mockReset();
});

interface HttpResponse<T> {
  status: number;
  body: T;
}

function request<T>(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const data = body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(`${baseUrl}${urlPath}`);
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": String(data.length) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            // 500 responses come back as Express's default HTML error page
            // (no JSON middleware kicks in), so be lenient: hand the raw
            // text back as the body when JSON parsing fails. Tests that
            // care about JSON shape only inspect 200 responses.
            let parsed: unknown;
            if (text.length === 0) {
              parsed = {};
            } else {
              try {
                parsed = JSON.parse(text);
              } catch {
                parsed = text;
              }
            }
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

// Build a fake pg "undefined_table" error. The SQLSTATE 42P01 code is what
// the stats handlers key off of via isMissingPageViewsTable().
function makeUndefinedTableError(): Error {
  const err = new Error('relation "page_views" does not exist') as Error & { code?: string };
  err.code = "42P01";
  return err;
}

// drizzle-orm wraps driver errors in DrizzleQueryError and exposes the
// original pg error (with its SQLSTATE) on `.cause`. The stats handlers
// must detect either shape; this helper covers the wrapped case.
function makeWrappedUndefinedTableError(): Error {
  const wrapped = new Error("Failed query: insert into page_views ...") as Error & {
    cause?: unknown;
  };
  wrapped.cause = makeUndefinedTableError();
  return wrapped;
}

describe("GET /stats/visitors", () => {
  it("degrades to zero counts when page_views table is absent (42P01)", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        throw makeUndefinedTableError();
      });

    const r = await request<{ totalUniqueVisitors: number; totalVisits: number }>(
      "GET",
      "/stats/visitors",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ totalUniqueVisitors: 0, totalVisits: 0 });
  });

  it("degrades to zero counts when 42P01 is wrapped in DrizzleQueryError.cause", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        throw makeWrappedUndefinedTableError();
      });

    const r = await request<{ totalUniqueVisitors: number; totalVisits: number }>(
      "GET",
      "/stats/visitors",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ totalUniqueVisitors: 0, totalVisits: 0 });
  });

  it("returns real counts when page_views exists with rows", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => ({
        rows: [{ total_unique_visitors: 42, total_visits: 7 }],
      }));

    const r = await request<{ totalUniqueVisitors: number; totalVisits: number }>(
      "GET",
      "/stats/visitors",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ totalUniqueVisitors: 42, totalVisits: 7 });
  });

  it("returns zero counts when page_views exists but has no rows", async () => {
    // Postgres' count(distinct ...) returns 0/0 for an empty table, but
    // defensive coding in the handler also coerces a missing row to 0.
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => ({ rows: [] }));

    const r = await request<{ totalUniqueVisitors: number; totalVisits: number }>(
      "GET",
      "/stats/visitors",
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ totalUniqueVisitors: 0, totalVisits: 0 });
  });

  it("surfaces non-undefined-table DB errors as 500 (no silent fallback)", async () => {
    // A genuine connection or permission error must NOT be coerced into a
    // {0,0} success — that would mask real breakage in production.
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        const err = new Error("connection refused") as Error & { code?: string };
        err.code = "08006"; // connection_failure, not 42P01
        throw err;
      });

    const r = await request<{ totalUniqueVisitors?: number }>("GET", "/stats/visitors");
    expect(r.status).toBe(500);
  });
});

describe("POST /stats/visit", () => {
  it("returns { recorded: false } when page_views table is absent (42P01)", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        throw makeUndefinedTableError();
      });

    const r = await request<{ recorded: boolean }>("POST", "/stats/visit", {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recorded: false });
  });

  it("returns { recorded: false } when 42P01 is wrapped in DrizzleQueryError.cause", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        throw makeWrappedUndefinedTableError();
      });

    const r = await request<{ recorded: boolean }>("POST", "/stats/visit", {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recorded: false });
  });

  it("returns { recorded: true } on a successful insert", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => ({ rows: [] }));

    const r = await request<{ recorded: boolean }>("POST", "/stats/visit", {});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recorded: true });
  });

  it("surfaces non-undefined-table DB errors as 500 (no silent fallback)", async () => {
    (executeMock as unknown as { mockImplementation: (fn: ExecuteFn) => void })
      .mockImplementation(async () => {
        const err = new Error("unique violation") as Error & { code?: string };
        err.code = "23505"; // unique_violation, not 42P01
        throw err;
      });

    const r = await request<{ recorded?: boolean }>("POST", "/stats/visit", {});
    expect(r.status).toBe(500);
  });
});
