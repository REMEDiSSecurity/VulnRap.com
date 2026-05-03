// Task #673 — Webhook subscription endpoints + delivery worker tests.
//
// The DB is mocked at the @workspace/db boundary (drizzle-orm helpers
// echoed through the same mock) so the test can run hermetically. We
// cover: reviewer-only gating on POST/GET/DELETE, that POST returns
// the signing secret exactly once, that the dispatcher signs the
// payload and posts to every subscribed URL with exponential-backoff
// retries on transient failure, and that success/failure stamps the
// row.

import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeWebhookRow {
  id: number;
  url: string;
  secretHash: string;
  eventTypes: string[];
  createdAt: Date;
  lastDeliveredAt: Date | null;
  failureCount: number;
}

const webhookRows: FakeWebhookRow[] = [];
let nextId = 1;

vi.mock("@workspace/db", () => {
  const webhooksTable = {
    __name: "webhooks",
    id: { __field: "id" },
    url: { __field: "url" },
    secretHash: { __field: "secretHash" },
    eventTypes: { __field: "eventTypes" },
    createdAt: { __field: "createdAt" },
    lastDeliveredAt: { __field: "lastDeliveredAt" },
    failureCount: { __field: "failureCount" },
  };

  type Pred = (r: FakeWebhookRow) => boolean;
  type Token = { kind: "predicate"; fn: Pred } | { kind: "and"; parts: Pred[] };
  function toPred(t: Token | null | undefined): Pred {
    if (!t) return () => true;
    if (t.kind === "predicate") return t.fn;
    return (r) => t.parts.every((p) => p(r));
  }

  const db = {
    select(_shape?: unknown) {
      let predicate: Pred = () => true;
      const builder = {
        from() { return builder; },
        where(t: Token) { predicate = toPred(t); return builder; },
        orderBy() { return builder; },
        then<T>(onF: (rows: unknown[]) => T) {
          const sorted = [...webhookRows]
            .filter(predicate)
            .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
          return Promise.resolve(sorted).then(onF);
        },
      };
      return builder;
    },
    insert(_t: unknown) {
      return {
        values(row: Omit<FakeWebhookRow, "id" | "createdAt" | "lastDeliveredAt" | "failureCount"> & Partial<FakeWebhookRow>) {
          return {
            returning() {
              const inserted: FakeWebhookRow = {
                id: nextId++,
                url: row.url,
                secretHash: row.secretHash,
                eventTypes: row.eventTypes,
                createdAt: new Date(),
                lastDeliveredAt: null,
                failureCount: 0,
              };
              webhookRows.push(inserted);
              return Promise.resolve([inserted]);
            },
          };
        },
      };
    },
    update(_t: unknown) {
      return {
        set(values: Partial<FakeWebhookRow> & { failureCount?: unknown }) {
          let predicate: Pred = () => true;
          const chain = {
            where(t: Token) {
              predicate = toPred(t);
              return chain;
            },
            then<T>(onF: (v: unknown) => T) {
              for (const r of webhookRows) {
                if (predicate(r)) {
                  if (values.lastDeliveredAt !== undefined) r.lastDeliveredAt = values.lastDeliveredAt;
                  if (typeof values.failureCount === "number") r.failureCount = values.failureCount;
                  else if (values.failureCount && typeof values.failureCount === "object" && "__incrFailure" in (values.failureCount as object)) {
                    r.failureCount = r.failureCount + 1;
                  }
                }
              }
              return Promise.resolve(undefined as unknown).then(onF);
            },
          };
          return chain;
        },
      };
    },
    delete(_t: unknown) {
      let predicate: Pred = () => true;
      const chain = {
        where(t: Token) { predicate = toPred(t); return chain; },
        returning() {
          const removed: { id: number }[] = [];
          for (let i = webhookRows.length - 1; i >= 0; i--) {
            if (predicate(webhookRows[i])) {
              removed.push({ id: webhookRows[i].id });
              webhookRows.splice(i, 1);
            }
          }
          return Promise.resolve(removed);
        },
      };
      return chain;
    },
  };

  const eq = (col: { __field: string }, val: unknown) => ({
    kind: "predicate" as const,
    fn: (r: FakeWebhookRow) => (r as unknown as Record<string, unknown>)[col.__field] === val,
  });
  const desc = (_x: unknown) => _x;
  // The webhook-delivery worker calls .set({ failureCount: sql`... + 1` }).
  // Returning a tagged object lets the fake update branch increment instead
  // of overwriting.
  const sql = Object.assign(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => ({ __incrFailure: true }),
    { raw: (_s: string) => ({ __raw: true }) },
  );
  const and = (...preds: Array<{ fn: Pred }>) => ({ kind: "and" as const, parts: preds.map((p) => p.fn) });

  return { db, webhooksTable, eq, desc, sql, and };
});

