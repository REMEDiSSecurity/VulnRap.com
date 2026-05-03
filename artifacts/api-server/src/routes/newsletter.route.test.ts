// Task #733 — Cover the welcome / confirm / unsubscribe additions to
// /api/newsletter. Mocks `@workspace/db` with a tiny in-memory table so
// the real Express handlers run end-to-end without a Postgres.
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

interface Row {
  id: number;
  emailHmac: string;
  tokenHash: string | null;
  confirmedAt: Date | null;
  createdAt: Date;
}

const ROWS: Row[] = [];
let nextId = 1;
const DISPATCHED: Array<{
  kind: string;
  to: string;
  unsubscribeUrl: string;
  confirmUrl?: string;
}> = [];

vi.mock("@workspace/db", async () => {
  const newsletterSubscriptionsTable = {
    id: { name: "id" },
    emailHmac: { name: "emailHmac" },
    tokenHash: { name: "tokenHash" },
    confirmedAt: { name: "confirmedAt" },
    createdAt: { name: "createdAt" },
  };

  type Cond = { col: { name: string }; val: unknown };
  const matches = (row: Row, cond: Cond): boolean =>
    (row as unknown as Record<string, unknown>)[cond.col.name] === cond.val;

  const db = {
    insert(_table: unknown) {
      let _values: Partial<Row> | null = null;
      let _conflict = false;
      const chain = {
        values(v: Partial<Row>) {
          _values = v;
          return chain;
        },
        onConflictDoNothing(_opts: unknown) {
          _conflict = true;
          return chain;
        },
        async returning(_sel: unknown) {
          if (!_values) return [];
          if (
            _conflict &&
            ROWS.some((r) => r.emailHmac === _values!.emailHmac)
          ) {
            return [];
          }
          const row: Row = {
            id: nextId++,
            emailHmac: _values.emailHmac as string,
            tokenHash: (_values.tokenHash as string | null) ?? null,
            confirmedAt: (_values.confirmedAt as Date | null) ?? null,
            createdAt: new Date(),
          };
          ROWS.push(row);
          return [{ id: row.id }];
        },
      };
      return chain;
    },
    select(_sel: unknown) {
      let _cond: Cond | null = null;
      const chain = {
        from(_t: unknown) {
          return chain;
        },
        where(c: Cond) {
          _cond = c;
          return chain;
        },
        async limit(_n: number): Promise<Array<Record<string, unknown>>> {
          const matched = ROWS.filter((r) => (_cond ? matches(r, _cond) : true));
          const out = matched.map((r) => ({
            id: r.id,
            confirmedAt: r.confirmedAt,
          }));
          return out.slice(0, _n);
        },
      };
      return chain;
    },
    update(_table: unknown) {
      let _set: Partial<Row> | null = null;
      let _cond: Cond | null = null;
      const chain = {
        set(s: Partial<Row>) {
          _set = s;
          return chain;
        },
        where(c: Cond) {
          _cond = c;
          return Promise.resolve();
        },
        // never awaited directly, returned via where above
        get _set() {
          return _set;
        },
      };
      // After where(), apply mutation. Return a thenable from where.
      const orig = chain.where;
      chain.where = (c: Cond) => {
        _cond = c;
        for (const r of ROWS) {
          if (matches(r, _cond)) {
            Object.assign(r, _set);
          }
        }
        return Promise.resolve() as unknown as ReturnType<typeof orig>;
      };
      return chain;
    },
    delete(_table: unknown) {
      let _cond: Cond | null = null;
      const chain = {
        where(c: Cond) {
          _cond = c;
          return chain;
        },
        async returning(_sel: unknown): Promise<Array<{ id: number }>> {
          const out: Array<{ id: number }> = [];
          for (let i = ROWS.length - 1; i >= 0; i--) {
            if (matches(ROWS[i]!, _cond!)) {
              out.push({ id: ROWS[i]!.id });
              ROWS.splice(i, 1);
            }
          }
          return out;
        },
      };
      return chain;
    },
  };

  return { db, newsletterSubscriptionsTable };
});

