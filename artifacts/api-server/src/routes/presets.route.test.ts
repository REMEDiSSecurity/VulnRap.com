process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "fs";
import path from "path";
import { ListPresetsResponse } from "@workspace/api-zod";

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

function loadRawPresets() {
  const candidates = [
    path.resolve(process.cwd(), "data/presets.json"),
    path.resolve(process.cwd(), "artifacts/api-server/data/presets.json"),
  ];
  for (const c of candidates) {
    try {
      return JSON.parse(readFileSync(c, "utf8"));
    } catch {}
  }
  throw new Error("Could not locate presets.json for test");
}

describe("GET /api/presets", () => {
  it("responds 200 with the full curated payload matching presets.json", async () => {
    const res = await fetch(`${baseUrl}/api/presets`);
    expect(res.status).toBe(200);

    const body = await res.json();
    const raw = loadRawPresets();

    const expected = { version: raw.version, presets: raw.presets };
    expect(body).toEqual(expected);
  });

  it("sets Cache-Control with public, max-age=3600, stale-while-revalidate=600", async () => {
    const res = await fetch(`${baseUrl}/api/presets`);
    const cc = res.headers.get("cache-control");
    expect(cc).toContain("public");
    expect(cc).toContain("max-age=3600");
    expect(cc).toContain("stale-while-revalidate=600");
  });

  it("returns valid JSON that parses against ListPresetsResponse", async () => {
    const res = await fetch(`${baseUrl}/api/presets`);
    const body = await res.json();
    const parsed = ListPresetsResponse.safeParse(body);
    expect(parsed.success).toBe(true);
  });
});

describe("presets.json schema validation", () => {
  const raw = loadRawPresets();

  it("has a version string", () => {
    expect(typeof raw.version).toBe("string");
    expect(raw.version.length).toBeGreaterThan(0);
  });

  it("every entry parses against ListPresetsResponse", () => {
    const result = ListPresetsResponse.safeParse({
      version: raw.version,
      presets: raw.presets,
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      console.error(result.error.format());
    }
  });

  it("every preset has a unique id", () => {
    const ids = raw.presets.map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset has sensitivity in {lenient, balanced, strict}", () => {
    for (const p of raw.presets) {
      expect(["lenient", "balanced", "strict"]).toContain(p.sensitivity);
    }
  });

  it("every engine weight is in [0, 2]", () => {
    for (const p of raw.presets) {
      for (const [key, val] of Object.entries(p.engineWeights)) {
        expect(val).toBeGreaterThanOrEqual(0);
        expect(val).toBeLessThanOrEqual(2);
      }
    }
  });

  it("slop thresholds are in [0, 100] and low < high", () => {
    for (const p of raw.presets) {
      expect(p.slopThresholdLow).toBeGreaterThanOrEqual(0);
      expect(p.slopThresholdLow).toBeLessThanOrEqual(100);
      expect(p.slopThresholdHigh).toBeGreaterThanOrEqual(0);
      expect(p.slopThresholdHigh).toBeLessThanOrEqual(100);
      expect(p.slopThresholdLow).toBeLessThan(p.slopThresholdHigh);
    }
  });
});
