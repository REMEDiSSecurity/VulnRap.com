process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "fs";
import path from "path";
import { ListRoadmapResponse } from "@workspace/api-zod";

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

function loadRawRoadmap() {
  const candidates = [
    path.resolve(process.cwd(), "data/roadmap.json"),
    path.resolve(process.cwd(), "artifacts/api-server/data/roadmap.json"),
  ];
  for (const c of candidates) {
    try {
      return JSON.parse(readFileSync(c, "utf8"));
    } catch {}
  }
  throw new Error("Could not locate roadmap.json for test");
}

describe("GET /api/roadmap", () => {
  it("responds 200 with the full curated payload matching roadmap.json", async () => {
    const res = await fetch(`${baseUrl}/api/roadmap`);
    expect(res.status).toBe(200);

    const body = await res.json();
    const raw = loadRawRoadmap();

    const expected = {
      version: raw.version,
      updatedAt: raw.updatedAt,
      items: raw.items,
    };
    expect(body).toEqual(expected);
  });

  it("sets Cache-Control with public, max-age=3600, stale-while-revalidate=600", async () => {
    const res = await fetch(`${baseUrl}/api/roadmap`);
    const cc = res.headers.get("cache-control");
    expect(cc).toContain("public");
    expect(cc).toContain("max-age=3600");
    expect(cc).toContain("stale-while-revalidate=600");
  });

  it("returns valid JSON that parses against ListRoadmapResponse", async () => {
    const res = await fetch(`${baseUrl}/api/roadmap`);
    const body = await res.json();
    const parsed = ListRoadmapResponse.safeParse(body);
    expect(parsed.success).toBe(true);
  });
});

describe("roadmap.json schema validation", () => {
  const raw = loadRawRoadmap();

  it("has a version string", () => {
    expect(typeof raw.version).toBe("string");
    expect(raw.version.length).toBeGreaterThan(0);
  });

  it("has an updatedAt date string", () => {
    expect(typeof raw.updatedAt).toBe("string");
    expect(raw.updatedAt.length).toBeGreaterThan(0);
  });

  it("parses against ListRoadmapResponse", () => {
    const result = ListRoadmapResponse.safeParse({
      version: raw.version,
      updatedAt: raw.updatedAt,
      items: raw.items,
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      console.error(result.error.format());
    }
  });

  it("every item has a unique id", () => {
    const ids = raw.items.map((item: { id: string }) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every item has column in {now, next, later}", () => {
    for (const item of raw.items) {
      expect(["now", "next", "later"]).toContain(item.column);
    }
  });

  it("every item has status in {in_progress, shipping_soon, planned, research}", () => {
    for (const item of raw.items) {
      expect(["in_progress", "shipping_soon", "planned", "research"]).toContain(
        item.status,
      );
    }
  });

  it("every item has a non-empty title and description", () => {
    for (const item of raw.items) {
      expect(typeof item.title).toBe("string");
      expect(item.title.length).toBeGreaterThan(0);
      expect(typeof item.description).toBe("string");
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  it("rejects a fixture with an invalid column value", () => {
    const bad = {
      version: raw.version,
      updatedAt: raw.updatedAt,
      items: [
        {
          id: "bad-column",
          column: "yesterday",
          status: "planned",
          title: "Bad",
          description: "This should fail",
        },
      ],
    };
    const result = ListRoadmapResponse.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a fixture with an invalid status value", () => {
    const bad = {
      version: raw.version,
      updatedAt: raw.updatedAt,
      items: [
        {
          id: "bad-status",
          column: "now",
          status: "done",
          title: "Bad",
          description: "This should fail",
        },
      ],
    };
    const result = ListRoadmapResponse.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a fixture missing required fields", () => {
    const bad = {
      version: raw.version,
      updatedAt: raw.updatedAt,
      items: [
        {
          id: "missing-fields",
          column: "now",
        },
      ],
    };
    const result = ListRoadmapResponse.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