vi.mock("drizzle-orm", async () => {
  return {
    eq: (col: { name: string }, val: unknown) => ({ col, val }),
    sql: () => ({}),
  };
});

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  process.env.VISITOR_HMAC_KEY = "test-key-for-newsletter-suite";
  process.env.PUBLIC_URL = "https://example.test";
  const { default: newsletterRouter } = await import("./newsletter");
  const { __setNewsletterEmailDispatcher } = await import(
    "../lib/newsletter-email"
  );
  __setNewsletterEmailDispatcher(async (payload) => {
    DISPATCHED.push({
      kind: payload.kind,
      to: payload.to,
      unsubscribeUrl: payload.unsubscribeUrl,
      confirmUrl: payload.confirmUrl,
    });
    return { ok: true, status: 200 };
  });

  const app = express();
  app.use(express.json());
  app.use("/api", newsletterRouter);
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
  ROWS.length = 0;
  DISPATCHED.length = 0;
  nextId = 1;
  delete process.env.NEWSLETTER_DOUBLE_OPT_IN;
});

interface Resp<T> {
  status: number;
  body: T;
}

function request<T>(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<Resp<T>> {
  return new Promise((resolve, reject) => {
    const data =
      body == null ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const u = new URL(`${baseUrl}${urlPath}`);
    const headers: Record<string, string> = data
      ? {
          "Content-Type": "application/json",
          "Content-Length": String(data.length),
        }
      : {};
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const txt = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          try {
            parsed = txt ? JSON.parse(txt) : null;
          } catch {
            parsed = txt;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed as T });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("POST /api/newsletter/subscribe (single opt-in default)", () => {
  it("creates a row, sends a welcome email with an unsubscribe link, and is idempotent on re-signup", async () => {
    const r1 = await request<{
      ok: boolean;
      alreadySubscribed: boolean;
      pendingConfirmation: boolean;
      message: string;
    }>("POST", "/api/newsletter/subscribe", { email: "first@example.com" });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({
      ok: true,
      alreadySubscribed: false,
      pendingConfirmation: false,
    });

    expect(ROWS).toHaveLength(1);
    expect(ROWS[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(ROWS[0]!.confirmedAt).toBeInstanceOf(Date);

    // Wait for fire-and-forget email dispatch.
    await new Promise((r) => setTimeout(r, 20));
    expect(DISPATCHED).toHaveLength(1);
    expect(DISPATCHED[0]).toMatchObject({
      kind: "welcome",
      to: "first@example.com",
    });
    expect(DISPATCHED[0]!.unsubscribeUrl).toContain(
      "https://example.test/api/newsletter/unsubscribe?token=",
    );
    expect(DISPATCHED[0]!.confirmUrl).toBeUndefined();

    // Duplicate: returns 201 with alreadySubscribed=true and does not
    // mint a new email.
    const r2 = await request<{ alreadySubscribed: boolean }>(
      "POST",
      "/api/newsletter/subscribe",
      { email: "first@example.com" },
    );
    expect(r2.status).toBe(201);
    expect(r2.body.alreadySubscribed).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(DISPATCHED).toHaveLength(1);
  });
});

describe("POST /api/newsletter/subscribe (double opt-in)", () => {
  it("leaves confirmedAt null, sends a confirm email, and confirms via /confirm", async () => {
    process.env.NEWSLETTER_DOUBLE_OPT_IN = "true";
    const r = await request<{
      pendingConfirmation: boolean;
      message: string;
    }>("POST", "/api/newsletter/subscribe", { email: "two@example.com" });
    expect(r.status).toBe(201);
    expect(r.body.pendingConfirmation).toBe(true);
    expect(r.body.message).toMatch(/check your inbox/i);
    expect(ROWS[0]!.confirmedAt).toBeNull();

    await new Promise((r) => setTimeout(r, 20));
    expect(DISPATCHED).toHaveLength(1);
    expect(DISPATCHED[0]!.kind).toBe("confirm");
    expect(DISPATCHED[0]!.confirmUrl).toBeTruthy();
    const confirmUrl = new URL(DISPATCHED[0]!.confirmUrl!);
    const token = confirmUrl.searchParams.get("token")!;
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    // Confirm via the link.
    const c = await request<{ ok: boolean; alreadyConfirmed: boolean }>(
      "GET",
      `/api/newsletter/confirm?token=${token}`,
    );
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ ok: true, alreadyConfirmed: false });
    expect(ROWS[0]!.confirmedAt).toBeInstanceOf(Date);

    // Re-clicking is idempotent.
    const c2 = await request<{ alreadyConfirmed: boolean }>(
      "GET",
      `/api/newsletter/confirm?token=${token}`,
    );
    expect(c2.status).toBe(200);
    expect(c2.body.alreadyConfirmed).toBe(true);
  });

  it("rejects an unknown confirmation token with 404", async () => {
    const c = await request<{ error: string }>(
      "GET",
      `/api/newsletter/confirm?token=${"a".repeat(64)}`,
    );
    expect(c.status).toBe(404);
    expect(c.body.error).toBeTruthy();
  });

  it("rejects a missing / too-short token with 400", async () => {
    const c = await request<{ error: string }>(
      "GET",
      "/api/newsletter/confirm?token=short",
    );
    expect(c.status).toBe(400);
  });
});

describe("/api/newsletter/unsubscribe", () => {
  it("removes the row given a valid token (GET form, one-click)", async () => {
    await request("POST", "/api/newsletter/subscribe", {
      email: "remove@example.com",
    });
    await new Promise((r) => setTimeout(r, 20));
    const url = new URL(DISPATCHED[0]!.unsubscribeUrl);
    const token = url.searchParams.get("token")!;
    expect(ROWS).toHaveLength(1);

    const u = await request<{ ok: boolean; removed: boolean }>(
      "GET",
      `/api/newsletter/unsubscribe?token=${token}`,
    );
    expect(u.status).toBe(200);
    expect(u.body).toMatchObject({ ok: true, removed: true });
    expect(ROWS).toHaveLength(0);

    // Re-clicking returns 200 with removed=false (not a scary error).
    const u2 = await request<{ removed: boolean }>(
      "GET",
      `/api/newsletter/unsubscribe?token=${token}`,
    );
    expect(u2.status).toBe(200);
    expect(u2.body.removed).toBe(false);
  });

  it("accepts the POST body form for richer clients", async () => {
    await request("POST", "/api/newsletter/subscribe", {
      email: "post-remove@example.com",
    });
    await new Promise((r) => setTimeout(r, 20));
    const url = new URL(DISPATCHED[0]!.unsubscribeUrl);
    const token = url.searchParams.get("token")!;

    const u = await request<{ removed: boolean }>(
      "POST",
      "/api/newsletter/unsubscribe",
      { token },
    );
    expect(u.status).toBe(200);
    expect(u.body.removed).toBe(true);
    expect(ROWS).toHaveLength(0);
  });

  it("rejects a missing token with 400", async () => {
    const u = await request<{ error: string }>(
      "GET",
      "/api/newsletter/unsubscribe",
    );
    expect(u.status).toBe(400);
  });
});

describe("renderNewsletterEmail", () => {
  it("renders welcome and confirm bodies with escaped URLs", async () => {
    const { renderNewsletterEmail } = await import("../lib/newsletter-email");
    const welcome = renderNewsletterEmail({
      kind: "welcome",
      to: "u@x.test",
      unsubscribeUrl: "https://example.test/u?token=abc&kind=foo",
    });
    expect(welcome.subject).toMatch(/welcome/i);
    expect(welcome.text).toContain("https://example.test/u?token=abc&kind=foo");
    expect(welcome.html).toContain("token=abc&amp;kind=foo");

    const confirm = renderNewsletterEmail({
      kind: "confirm",
      to: "u@x.test",
      unsubscribeUrl: "https://example.test/u?token=u",
      confirmUrl: "https://example.test/c?token=c",
    });
    expect(confirm.subject).toMatch(/confirm/i);
    expect(confirm.text).toContain("https://example.test/c?token=c");
    expect(confirm.html).toContain("https://example.test/c?token=c");

    expect(() =>
      renderNewsletterEmail({
        kind: "confirm",
        to: "u@x.test",
        unsubscribeUrl: "https://example.test/u",
      }),
    ).toThrow(/confirmUrl is required/);
  });
});