vi.mock("drizzle-orm", async () => {
  const m = await import("@workspace/db");
  const r = m as unknown as Record<string, unknown>;
  return { eq: r.eq, desc: r.desc, sql: r.sql, and: r.and };
});

const TOKEN = "webhooks-test-token";
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.CALIBRATION_TOKEN = TOKEN;
  const webhooksRouter = (await import("./webhooks")).default;
  const app = express();
  app.use(express.json());
  app.use("/api", webhooksRouter);
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
  webhookRows.length = 0;
  nextId = 1;
});

interface HttpResponse<T> { status: number; body: T }

function request<T>(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<HttpResponse<T>> {
  return new Promise((resolve, reject) => {
    const data = body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(`${baseUrl}${urlPath}`);
    const baseHeaders: Record<string, string> = data
      ? { "content-type": "application/json", "content-length": String(data.length) }
      : {};
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { ...baseHeaders, ...headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* keep raw */ }
          resolve({ status: res.statusCode ?? 0, body: parsed as T });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("POST /api/webhooks", () => {
  it("rejects without a reviewer token", async () => {
    const res = await request<{ error: string }>("POST", "/api/webhooks", { url: "https://example.com/hook" });
    expect(res.status).toBe(401);
  });

  it("rejects an invalid url", async () => {
    const res = await request<{ error: string }>("POST", "/api/webhooks", { url: "not-a-url" }, { "x-calibration-token": TOKEN });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url/i);
  });

  it("rejects an unsupported event type", async () => {
    const res = await request<{ error: string }>(
      "POST",
      "/api/webhooks",
      { url: "https://example.com/hook", eventTypes: ["report.deleted"] },
      { "x-calibration-token": TOKEN },
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unsupported event type/);
  });

  it("registers a webhook, returns the secret once, and stores only its hash", async () => {
    const res = await request<{ id: number; url: string; eventTypes: string[]; secret: string; failureCount: number }>(
      "POST",
      "/api/webhooks",
      { url: "https://example.com/hook" },
      { "x-calibration-token": TOKEN },
    );
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(1);
    expect(res.body.url).toBe("https://example.com/hook");
    expect(res.body.eventTypes).toEqual(["report.scored"]);
    expect(res.body.failureCount).toBe(0);
    expect(typeof res.body.secret).toBe("string");
    expect(res.body.secret.length).toBeGreaterThan(0);

    expect(webhookRows).toHaveLength(1);
    const stored = webhookRows[0];
    // Plaintext secret is NOT stored — only its sha256 hash.
    expect(stored.secretHash).toBe(crypto.createHash("sha256").update(res.body.secret, "utf8").digest("hex"));
    expect((stored as unknown as Record<string, unknown>).secret).toBeUndefined();
  });
});

describe("GET /api/webhooks", () => {
  it("requires the reviewer token (strict)", async () => {
    const res = await request<{ error: string }>("GET", "/api/webhooks");
    expect(res.status).toBe(401);
  });

  it("lists registered webhooks newest-first when authed", async () => {
    webhookRows.push(
      { id: 1, url: "https://a.example/hook", secretHash: "x", eventTypes: ["report.scored"], createdAt: new Date("2026-01-01"), lastDeliveredAt: null, failureCount: 0 },
      { id: 2, url: "https://b.example/hook", secretHash: "y", eventTypes: ["report.scored"], createdAt: new Date("2026-02-01"), lastDeliveredAt: null, failureCount: 3 },
    );
    nextId = 3;
    const res = await request<{ webhooks: Array<{ id: number; url: string; failureCount: number }> }>(
      "GET",
      "/api/webhooks",
      undefined,
      { "x-calibration-token": TOKEN },
    );
    expect(res.status).toBe(200);
    expect(res.body.webhooks).toHaveLength(2);
    expect(res.body.webhooks[0].id).toBe(2);
    expect(res.body.webhooks[0].failureCount).toBe(3);
  });
});

describe("DELETE /api/webhooks/:id", () => {
  it("requires the reviewer token", async () => {
    const res = await request<{ error: string }>("DELETE", "/api/webhooks/1");
    expect(res.status).toBe(401);
  });

  it("404s when the id does not exist", async () => {
    const res = await request<{ error: string }>("DELETE", "/api/webhooks/999", undefined, { "x-calibration-token": TOKEN });
    expect(res.status).toBe(404);
  });

  it("deletes a registered webhook", async () => {
    webhookRows.push({ id: 1, url: "https://a.example/hook", secretHash: "x", eventTypes: ["report.scored"], createdAt: new Date(), lastDeliveredAt: null, failureCount: 0 });
    nextId = 2;
    const res = await request<{ id: number }>("DELETE", "/api/webhooks/1", undefined, { "x-calibration-token": TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(1);
    expect(webhookRows).toHaveLength(0);
  });
});

describe("dispatchReportScoredEvent", () => {
  it("posts a signed payload to every subscriber and stamps lastDeliveredAt on 2xx", async () => {
    const delivery = await import("../lib/webhook-delivery");
    const secret = "secret-1";
    webhookRows.push({
      id: 7,
      url: "https://hook-a.example/in",
      secretHash: delivery.hashSecret(secret),
      eventTypes: ["report.scored"],
      createdAt: new Date(),
      lastDeliveredAt: null,
      failureCount: 0,
    });
    delivery.rememberWebhookSecret(7, secret);

    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, headers, body: String(init.body) });
      return new Response("", { status: 200 });
    });
    delivery.__setWebhookDeliveryDepsForTests({ fetch: fakeFetch as unknown as typeof fetch });

    await delivery.dispatchReportScoredEvent({
      event: "report.scored",
      reportId: 42,
      slopScore: 80,
      slopTier: "slop",
      compositeScore: 82,
      label: "AI-generated",
      createdAt: "2026-05-03T00:00:00.000Z",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://hook-a.example/in");
    expect(calls[0].headers["x-vulnrap-event"]).toBe("report.scored");
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(calls[0].body, "utf8").digest("hex");
    expect(calls[0].headers["x-vulnrap-signature"]).toBe(expected);
    expect(JSON.parse(calls[0].body)).toMatchObject({ event: "report.scored", reportId: 42, slopScore: 80 });
    expect(webhookRows[0].lastDeliveredAt).not.toBeNull();
    expect(webhookRows[0].failureCount).toBe(0);

    delivery.__setWebhookDeliveryDepsForTests(null);
  });

  it("retries with exponential backoff on transient failure and increments failureCount on terminal failure", async () => {
    const delivery = await import("../lib/webhook-delivery");
    const secret = "secret-2";
    webhookRows.push({
      id: 9,
      url: "https://hook-b.example/in",
      secretHash: delivery.hashSecret(secret),
      eventTypes: ["report.scored"],
      createdAt: new Date(),
      lastDeliveredAt: null,
      failureCount: 0,
    });
    delivery.rememberWebhookSecret(9, secret);

    const fakeFetch = vi.fn(async () => new Response("", { status: 500 }));
    // Skip the real backoff sleeps so the test runs in milliseconds.
    const fakeSetTimeout = ((cb: () => void) => {
      Promise.resolve().then(cb);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    delivery.__setWebhookDeliveryDepsForTests({ fetch: fakeFetch as unknown as typeof fetch, setTimeout: fakeSetTimeout });

    await delivery.dispatchReportScoredEvent({
      event: "report.scored",
      reportId: 1,
      slopScore: 10,
      slopTier: "human",
      compositeScore: null,
      label: null,
      createdAt: "2026-05-03T00:00:00.000Z",
    });

    expect(fakeFetch).toHaveBeenCalledTimes(5);
    expect(webhookRows[0].lastDeliveredAt).toBeNull();
    expect(webhookRows[0].failureCount).toBe(1);

    delivery.__setWebhookDeliveryDepsForTests(null);
  });

  it("skips delivery when no cached secret is available (post-restart)", async () => {
    const delivery = await import("../lib/webhook-delivery");
    webhookRows.push({
      id: 11,
      url: "https://hook-c.example/in",
      secretHash: "deadbeef",
      eventTypes: ["report.scored"],
      createdAt: new Date(),
      lastDeliveredAt: null,
      failureCount: 0,
    });
    delivery.forgetWebhookSecret(11);

    const fakeFetch = vi.fn(async () => new Response("", { status: 200 }));
    delivery.__setWebhookDeliveryDepsForTests({ fetch: fakeFetch as unknown as typeof fetch });

    await delivery.dispatchReportScoredEvent({
      event: "report.scored",
      reportId: 1,
      slopScore: 10,
      slopTier: "human",
      compositeScore: null,
      label: null,
      createdAt: "2026-05-03T00:00:00.000Z",
    });

    expect(fakeFetch).not.toHaveBeenCalled();
    expect(webhookRows[0].lastDeliveredAt).toBeNull();
    expect(webhookRows[0].failureCount).toBe(0);

    delivery.__setWebhookDeliveryDepsForTests(null);
  });
});
