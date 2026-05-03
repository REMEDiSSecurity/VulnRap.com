// Active-phrase server-side cache test for the single-phrase removal-impact
// dry-run. Lives in its own file so the `vi.mock("@workspace/db", ...)`
// stub doesn't leak into the broader handwavy-phrases route test suite.
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
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

vi.mock("@workspace/db", () => {
  // Drizzle's query builder is a thenable that resolves on await. The
  // route only needs the rows / count shapes to be empty arrays for the
  // production scan to succeed (zero archive matches → no impact).
  const builder: {
    select: (...args: unknown[]) => typeof builder;
    from: (...args: unknown[]) => typeof builder;
    where: (...args: unknown[]) => typeof builder;
    orderBy: (...args: unknown[]) => typeof builder;
    limit: (...args: unknown[]) => typeof builder;
    then: <T>(onF: (rows: unknown[]) => T) => Promise<T>;
  } = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: () => builder,
    then: (onF) => Promise.resolve([]).then(onF),
  };
  return {
    db: builder,
    reportsTable: {
      id: "id",
      vulnrapCompositeLabel: "label",
      contentText: "content",
      createdAt: "createdAt",
    },
  };
});

const TEST_TOKEN = "handwavy-cache-active-test-token";

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let phrasesPath: string;
let __resetForTests: () => void;

const SEED = JSON.stringify(
  {
    _meta: { description: "test fixture" },
    phrases: ["seed phrase one", "seed phrase two"],
  },
  null,
  2,
);

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "handwavy-cache-active-"));
  phrasesPath = path.join(tmpDir, "handwavy-phrases.json");
  await fs.writeFile(phrasesPath, SEED, "utf8");
  process.env.HANDWAVY_PHRASES_PATH = phrasesPath;
  process.env.CALIBRATION_TOKEN = TEST_TOKEN;

  const calibrationRouter = (await import("./calibration")).default;
  const handwavy = await import("../lib/engines/avri/handwavy-phrases");
  __resetForTests = handwavy.__resetHandwavyPhrasesForTests;

  const app = express();
  app.use(express.json());
  app.use(calibrationRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.CALIBRATION_TOKEN;
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(async () => {
  __resetForTests();
  await fs.writeFile(phrasesPath, SEED, "utf8");
  __resetForTests();
  // Bounce the singleton cache via a throwaway add+delete.
  const tag = `cache-bust-${Date.now()}-${Math.random()}`;
  await request("POST", "/feedback/calibration/handwavy-phrases", {
    phrase: tag,
  });
  await request("DELETE", "/feedback/calibration/handwavy-phrases", {
    phrase: tag,
  });
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
          "X-Calibration-Token": TEST_TOKEN,
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

interface DryRunBody {
  cacheHit: boolean;
  cachedAt?: string;
  wouldRemove: number;
  phrase: string;
  removed: boolean;
  dryRunImpact: {
    productionLimit: number;
    productionError: string | null;
    production: { total: number } | null;
  };
}

describe("active-phrase removal-impact dry-run cache", () => {
  it("caches a successful active-phrase scan and replays it on a second request", async () => {
    const first = await request<DryRunBody>(
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "seed phrase one", dryRun: true },
    );
    expect(first.status).toBe(200);
    expect(first.body.cacheHit).toBe(false);
    expect(first.body.removed).toBe(true);
    expect(first.body.wouldRemove).toBe(1);
    expect(first.body.dryRunImpact.productionError).toBeNull();
    expect(first.body.dryRunImpact.production).not.toBeNull();

    const second = await request<DryRunBody>(
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "seed phrase one", dryRun: true },
    );
    expect(second.status).toBe(200);
    expect(second.body.cacheHit).toBe(true);
    expect(typeof second.body.cachedAt).toBe("string");
    expect(second.body.wouldRemove).toBe(first.body.wouldRemove);
    expect(second.body.removed).toBe(first.body.removed);
    expect(second.body.phrase).toBe(first.body.phrase);
  });

  it("a real removal of a different phrase invalidates the cached active-phrase preview", async () => {
    const seed = await request<DryRunBody>(
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "seed phrase one", dryRun: true },
    );
    expect(seed.body.cacheHit).toBe(false);
    const warm = await request<DryRunBody>(
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "seed phrase one", dryRun: true },
    );
    expect(warm.body.cacheHit).toBe(true);

    const realDelete = await request<{ removed: boolean }>(
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "seed phrase two" },
    );
    expect(realDelete.status).toBe(200);

    // After "seed phrase two" is gone, the version key for "seed phrase one"
    // changes and the prior cached preview must be unreachable.
    const afterDelete = await request<DryRunBody>(
      "DELETE",
      "/feedback/calibration/handwavy-phrases",
      { phrase: "seed phrase one", dryRun: true },
    );
    expect(afterDelete.body.cacheHit).toBe(false);
  });
});
