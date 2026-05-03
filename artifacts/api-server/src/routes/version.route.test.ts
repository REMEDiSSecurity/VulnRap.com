// Task #728 — Tests for GET /api/version. Exercises the route through
// the real Express mount (`app.listen(0)` + fetch) so the path prefix
// and the GetVersionResponse zod parse are covered end-to-end.

process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

// Force the dev fallback values so the test is deterministic regardless
// of whether the harness was launched from a built bundle or a watch
// session (where esbuild's `define` is not in play).
process.env.VULNRAP_PROJECT_VERSION = "9.9.9-test";
process.env.VULNRAP_SPEC_VERSION = "9.9.9-test";
process.env.VULNRAP_GIT_SHA = "abc123def456";
process.env.VULNRAP_BUILT_AT = "2026-04-15T18:32:01.000Z";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { getBuildInfo } from "../lib/build-info";

const appModule = await import("../app");
const app = appModule.default;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.on("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /api/version", () => {
  it("returns project, projectVersion, gitSha, specVersion, builtAt", async () => {
    const res = await fetch(`${baseUrl}/api/version`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      project: "vulnrap",
      projectVersion: "9.9.9-test",
      gitSha: "abc123def456",
      specVersion: "9.9.9-test",
      builtAt: "2026-04-15T18:32:01.000Z",
    });
  });

  it("getBuildInfo() falls back to dev sentinels when env is unset", () => {
    const saved = {
      pv: process.env.VULNRAP_PROJECT_VERSION,
      sv: process.env.VULNRAP_SPEC_VERSION,
      sha: process.env.VULNRAP_GIT_SHA,
      ba: process.env.VULNRAP_BUILT_AT,
    };
    delete process.env.VULNRAP_PROJECT_VERSION;
    delete process.env.VULNRAP_SPEC_VERSION;
    delete process.env.VULNRAP_GIT_SHA;
    delete process.env.VULNRAP_BUILT_AT;
    try {
      const info = getBuildInfo();
      expect(info.project).toBe("vulnrap");
      expect(info.projectVersion).toBe("0.0.0-dev");
      expect(info.specVersion).toBe("0.0.0-dev");
      expect(info.gitSha).toBe("dev");
      expect(info.builtAt).toBe(new Date(0).toISOString());
    } finally {
      if (saved.pv !== undefined) process.env.VULNRAP_PROJECT_VERSION = saved.pv;
      if (saved.sv !== undefined) process.env.VULNRAP_SPEC_VERSION = saved.sv;
      if (saved.sha !== undefined) process.env.VULNRAP_GIT_SHA = saved.sha;
      if (saved.ba !== undefined) process.env.VULNRAP_BUILT_AT = saved.ba;
    }
  });
});
